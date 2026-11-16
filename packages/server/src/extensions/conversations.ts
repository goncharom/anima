// Conversation management is server policy; execution/history remain Durable's responsibility.
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { BusyBehavior, type UpdateConversationRequest, type UpdateQueuedInputRequest } from "@anima/protocol-ts";
import { Code, ConnectError } from "@connectrpc/connect";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Models } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  configure, defineDoc, InboxDoc, LiveDoc,
  type Conversation, type ConversationId, type ConversationRecord, type ContextView,
  type Cursor, type Harness, type TaskRecord, type Tx,
} from "@earendil-works/pi-durable";
import { FileError, getOrThrow } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

export type ConversationInfo = {
  conversationId: string;
  name: string;
  archived: boolean;
  parentConversationId?: string;
  forkEntryId?: string;
  ownerConversationId?: string;
};

/** Only display metadata and immutable ancestry, never a second copy of runtime state. */
export const ConversationsDoc = defineDoc<{ conversations: Record<string, ConversationInfo> }>({
  kind: "anima.conversations", version: 1, scope: "session",
  initial: () => ({ conversations: {} }), checkpointWhen: () => false,
});

export async function registerConversation(tx: Tx, conversation: ConversationRecord) {
  const directory = await tx.doc(ConversationsDoc);
  directory.conversations[String(conversation.id)] ??= {
    conversationId: String(conversation.id), name: `Conversation ${conversation.id}`, archived: false,
    ...(conversation.parent ? {
      parentConversationId: String(conversation.parent.conversationId), forkEntryId: String(conversation.parent.at),
    } : {}),
    ...(conversation.owner ? { ownerConversationId: String(conversation.owner.conversationId) } : {}),
  };
  return directory.conversations[String(conversation.id)];
}

export function displayName(name: string): string {
  name = name.trim();
  if (!name || name.length > 200 || /[\x00-\x1f\x7f-\x9f]/.test(name)) {
    throw new ConnectError("Name must be 1–200 characters without control characters", Code.InvalidArgument);
  }
  return name;
}

export async function backfillConversations(tx: Tx, rootId: ConversationId, names: Map<ConversationId, string>) {
  const directory = await tx.doc(ConversationsDoc);
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanConversations({}, 100, cursor);
    for (const conversation of page.items) {
      const missing = directory.conversations[String(conversation.id)] === undefined;
      const info = await registerConversation(tx, conversation);
      if (missing) {
        info.name = conversation.id === rootId ? "Chief of staff" : names.get(conversation.id) ?? info.name;
      }
      if (conversation.id === rootId) info.archived = false;
    }
    cursor = page.next;
  } while (cursor !== undefined);
}

/** Same server filesystem/environment as coding tools. */
export async function directoryPath(path: string, context: Context): Promise<string> {
  const env = new NodeExecutionEnv({ cwd: process.cwd() });
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
  try {
    const canonical = getOrThrow(await env.canonicalPath(expanded || process.cwd(), context));
    if (getOrThrow(await env.fileInfo(canonical, context)).kind !== "directory") {
      throw new ConnectError("Path is not a directory", Code.InvalidArgument);
    }
    return canonical;
  } catch (error) {
    throw fileError(error);
  }
}

export async function listDirectories(path: string, offset: number, context: Context) {
  path = await directoryPath(path, context);
  if (offset > 1_000_000) throw new ConnectError("Directory offset is too large", Code.InvalidArgument);
  const env = new NodeExecutionEnv({ cwd: path });
  const opened = await env.openDirReader(path, context);
  if (!opened.ok) throw fileError(opened.error);
  const reader = opened.value;
  const directories: { name: string; path: string }[] = [];
  let visited = 0;
  let done = false;
  try {
    while (!done && visited < offset) {
      const page = getOrThrow(await reader.next(Math.min(256, offset - visited), context));
      visited += page.entries.length;
      done = page.done;
    }
    // Bound both directory results and scans of directories containing mostly files.
    while (!done && directories.length < 200 && visited - offset < 2_000) {
      const page = getOrThrow(await reader.next(Math.min(200 - directories.length, 256), context));
      visited += page.entries.length;
      done = page.done;
      for (const entry of page.entries) {
        let directory = entry.kind === "directory";
        if (entry.kind === "symlink") {
          const canonical = await env.canonicalPath(entry.path, context);
          const info = canonical.ok ? await env.fileInfo(canonical.value, context) : undefined;
          directory = info?.ok === true && info.value.kind === "directory";
        }
        if (directory) directories.push({ name: entry.name, path: entry.path });
      }
    }
    directories.sort((a, b) => a.name.localeCompare(b.name));
    return { path, parent: dirname(path), directories, nextOffset: done ? undefined : visited };
  } catch (error) {
    throw fileError(error);
  } finally {
    await reader.close(context);
  }
}

function fileError(error: unknown) {
  if (!(error instanceof FileError)) return error;
  const code = error.code === "not_found" ? Code.NotFound : error.code === "permission_denied" ? Code.PermissionDenied
    : error.code === "aborted" ? Code.Canceled : Code.InvalidArgument;
  return new ConnectError(error.message, code);
}

export async function updateConversation(
  conversation: Conversation, rootId: ConversationId,
  request: UpdateConversationRequest, models: Models | undefined, context: Context,
) {
  const name = request.name === undefined ? undefined : displayName(request.name);
  if (request.archived && conversation.id === rootId) {
    throw new ConnectError("The chief of staff cannot be archived", Code.FailedPrecondition);
  }
  const cwd = request.cwd === undefined ? undefined : await directoryPath(request.cwd, context);
  if (request.model) {
    if (!models) throw new ConnectError("The server model catalog is unavailable", Code.FailedPrecondition);
    const available = await models.getAvailableOfType("chat", request.model.provider);
    if (!available.some(model => model.id === request.model!.modelId && model.provider === request.model!.provider)) {
      throw new ConnectError("Chat model is not available on this server", Code.InvalidArgument);
    }
  }
  await conversation.commit(async tx => {
    if (cwd !== undefined) await requireIdle(tx, conversation.id);
    const info = (await tx.doc(ConversationsDoc)).conversations[String(conversation.id)];
    if (name !== undefined) info.name = name;
    if (request.archived !== undefined) info.archived = request.archived;
    await configure(tx, conversation.id, {
      cwd, model: request.model && { provider: request.model.provider, modelId: request.model.modelId },
    });
  }, context);
}

/** These Anima tasks can deliver input even before it has reached pi.inbox. */
export function targetsConversation(task: TaskRecord<JsonValue, JsonValue, JsonValue>, id: ConversationId): boolean {
  if (task.state.status === "terminal") return false;
  const input = object(task.input);
  const phase = "checkpoint" in task.state ? object(task.state.checkpoint) : {};
  return task.kind === "anima.subagent-reporter" && input.conversationId === id && phase.phase === "deliver";
}

async function requireIdle(tx: Tx, id: ConversationId) {
  const live = await tx.doc(LiveDoc, id);
  const inbox = await tx.doc(InboxDoc, id);
  const busy = () => new ConnectError("Change folder requires an idle conversation with no queued or pending input", Code.FailedPrecondition);
  if (live.run || inbox.items.length) throw busy();
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({}, 100, cursor);
    for (const task of page.items) {
      if (task.state.status === "terminal") continue;
      if (task.conversationId === id && !task.background || targetsConversation(task, id)) throw busy();
    }
    cursor = page.next;
  } while (cursor !== undefined);
}

export async function abortConversation(harness: Harness, conversation: Conversation, context: Context) {
  const inspection = await harness.inspect(context);
  // Once accepted, disconnecting must not abandon the sequence between stopping delivery and stopping the run.
  await Promise.all(inspection.tasks.filter(({ record }) => targetsConversation(record, conversation.id)).map(async ({ record }) => {
    await harness.abortTask(record.id, BACKGROUND_CONTEXT);
    await harness.waitForTask(record.id, BACKGROUND_CONTEXT);
  }));
  await conversation.abort(BACKGROUND_CONTEXT);
}

export async function updateQueuedInput(conversation: Conversation, request: UpdateQueuedInputRequest, context: Context) {
  const expectedMode = queueMode(request.expectedMode);
  const mode = request.whenBusy === undefined ? undefined : queueMode(request.whenBusy);
  if (request.content !== undefined && !request.content.trim()) throw new ConnectError("Input must not be empty", Code.InvalidArgument);
  if (request.remove && (request.content !== undefined || mode !== undefined)) {
    throw new ConnectError("Withdraw cannot also edit an input", Code.InvalidArgument);
  }
  return conversation.commit(async tx => {
    const inbox = await tx.doc(InboxDoc, conversation.id);
    const index = inbox.items.findIndex(item => String(item.id) === request.submissionId);
    const item = inbox.items[index];
    if (!item || item.mode === "write" || typeof item.content !== "string"
      || item.entry && object(item.entry.data).origin !== "user") {
      throw new ConnectError("User input is no longer queued or is not editable text", Code.FailedPrecondition);
    }
    if (item.content !== request.expectedContent || item.mode !== expectedMode) {
      throw new ConnectError("Queued input was changed by another client; reopen it", Code.Aborted);
    }
    if (!request.remove) {
      if (request.content !== undefined) item.content = request.content;
      if (mode !== undefined) item.mode = mode;
    }
    const result = { content: item.content, whenBusy: item.mode === "steer" ? BusyBehavior.STEER : BusyBehavior.QUEUE };
    if (request.remove) {
      const id = item.id;
      inbox.items.splice(index, 1);
      tx.settleSubmission(id, { status: "unanswered", reason: "aborted" });
    }
    return result;
  }, context);
}

function queueMode(mode: BusyBehavior): "steer" | "followUp" {
  if (mode === BusyBehavior.STEER) return "steer";
  if (mode === BusyBehavior.QUEUE) return "followUp";
  throw new ConnectError("Queue mode must be STEER or QUEUE", Code.InvalidArgument);
}

/** Match Durable's compaction estimate, invalidating usage older than context edits. */
function contextTokens(view: ContextView) {
  const after = view.entries.reduce((id, entry) => entry.edits?.length ? Math.max(id, entry.id) : id, view.head?.id ?? 0);
  let measured: AssistantMessage | undefined;
  for (let index = view.entries.length - 1; index >= 0 && !measured; index--) {
    if (view.entries[index].id <= after) continue;
    measured = view.contributions[index].findLast((message): message is AssistantMessage =>
      message.role === "assistant" && calculateContextTokens(message.usage) > 0);
  }
  const from = measured ? view.messages.lastIndexOf(measured) + 1 : 0;
  return (measured ? calculateContextTokens(measured.usage) : 0)
    + view.messages.slice(from).reduce((total, message) => total + estimateMessageTokens(message), 0);
}

/** One cache per attached conversation; streaming partials don't rebuild context or spawn Git. */
export function conversationStatus(conversation: Conversation, models: Models | undefined) {
  let contextKey = "";
  let tokens = 0;
  let git: { cwd: string; at: number; branch?: string } | undefined;
  return async (newest: number, context: Context) => {
    const agent = await conversation.agent(context);
    const cwd = agent.cwd ?? process.cwd();
    const key = `${newest}:${JSON.stringify(agent.model)}`;
    if (key !== contextKey) {
      tokens = contextTokens(await conversation.context(context));
      contextKey = key;
    }
    if (!git || git.cwd !== cwd || Date.now() - git.at >= 5_000) {
      let output = "";
      const result = await new NodeExecutionEnv({ cwd }).exec(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
        timeout: 2,
        onOutput(text, _context, info) { if (info.stream === "stdout") output = (output + text).slice(0, 1_024); },
      }, context);
      git = { cwd, at: Date.now(), ...(result.ok && result.value.exitCode === 0 ? { branch: output.trim() } : {}) };
    }
    const model = agent.model && models?.getModelOfType("chat", agent.model.provider, agent.model.modelId);
    return { cwd, model: agent.model, gitBranch: git.branch, contextTokens: tokens, contextWindow: model?.contextWindow ?? 0 };
  };
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
