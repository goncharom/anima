// Background subagents with automatic follow-up reports, based on Durable's example 22.
import { Type } from "@earendil-works/pi-ai";
import {
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  type AgentChange,
  type ConversationId,
  type Extension,
  type TaskId,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { ConversationReporter, createReporter } from "./conversation-reporter.ts";

/** Replace inherited coordinator filters for all coding workers. */
export const WorkerCapabilities = {
  extensions: [CodingTools], tools: CodingTools.tools ?? [], modelTools: null,
} satisfies AgentChange;

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
const Launch = defineDoc<{ conversationId?: ConversationId; reporterTaskId?: TaskId }>({
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
    "For related follow-ups, reuse an existing conversation with send_message instead. " +
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

      const anchor = await tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, background: true });
      const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
      await configure(tx, child.id, {
        thinkingLevel: "high",
        ...WorkerCapabilities,
        instructions:
          `You are the background subagent ${JSON.stringify(name)}. Complete the parent's task independently. ` +
          "Do not delegate to other agents. Your final answer is automatically reported to the parent. " +
          "Include your findings, changes, and any limitations in that answer.",
      });
      const reporter = await createReporter(tx, { name, conversationId: child.id, message });
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

const sendMessage = defineTool({
  name: "send_message",
  description:
    "Send a follow-up or correction to one of your existing subagents. Reuse its conversationId rather than " +
    "starting another agent for related work. Returns immediately; the answer is automatically reported here. " +
    "A busy child receives this at its next tool boundary (not after its entire assignment).",
  parameters: Type.Object({
    conversationId: Type.String({ minLength: 1, description: "An existing subagent conversationId returned by subagent." }),
    message: Type.String({ minLength: 1, description: "The follow-up instruction and relevant context." }),
  }),
  replay: "safe",
  execute: async ({ conversationId, message }, api, context) => {
    const reporterTaskId = await api.commit(async (tx) => {
      const launch = await tx.doc(Launch, api.taskId);
      // Memoize the reporter too, using a stable request ID for safe replay.
      const agents = await tx.doc(SubagentsDoc, api.conversationId);
      const agent = Object.values(agents.agents).find((candidate) => String(candidate.conversationId) === conversationId);
      if (agent === undefined) throw new Error("Destination is not one of your subagents");
      const requestId = `subagent-message:${api.taskId}`;
      if (launch.reporterTaskId !== undefined) return launch.reporterTaskId;
      const reporter = await createReporter(tx, {
        name: agent.name, conversationId: agent.conversationId, message, requestId,
      });
      launch.reporterTaskId = reporter;
      return reporter;
    }, context);
    return {
      output: [{ type: "text", text: JSON.stringify({ conversationId, reporterTaskId, reportBack: true }) }],
    };
  },
});

/** Exact root allowlist: delegation only, with no file, shell, or tool-discovery capability. */
export const CoordinatorTools = [subagent, sendMessage];

/** Launch non-recursive background children and automatically report their answers. */
export const BackgroundSubagents: Extension = defineExtension({
  name: "background-subagents",
  tasks: [Anchor, ConversationReporter],
  tools: CoordinatorTools,
});
