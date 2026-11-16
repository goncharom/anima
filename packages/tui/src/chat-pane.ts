import { randomUUID } from "node:crypto";
import { BusyBehavior, type ConversationSnapshot } from "@anima/protocol-ts";
import {
  CombinedAutocompleteProvider, Editor, getKeybindings, HStack, ScrollView, VStack,
  type SlashCommand, type TuiAltScreen, type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { RemoteClient, queuedInputs, type ConversationState } from "./client.ts";
import { Dialogs } from "./dialogs.ts";
import { Transcript } from "./transcript.ts";
import { button, clean, colors, editorTheme, line } from "./ui.ts";

export const COMMANDS: SlashCommand[] = [
  { name: "new", description: "New coordinator conversation in a server folder" },
  { name: "conversations", description: "Switch human conversation" },
  { name: "rename", description: "Rename this conversation" },
  { name: "archive", description: "Archive this conversation (work continues)" },
  { name: "archived", description: "Restore conversations (or this worker's sibling agents)" },
  { name: "cwd", description: "Change this conversation's folder while idle" },
  { name: "model", description: "Choose this conversation's chat model" },
  { name: "queue", description: "Edit queued steering/follow-up messages" },
  { name: "sidebar", description: "Toggle human conversations (F2)" },
  { name: "agents", description: "Toggle this coordinator's subagents (F3)" },
  { name: "resize", description: "Set panel width: /resize left|right columns" },
  { name: "help", description: "Show commands; F6 switches chat focus" },
  { name: "quit", description: "Disconnect; leave server/work running" },
];

class ChatEditor extends Editor {
  onKey?: (data: string) => boolean;
  onActivate?: () => void;
  override handleInput(data: string) {
    this.onActivate?.();
    if (!this.onKey?.(data)) super.handleInput(data);
  }
  override handleMouse(event: TuiMouseEvent) {
    if (event.type === "press" || event.type === "click") this.onActivate?.();
    return super.handleMouse(event);
  }
}

type Host = {
  title: () => string;
  activate: () => void;
  isActive: () => boolean;
  header: () => void;
  agents: () => void;
  command: (name: string, argument: string) => Promise<void>;
  archive: () => void;
  restoreFocus: () => void;
  exit: () => void;
};

/** The same conversation UI is mounted in the main workspace and the worker panel. */
export class ChatPane extends VStack {
  readonly id: string;
  readonly editor: ChatEditor;
  readonly dialogs: Dialogs;
  readonly scroll: ScrollView;
  private transcript: Transcript;
  private note = "";
  private ready = false;
  private connectionError = "";
  private unfollow?: () => void;
  private sending = false;
  private expanded = false;
  private pending?: { content: string; mode: BusyBehavior; requestId: string };
  private thinkingChange?: { snapshot?: ConversationSnapshot; saving: boolean };
  private disposed = false;

  private tui: TuiAltScreen;
  private remote: RemoteClient;
  private host: Host;

  constructor(tui: TuiAltScreen, remote: RemoteClient, id: string, host: Host) {
    super();
    this.tui = tui;
    this.remote = remote;
    this.host = host;
    this.id = id;
    this.editor = new ChatEditor(tui, editorTheme(), { paddingX: 1 });
    this.editor.onActivate = host.activate;
    this.editor.onKey = data => this.key(data);
    this.editor.onSubmit = text => void this.submit(text, BusyBehavior.STEER);
    const autocomplete = new CombinedAutocompleteProvider(COMMANDS, process.cwd(), null);
    this.editor.setAutocompleteProvider({
      triggerCharacters: ["/"],
      getSuggestions: (lines, row, col, options) => {
        const prefix = lines[row]?.slice(0, col) ?? "";
        return row === 0 && /^\/[\w-]*$/.test(prefix)
          ? autocomplete.getSuggestions(lines, row, col, options) : Promise.resolve(null);
      },
      applyCompletion: (...args) => autocomplete.applyCompletion(...args),
      shouldTriggerFileCompletion: () => false,
    });
    this.dialogs = new Dialogs(tui, host.restoreFocus, error => this.error(error));
    this.transcript = new Transcript(tui, () => void this.act(async () => {
      await remote.older(id);
      this.scroll.scrollToStart();
    }), host.activate);
    this.transcript.update(remote.state(id));
    this.scroll = new ScrollView(this.transcript, { follow: "end", overscroll: "contain" });
    // The renderer reads this public property each layout frame. A computed primary
    // keeps keyboard search/scroll on the active chat without replacing its scroll state.
    Object.defineProperty(this.scroll, "primary", { get: host.isActive });
    this.addChild(new HStack([
      { component: button(() => `${host.isActive() ? colors.accent("●") : colors.muted("○")} ${clean(host.title())}${this.queuedCount()}`, host.header), basis: 0, grow: 1 },
      { component: button(() => colors.accent(" Agents "), host.agents), basis: 8, shrink: 0 },
    ]), { basis: 1, shrink: 0 });
    this.addChild(this.scroll, { basis: 0, grow: 1, minSize: 1 });
    this.addChild(this.editor, { basis: "auto", shrink: 1, minSize: 3 });
    this.addChild(line(() => {
      const status = remote.state(id).snapshot?.status;
      return colors.muted(status ? `${clean(status.cwd)}${status.gitBranch ? ` · ${clean(status.gitBranch)}` : ""}` : "Waiting for server status…");
    }), { basis: 1, shrink: 0 });
    this.addChild(line(() => this.footer()), { basis: 1, shrink: 0 });
    this.addChild(line(() => this.notice()), { basis: 1, shrink: 0, visible: () => Boolean(this.notice()) });
  }

  follow() {
    if (this.unfollow || this.disposed) return;
    this.ready = false;
    this.unfollow = this.remote.follow(this.id, (ready, error) => {
      if (this.disposed) return;
      this.ready = ready;
      this.connectionError = ready ? "" : clean(error instanceof Error ? error.message : String(error ?? ""));
      this.tui.requestRender();
    });
  }
  detach() {
    this.unfollow?.();
    this.unfollow = undefined;
    this.ready = false;
  }
  update(state: ConversationState) {
    if (this.disposed) return;
    if (this.thinkingChange?.saving === false && state.snapshot !== this.thinkingChange.snapshot) this.thinkingChange = undefined;
    this.transcript.update(state);
    this.tui.requestRender();
  }
  private queuedCount() {
    const count = queuedInputs(this.remote.state(this.id)).length;
    return count ? colors.yellow(` · ${count} queued`) : "";
  }
  private footer() {
    const status = this.remote.state(this.id).snapshot?.status;
    if (!status) return colors.muted("Waiting for server status…");
    const context = status.contextWindow ? `~${(status.contextTokens / status.contextWindow * 100).toFixed(1)}% context` : "context —";
    const thinking = status.thinkingLevel !== undefined && status.supportedThinkingLevels.some(level => level !== "off")
      ? ` · thinking ${clean(status.thinkingLevel)} (Shift+Tab)` : "";
    return colors.muted(`${context} | ${status.model ? `${clean(status.model.provider)}/${clean(status.model.modelId)}` : "no model"}${thinking}`);
  }
  private notice() { return this.ready ? this.note : colors.yellow(`Reconnecting…${this.connectionError ? ` ${this.connectionError}` : ""}`); }
  error(error: unknown) {
    if (this.disposed) return;
    this.note = colors.error(clean(error instanceof Error ? error.message : String(error)));
    this.tui.requestRender();
  }
  async act(action: () => Promise<unknown>) {
    try { if (!this.disposed) await action(); }
    catch (error) { this.error(error); }
    finally { this.tui.requestRender(); }
  }
  private key(data: string) {
    const kb = getKeybindings();
    if (kb.matches(data, "app.interrupt")) {
      if (this.editor.isShowingAutocomplete()) return false;
      void this.act(async () => {
        await this.remote.rpc.abortConversation({ conversationId: this.id }, { signal: this.remote.lifetime.signal });
        this.pending = undefined;
        this.note = "";
      });
    } else if (kb.matches(data, "app.clear")) {
      if (this.editor.getText()) this.editor.setText("");
      else this.host.exit();
    } else if (kb.matches(data, "app.exit") && !this.editor.getText()) this.host.exit();
    else if (kb.matches(data, "app.model.select")) void this.act(() => this.command("model"));
    else if (kb.matches(data, "app.thinking.cycle")) void this.act(() => this.cycleThinking());
    else if (kb.matches(data, "app.tools.expand")) {
      this.expanded = !this.expanded;
      this.transcript.expand(this.expanded);
    } else if (kb.matches(data, "app.message.followUp")) {
      const content = this.editor.getExpandedText();
      if (!this.sending && content.trim()) {
        this.editor.setText("");
        void this.submit(content, BusyBehavior.QUEUE);
      }
    } else if (kb.matches(data, "app.message.dequeue")) void this.act(() => this.dequeue());
    else return false;
    this.tui.requestRender();
    return true;
  }
  private async cycleThinking() {
    if (this.thinkingChange) return;
    const status = this.remote.state(this.id).snapshot?.status;
    const levels = status?.supportedThinkingLevels ?? [];
    if (!status || status.thinkingLevel === undefined || !levels.length) { this.note = "Thinking controls unavailable."; return; }
    if (!levels.some(level => level !== "off")) { this.note = "Current model does not support thinking."; return; }
    const level = levels[(levels.indexOf(status.thinkingLevel) + 1) % levels.length];
    const change = { snapshot: this.remote.state(this.id).snapshot, saving: true };
    this.thinkingChange = change;
    try {
      await this.remote.rpc.updateConversation({ conversationId: this.id, thinkingLevel: level }, { signal: this.remote.lifetime.signal });
      change.snapshot = this.remote.state(this.id).snapshot;
      change.saving = false;
      const current = change.snapshot?.status;
      if (current?.thinkingLevel === level || current?.model?.provider !== status.model?.provider
        || current?.model?.modelId !== status.model?.modelId) this.thinkingChange = undefined;
      this.note = "";
    } catch (error) { this.thinkingChange = undefined; throw error; }
  }
  private async submit(content: string, mode: BusyBehavior) {
    if (!content.trim() || this.sending) return;
    if (content.startsWith("/")) {
      const [name, ...rest] = content.slice(1).split(" ");
      this.editor.addToHistory(content);
      await this.act(() => this.host.command(name, rest.join(" ").trim()));
      return;
    }
    const old = this.pending;
    const request = old?.content === content && old.mode === mode ? old : { content, mode, requestId: randomUUID() };
    this.pending = request;
    this.sending = this.editor.disableSubmit = true;
    this.note = "Sending…";
    this.tui.requestRender();
    try {
      await this.remote.rpc.submitInput({ conversationId: this.id, content, whenBusy: mode, requestId: request.requestId }, { signal: this.remote.lifetime.signal });
      this.pending = undefined;
      this.editor.addToHistory(content);
      this.note = "";
    } catch (error) {
      this.editor.setText([content, this.editor.getExpandedText()].filter(Boolean).join("\n\n"));
      this.error(error);
    } finally {
      this.sending = this.editor.disableSubmit = false;
      this.tui.requestRender();
    }
  }

  /** Local commands always capture this pane's ID, including across asynchronous dialogs. */
  async command(name: string, argument = ""): Promise<void> {
    const signal = this.remote.lifetime.signal;
    if (name === "rename") {
      const title = argument || await this.dialogs.ask("Conversation name", this.host.title());
      if (title !== undefined) await this.remote.rpc.updateConversation({ conversationId: this.id, name: title }, { signal });
    } else if (name === "archive") {
      await this.remote.rpc.updateConversation({ conversationId: this.id, archived: true }, { signal });
      this.host.archive();
    } else if (name === "cwd") {
      const cwd = argument || await this.dialogs.folder(this.remote, this.remote.state(this.id).snapshot?.status?.cwd || "");
      if (cwd !== undefined) await this.remote.rpc.updateConversation({ conversationId: this.id, cwd }, { signal });
    } else if (name === "model") {
      const response = await this.dialogs.wait("Loading server models…", signal => this.remote.rpc.listModels({}, { signal }));
      if (!response) return;
      const selected = this.remote.state(this.id).snapshot?.status?.model;
      const choice = await this.dialogs.choose("Chat model", response.models.map((info, index) => ({
        value: String(index), label: `${selected?.provider === info.model?.provider && selected?.modelId === info.model?.modelId ? "✓ " : ""}${info.name}`,
        description: `${info.model?.provider}/${info.model?.modelId} · ${Math.round(info.contextWindow / 1_000)}k context`,
      })));
      if (choice !== undefined) await this.remote.rpc.updateConversation({ conversationId: this.id, model: response.models[Number(choice)].model }, { signal });
    } else if (name === "queue") {
      const items = queuedInputs(this.remote.state(this.id));
      const choice = await this.dialogs.choose("Queued inputs", items.map(item => ({ value: item.id, label: item.content.slice(0, 200), description: item.mode === "steer" ? "steering" : "follow-up" })));
      const item = items.find(item => item.id === choice);
      if (item) await this.dialogs.editQueue(item, async change => {
        await this.remote.rpc.updateQueuedInput({
          conversationId: this.id, submissionId: item.id, expectedContent: item.content,
          expectedMode: item.mode === "steer" ? BusyBehavior.STEER : BusyBehavior.QUEUE, ...change,
        }, { signal });
      });
    } else throw new Error(`Unknown command /${clean(name)}`);
  }
  private async dequeue() {
    const restored: string[] = [];
    try {
      for (const item of queuedInputs(this.remote.state(this.id))) {
        const result = await this.remote.rpc.updateQueuedInput({
          conversationId: this.id, submissionId: item.id, expectedContent: item.content,
          expectedMode: item.mode === "steer" ? BusyBehavior.STEER : BusyBehavior.QUEUE, remove: true,
        }, { signal: this.remote.lifetime.signal });
        restored.push(result.content);
      }
    } finally {
      if (restored.length) {
        this.pending = undefined;
        this.editor.setText([...restored, this.editor.getExpandedText()].filter(Boolean).join("\n\n"));
      }
    }
  }
  dispose() {
    this.disposed = true;
    this.dialogs.cancel();
    this.detach();
  }
}
