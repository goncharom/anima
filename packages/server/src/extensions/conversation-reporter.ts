// Reports one conversation submission back to the conversation that requested it.
import {
  AssistantEntry,
  defineDocFamily,
  defineTask,
  type ConversationId,
  type EntryId,
  type InputEntry,
  type SubmissionId,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";

/** Private request receipts prevent duplicate tasks when a client retries. */
export const InputRequests = defineDocFamily<{ taskId?: TaskId }, null>({
  kind: "anima.input-request", version: 2, scope: "conversation", family: true,
  history: "latest", fork: "initial", initial: () => ({}), checkpointWhen: () => false,
  migrate: (value) => {
    const taskId = value.taskId ?? value.routingTaskId ?? value.reporterTaskId;
    return typeof taskId === "number" ? { taskId: taskId as TaskId } : {};
  }
});

/** Every reporter has the same background ownership boundary. */
export function createReporter(tx: Tx, input: ReporterInput) {
  return tx.createTask(ConversationReporter, input, { ownership: { kind: "conversation" }, background: true });
}

type ReporterInput = {
  conversationId: ConversationId;
  message: string;
  name?: string;
  requestId?: string;
  whenBusy?: "followUp" | "steer" | "reject";
  entry?: InputEntry;
  inputEntryId?: EntryId;
  routingTaskId?: TaskId;
  reportToCaller?: boolean;
};
type ReporterCheckpoint = { phase: "deliver" } | { phase: "report"; report?: string; submissionId?: SubmissionId };

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
        whenBusy: task.input.whenBusy ?? "steer",
        entry: task.input.entry ?? {
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
        // A queued input may have been edited in place. Report what was actually delivered.
        const delivered = settled.entry === undefined ? undefined : await tx.entry(settled.entry);
        const input = delivered?.model?.find(message => message.role === "user");
        const instruction = input?.role === "user"
          ? typeof input.content === "string" ? input.content : input.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
          : task.input.message;
        let report: string | undefined;
        const source = task.input.name === undefined
          ? `conversation ${task.input.conversationId}`
          : `subagent ${JSON.stringify(task.input.name)}`;
        if (settled.status === "unanswered") {
          if (settled.reason !== "aborted") {
            report = `[${source} failed: ${settled.reason}]${settled.detail ? `\n${settled.detail}` : ""}` +
              `\n\nInstruction:\n${instruction}`;
          }
        } else if (settled.type === "input") {
          const message = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0];
          const text = message?.role === "assistant"
            ? message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")
            : "";
          report = `[${source} completed]\n\nInstruction answered:\n${instruction}` +
            `\n\nResult:\n${text || "Completed without a text response."}`;
        }
        if (task.input.routingTaskId !== undefined) {
          await tx.appendEntry(runtime.conversationId, {
            kind: "anima.routing-settled",
            data: {
              routingTaskId: String(task.input.routingTaskId),
              ...(task.input.inputEntryId === undefined ? {} : { inputEntryId: String(task.input.inputEntryId) }),
              conversationId: String(task.input.conversationId), submissionId: String(submission.id),
              status: settled.status,
              ...(settled.status === "unanswered" ? { reason: settled.reason } : {}),
            },
          });
        }
        return {
          status: "running",
          checkpoint: { phase: "report", submissionId: submission.id, ...(report === undefined ? {} : { report }) },
        };
      }, context);
    },
    report: async (task, runtime, context) => {
      const report = task.state.checkpoint.report;
      if (report !== undefined && task.input.reportToCaller !== false) {
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
              ...(task.state.checkpoint.submissionId === undefined ? {} : {
                sourceSubmissionId: String(task.state.checkpoint.submissionId),
              }),
              ...(task.input.inputEntryId === undefined ? {} : { inputEntryId: String(task.input.inputEntryId) }),
              ...(task.input.routingTaskId === undefined ? {} : { routingTaskId: String(task.input.routingTaskId) }),
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
