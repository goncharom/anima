import type { ConversationInfo } from "@anima/protocol-ts";
import { Container, ScrollView, VStack } from "@earendil-works/pi-tui";
import type { Graph } from "./client.ts";
import { button, clean, colors, line } from "./ui.ts";

export function workingConversations(graph: Graph): Set<string> {
  const busy = new Set<string>();
  for (const task of Object.values(graph.tasks)) {
    let current: typeof task | undefined = task;
    const seen = new Set<number>();
    let background = false;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.background) { background = true; break; }
      current = current.owner === undefined ? undefined : graph.tasks[String(current.owner)];
    }
    if (!background) busy.add(String(task.conversationId));
  }
  return busy;
}

type Actions = {
  select: (id: string) => void;
  collapse: () => void;
  command: (name: string) => void;
};

export class Sidebar extends VStack {
  private rows = new Container();
  private scroll = new ScrollView(this.rows, { overscroll: "contain" });
  private actions: Actions;
  private rootSelected = true;

  constructor(actions: Actions) {
    super();
    this.actions = actions;
    this.addChild(button(() => colors.accent("▾ Conversations"), actions.collapse), { basis: 1, shrink: 0 });
    this.addChild(button("＋ New conversation", () => actions.command("new")), { basis: 1, shrink: 0 });
    this.addChild(this.scroll, { basis: 0, grow: 1, minSize: 1 });
    for (const [label, command] of [
      ["Rename selected", "rename"], ["Change folder", "cwd"], ["Fork in folder", "fork"],
      ["Archive selected", "archive"], ["Archived…", "archived"], ["Help", "help"],
    ]) this.addChild(button(() => colors.muted(label), () => {
      if (command !== "archive" || !this.rootSelected) actions.command(command);
    }), { basis: 1, shrink: 0, visible: () => command !== "archive" || !this.rootSelected });
  }

  update(conversations: ConversationInfo[], rootId: string, selected: string, busy: Set<string>, connected: boolean) {
    this.rows.clear();
    this.rootSelected = selected === rootId;
    const visible = conversations.filter(info => !info.archived || info.conversationId === rootId)
      .sort((a, b) => Number(b.conversationId === rootId) - Number(a.conversationId === rootId) || a.name.localeCompare(b.name));
    for (const info of visible) {
      const id = info.conversationId;
      this.rows.addChild(button(() => {
        const dot = !connected ? colors.muted("○") : busy.has(id) ? colors.yellow("●") : colors.green("●");
        const name = `${id === rootId ? "⌂ " : info.ownerConversationId ? "↳ " : ""}${clean(info.name)}`;
        return `${id === selected ? colors.accent("›") : " "} ${dot} ${id === selected ? colors.accent(name) : name}`;
      }, () => this.actions.select(id)));
    }
    if (!visible.length) this.rows.addChild(line(colors.muted("Connecting…")));
  }
}
