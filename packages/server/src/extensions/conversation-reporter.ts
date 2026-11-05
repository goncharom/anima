// Reports one conversation submission back to the conversation that requested it.
import { AssistantEntry, defineTask, type ConversationId } from "@earendil-works/pi-durable";

type ReporterInput = {
  conversationId: ConversationId;
  message: string;
  name?: string;
  requestId?: string;
  whenBusy?: "followUp" | "steer" | "reject";
};
type ReporterCheckpoint = { phase: "deliver" } | { phase: "report"; report?: string };

/** Submit or reattach to one input, then deliver its answer as a background follow-up. */
export const ConversationReporter = defineTask<ReporterInput, ReporterCheckpoint, null>({
  // Keep the durable kind stable for reporters already stored in SQLite.
  name: "anima.subagent-reporter",
  version: 1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    deliver: async (task, runtime, context) => {
      const target = (await runtime.conversation(task.input.conversationId, context))!;
      const submission = await target.submit({
        type: "input",
        content: task.input.message,
        requestId: task.input.requestId ?? `subagent:${task.id}`,
        whenBusy: task.input.whenBusy ?? "followUp",
        entry: {
          kind: "anima.agent-message",
          data: {
            origin: "agent",
            visibility: "internal",
            sourceConversationId: String(runtime.conversationId),
            sourceTaskId: String(task.id),
          },
        },
      }, context);
      const settled = await submission.wait(context);
      await runtime.commit(async (tx) => {
        let report: string | undefined;
        const source = task.input.name === undefined
          ? `conversation ${task.input.conversationId}`
          : `subagent ${JSON.stringify(task.input.name)}`;
        if (settled.status === "unanswered") {
          if (settled.reason !== "aborted") {
            report = `[${source} failed: ${settled.reason}]${settled.detail ? `\n${settled.detail}` : ""}`;
          }
        } else if (settled.type === "input") {
          const message = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0];
          const text = message?.role === "assistant"
            ? message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")
            : "";
          report = `[${source} completed]\n${text || "Completed without a text response."}`;
        }
        return {
          status: "running",
          checkpoint: { phase: "report", ...(report === undefined ? {} : { report }) },
        };
      }, context);
    },
    report: async (task, runtime, context) => {
      const report = task.state.checkpoint.report;
      if (report !== undefined) {
        const caller = (await runtime.conversation(runtime.conversationId, context))!;
        await caller.submit({
          type: "input",
          content: report,
          whenBusy: "followUp",
          requestId: `subagent-report:${task.id}`,
          entry: {
            kind: "anima.agent-report",
            data: {
              origin: "agent",
              visibility: "internal",
              sourceConversationId: String(task.input.conversationId),
              reporterTaskId: String(task.id),
              ...(task.input.name === undefined ? {} : { sourceName: task.input.name }),
            },
          },
        }, context);
      }
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
        context,
      );
    },
  },
  abort: (_task, runtime, context) => runtime.commit(
    () => ({ status: "terminal", outcome: { status: "aborted" } }),
    context,
  ),
});
