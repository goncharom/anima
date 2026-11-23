import { ScheduleAction, ScheduleStatus, type ConversationInfo } from "@anima/protocol-ts";
import { getKeybindings, HStack, isKeyRelease, isKeyRepeat, matchesKey, VStack, type TuiAltScreen } from "@earendil-works/pi-tui";
import { ChatPane, COMMANDS } from "./chat-pane.ts";
import { RemoteClient, type Graph } from "./client.ts";
import { Dialogs } from "./dialogs.ts";
import { ConversationList, SidePanel, Workspace } from "./panels.ts";
import { Sidebar, workingConversations } from "./sidebar.ts";
import { button, clean, colors, line } from "./ui.ts";

function scheduleStatus(status: ScheduleStatus): string {
  switch (status) {
    case ScheduleStatus.PENDING: return "Pending approval";
    case ScheduleStatus.ACTIVE: return "Active";
    case ScheduleStatus.CANCELLED: return "Cancelled";
    case ScheduleStatus.FAILED: return "Failed";
    default: return "Unknown";
  }
}

/** Workspace navigation is separate from the conversation-bound chat controllers. */
export class App {
  readonly remote: RemoteClient;
  private tui: TuiAltScreen;
  private sidebar: Sidebar;
  private agents: SidePanel;
  private agentList: ConversationList;
  private workspace: Workspace;
  private main = new VStack();
  private dialogs: Dialogs;
  private panes = new Map<string, ChatPane>();
  private selected = "";
  private worker = "";
  private rememberedWorkers = new Map<string, string>();
  private active?: ChatPane;
  private directory: ConversationInfo[] = [];
  private busy = new Set<string>();
  private connections = new Set<string>();
  private connectionError = "";
  private hideThinking = false;
  private note = "";
  private stopped = false;
  private closing?: Promise<void>;
  private removeKeys: () => void;
  onExit: () => void = () => { void this.stop(); };

  constructor(tui: TuiAltScreen, serverUrl: string) {
    this.tui = tui;
    this.remote = new RemoteClient(serverUrl);
    this.dialogs = new Dialogs(tui, () => this.restoreFocus(this.active), error => this.error(error));
    this.sidebar = new Sidebar({
      collapse: () => this.toggleLeft(), select: id => this.selectHuman(id),
      command: name => void this.act(() => this.command(this.mainPane(), name)),
    });
    this.agentList = new ConversationList(id => this.selectWorker(id), "No subagents yet", true);
    this.agents = new SidePanel(
      () => this.worker ? "‹ Subagents" : `Subagents (${this.workers().length})`,
      () => this.showAgentList(), () => this.toggleAgents(),
    );
    this.agents.setBody(this.agentList);
    this.agents.addChild(button(() => colors.muted("Archived agents…"), () => void this.act(() => this.restoreWorker(this.selected))), { basis: 1, shrink: 0 });
    this.agents.addChild(line(() => this.notice()), { basis: 1, shrink: 0, visible: () => Boolean(this.notice()) });
    this.workspace = new Workspace(this.sidebar, this.main, this.agents, () => tui.terminal.rows, () => this.refresh());
    tui.setLayoutRoot(this.workspace);
    this.removeKeys = tui.addInputListener(data => {
      if (tui.hasOverlay()) return;
      if (getKeybindings().matches(data, "app.thinking.toggle")) {
        if (!isKeyRelease(data) && !isKeyRepeat(data)) {
          this.hideThinking = !this.hideThinking;
          for (const pane of this.panes.values()) pane.setHideThinking(this.hideThinking);
        }
      } else if (matchesKey(data, "f2")) this.toggleLeft();
      else if (matchesKey(data, "f3")) this.toggleAgents();
      else if (matchesKey(data, "f6")) this.cycleFocus();
      else if (matchesKey(data, "escape") && tui.getFocusedComponent() === this.agentList) this.toggleAgents();
      else if (!this.isEditorFocused() && (matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d"))) this.onExit();
      else if (!this.selected && (data === "n" || matchesKey(data, "ctrl+n"))) void this.act(() => this.command(undefined, "new"));
      else return;
      return { consume: true };
    });
    this.remote.onChange = state => this.panes.get(state.id)?.update(state);
    this.mountMain();
    this.refresh();
  }

  start() {
    this.tui.start();
    this.remote.watch(signal => this.remote.rpc.watchConversations({}, { signal }), value => {
      if (this.stopped) return;
      this.directory = value.conversations;
      const selected = this.directory.find(info => info.conversationId === this.selected);
      if (!this.selected || selected?.archived || selected?.ownerConversationId) {
        this.selectHuman(this.humans()[0]?.conversationId ?? "");
      }
      if (this.worker && !this.workers().some(info => info.conversationId === this.worker)) this.showAgentList(false);
      this.refresh();
    }, (ready, error) => this.connection("directory", ready, error));
    this.remote.watch(signal => this.remote.rpc.watchTaskGraph({}, { signal }), value => {
      this.busy = workingConversations((value.graph ?? { tasks: {} }) as unknown as Graph);
      this.refresh();
    }, (ready, error) => this.connection("tasks", ready, error));
  }

  private humans(archived = false) { return this.directory.filter(info => !info.ownerConversationId && info.archived === archived); }
  private workers() { return this.directory.filter(info => info.ownerConversationId === this.selected && !info.archived); }
  private mainPane() { return this.panes.get(this.selected); }
  private workerPane() { return this.panes.get(this.worker); }
  private isEditorFocused() { return [...this.panes.values()].some(pane => this.tui.getFocusedComponent() === pane.editor); }

  private pane(id: string): ChatPane {
    let pane = this.panes.get(id);
    if (!pane) {
      pane = new ChatPane(this.tui, this.remote, id, {
        title: () => this.directory.find(info => info.conversationId === id)?.name ?? "Conversation",
        activate: () => this.focus(this.panes.get(id)),
        isActive: () => this.active?.id === id,
        header: () => id === this.selected ? this.toggleLeft() : this.showAgentList(),
        agents: () => id === this.selected ? this.toggleAgents() : this.showAgentList(),
        command: (name, argument) => this.command(this.panes.get(id), name, argument),
        archive: () => this.archived(id),
        restoreFocus: () => this.restoreFocus(this.panes.get(id)),
        exit: () => this.onExit(),
      });
      pane.setHideThinking(this.hideThinking);
      this.panes.set(id, pane);
    }
    return pane;
  }
  private activate(pane?: ChatPane) {
    if (this.active === pane) return;
    this.active = pane;
    this.tui.requestRender();
  }
  private focus(pane?: ChatPane) {
    this.activate(pane);
    const target = pane?.editor ?? null;
    if (this.tui.getFocusedComponent() !== target) this.tui.setFocus(target);
    this.tui.requestRender();
  }
  private restoreFocus(origin?: ChatPane) {
    if (this.stopped) return;
    const visible = origin?.id === this.selected && !this.workspace.isDrawer(this.tui.terminal.columns)
      || origin?.id === this.worker && this.workspace.rightOpen;
    if (visible) this.focus(origin);
    else if (this.workspace.isDrawer(this.tui.terminal.columns)) this.focusAgents();
    else this.focus(this.mainPane());
  }
  private cancelDialogs() {
    this.dialogs.cancel();
    for (const pane of this.panes.values()) pane.dialogs.cancel();
  }
  private selectHuman(id: string) {
    if (this.stopped) return;
    const info = this.directory.find(info => info.conversationId === id);
    if (info?.ownerConversationId || info?.archived) return;
    if (id !== this.selected) {
      this.cancelDialogs();
      this.mainPane()?.detach();
      this.workerPane()?.detach();
      this.selected = id;
      const remembered = this.rememberedWorkers.get(id);
      this.worker = this.workers().some(info => info.conversationId === remembered) ? remembered! : "";
      this.mountMain();
    }
    this.refresh();
    if (this.workspace.isDrawer(this.tui.terminal.columns)) this.focusAgents();
    else this.focus(this.mainPane());
  }
  private selectWorker(id: string) {
    if (!this.workers().some(info => info.conversationId === id)) return;
    this.cancelDialogs();
    this.workerPane()?.detach();
    this.worker = id;
    this.rememberedWorkers.set(this.selected, id);
    this.workspace.rightOpen = true;
    this.refresh();
    this.focus(this.workerPane());
  }
  private showAgentList(focus = true) {
    const returnFocus = focus || this.active?.id === this.worker;
    this.cancelDialogs();
    this.workerPane()?.detach();
    this.worker = "";
    this.agents.setBody(this.agentList);
    this.refresh();
    if (returnFocus) {
      if (this.workspace.rightOpen) this.focusAgents();
      else this.focus(this.mainPane());
    }
  }
  private focusAgents() {
    if (this.worker) this.focus(this.workerPane());
    else { this.activate(undefined); this.tui.setFocus(this.agentList); this.tui.requestRender(); }
  }
  private mountMain() {
    this.main.clear();
    this.main.addChild(new HStack([
      { component: button(() => colors.accent("☰ Conversations"), () => void this.act(() => this.command(this.mainPane(), "conversations"))), basis: 0, grow: 1 },
      { component: button(() => colors.accent(`Subagents ${this.workers().length} ▸`), () => this.toggleAgents()), basis: 16, shrink: 0 },
    ]), { basis: 1, shrink: 0 });
    if (this.selected) this.main.addChild(this.pane(this.selected), { basis: 0, grow: 1, minSize: 1 });
    else {
      this.main.addChild(line(""), { basis: 0, grow: 1 });
      this.main.addChild(line(colors.muted("Create a conversation to get started.")), { basis: 1 });
      this.main.addChild(button(() => colors.accent("＋ New conversation (N)"), () => void this.act(() => this.command(undefined, "new"))), { basis: 1 });
      this.main.addChild(button("Archived conversations…", () => void this.act(() => this.command(undefined, "archived"))), { basis: 1 });
      this.main.addChild(button("Schedules…", () => void this.act(() => this.command(undefined, "schedules"))), { basis: 1 });
      this.main.addChild(line(""), { basis: 0, grow: 1 });
    }
    this.main.addChild(line(() => this.notice()), { basis: 1, shrink: 0, visible: () => Boolean(this.notice()) });
  }
  private toggleLeft() { this.workspace.leftOpen = !this.workspace.leftOpen; this.refresh(); }
  private toggleAgents() {
    this.cancelDialogs();
    this.workspace.rightOpen = !this.workspace.rightOpen;
    this.refresh();
    if (this.workspace.rightOpen) this.focusAgents();
    else this.focus(this.mainPane());
  }
  private cycleFocus() {
    if (this.workspace.isDrawer(this.tui.terminal.columns)) { this.toggleAgents(); return; }
    if (this.workspace.rightOpen && this.active === this.mainPane()) this.focusAgents();
    else this.focus(this.mainPane());
  }
  private archived(id: string) {
    this.directory = this.directory.map(info => info.conversationId === id ? { ...info, archived: true } : info);
    if (this.selected === id) this.selectHuman(this.humans()[0]?.conversationId ?? "");
    else if (this.worker === id) this.showAgentList();
    this.refresh();
  }
  private connection(name: string, ready: boolean, error?: unknown) {
    if (this.stopped) return;
    if (ready) this.connections.add(name);
    else {
      this.connections.delete(name);
      if (error) this.connectionError = clean(error instanceof Error ? error.message : String(error));
    }
    if (this.connections.size === 2) this.connectionError = "";
    this.refresh();
  }
  private notice() {
    return this.connections.size < 2 ? colors.yellow(`Reconnecting… ${this.connectionError}`) : this.note;
  }
  private refresh() {
    if (this.stopped) return;
    this.sidebar.update(this.directory, this.selected, this.busy, this.connections.size === 2);
    this.agentList.update(this.workers(), this.worker, this.busy, this.connections.size === 2);
    this.mainPane()?.follow();
    if (this.worker) {
      const pane = this.pane(this.worker);
      this.agents.setBody(pane);
      if (this.workspace.rightOpen) pane.follow();
      else pane.detach();
    } else this.agents.setBody(this.agentList);
    // A terminal resize can hide the focused main chat. Never type into an invisible editor.
    if (!this.tui.hasOverlay() && this.workspace.isDrawer(this.tui.terminal.columns) && this.active === this.mainPane()) this.focusAgents();
    this.tui.requestRender();
  }
  private async restoreWorker(ownerId: string, dialogs = this.dialogs) {
    const choice = await dialogs.choose("Archived subagents", this.directory
      .filter(info => info.ownerConversationId === ownerId && info.archived)
      .map(info => ({ value: info.conversationId, label: info.name })));
    if (!choice || this.stopped) return;
    await this.remote.rpc.updateConversation({ conversationId: choice, archived: false }, { signal: this.remote.lifetime.signal });
    this.directory = this.directory.map(info => info.conversationId === choice ? { ...info, archived: false } : info);
    if (this.selected === ownerId) this.selectWorker(choice);
  }
  private error(error: unknown) {
    if (this.stopped) return;
    this.note = colors.error(clean(error instanceof Error ? error.message : String(error)));
    this.tui.requestRender();
  }
  private async act(action: () => Promise<unknown>) {
    try { if (!this.stopped) await action(); }
    catch (error) { this.error(error); }
    finally { this.refresh(); }
  }

  private async schedules(dialogs: Dialogs) {
    while (!this.stopped) {
      const response = await dialogs.wait("Loading schedules…", signal => this.remote.rpc.listSchedules({}, { signal }));
      if (!response) return;
      const id = await dialogs.choose(response.schedules.length === 0 ? "Schedules · No jobs yet" : "Schedules", response.schedules.map(job => ({
        value: job.scheduleId,
        label: job.name,
        description: `${scheduleStatus(job.status)} · ${job.cron} · ${job.timezone}`,
      })));
      const job = response.schedules.find(candidate => candidate.scheduleId === id);
      if (!job) return;
      const actions: { key: "a" | "c" | "o"; label: string }[] = [];
      if (job.status === ScheduleStatus.PENDING) actions.push({ key: "a", label: "Approve and start schedule" });
      if (job.status === ScheduleStatus.PENDING || job.status === ScheduleStatus.ACTIVE) {
        actions.push({ key: "c", label: job.status === ScheduleStatus.PENDING ? "Reject proposal" : "Cancel future runs" });
      }
      if (job.conversationId && this.humans().some(info => info.conversationId === job.conversationId)) {
        actions.push({ key: "o", label: "Open job conversation" });
      }
      const detail = [
        job.name,
        `${scheduleStatus(job.status)} · ${job.cron} · ${job.timezone}`,
        ...(job.nextRunAt ? [`Next run (UTC): ${job.nextRunAt}`] : []),
        ...(job.error ? [`Error: ${job.error}`] : []),
        "", "Allowed tools:", ...(job.tools.length ? job.tools : ["None"]),
        "", "Instruction:", job.instruction,
      ].join("\n");
      const choice = await dialogs.review("Schedule details", detail, actions);
      if (!choice) return;
      if (choice === "o" && job.conversationId) return this.selectHuman(job.conversationId);
      const action = choice === "a" ? ScheduleAction.APPROVE : ScheduleAction.CANCEL;
      const updated = await dialogs.wait(choice === "a" ? "Approving…" : "Cancelling…", signal =>
        this.remote.rpc.updateSchedule({ scheduleId: job.scheduleId, action }, { signal }));
      if (!updated) return;
    }
  }

  private async command(origin: ChatPane | undefined, name: string, argument = ""): Promise<void> {
    const dialogs = origin?.dialogs ?? this.dialogs;
    const signal = this.remote.lifetime.signal;
    if (name === "sidebar") return this.toggleLeft();
    if (name === "agents") return this.toggleAgents();
    if (name === "quit") return this.onExit();
    if (name === "schedules") return this.schedules(dialogs);
    if (name === "resize") {
      const [side, columns] = argument.split(/\s+/);
      const width = Number(columns);
      if ((side !== "left" && side !== "right") || !Number.isFinite(width) || width < 1) throw new Error("Usage: /resize left|right columns");
      this.workspace.setWidth(side, Math.min(width, this.tui.terminal.columns));
      this.refresh();
      return;
    }
    if (name === "help") {
      const choice = await dialogs.choose("Commands · F2 left · F3 agents · F6 chat focus", COMMANDS.filter(command => command.name !== "help")
        .map(command => ({ value: command.name, label: `/${command.name}`, description: command.description })));
      if (choice) await this.command(origin, choice);
      return;
    }
    if (name === "conversations" || name === "archived") {
      const ownerId = this.directory.find(info => info.conversationId === origin?.id)?.ownerConversationId;
      if (name === "archived" && ownerId) return this.restoreWorker(ownerId, dialogs);
      const archived = name === "archived";
      const choice = await dialogs.choose(archived ? "Archived conversations" : "Conversations", this.humans(archived)
        .map(info => ({ value: info.conversationId, label: info.name })));
      if (choice) {
        if (archived) {
          await this.remote.rpc.updateConversation({ conversationId: choice, archived: false }, { signal });
          this.directory = this.directory.map(info => info.conversationId === choice ? { ...info, archived: false } : info);
        }
        this.selectHuman(choice);
      }
      return;
    }
    if (name === "new") {
      const cwd = await dialogs.folder(this.remote, argument || (origin ? this.remote.state(origin.id).snapshot?.status?.cwd : "") || "");
      if (cwd === undefined || this.stopped) return;
      const title = await dialogs.ask("Conversation name", cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "Conversation");
      if (title === undefined || this.stopped) return;
      const result = await dialogs.wait("Creating conversation…", signal => this.remote.rpc.createConversation({ cwd, name: title }, { signal }));
      if (result && !this.stopped) this.selectHuman(result.conversationId);
      return;
    }
    if (!origin) throw new Error("Create or select a conversation first.");
    await origin.command(name, argument);
  }

  stop(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.removeKeys();
    this.dialogs.cancel();
    for (const pane of this.panes.values()) pane.dispose();
    this.closing = this.remote.close();
    this.tui.stop();
    return this.closing;
  }
}
