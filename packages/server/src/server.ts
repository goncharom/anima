import { mkdir, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BusyBehavior, ConversationSnapshotSchema, HarnessService } from "@anima/protocol-ts";
import { create, type JsonObject } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
  AgentDoc,
  configure,
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
  type Tx,
  type WatchEnd,
  type WatchHandle,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { BackgroundSubagents, CoordinatorTools, SubagentsDoc, WorkerCapabilities } from "./extensions/subagents.ts";
import { createReporter, InputRequests } from "./extensions/conversation-reporter.ts";
import { routeInput, Routing } from "./extensions/routing.ts";
import { openMcp } from "./extensions/mcp.ts";
import {
  abortConversation, backfillConversations, conversationStatus, ConversationsDoc, directoryPath,
  displayName, listDirectories, registerConversation, updateConversation, updateQueuedInput,
} from "./extensions/conversations.ts";

export { routeInput, RoutingTask, type RoutingResult } from "./extensions/routing.ts";
export { SubagentsDoc };

// Use registered definitions so document watches retain Durable's versions and migrations.
const DOCUMENT_TOKENS: readonly ConversationDocToken<DurableJsonObject>[] = [
  AgentDoc, LiveDoc, InboxDoc, ProviderDoc, UsageDoc, SubagentsDoc,
];
const DOCUMENTS = new Map(DOCUMENT_TOKENS.map((token) => [token.definition.kind, token]));

// Match Pi's process-wide limit, including cancelled workers that are still exiting.
let activeCodemodeWorkers = 0;

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
  registry.install(CodingTools);
  registry.install(BackgroundSubagents);
  registry.install(Routing);
  const sandbox = new CodemodeSandbox({
    memoryLimitBytes: 256 * 1024 * 1024,
    acquireWorker() {
      if (activeCodemodeWorkers >= 2) throw new Error("Codemode worker limit reached; retry after a running script exits");
      activeCodemodeWorkers++;
      return () => { activeCodemodeWorkers--; };
    },
  });
  const codemode = createCodemodeExtension({ sandbox });
  registry.install(codemode);
  const mcp = await openMcp(registry, (namespaces) => {
    registry.install(createCodemodeExtension({ sandbox, namespaces }));
  }).catch(async (error) => {
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
  const startupFailed = async (error: unknown): Promise<never> => {
    await Promise.all([harness.close(BACKGROUND_CONTEXT), closeTools()]);
    throw error;
  };
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: {
      model: { provider: "openai", modelId: "gpt-6.1-sol" },
      thinkingLevel: "high",
      cwd: process.cwd(),
    },
    init: async (tx, id) => { (await tx.doc(ConversationsDoc)).conversations[String(id)].name = "Chief of staff"; },
  }).catch(startupFailed);
  // root({ agent }) initializes only NEW roots. Reapply policy to persisted sessions before resume,
  // without resetting history, changing their chosen model/cwd, or aborting existing submissions.
  await root.commit(async (tx) => {
    const agents = await tx.doc(SubagentsDoc, root.id);
    const children = [];
    for (const agent of Object.values(agents.agents)) {
      if (await tx.conversation(agent.conversationId)) children.push(agent.conversationId);
    }
    await backfillConversations(tx, root.id, new Map(Object.values(agents.agents).map(agent => [agent.conversationId, agent.name])));
    await configure(tx, root.id, {
      extensions: [BackgroundSubagents, Routing],
      tools: CoordinatorTools,
      modelTools: null,
      instructions: "",
    });
    for (const id of children) {
      await configure(tx, id, WorkerCapabilities);
    }
    // Upgrade existing independent coding conversations without replacing their tool restrictions.
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanConversations({}, 100, cursor);
      for (const conversation of page.items) {
        if (conversation.id === root.id || conversation.owner !== undefined) continue;
        const agent = await tx.doc(AgentDoc, conversation.id);
        if (!Array.isArray(agent.extensions) || !agent.extensions.includes(CodingTools.name)) continue;
        for (const extension of WorkerCapabilities.extensions) {
          if (!agent.extensions.includes(extension.name)) agent.extensions.push(extension.name);
        }
        if (Array.isArray(agent.tools)) {
          const enabled = new Set(agent.tools);
          // Preserve existing restrictions, while allowing newly discovered MCP tools.
          agent.tools = { remove: registry.snapshot().tools()
            .filter(({ extension, tool }) => extension.name !== "mcp" && extension.name !== "codemode" && !enabled.has(tool.name))
            .map(({ tool }) => tool.name) };
        }
      }
      cursor = page.next;
    } while (cursor !== undefined);
  }, BACKGROUND_CONTEXT).catch(startupFailed);

  return { harness, root, models };
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
  const root = await harness.root(context);
  if (conversation.id === root.id) {
    return routeInput(harness, content, context, options.requestId, options.whenBusy);
  }
  const directory = await harness.snapshot(SubagentsDoc, root.id, context);
  const agent = Object.values(directory?.agents ?? {}).find((agent) => agent.conversationId === conversation.id);
  if (agent) {
    // A durable reporter owns delivery and report-back; disconnecting the client loses neither.
    await root.commit(async (tx) => {
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
  await conversation.submit({ type: "input", content, ...options }, context);
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
        async getRootConversation(_request, rpc) {
          const context = withAbortSignal(rpc.signal, BACKGROUND_CONTEXT);
          const root = await runtime.root(context);
          return { conversationId: String(root.id) };
        },
        async createConversation(request, rpc) {
          const context = withAbortSignal(rpc.signal, BACKGROUND_CONTEXT);
          const defaults = await (await runtime.root(context)).agent(context);
          const cwd = await directoryPath(request.cwd ?? defaults.cwd ?? process.cwd(), context);
          const name = request.name === undefined ? undefined : displayName(request.name);
          const conversation = await runtime.createConversation({
            ownership: { kind: "ownerless" },
            agent: {
              model: defaults.model,
              thinkingLevel: defaults.thinkingLevel,
              cwd,
              ...WorkerCapabilities,
              modelTools: null,
              instructions: request.instructions ?? "You are an independent coding assistant.",
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
          for await (const graph of watchValues(await runtime.watchTaskGraph(context))) {
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
          for await (const value of watchValues(watch)) {
            yield { value: value === null ? undefined : jsonObject(value), retired: value === null };
          }
        },
        async abortConversation(request, rpc) {
          const context = withAbortSignal(rpc.signal, BACKGROUND_CONTEXT);
          const conversation = await requireConversation(runtime, request.conversationId, context);
          await abortConversation(runtime, conversation, context);
          return {};
        },
        async *watchConversations(_request, rpc) {
          const context = withAbortSignal(rpc.signal, BACKGROUND_CONTEXT);
          const watch = await runtime.watchDoc(ConversationsDoc, context);
          if (!watch) throw new ConnectError("Conversation directory is unavailable", Code.FailedPrecondition);
          for await (const directory of watchValues(watch)) {
            if (directory) yield { conversations: Object.values(directory.conversations) };
          }
        },
        async updateConversation(request, rpc) {
          const context = withAbortSignal(rpc.signal, BACKGROUND_CONTEXT);
          const conversation = await requireConversation(runtime, request.conversationId, context);
          const root = await runtime.root(context);
          await updateConversation(conversation, root.id, request, models, context);
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
        async forkConversation(request, rpc) {
          const context = withAbortSignal(rpc.signal, BACKGROUND_CONTEXT);
          const source = await requireConversation(runtime, request.conversationId, context);
          const at = request.entryId === undefined ? undefined : parseId<EntryId>(request.entryId);
          if (at !== undefined && !(await source.entries({ minEntryId: at, maxEntryId: at }, 1, undefined, context)).items.length) {
            throw new ConnectError("Fork entry is not visible in this conversation", Code.InvalidArgument);
          }
          const cwd = request.cwd === undefined ? undefined : await directoryPath(request.cwd, context);
          const directory = await runtime.snapshot(ConversationsDoc, context);
          const info = directory?.conversations[request.conversationId];
          const name = displayName(request.name ?? `${(info?.name ?? "Conversation").slice(0, 180)} (fork)`);
          const root = await runtime.root(context);
          const preferences = at === undefined ? await source.agent(context) : undefined;
          const options = {
            ownership: { kind: "ownerless" } as const,
            agent: {
              ...(preferences ? {
                model: preferences.model, thinkingLevel: preferences.thinkingLevel,
                cwd: preferences.cwd, instructions: preferences.instructions,
              } : {}),
              // Normal history forks retain native as-of tool restrictions and loaded tools.
              ...(at === undefined || source.id === root.id ? { ...WorkerCapabilities, modelTools: null } : {}),
              ...(cwd === undefined ? {} : { cwd }),
              ...(source.id === root.id || info?.ownerConversationId ? { instructions: "You are an independent coding assistant." } : {}),
            },
            init: async (tx: Tx, id: ConversationId) => {
              const info = await registerConversation(tx, {
                id, ...(at === undefined ? {} : { parent: { conversationId: source.id, at } }),
              });
              info.name = name;
            },
          };
          const conversation = at === undefined
            ? await runtime.createConversation(options, context) : await source.fork(at, options, context);
          return { conversationId: String(conversation.id) };
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
    if (harness) {
      const root = await runtime.root(BACKGROUND_CONTEXT);
      const agents = await runtime.snapshot(SubagentsDoc, root.id, BACKGROUND_CONTEXT);
      await root.commit(tx => backfillConversations(tx, root.id,
        new Map(Object.values(agents?.agents ?? {}).map(agent => [agent.conversationId, agent.name]))), BACKGROUND_CONTEXT);
    }
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
  let pending: { value: T } | undefined = { value: watch.value };
  let ended: WatchEnd | undefined;
  let wake = Promise.withResolvers<void>();
  watch.start(async (value) => {
    pending = { value };
    wake.resolve();
  });
  // Refresh derived Git status while idle, only while a client is attached.
  const timer = refreshMs === undefined ? undefined : setInterval(() => {
    pending ??= { value: watch.value };
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
        const { value } = pending;
        pending = undefined;
        yield value;
      } else if (ended !== undefined) {
        if (ended.reason === "session_failed" || ended.reason === "listener_error") {
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
  for await (const view of watchValues(await conversation.watch(context), 5_000)) {
    // Durable's view is active model context; include raw routing receipts and history too.
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
