import { mkdir, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BusyBehavior, ConversationSnapshotSchema, HarnessService } from "@anima/protocol-ts";
import { create, type JsonObject } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
  AgentDoc,
  ConversationBusy,
  createRegistry,
  Harness,
  InboxDoc,
  LiveDoc,
  ProviderDoc,
  UsageDoc,
  type Conversation,
  type ConversationDocToken,
  type ConversationId,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type JsonObject as DurableJsonObject,
  type WatchEnd,
  type WatchHandle,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ProjectCodingTools } from "./extensions/project-resources.ts";
import { BackgroundSubagents, coordinatorCapabilities, SubagentsDoc } from "./extensions/subagents.ts";
import { createReporter, InputRequests } from "./extensions/conversation-reporter.ts";
import { openMcp } from "./extensions/mcp.ts";
import {
  abortConversation, conversationStatus, ConversationsDoc, directoryPath,
  displayName, listDirectories, registerConversation, updateConversation, updateQueuedInput,
} from "./extensions/conversations.ts";

export { SubagentsDoc };

// Use registered definitions so document watches retain Durable's versions and migrations.
const DOCUMENT_TOKENS: readonly ConversationDocToken<DurableJsonObject>[] = [
  AgentDoc, LiveDoc, InboxDoc, ProviderDoc, UsageDoc, SubagentsDoc,
];
const DOCUMENTS = new Map(DOCUMENT_TOKENS.map((token) => [token.definition.kind, token]));

// Match Pi's process-wide limit, including cancelled workers that are still exiting.
let activeCodemodeWorkers = 0;

const DEFAULT_AGENT = {
  model: { provider: "openai", modelId: "gpt-6.1-sol" },
  thinkingLevel: "high" as const,
};

/** Open a SQLite-backed coding harness using OPENAI_API_KEY from the environment. */
export async function createHarness() {
  const databasePath = process.env.ANIMA_DB_PATH
    ?? fileURLToPath(new URL("../../../.anima/session.sqlite", import.meta.url));
  if (process.argv.includes("--force-recreate-db")) {
    await rm(databasePath, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    await rm(`${databasePath}-wal`, { force: true });
  }
  await mkdir(dirname(databasePath), { recursive: true });
  const models = createModels();
  models.setProvider(openaiProvider());

  const registry = createRegistry();
  registry.install(ProjectCodingTools);
  registry.install(BackgroundSubagents);
  const sandbox = new CodemodeSandbox({
    memoryLimitBytes: 256 * 1024 * 1024,
    acquireWorker() {
      if (activeCodemodeWorkers >= 2) throw new Error("Codemode worker limit reached; retry after a running script exits");
      activeCodemodeWorkers++;
      return () => { activeCodemodeWorkers--; };
    },
  });
  registry.install(createCodemodeExtension({ sandbox }));
  const mcp = await openMcp(registry).catch(async (error) => {
    await sandbox.close();
    throw error;
  });
  const closeTools = () => Promise.all([sandbox.close(), mcp.close()]);

  const harness = await openNodeSqliteStorage(databasePath).then((storage) => Harness.open(
    storage,
    {
      models,
      registry,
      settings: { steeringMode: "all" },
      conversationCreated: async (tx, conversation) => {
        await tx.doc(SubagentsDoc, conversation.id);
        await registerConversation(tx, conversation);
      },
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
    },
    BACKGROUND_CONTEXT,
  )).catch(async (error) => {
    await closeTools();
    throw error;
  });
  harness.subscribeClose(() => {
    void closeTools().catch((error) => console.error("Tool shutdown failed:", error));
  });
  return { harness, models };
}

/** Shared user-input policy. Internal agent messages still use Conversation.submit directly. */
export async function submitInput(
  harness: Harness,
  conversation: Conversation,
  content: string,
  context: Context,
  options: { requestId?: string; whenBusy?: "followUp" | "steer" | "reject" } = {},
): Promise<void> {
  if (!content.trim()) throw new Error("Input must not be empty");
  const record = await harness.commit(tx => tx.conversation(conversation.id), context);
  if (record?.owner) {
    const owner = await harness.conversation(record.owner.conversationId, context);
    if (!owner) throw new ConnectError("Worker's coordinator is unavailable", Code.FailedPrecondition);
    // A durable reporter belongs to the actual coordinator, not a singleton conversation.
    await owner.commit(async (tx) => {
      const directory = await tx.doc(SubagentsDoc, owner.id);
      const agent = Object.values(directory.agents).find(agent => agent.conversationId === conversation.id);
      if (!agent) throw new ConnectError("Conversation is not a registered subagent", Code.FailedPrecondition);
      const receipt = options.requestId
        ? await tx.doc(InputRequests, conversation.id, options.requestId, null) : undefined;
      if (receipt?.taskId !== undefined) return;
      // Decide reject at admission, not later when the background delivery runs.
      if (options.whenBusy === "reject" && ((await tx.doc(LiveDoc, conversation.id)).run !== undefined
        || (await tx.doc(InboxDoc, conversation.id)).items.length > 0)) {
        throw new ConversationBusy(conversation.id);
      }
      const name = (await tx.doc(ConversationsDoc)).conversations[String(conversation.id)]?.name ?? agent.name;
      const id = await createReporter(tx, {
        conversationId: conversation.id, name, message: content,
        requestId: options.requestId || undefined,
        whenBusy: options.whenBusy === "reject" ? "followUp" : options.whenBusy,
        entry: { kind: "anima.user-message", data: { origin: "user" } },
      });
      if (receipt) receipt.taskId = id;
    }, context);
    harness.resume();
    return;
  }
  await conversation.submit({ type: "input", content, ...options, whenBusy: options.whenBusy ?? "steer" }, context);
}

/** Start a loopback Connect server, taking ownership of its harness until close(). */
export async function startServer(harness?: Harness, options: { port?: number; models?: Models } = {}) {
  const opened = harness ? { harness, models: options.models } : await createHarness();
  const runtime = opened.harness;
  const models = opened.models;
  const shutdown = new AbortController();
  const server = createHttpServer(connectNodeAdapter({
    shutdownSignal: shutdown.signal,
    routes(router) {
      router.service(HarnessService, {
        async createConversation(request, rpc) {
          const context = withAbortSignal(rpc.signal, BACKGROUND_CONTEXT);
          const cwd = await directoryPath(request.cwd ?? process.cwd(), context);
          const name = request.name === undefined ? undefined : displayName(request.name);
          const conversation = await runtime.createConversation({
            ownership: { kind: "ownerless" },
            agent: {
              ...DEFAULT_AGENT,
              cwd,
              ...coordinatorCapabilities(request.instructions),
            },
            init: async (tx, id) => {
              const info = await registerConversation(tx, { id });
              if (name !== undefined) info.name = name;
            },
          }, context);
          return { conversationId: String(conversation.id) };
        },
        async submitInput(request, rpc) {
          const context = withAbortSignal(rpc.signal, BACKGROUND_CONTEXT);
          const conversation = await requireConversation(runtime, request.conversationId, context);
          if (!request.content.trim()) {
            throw new ConnectError("content must not be empty", Code.InvalidArgument);
          }
          try {
            await submitInput(runtime, conversation, request.content, context, {
              requestId: request.requestId || undefined,
              whenBusy: busyMode(request.whenBusy),
            });
            return {};
          } catch (error) {
            if (error instanceof ConversationBusy) {
              throw new ConnectError("Conversation is busy", Code.FailedPrecondition);
            }
            throw error;
          }
        },
        async *watchConversation(request, rpc) {
          const context = withAbortSignal(rpc.signal, BACKGROUND_CONTEXT);
          const conversation = await requireConversation(runtime, request.conversationId, context);
          yield* watchConversation(conversation, models, context);
        },
        async *watchTaskGraph(_request, rpc) {
          const context = withAbortSignal(rpc.signal, BACKGROUND_CONTEXT);
          for await (const { value: graph } of watchValues(await runtime.watchTaskGraph(context))) {
            yield { graph: jsonObject(graph) };
          }
        },
        async *watchDocument(request, rpc) {
          const context = withAbortSignal(rpc.signal, BACKGROUND_CONTEXT);
          const conversation = await requireConversation(runtime, request.conversationId, context);
          if (!request.kind) {
            throw new ConnectError("kind must not be empty", Code.InvalidArgument);
          }
          const token = DOCUMENTS.get(request.kind);
          if (token === undefined) {
            throw new ConnectError("Document kind is not registered", Code.NotFound);
          }
          const watch = await runtime.watchDoc(token, conversation.id, context);
          if (watch === undefined) {
            throw new ConnectError("Document not found", Code.NotFound);
          }
          for await (const { value, retired } of watchValues(watch)) {
            yield { value: retired ? undefined : jsonObject(value), retired };
          }
        },
        async abortConversation(request, rpc) {
          const context = withAbortSignal(rpc.signal, BACKGROUND_CONTEXT);
          const conversation = await requireConversation(runtime, request.conversationId, context);
          await abortConversation(runtime, conversation, context);
          return {};
        },
        async compactConversation(request, rpc) {
          const context = withAbortSignal(rpc.signal, BACKGROUND_CONTEXT);
          const conversation = await requireConversation(runtime, request.conversationId, context);
          const taskId = await conversation.compact(request.instructions?.trim() || undefined, context);
          // Disconnecting cancels these waits, not the admitted Durable task.
          const { state } = await runtime.waitForTask(taskId, context);
          const outcome = state.outcome;
          if (outcome.status === "aborted") throw new ConnectError("Compaction canceled", Code.Canceled);
          if (outcome.status !== "completed") {
            throw new ConnectError(outcome.error?.message ?? `Compaction ${outcome.status}: ${outcome.reason}`, Code.FailedPrecondition);
          }
          if (outcome.result.submissionId === undefined) return { compacted: false };
          const submission = await runtime.submission(outcome.result.submissionId, context);
          if (!submission) throw new ConnectError("Compaction summary is unavailable", Code.Internal);
          const placed = await submission.wait(context);
          if (placed.status === "done") return { compacted: true };
          if (placed.reason === "stale") return { compacted: false };
          throw new ConnectError(`Compaction summary was not applied: ${placed.reason}`, Code.FailedPrecondition);
        },
        async *watchConversations(_request, rpc) {
          const context = withAbortSignal(rpc.signal, BACKGROUND_CONTEXT);
          const watch = await runtime.watchDoc(ConversationsDoc, context);
          if (!watch) throw new ConnectError("Conversation directory is unavailable", Code.FailedPrecondition);
          for await (const { value: directory, retired } of watchValues(watch)) {
            if (!retired) yield { conversations: Object.values(directory.conversations) };
          }
        },
        async updateConversation(request, rpc) {
          const context = withAbortSignal(rpc.signal, BACKGROUND_CONTEXT);
          const conversation = await requireConversation(runtime, request.conversationId, context);
          await updateConversation(conversation, request, models, context);
          return {};
        },
        async listDirectories(request, rpc) {
          return listDirectories(request.path, request.offset, withAbortSignal(rpc.signal, BACKGROUND_CONTEXT));
        },
        async listModels(_request, rpc) {
          if (!models) throw new ConnectError("The server model catalog is unavailable", Code.FailedPrecondition);
          const available = await models.getAvailableOfType("chat", undefined, { signal: rpc.signal });
          return { models: available.map(model => ({
            model: { provider: model.provider, modelId: model.id }, name: model.name,
            contextWindow: model.contextWindow, reasoning: model.reasoning,
          })) };
        },
        async updateQueuedInput(request, rpc) {
          const context = withAbortSignal(rpc.signal, BACKGROUND_CONTEXT);
          parseId(request.submissionId);
          const conversation = await requireConversation(runtime, request.conversationId, context);
          return updateQueuedInput(conversation, request, context);
        },
        async getEntries(request, rpc) {
          const context = withAbortSignal(rpc.signal, BACKGROUND_CONTEXT);
          const conversation = await requireConversation(runtime, request.conversationId, context);
          const limit = request.limit || 50;
          if (limit > 200) {
            throw new ConnectError("limit must not exceed 200", Code.InvalidArgument);
          }
          const max = request.beforeEntryId === undefined
            ? undefined : parseId<EntryId>(request.beforeEntryId) - 1;
          const page = await historyPage(conversation, max, limit, context);
          return {
            entries: page.entries.map(jsonObject),
            nextBeforeEntryId: page.before === undefined ? undefined : String(page.entries[0]!.id),
          };
        },
      });
    },
  }));

  try {
    // Initialize the directory without creating any conversation, even on an empty database.
    await runtime.commit(async tx => { await tx.doc(ConversationsDoc); }, BACKGROUND_CONTEXT);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 4242, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    runtime.resume();
  } catch (error) {
    server.close();
    await runtime.close(BACKGROUND_CONTEXT);
    throw error;
  }

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP listening address");
  }
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close(): Promise<void> {
      return closing ??= (async () => {
        shutdown.abort(new ConnectError("Server is shutting down", Code.Unavailable));
        const closed = new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
        // Allow stream endings before destroying connections from slow clients.
        const drainTimeout = setTimeout(() => server.closeAllConnections(), 5_000);
        drainTimeout.unref();
        try {
          await Promise.all([runtime.close(BACKGROUND_CONTEXT), closed]);
        } finally {
          clearTimeout(drainTimeout);
          server.closeAllConnections();
          await closed;
        }
      })();
    },
  };
}

/** Validate opaque wire IDs before converting to Durable's numeric identifiers. */
function parseId<T extends number>(value: string): T {
  const id = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(id)) {
    throw new ConnectError("Invalid ID", Code.InvalidArgument);
  }
  return id as T;
}

async function requireConversation(harness: Harness, id: string, context: Context) {
  const conversation = await harness.conversation(parseId<ConversationId>(id), context);
  if (conversation === undefined) throw new ConnectError("Conversation not found", Code.NotFound);
  return conversation;
}

function busyMode(behavior: BusyBehavior): "followUp" | "steer" | "reject" | undefined {
  switch (behavior) {
    case BusyBehavior.UNSPECIFIED:
      return undefined;
    case BusyBehavior.QUEUE:
      return "followUp";
    case BusyBehavior.STEER:
      return "steer";
    case BusyBehavior.REJECT:
      return "reject";
    default:
      throw new ConnectError("Unknown busy behavior", Code.InvalidArgument);
  }
}

/** Read a bounded raw history window plus one older entry. */
async function historyPage(conversation: Conversation, max: number | undefined, limit: number, context: Context) {
  const entries: EntryRecord[] = [];
  const query = max === undefined ? {} : { maxEntryId: max as EntryId };
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries(query, limit + 1 - entries.length, cursor, context);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined && entries.length < limit + 1);
  const before = entries.length > limit ? entries.pop()!.id : undefined;
  return { entries: entries.reverse(), before };
}

/** Omit optional undefined properties when adapting Durable JSON to protobuf Struct. */
function jsonObject(value: object): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

/** Bridge Durable state watches to bounded replacement streams, not an event queue. */
async function* watchValues<T>(watch: WatchHandle<T>, refreshMs?: number) {
  let pending: { value: T; retired: boolean } | undefined = { value: watch.value, retired: false };
  let ended: WatchEnd | undefined;
  let wake = Promise.withResolvers<void>();
  watch.start(async (call) => {
    // Transient failures leave the last value valid. A retirement must not be
    // coalesced away if a document at the same address is created again.
    if (call.kind === "value" && !pending?.retired) {
      pending = { value: call.value, retired: call.retired };
      wake.resolve();
    }
  });
  // Refresh derived Git status while idle, only while a client is attached.
  const timer = refreshMs === undefined ? undefined : setInterval(() => {
    pending ??= { value: watch.value, retired: false };
    wake.resolve();
  }, refreshMs);
  timer?.unref();
  void watch.closed.then((end) => {
    ended = end;
    wake.resolve();
  });
  try {
    while (true) {
      if (pending !== undefined) {
        const frame = pending;
        pending = undefined;
        yield frame;
        if (frame.retired) return;
      } else if (ended !== undefined) {
        if (ended.kind === "failed" || ended.kind === "listener_error") {
          throw new ConnectError("Watch failed", Code.Unavailable);
        }
        return;
      } else {
        await wake.promise;
        wake = Promise.withResolvers<void>();
      }
    }
  } finally {
    clearInterval(timer);
    await watch.stop();
  }
}

/** Stream raw transcript history together with the UI's conversation documents. */
async function* watchConversation(conversation: Conversation, models: Models | undefined, context: Context) {
  const status = conversationStatus(conversation, models);
  let cached: { newest: number; page: Awaited<ReturnType<typeof historyPage>> } | undefined;
  for await (const { value: view } of watchValues(await conversation.watch(context), 5_000)) {
    // Durable's view is active model context; include raw history and custom entries too.
    const newest = view.entries.reduce((id, entry) => Math.max(id, entry.id), 0);
    if (cached?.newest !== newest) cached = { newest, page: await historyPage(conversation, newest, 50, context) };
    const page = cached.page;
    yield {
      snapshot: create(ConversationSnapshotSchema, {
        conversationId: String(conversation.id),
        entries: page.entries.map(jsonObject),
        beforeEntryId: page.before === undefined ? undefined : String(page.before),
        docs: Object.fromEntries(Object.entries(view.docs).map(([kind, value]) => [kind, jsonObject(value)])),
        status: await status(newest, context),
      }),
    };
  }
}

if (import.meta.main) {
  const server = await startServer();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => {
      console.error("Shutdown timed out after 10 seconds.");
      process.exit(1);
    }, 10_000);
    try {
      await server.close();
    } catch (error) {
      console.error("Shutdown failed:", error);
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(`Anima server listening on ${server.url}`);
}
