// Background subagents with automatic follow-up reports, based on Durable's example 22.
import { Type } from "@earendil-works/pi-ai";
import {
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  type ConversationId,
  type Extension,
  type TaskId,
} from "@earendil-works/pi-durable";
import { ConversationReporter } from "./conversation-reporter.ts";

export type SubagentInfo = {
  name: string;
  conversationId: ConversationId;
  reporterTaskId: TaskId;
};

/** Names and child IDs keyed by reporter task ID; execution state lives in the task graph. */
export const SubagentsDoc = defineDoc<{ agents: Record<string, SubagentInfo> }>({
  kind: "anima.subagents",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ agents: {} }),
  checkpointWhen: () => false,
});

// A safe tool replay reuses its launch. This memo retires when the tool task ends.
const Launch = defineDoc<{ conversationId?: ConversationId }>({
  kind: "anima.subagent-launch",
  version: 1,
  scope: "task",
  initial: () => ({}),
  checkpointWhen: () => false,
});

// A background ownership boundary keeps the child out of the parent's abort/idle scope.
const Anchor = defineTask<null, { phase: "done" }, null>({
  name: "anima.subagent-anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_task, runtime, context) => runtime.commit(
      () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
      context,
    ),
  },
  abort: (_task, runtime, context) => runtime.commit(
    () => ({ status: "terminal", outcome: { status: "aborted" } }),
    context,
  ),
});

const subagent = defineTool({
  name: "subagent",
  description:
    "Start a background subagent for an independent task. Each call starts a new agent and returns immediately. " +
    "Give it a short name and a self-contained message with all context it needs. It inherits your model, " +
    "working directory, and coding tools, but cannot create subagents. Its final answer (or failure) will " +
    "automatically arrive here as a follow-up message. The result includes its conversationId.",
  parameters: Type.Object({
    name: Type.String({ minLength: 1, description: "A short label for this subagent." }),
    message: Type.String({ minLength: 1, description: "The complete task and relevant context for the subagent." }),
  }),
  replay: "safe",
  execute: async ({ name, message }, api, context) => {
    const conversationId = await api.commit(async (tx) => {
      const launch = await tx.doc(Launch, api.taskId);
      if (launch.conversationId !== undefined) return launch.conversationId;

      const background = { ownership: { kind: "conversation" }, background: true } as const;
      const anchor = await tx.createTask(Anchor, null, background);
      const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
      await configure(tx, child.id, {
        extensions: { remove: [BackgroundSubagents] },
        instructions:
          `You are the background subagent ${JSON.stringify(name)}. Complete the parent's task independently. ` +
          "Do not delegate to other agents. Your final answer is automatically reported to the parent. " +
          "Include your findings, changes, and any limitations in that answer.",
      });
      const reporter = await tx.createTask(ConversationReporter, { name, conversationId: child.id, message }, background);
      (await tx.doc(SubagentsDoc, api.conversationId)).agents[String(reporter)] = {
        name,
        conversationId: child.id,
        reporterTaskId: reporter,
      };
      launch.conversationId = child.id;
      return child.id;
    }, context);

    return {
      output: [{ type: "text", text: JSON.stringify({ name, conversationId: String(conversationId), reportBack: true }) }],
      details: { name, conversationId },
    };
  },
});

/** Launch non-recursive background children and automatically report their answers. */
export const BackgroundSubagents: Extension = defineExtension({
  name: "background-subagents",
  tasks: [Anchor, ConversationReporter],
  tools: [subagent],
});
