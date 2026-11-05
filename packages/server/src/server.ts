import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { BackgroundSubagents, SubagentsDoc } from "./extensions/subagents.ts";
import { Routing } from "./extensions/routing.ts";

export { routeInput, RoutingTask, type RoutingResult } from "./extensions/routing.ts";

/** Open a SQLite-backed coding harness using OPENAI_API_KEY from the environment. */
export async function createHarness() {
  const databasePath = process.env.ANIMA_DB_PATH
    ?? fileURLToPath(new URL("../../../.anima/session.sqlite", import.meta.url));
  await mkdir(dirname(databasePath), { recursive: true });
  const models = createModels();
  models.setProvider(openaiProvider());

  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(BackgroundSubagents);
  registry.install(Routing);

  const harness = await Harness.open(
    await openNodeSqliteStorage(databasePath),
    {
      models,
      registry,
      conversationCreated: async (tx, conversation) => {
        await tx.doc(SubagentsDoc, conversation.id);
      },
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
    },
    BACKGROUND_CONTEXT,
  );
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: {
      model: { provider: "openai", modelId: "gpt-6-luna" },
      cwd: process.cwd(),
    },
  });

  return { harness, root };
}
