import { randomUUID } from "node:crypto";
import { BusyBehavior, type ConversationInfo } from "@anima/protocol-ts";
import {
  getKeybindings, HStack, Editor, matchesKey, ScrollView, VStack, type TuiAltScreen,
  CombinedAutocompleteProvider, type SlashCommand,
} from "@earendil-works/pi-tui";
import { RemoteClient, queuedInputs, type Graph } from "./client.ts";
import { Dialogs } from "./dialogs.ts";
import { Sidebar, workingConversations } from "./sidebar.ts";
import { Transcript, userText } from "./transcript.ts";
import { forkFamily, historyTree } from "./tree.ts";
import { button, clean, colors, editorTheme, line } from "./ui.ts";

const COMMANDS: SlashCommand[] = [
  { name: "new", description: "New conversation in a server folder" },
  { name: "conversations", description: "Switch conversation" },
  { name: "rename", description: "Rename selected conversation" },
  { name: "archive", description: "Archive selected conversation (not root)" },
  { name: "archived", description: "Restore/open archived conversations" },
  { name: "cwd", description: "Change folder while idle (does not move files)" },
  { name: "fork", description: "Fork current history into a chosen folder" },
  { name: "model", description: "Choose a server chat model" },
  { name: "queue", description: "Edit queued steering/follow-up messages" },
  { name: "tree", description: "Browse branches, or fork/edit earlier history" },
  { name: "sidebar", description: "Toggle sidebar" },
  { name: "help", description: "Show commands" },
  { name: "quit", description: "Disconnect client; leave server/work running" },
];

class ChatEditor extends Editor {
  onKey?: (data: string) => boolean;
  override handleInput(data: string) {
    if (!this.onKey?.(data)) super.handleInput(data);
  }
}

type View = { transcript: Transcript; scroll: ScrollView; editor: ChatEditor };
type Pending = { content: string; mode: BusyBehavior; requestId: string };

export class App {
  readonly remote: RemoteClient;
  private tui: TuiAltScreen;
  private editor: ChatEditor;
  private dialogs: Dialogs;
  private sidebar: Sidebar;
  private main = new VStack();
  private rootId = "";
  private selected = "";
  private directory: ConversationInfo[] = [];
  private graph: Graph = { tasks: {} };
  private busy = new Set<string>();
  private connections = new Set<string>();
  private connectionError = "";
  private sidebarOpen = true;
  private expanded = false;
  private note = "";
  private views = new Map<string, View>();
  private pending = new Map<string, Pending>();
  private sending = new Set<string>();
  private unfollow?: () => void;
  private stopped = false;
  private closing?: Promise<void>;
  onExit: () => void = () => { void this.stop(); };

  constructor(tui: TuiAltScreen, serverUrl: string) {
    this.tui = tui;
    this.remote = new RemoteClient(serverUrl);
    this.editor = this.createEditor();
    this.dialogs = new Dialogs(tui, () => tui.setFocus(this.editor), error => this.error(error));
    this.sidebar = new Sidebar({
      collapse: () => this.toggleSidebar(), select: id => this.select(id),
      command: name => void this.act(() => this.command(name)),
    });
    this.main.addChild(line("Connecting to Anima…"));
    const sidebarVisible = ({ width }: { width: number }) => this.sidebarOpen && width >= 72;
    tui.setLayoutRoot(new HStack([
      { component: this.sidebar, basis: 27, shrink: 0, visible: sidebarVisible },
      { component: {
        render: width => Array(tui.terminal.rows).fill(width > 0 ? colors.muted("│") : ""),
        invalidate() {},
      }, basis: 1, shrink: 0, visible: sidebarVisible },
      { component: this.main, basis: 0, grow: 1, minSize: 0 },
    ], { gap: 1 }));
    this.remote.onChange = state => {
      if (this.stopped || state.id !== this.selected) return;
      this.view(state.id).transcript.update(state);
      this.tui.requestRender();
    };
    this.refresh();
  }

  /** Editors belong to views: drafts, paste markers, cursor and undo never cross conversations. */
  private createEditor() {
    const editor = new ChatEditor(this.tui, editorTheme(), { paddingX: 1 });
    editor.onSubmit = text => void this.submit(text, BusyBehavior.STEER);
    editor.onKey = data => this.key(data);
    // Reuse slash completion, but never complete files against the client's cwd.
    const commands = new CombinedAutocompleteProvider(COMMANDS, process.cwd(), null);
    editor.setAutocompleteProvider({
      triggerCharacters: ["/"],
      getSuggestions: (lines, row, col, options) => {
        const prefix = lines[row]?.slice(0, col) ?? "";
        return row === 0 && /^\/[\w-]*$/.test(prefix) && COMMANDS.some(command => command.name.startsWith(prefix.slice(1)))
          ? commands.getSuggestions(lines, row, col, options) : Promise.resolve(null);
      },
      applyCompletion: (...args) => commands.applyCompletion(...args),
      shouldTriggerFileCompletion: () => false,
    });
    return editor;
  }

  async start() {
    this.tui.setFocus(this.editor);
    this.tui.start();
    const root = await this.remote.rpc.getRootConversation({}, { signal: this.remote.lifetime.signal, timeoutMs: 5_000 });
    if (this.stopped) return;
    this.rootId = root.conversationId;
    this.select(this.rootId);
    this.remote.watch(signal => this.remote.rpc.watchConversations({}, { signal }), value => {
      this.directory = value.conversations;
      const selected = this.directory.find(info => info.conversationId === this.selected);
      if (!selected || selected.archived) this.select(this.rootId);
      this.refresh();
    }, (ready, error) => this.connection("directory", ready, error));
    this.remote.watch(signal => this.remote.rpc.watchTaskGraph({}, { signal }), value => {
      this.graph = (value.graph ?? { tasks: {} }) as unknown as Graph;
      this.busy = workingConversations(this.graph);
      this.refresh();
    }, (ready, error) => this.connection("tasks", ready, error));
  }

  private view(id: string): View {
    let view = this.views.get(id);
    if (!view) {
      const transcript = new Transcript(this.tui, () => void this.act(async () => {
        await this.remote.older(id);
        this.views.get(id)?.scroll.scrollToStart();
        this.tui.requestRender();
      }));
      transcript.expand(this.expanded);
      transcript.update(this.remote.state(id));
      view = { transcript, scroll: new ScrollView(transcript, { follow: "end", primary: true }), editor: this.createEditor() };
      this.views.set(id, view);
    }
    return view;
  }

  private select(id: string) {
    if (this.stopped || !id || id === this.selected) return;
    this.dialogs.cancel();
    this.unfollow?.();
    this.selected = id;
    this.note = "";
    this.connections.delete("conversation");
    this.editor = this.view(id).editor;
    this.main.clear();
    this.main.addChild(button(() => {
      const name = this.directory.find(info => info.conversationId === this.selected)?.name ?? "Conversation";
      const count = queuedInputs(this.remote.state(this.selected)).length;
      return `${colors.accent("☰")} ${clean(name)}${count ? colors.yellow(` · ${count} queued`) : ""}`;
    }, () => this.tui.terminal.columns < 72
      ? void this.act(() => this.command("conversations")) : this.toggleSidebar()), { basis: 1, shrink: 0 });
    this.main.addChild(this.view(id).scroll, { basis: 0, grow: 1, minSize: 1 });
    this.main.addChild(this.editor, { basis: "auto", shrink: 1, minSize: 3 });
    this.main.addChild(line(() => {
      const status = this.remote.state(this.selected).snapshot?.status;
      return colors.muted(status ? `${clean(status.cwd)}${status.gitBranch ? ` · ${clean(status.gitBranch)}` : ""}` : "Waiting for server status…");
    }), { basis: 1, shrink: 0 });
    this.main.addChild(line(() => this.footer()), { basis: 1, shrink: 0 });
    this.main.addChild(line(() => this.notice()), { basis: 1, shrink: 0, visible: () => Boolean(this.notice()) });
    this.unfollow = this.remote.follow(id, (ready, error) => {
      if (this.selected === id) this.connection("conversation", ready, error);
    });
    this.tui.setFocus(this.editor);
    this.refresh();
  }

  private notice() {
    if (this.connections.size < 3) return colors.yellow(`Reconnecting…${this.connectionError ? ` ${this.connectionError}` : ""}`);
    return this.note;
  }

  private connection(name: string, ready: boolean, error?: unknown) {
    if (this.stopped || ready && this.connections.has(name)) return;
    if (ready) this.connections.add(name);
    else {
      this.connections.delete(name);
      if (error) this.connectionError = clean(error instanceof Error ? error.message : String(error));
    }
    if (this.connections.size === 3) this.connectionError = "";
    this.refresh();
  }
  private refresh() {
    if (this.stopped) return;
    this.sidebar.update(this.directory, this.rootId, this.selected, this.busy, this.connections.size === 3);
    this.editor.disableSubmit = this.sending.has(this.selected) || !this.selected;
    this.tui.requestRender();
  }
  private footer() {
    const status = this.remote.state(this.selected).snapshot?.status;
    if (!status) return colors.muted("Waiting for server status…");
    const context = status.contextWindow ? `~${(status.contextTokens / status.contextWindow * 100).toFixed(1)}% context` : "context —";
    return colors.muted(`${context}  |  ${status.model ? `${clean(status.model.provider)}/${clean(status.model.modelId)}` : "no model"}`);
  }
  private error(error: unknown) {
    this.note = colors.error(clean(error instanceof Error ? error.message : String(error)));
    this.tui.requestRender();
  }
  private async act(action: () => Promise<unknown>) {
    try { if (!this.stopped) await action(); }
    catch (error) { if (!this.stopped) this.error(error); }
    finally { this.refresh(); }
  }
  private toggleSidebar() {
    this.sidebarOpen = !this.sidebarOpen;
    this.tui.requestRender();
  }

  private key(data: string): boolean {
    const kb = getKeybindings();
    if (matchesKey(data, "f2")) { this.toggleSidebar(); return true; }
    if (kb.matches(data, "app.interrupt")) {
      if (this.editor.isShowingAutocomplete()) return false;
      const id = this.selected;
      void this.act(async () => {
        await this.remote.rpc.abortConversation({ conversationId: id }, { signal: this.remote.lifetime.signal });
        this.pending.delete(id);
        this.note = "";
      });
      return true;
    }
    if (kb.matches(data, "app.clear")) {
      if (this.editor.getText()) this.editor.setText("");
      else this.onExit();
      return true;
    }
    if (kb.matches(data, "app.exit") && !this.editor.getText()) { this.onExit(); return true; }
    if (kb.matches(data, "app.model.select")) { void this.act(() => this.command("model")); return true; }
    if (kb.matches(data, "app.tools.expand")) {
      this.expanded = !this.expanded;
      for (const view of this.views.values()) view.transcript.expand(this.expanded);
      this.tui.requestRender();
      return true;
    }
    if (kb.matches(data, "app.message.followUp")) {
      const content = this.editor.getExpandedText();
      if (!this.sending.has(this.selected) && content.trim()) {
        this.editor.setText("");
        void this.submit(content, BusyBehavior.QUEUE);
      }
      return true;
    }
    if (kb.matches(data, "app.message.dequeue")) { void this.act(() => this.dequeue()); return true; }
    return false;
  }

  private async submit(content: string, mode: BusyBehavior) {
    if (!content.trim() || !this.selected) return;
    const editor = this.editor;
    if (content.startsWith("/")) {
      const [name, ...rest] = content.slice(1).split(" ");
      this.editor.addToHistory(content);
      await this.act(() => this.command(name, rest.join(" ").trim()));
      return;
    }
    const id = this.selected;
    const old = this.pending.get(id);
    const request = old?.content === content && old.mode === mode ? old : { content, mode, requestId: randomUUID() };
    this.pending.set(id, request);
    this.sending.add(id);
    this.note = "Sending…";
    this.refresh();
    try {
      await this.remote.rpc.submitInput({ conversationId: id, content, whenBusy: mode, requestId: request.requestId }, { signal: this.remote.lifetime.signal });
      this.pending.delete(id);
      editor.addToHistory(content);
      this.note = "";
    } catch (error) {
      // Preserve the draft and request ID: retrying an uncertain send cannot duplicate it.
      editor.setText([content, editor.getExpandedText()].filter(Boolean).join("\n\n"));
      if (!this.stopped) this.error(error);
    } finally {
      this.sending.delete(id);
      this.refresh();
    }
  }

  private async command(name: string, argument = ""): Promise<void> {
    const id = this.selected;
    const signal = this.remote.lifetime.signal;
    if (name === "sidebar") return this.toggleSidebar();
    if (name === "quit") return this.onExit();
    if (name === "help") {
      const choice = await this.dialogs.choose("Commands", COMMANDS
        .filter(command => command.name !== "help").map(command => ({ value: command.name, label: `/${command.name}`, description: command.description })));
      if (choice) await this.command(choice);
      return;
    }
    if (name === "conversations" || name === "archived") {
      const archived = name === "archived";
      const choice = await this.dialogs.choose(archived ? "Archived" : "Conversations", this.directory
        .filter(info => info.archived === archived).sort((a, b) => Number(b.conversationId === this.rootId) - Number(a.conversationId === this.rootId))
        .map(info => ({ value: info.conversationId, label: info.name, description: info.conversationId === this.rootId ? "Chief of staff" : undefined })));
      if (choice) {
        if (archived) await this.remote.rpc.updateConversation({ conversationId: choice, archived: false }, { signal });
        this.select(choice);
      }
      return;
    }
    if (name === "new") {
      const cwd = await this.dialogs.folder(this.remote, argument || this.remote.state(id).snapshot?.status?.cwd || "");
      if (cwd === undefined) return;
      const title = await this.dialogs.ask("Conversation name", cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "Conversation");
      if (title === undefined) return;
      const result = await this.dialogs.wait("Creating conversation…", signal => this.remote.rpc.createConversation({ cwd, name: title }, { signal }));
      if (result) this.select(result.conversationId);
      return;
    }
    if (name === "rename") {
      const title = argument || await this.dialogs.ask("Conversation name", this.directory.find(info => info.conversationId === id)?.name);
      if (title !== undefined) await this.remote.rpc.updateConversation({ conversationId: id, name: title }, { signal });
      return;
    }
    if (name === "archive") {
      await this.remote.rpc.updateConversation({ conversationId: id, archived: true }, { signal });
      this.select(this.rootId);
      return;
    }
    if (name === "cwd" || name === "fork") {
      const cwd = argument || await this.dialogs.folder(this.remote, this.remote.state(id).snapshot?.status?.cwd || "");
      if (cwd === undefined) return;
      if (name === "cwd") {
        await this.remote.rpc.updateConversation({ conversationId: id, cwd }, { signal });
        this.note = "";
      } else {
        const latest = [...this.remote.state(id).entries.keys()].sort((a, b) => a - b).at(-1);
        const result = await this.dialogs.wait("Forking conversation…", signal => this.remote.rpc.forkConversation({ conversationId: id, entryId: latest === undefined ? undefined : String(latest), cwd }, { signal }));
        if (result) this.select(result.conversationId);
      }
      this.refresh();
      return;
    }
    if (name === "model") {
      const response = await this.dialogs.wait("Loading server models…", signal => this.remote.rpc.listModels({}, { signal }));
      if (!response) return;
      const selected = this.remote.state(id).snapshot?.status?.model;
      const choice = await this.dialogs.choose("Chat model", response.models.map((info, index) => ({
        value: String(index), label: `${selected?.provider === info.model?.provider && selected?.modelId === info.model?.modelId ? "✓ " : ""}${info.name}`,
        description: `${info.model?.provider}/${info.model?.modelId} · ${Math.round(info.contextWindow / 1_000)}k context`,
      })));
      if (choice !== undefined) await this.remote.rpc.updateConversation({ conversationId: id, model: response.models[Number(choice)].model }, { signal });
      return;
    }
    if (name === "queue") {
      const items = queuedInputs(this.remote.state(id));
      const choice = await this.dialogs.choose("Queued inputs", items.map(item => ({ value: item.id, label: item.content.slice(0, 200), description: item.mode === "steer" ? "steering" : "follow-up" })));
      const item = items.find(item => item.id === choice);
      if (item) await this.dialogs.editQueue(item, async change => {
        await this.remote.rpc.updateQueuedInput({
          conversationId: id, submissionId: item.id, expectedContent: item.content,
          expectedMode: item.mode === "steer" ? BusyBehavior.STEER : BusyBehavior.QUEUE, ...change,
        }, { signal });
      });
      return;
    }
    if (name === "tree") return this.tree(id);
    this.note = colors.error(`Unknown command /${clean(name)}`);
    this.tui.requestRender();
  }

  private async dequeue() {
    const id = this.selected;
    const editor = this.view(id).editor;
    const items = queuedInputs(this.remote.state(id));
    const restored: string[] = [];
    try {
      for (const item of items) {
        const result = await this.remote.rpc.updateQueuedInput({
          conversationId: id, submissionId: item.id, expectedContent: item.content,
          expectedMode: item.mode === "steer" ? BusyBehavior.STEER : BusyBehavior.QUEUE, remove: true,
        }, { signal: this.remote.lifetime.signal });
        restored.push(result.content);
      }
    } finally {
      if (restored.length) {
        this.pending.delete(id);
        editor.setText([...restored, editor.getExpandedText()].filter(Boolean).join("\n\n"));
        this.tui.requestRender();
      }
    }
  }

  private async tree(id: string) {
    const family = forkFamily(this.directory, id);
    const tree = await this.dialogs.wait("Loading history tree…", async signal => {
      const histories = new Map();
      for (const info of family) histories.set(info.conversationId, await this.remote.history(info.conversationId, signal));
      return historyTree(family, histories);
    });
    if (!tree) return;
    const choice = await this.dialogs.tree(tree.roots, `conversation:${id}`);
    if (!choice) return;
    const branch = tree.branches.get(choice);
    if (branch) {
      if (this.directory.find(info => info.conversationId === branch)?.archived) {
        await this.remote.rpc.updateConversation({ conversationId: branch, archived: false }, { signal: this.remote.lifetime.signal });
      }
      this.select(branch);
      return;
    }
    const entry = tree.entries.get(choice);
    if (!entry) return;
    const text = userText(entry);
    const at = text === undefined ? choice : tree.parents.get(choice);
    const result = await this.dialogs.wait("Forking selected history…", signal => this.remote.rpc.forkConversation({
      conversationId: String(entry.conversationId), entryId: at,
    }, { signal }));
    if (result) {
      this.select(result.conversationId);
      if (text !== undefined) this.editor.setText(clean(text));
      this.refresh();
    }
  }

  stop(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.dialogs.cancel();
    this.unfollow?.();
    this.closing = this.remote.close();
    this.tui.stop();
    return this.closing;
  }
}
