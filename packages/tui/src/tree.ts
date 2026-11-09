import type { ConversationInfo } from "@anima/protocol-ts";
import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { Entry } from "./client.ts";
import { contentText, userText } from "./transcript.ts";
import { clean, cleanData } from "./ui.ts";

/** Fork ancestry is a history relationship; subagent ownership is not. */
export function forkFamily(directory: ConversationInfo[], selected: string): ConversationInfo[] {
  const byId = new Map(directory.map(info => [info.conversationId, info]));
  const ancestor = (id: string) => {
    const seen = new Set<string>();
    while (!seen.has(id)) {
      seen.add(id);
      const parent = byId.get(id)?.parentConversationId;
      if (!parent) break;
      id = parent;
    }
    return id;
  };
  const root = ancestor(selected);
  return directory.filter(info => ancestor(info.conversationId) === root);
}

/** Presentation-only conversion. All branching is still performed by the server. */
export function historyTree(directory: ConversationInfo[], histories: Map<string, Entry[]>) {
  const nodes = new Map<string, SessionTreeNode>();
  const entries = new Map<string, Entry>();
  const parents = new Map<string, string | undefined>();
  const branches = new Map<string, string>();
  for (const history of histories.values()) {
    let previous: string | undefined;
    for (const entry of history) {
      const id = String(entry.id);
      if (!nodes.has(id)) {
        entries.set(id, entry);
        parents.set(id, previous);
        nodes.set(id, { entry: presentationEntry(entry, previous), children: [] });
      }
      previous = id;
    }
  }
  for (const info of directory) {
    const key = `conversation:${info.conversationId}`;
    const parentId = histories.get(info.conversationId)?.at(-1)?.id;
    nodes.set(key, {
      entry: {
        type: "custom_message", id: key, parentId: parentId === undefined ? null : String(parentId), timestamp: "",
        customType: "conversation", content: clean(info.name), display: true,
      },
      label: clean(info.name) + (info.archived ? " (archived)" : ""), children: [],
    });
    branches.set(key, info.conversationId);
  }
  const roots: SessionTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.entry.parentId === null ? undefined : nodes.get(node.entry.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return { roots, entries, parents, branches };
}

function presentationEntry(entry: Entry, previous?: string): SessionEntry {
  const message = entry.model?.find(message => message.role !== "system");
  const base = { id: String(entry.id), parentId: previous ?? null, timestamp: new Date(entry.model?.[0]?.timestamp ?? 0).toISOString() };
  const user = userText(entry);
  if (user !== undefined) return {
    ...base, type: "message", message: { role: "user", content: clean(user), timestamp: message?.timestamp ?? 0 },
  };
  if (message && message.role !== "user") return { ...base, type: "message", message: cleanData(message) };
  if (!message) return { ...base, type: "custom", customType: entry.kind, data: cleanData(entry.data ?? entry.model ?? {}) };
  const content = contentText(message.content);
  return {
    ...base, type: "custom_message", customType: entry.kind,
    content: `${entry.kind}: ${clean(content)}`, display: true,
  };
}
