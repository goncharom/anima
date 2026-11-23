// Background subagents with automatic follow-up reports, based on Durable's example 22.
import { obj, opt, str } from "@earendil-works/pi-schema";
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
import { ConversationsDoc, displayName, displayTaskTitle, registerConversation } from "./conversations.ts";
import { COORDINATOR_PROMPT, workerPrompt } from "../prompts.ts";
import { createCron, CronJob } from "./crons.ts";
import { subagentDefaults } from "./subagent-defaults.ts";

/** Extension references select by name; each harness installs its own codemode sandbox. */
export const WorkerCapabilities = {
  extensions: [CodingTools, { name: "codemode" }, { name: "mcp" }],
  tools: null,
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
    "Give it a short name, a short task title, and a self-contained message with all context it needs. It inherits your working directory " +
    "and uses the server's default subagent model and thinking level, with coding tools but no ability to create subagents. Its final answer (or failure) will " +
    "automatically arrive here as a follow-up message. The result includes its conversationId.",
  parameters: obj({
    name: str({ minLength: 1, description: "A short label for this subagent." }),
    taskTitle: str({ minLength: 1, maxLength: 120, description: "A short plain-text title for its assignment." }),
    message: str({ minLength: 1, description: "The complete task and relevant context for the subagent." }),
  }, { open: true }),
  replay: "safe",
  execute: async ({ name, taskTitle, message }, api, context) => {
    name = displayName(name);
    taskTitle = displayTaskTitle(taskTitle);
    const conversationId = await api.commit(async (tx) => {
      const launch = await tx.doc(Launch, api.taskId);
      if (launch.conversationId !== undefined) return launch.conversationId;
      const defaults = await subagentDefaults(tx);

      const anchor = await tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, background: true });
      const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
      const info = await registerConversation(tx, child);
      info.name = name;
      info.taskTitle = taskTitle;
      await configure(tx, child.id, {
        ...WorkerCapabilities,
        ...defaults,
        modelTools: null,
        instructions: workerPrompt(name),
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
    "starting another agent for related work. An optional taskTitle immediately changes its displayed assignment title; omit it to retain the current title. " +
    "Returns immediately; the answer is automatically reported here. " +
    "A busy child receives this at its next tool boundary (not after its entire assignment).",
  parameters: obj({
    conversationId: str({ minLength: 1, description: "An existing subagent conversationId returned by subagent." }),
    taskTitle: opt(str({ minLength: 1, maxLength: 120, description: "Optional new short title for the worker's current assignment; omission retains its existing title." })),
    message: str({ minLength: 1, description: "The follow-up instruction and relevant context." }),
  }, { open: true }),
  replay: "safe",
  execute: async ({ conversationId, message, taskTitle }, api, context) => {
    if (taskTitle !== undefined) taskTitle = displayTaskTitle(taskTitle);
    const reporterTaskId = await api.commit(async (tx) => {
      const launch = await tx.doc(Launch, api.taskId);
      // Memoize the reporter too, using a stable request ID for safe replay.
      const agents = await tx.doc(SubagentsDoc, api.conversationId);
      const agent = Object.values(agents.agents).find((candidate) => String(candidate.conversationId) === conversationId);
      if (agent === undefined) throw new Error("Destination is not one of your subagents");
      const requestId = `subagent-message:${api.taskId}`;
      const info = (await tx.doc(ConversationsDoc)).conversations[String(agent.conversationId)];
      if (taskTitle !== undefined && info !== undefined) info.taskTitle = taskTitle;
      if (launch.reporterTaskId !== undefined) return launch.reporterTaskId;
      const name = info?.name ?? agent.name;
      const reporter = await createReporter(tx, {
        name, conversationId: agent.conversationId, message, requestId,
      });
      launch.reporterTaskId = reporter;
      return reporter;
    }, context);
    return {
      output: [{ type: "text", text: JSON.stringify({ conversationId, reporterTaskId, reportBack: true }) }],
    };
  },
});

/** Delegation tools available alongside the coordinator's coding tools. */
export const CoordinatorTools = [subagent, sendMessage, createCron];

export function coordinatorCapabilities(instructions?: string): AgentChange {
  return {
    extensions: [...WorkerCapabilities.extensions, BackgroundSubagents], tools: null, modelTools: null,
    instructions: instructions ? `${COORDINATOR_PROMPT}\n\nAdditional human instructions:\n${instructions}` : COORDINATOR_PROMPT,
  };
}

/** Launch non-recursive background children and automatically report their answers. */
export const BackgroundSubagents: Extension = defineExtension({
  name: "background-subagents",
  tasks: [Anchor, ConversationReporter, CronJob],
  tools: CoordinatorTools,
});
