import type { ConversationInfo } from "@anima/protocol-ts";
import type { Graph } from "./client.ts";
import { ConversationList, SidePanel } from "./panels.ts";
import { button, colors } from "./ui.ts";

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

export class Sidebar extends SidePanel {
  readonly list: ConversationList;
  constructor(actions: Actions) {
    super(() => "Conversations", () => actions.collapse(), actions.collapse);
    this.list = new ConversationList(actions.select, "No conversations yet");
    this.setBody(this.list);
    for (const [label, command] of [
      ["＋ New conversation", "new"], ["Rename selected", "rename"],
      ["Change folder", "cwd"], ["Archive selected", "archive"],
      ["Archived…", "archived"], ["Help", "help"],
    ]) this.addChild(button(() => colors.muted(label), () => actions.command(command)), { basis: 1, shrink: 0 });
  }
  update(conversations: ConversationInfo[], selected: string, busy: Set<string>, connected: boolean) {
    this.list.update(conversations.filter(info => !info.ownerConversationId && !info.archived), selected, busy, connected);
  }
}
