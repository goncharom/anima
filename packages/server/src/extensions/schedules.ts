import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { ScheduleAction, ScheduleInfoSchema, ScheduleStatus, type ScheduleInfo } from "@anima/protocol-ts";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { obj, str, arr, opt, bool } from "@earendil-works/pi-schema";
import {
  configure, defineDoc, defineSignal, defineTask, defineTool,
  ConversationBusy, type ConversationId, type Harness, type TaskId,
} from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord/context";
import { ConversationsDoc, registerConversation } from "./conversations.ts";

const MAX_SCHEDULES = 100;
const MAX_TOOLS = 20;
const MAX_INSTRUCTION = 10_000;
const MAX_CRON = 100;
const MAX_NAME = 120;

type ScheduleRecord = {
  scheduleId: string;
  name: string;
  cron: string;
  timezone: string;
  instruction: string;
  tools: string[];
  status: ScheduleStatus;
  sourceConversationId: string;
  conversationId?: string;
  taskId?: TaskId;
  nextRunAt?: string;
  error?: string;
  proposalTaskId?: string;
};

const ScheduleCancellation = defineSignal({
  name: "anima.schedule-cancelled", version: 1, schema: obj({ cancelled: bool() }),
});

/** Session-owned schedule metadata; tasks and runner conversations own execution state/history. */
const SchedulesDoc = defineDoc<{ schedules: Record<string, ScheduleRecord> }>({
  kind: "anima.schedules", version: 1, scope: "session",
  initial: () => ({ schedules: {} }), checkpointWhen: () => false,
});

type JobInput = { scheduleId: string; conversationId: ConversationId; firstRunAt: number };
type JobCheckpoint = { phase: "sleep"; until: number } | { phase: "fire"; dueAt: number };

/** One background durable task per schedule. Its absolute sleeps survive process downtime and Harness reopen. */
export const ScheduledJob = defineTask<JobInput, JobCheckpoint, null>({
  name: "anima.scheduled-job",
  version: 1,
  initial: (input) => ({ phase: "sleep", until: input.firstRunAt }),
  phases: {
    sleep: (task, runtime, context) => runtime.commit(
      () => sleepUntil(task.input.scheduleId, task.state.checkpoint.until), context,
    ),
    fire: async (task, runtime, context) => {
      const { scheduleId, conversationId } = task.input;
      const runner = await runtime.conversation(conversationId, context);
      await runtime.commit(async tx => {
        const schedule = (await tx.doc(SchedulesDoc)).schedules[scheduleId];
        if (!schedule || schedule.status !== ScheduleStatus.ACTIVE) {
          return { status: "terminal", outcome: { status: "aborted" } };
        }
        if (!runner) throw new Error("Scheduled conversation is unavailable");
        const now = runtime.now();
        const { dueAt } = task.state.checkpoint;
        if (now < dueAt) return sleepUntil(scheduleId, dueAt);
        const occurrence = latestMissed(schedule.cron, schedule.timezone, dueAt, now);
        const next = nextAfter(schedule.cron, schedule.timezone, now);
        const scheduledAt = new Date(occurrence).toISOString();
        const content = `# Scheduled job: ${schedule.name}\n\nScheduled at ${scheduledAt} (${schedule.timezone}).\n\n${schedule.instruction}`;
        try {
          // Admission comes before table writes and commits atomically with the next sleep.
          await runner.submit(tx, {
            type: "input", content, requestId: `schedule:${scheduleId}:${scheduledAt}`, whenBusy: "reject",
            entry: { kind: "anima.scheduled-message", data: { origin: "schedule", scheduleId, scheduledAt, content } },
          });
        } catch (error) {
          // Busy rejection writes nothing; skip this occurrence rather than build a backlog.
          if (!(error instanceof ConversationBusy)) throw error;
        }
        schedule.nextRunAt = new Date(next).toISOString();
        return sleepUntil(scheduleId, next);
      }, context);
    },
  },
  abort: (_task, runtime, context) => runtime.commit(
    () => ({ status: "terminal", outcome: { status: "aborted" } }), context,
  ),
});

const proposeSchedule = defineTool({
  name: "schedule_job",
  description:
    "Propose a recurring model job for human review. This only creates a PENDING proposal; it cannot activate a job. " +
    "The user must approve it in the Schedules UI. Each approved job runs in its own dedicated conversation, never in this source conversation. " +
    "Selected MCP tool names identify capabilities, not read-only behavior: review every name and its effects before approval. " +
    "Use an empty tools list for pure model work. Do not schedule high-frequency or unbounded work.",
  parameters: obj({
    name: str({ minLength: 1, maxLength: MAX_NAME, description: "Short visible name for the recurring job." }),
    cron: str({ minLength: 1, maxLength: MAX_CRON, description: "Five-field cron expression." }),
    timezone: str({ minLength: 1, maxLength: 100, description: "IANA timezone, such as Europe/London." }),
    instruction: str({ minLength: 1, maxLength: MAX_INSTRUCTION, description: "Self-contained instruction for each occurrence." }),
    tools: opt(arr(str({ minLength: 1, maxLength: 64 }), { maxItems: MAX_TOOLS })),
  }, { open: true }),
  replay: "safe",
  execute: async ({ name, cron, timezone, instruction, tools = [] }, api, context) => {
    const normalizedName = validateText(name, "name", MAX_NAME);
    const normalizedInstruction = validateText(instruction, "instruction", MAX_INSTRUCTION);
    validateCron(cron, timezone);
    if (tools.length > MAX_TOOLS || new Set(tools).size !== tools.length) {
      throw new Error(`Choose at most ${MAX_TOOLS} unique installed MCP tool names`);
    }
    const installed = new Set(api.registry.tools()
      .filter(({ extension }) => extension.name === "mcp")
      .map(({ tool }) => tool.name));
    if (tools.some((tool) => !installed.has(tool))) {
      throw new Error("Every selected tool must be an installed MCP tool; reload available tool names and retry");
    }
    const proposed = await api.commit(async (tx) => {
      const directory = await tx.doc(SchedulesDoc);
      const prior = Object.values(directory.schedules).find((item) => item.proposalTaskId === String(api.taskId));
      if (prior) return prior.scheduleId;
      const count = Object.values(directory.schedules).filter((item) =>
        item.status === ScheduleStatus.PENDING || item.status === ScheduleStatus.ACTIVE).length;
      if (count >= MAX_SCHEDULES) throw new Error(`At most ${MAX_SCHEDULES} pending or active schedules are allowed`);
      const scheduleId = randomUUID();
      directory.schedules[scheduleId] = {
        scheduleId, name: normalizedName, cron, timezone, instruction: normalizedInstruction,
        tools: [...tools], status: ScheduleStatus.PENDING,
        sourceConversationId: String(api.conversationId), proposalTaskId: String(api.taskId),
      };
      return scheduleId;
    }, context);
    const scheduleId = proposed;
    return {
      output: [{ type: "text", text: JSON.stringify({ scheduleId, status: "PENDING", message: "Review and approve this proposal in the Schedules UI; it is not active yet." }) }],
      details: { scheduleId, status: "PENDING" },
    };
  },
});

export const ScheduleTools = [proposeSchedule];
export const ScheduledJobs = [ScheduledJob];

export function listSchedules(harness: Harness, context: Context): Promise<ScheduleInfo[]> {
  return harness.commit(async tx => {
    const { schedules } = await tx.doc(SchedulesDoc);
    const jobs = Object.values(schedules).sort((a, b) => a.name.localeCompare(b.name) || a.scheduleId.localeCompare(b.scheduleId));
    return Promise.all(jobs.map(async job => {
      if (job.status === ScheduleStatus.ACTIVE && job.taskId !== undefined) {
        const task = await tx.task(job.taskId);
        if (!task || task.state.status === "terminal") {
          const outcome = task?.state.status === "terminal" ? task.state.outcome : undefined;
          job.status = ScheduleStatus.FAILED;
          job.error = (outcome?.error?.message ?? outcome?.reason ?? "The schedule task is no longer running.").slice(0, 2_000);
          delete job.nextRunAt;
        }
      }
      return toInfo(job);
    }));
  }, context);
}

export async function updateSchedule(
  harness: Harness,
  scheduleId: string,
  action: ScheduleAction,
  models: Models | undefined,
  context: Context,
): Promise<ScheduleInfo> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(scheduleId)) {
    throw new ConnectError("Invalid schedule ID", Code.InvalidArgument);
  }
  if (action === ScheduleAction.CANCEL) {
    return harness.commit(async tx => {
      const schedule = (await tx.doc(SchedulesDoc)).schedules[scheduleId];
      if (!schedule) throw new ConnectError("Schedule not found", Code.NotFound);
      if (schedule.status === ScheduleStatus.PENDING || schedule.status === ScheduleStatus.ACTIVE) {
        if (schedule.taskId !== undefined && schedule.nextRunAt !== undefined) {
          await tx.signal(
            schedule.taskId, ScheduleCancellation,
            `${schedule.scheduleId}:${schedule.nextRunAt}`, { cancelled: true },
          );
        }
        schedule.status = ScheduleStatus.CANCELLED;
        delete schedule.nextRunAt;
      }
      return toInfo(schedule);
    }, context);
  }
  if (action !== ScheduleAction.APPROVE) {
    throw new ConnectError("Unknown schedule action", Code.InvalidArgument);
  }
  const current = await harness.commit(async tx => {
    const schedule = (await tx.doc(SchedulesDoc)).schedules[scheduleId];
    if (!schedule) throw new ConnectError("Schedule not found", Code.NotFound);
    return toInfo(schedule);
  }, context);
  if (current.status !== ScheduleStatus.PENDING) return current;
  if (!models) throw new ConnectError("The server model catalog is unavailable", Code.FailedPrecondition);
  const source = await harness.conversation(Number(current.sourceConversationId) as ConversationId, context);
  if (!source) throw new ConnectError("Source conversation is unavailable", Code.FailedPrecondition);
  const sourceAgent = await source.agent(context);
  const model = sourceAgent.model;
  if (!model) throw new ConnectError("Source conversation has no configured model", Code.FailedPrecondition);
  const available = await models.getAvailableOfType("chat", model.provider, { signal: context.abortSignal });
  if (!available.some(candidate => candidate.provider === model.provider && candidate.id === model.modelId)) {
    throw new ConnectError("Source conversation model is unavailable", Code.FailedPrecondition);
  }
  const firstRunAt = nextAfter(current.cron, current.timezone, Date.now());
  const approved = await harness.commit(async (tx) => {
    const directory = await tx.doc(SchedulesDoc);
    const schedule = directory.schedules[scheduleId];
    if (!schedule) throw new ConnectError("Schedule not found", Code.NotFound);
    if (schedule.status !== ScheduleStatus.PENDING) return { ...schedule, tools: [...schedule.tools] };
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    const runnerId = conversation.id;
    const info = await registerConversation(tx, conversation);
    info.name = `Cron · ${schedule.name}`;
    const selectedTools = [...schedule.tools];
    const mcpExtension = sourceAgent.extensions.find((extension) => extension.name === "mcp");
    const registrations = selectedTools.map((name) => mcpExtension?.tools?.find((tool) => tool.name === name));
    if (selectedTools.length && (!mcpExtension || registrations.some((tool) => tool === undefined))) {
      throw new ConnectError("A selected MCP tool is no longer available", Code.FailedPrecondition);
    }
    const selectedRegistrations = registrations.filter((tool): tool is NonNullable<typeof tool> => tool !== undefined);
    await configure(tx, runnerId, {
      model: sourceAgent.model,
      cwd: sourceAgent.cwd,
      thinkingLevel: sourceAgent.thinkingLevel,
      extensions: mcpExtension && selectedTools.length ? [mcpExtension] : [],
      tools: selectedRegistrations,
      modelTools: selectedRegistrations,
      instructions: [
        `You are a dedicated recurring-job runner for ${JSON.stringify(schedule.name)}.`,
        "This is a separate conversation for this recurring job. Do not report, message, or write results to its source conversation.",
        "Only the explicitly selected MCP tools are available. Tool names describe capabilities, not safety or read-only guarantees; inspect the tool description and use the minimum necessary.",
        "Do not use shell, codemode, subagents, or scheduling tools.",
      ].join(" "),
    });
    schedule.status = ScheduleStatus.ACTIVE;
    schedule.conversationId = String(runnerId);
    schedule.nextRunAt = new Date(firstRunAt).toISOString();
    delete schedule.error;
    schedule.taskId = await tx.createTask(ScheduledJob, {
      scheduleId, conversationId: runnerId, firstRunAt,
    }, { conversationId: runnerId, ownership: { kind: "conversation" }, background: true });
    return { ...schedule, tools: [...schedule.tools] };
  }, context);
  return toInfo(approved);
}

function toInfo(schedule: ScheduleRecord): ScheduleInfo {
  return create(ScheduleInfoSchema, {
    scheduleId: schedule.scheduleId, name: schedule.name, cron: schedule.cron,
    timezone: schedule.timezone, instruction: schedule.instruction, tools: [...schedule.tools],
    status: schedule.status, sourceConversationId: schedule.sourceConversationId,
    ...(schedule.conversationId === undefined ? {} : { conversationId: schedule.conversationId }),
    ...(schedule.nextRunAt === undefined ? {} : { nextRunAt: schedule.nextRunAt }),
    ...(schedule.error === undefined ? {} : { error: schedule.error }),
  });
}

function validateText(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(normalized)) {
    throw new Error(`${label} must be 1–${max} characters without control characters`);
  }
  return normalized;
}

function validateCron(cron: string, timezone: string): void {
  if (cron.trim().split(/\s+/).length !== 5) throw new Error("Cron must contain exactly five fields");
  if (cron.includes("@") || /(?:^|[\s,*/(-])H(?=$|[\s,*/)(-])/i.test(cron)) {
    throw new Error("Cron macros and randomized H fields are not supported");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    nextAfter(cron, timezone, Date.now());
  } catch (error) {
    throw new Error(`Invalid cron expression or IANA timezone: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sleepUntil(scheduleId: string, until: number) {
  return {
    status: "sleeping", until,
    signals: [ScheduleCancellation.key(`${scheduleId}:${new Date(until).toISOString()}`)],
    checkpoint: { phase: "fire", dueAt: until },
  } as const;
}

function nextAfter(cron: string, timezone: string, timestamp: number): number {
  return CronExpressionParser.parse(cron, { tz: timezone, currentDate: new Date(timestamp) }).next().getTime();
}

/** Select the most recent due occurrence, dropping older downtime backlog without dropping the newest missed run. */
function latestMissed(cron: string, timezone: string, dueAt: number, now: number): number {
  const expression = CronExpressionParser.parse(cron, { tz: timezone, currentDate: new Date(now + 1) });
  const latest = expression.prev().getTime();
  return latest >= dueAt ? latest : dueAt;
}
