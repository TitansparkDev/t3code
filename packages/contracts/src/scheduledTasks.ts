// @effect-diagnostics globalDate:off - schedules are local wall-clock by design; the clock is injectable.
/**
 * Scheduled tasks — prompts an environment sends on its own clock.
 *
 * The use case this exists for: an always-on machine that must open a
 * provider's rolling usage window at a chosen time, on chosen accounts,
 * without anybody being awake to type. A task therefore names *what* to send,
 * *who* to send it to (one or more configured provider instances), and *when*.
 *
 * Fork-local (OmniCode). Kept in its own file so it never conflicts with
 * upstream edits to `orchestration.ts`. See `OMNI.md`.
 *
 * Two deliberate constraints:
 *
 *  - **The environment's own clock decides.** A time is a wall-clock time on
 *    the machine running the server, not the client's. A phone in another
 *    timezone must not silently move when a window opens.
 *  - **Runs are archived, not deleted.** Each run is a real thread with real
 *    history, archived as soon as its turn goes quiet so it stays out of the
 *    thread list; run history links to it. A run blocked on an approval keeps
 *    its session busy, so it is not archived while it needs a human.
 *
 * @module scheduledTasks
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderOptionSelections } from "./model.ts";
import { RuntimeMode } from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { QuotaUsedPercent } from "./quota.ts";

export const ScheduledTaskId = Schema.String.pipe(Schema.brand("ScheduledTaskId"));
export type ScheduledTaskId = typeof ScheduledTaskId.Type;

/** `HH:MM` on a 24-hour clock, in the server environment's local time. */
export const ScheduledTaskTimeOfDay = Schema.String.check(
  Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
);
export type ScheduledTaskTimeOfDay = typeof ScheduledTaskTimeOfDay.Type;

/** `0` is Sunday, matching `Date#getDay`. An empty list means every day. */
export const ScheduledTaskDayOfWeek = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 6 }),
);

/**
 * Extra sends after the first one on the same day, e.g. every five hours so
 * each send opens the next usage window. Repeats may run past midnight; they
 * still belong to the day whose start time began them.
 */
export const ScheduledTaskRepeat = Schema.Struct({
  everyMinutes: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 15, maximum: 1440 }),
  ),
  /** Total sends per day, including the first. */
  count: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 24 })),
});
export type ScheduledTaskRepeat = typeof ScheduledTaskRepeat.Type;

export const ScheduledTaskSchedule = Schema.Struct({
  /** The first send of the day. */
  timeOfDay: ScheduledTaskTimeOfDay,
  daysOfWeek: Schema.Array(ScheduledTaskDayOfWeek),
  repeat: Schema.optional(ScheduledTaskRepeat),
});
export type ScheduledTaskSchedule = typeof ScheduledTaskSchedule.Type;

/**
 * One account the prompt goes to.
 *
 * The model is stored per target because the point of running the same prompt
 * on two accounts is usually that they are two different subscriptions.
 */
export const ScheduledTaskTarget = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  /** Provider-native options, such as Codex reasoning effort. */
  options: Schema.optional(ProviderOptionSelections),
});
export type ScheduledTaskTarget = typeof ScheduledTaskTarget.Type;

export const ScheduledTaskRunOutcome = Schema.Literals(["started", "failed", "skipped"]);
export type ScheduledTaskRunOutcome = typeof ScheduledTaskRunOutcome.Type;

/** What happened the last time a task fired. Absent until it has run once. */
export const ScheduledTaskLastRun = Schema.Struct({
  at: IsoDateTime,
  outcome: ScheduledTaskRunOutcome,
  /** Threads the run created, one per target that started. */
  startedTargets: Schema.Array(ProviderInstanceId),
  detail: Schema.optional(TrimmedNonEmptyString),
});
export type ScheduledTaskLastRun = typeof ScheduledTaskLastRun.Type;

export const ScheduledTaskRunTrigger = Schema.Literals(["scheduled", "manual"]);
export type ScheduledTaskRunTrigger = typeof ScheduledTaskRunTrigger.Type;

export const ScheduledTaskRunTargetStatus = Schema.Literals([
  "starting",
  "running",
  "completed",
  "failed",
  "skipped",
]);
export type ScheduledTaskRunTargetStatus = typeof ScheduledTaskRunTargetStatus.Type;

export const ScheduledTaskWindowStatus = Schema.Literals(["opened", "active", "unverified"]);

/** The provider's five-hour window as observed when a run finished. */
export const ScheduledTaskRunQuota = Schema.Struct({
  usedPercent: QuotaUsedPercent,
  remainingPercent: QuotaUsedPercent,
  resetsAt: Schema.optional(IsoDateTime),
  observedAt: IsoDateTime,
});
export type ScheduledTaskRunQuota = typeof ScheduledTaskRunQuota.Type;

export const ScheduledTaskRunTarget = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optional(ProviderOptionSelections),
  threadId: Schema.optional(TrimmedNonEmptyString),
  status: ScheduledTaskRunTargetStatus,
  startedAt: Schema.optional(IsoDateTime),
  completedAt: Schema.optional(IsoDateTime),
  durationMs: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  quota5h: Schema.optional(ScheduledTaskRunQuota),
  windowStatus: Schema.optional(ScheduledTaskWindowStatus),
  detail: Schema.optional(TrimmedNonEmptyString),
});
export type ScheduledTaskRunTarget = typeof ScheduledTaskRunTarget.Type;

export const ScheduledTaskRunStatus = Schema.Literals([
  "running",
  "completed",
  "failed",
  "skipped",
]);
export type ScheduledTaskRunStatus = typeof ScheduledTaskRunStatus.Type;

export const ScheduledTaskRun = Schema.Struct({
  id: TrimmedNonEmptyString,
  trigger: ScheduledTaskRunTrigger,
  status: ScheduledTaskRunStatus,
  startedAt: IsoDateTime,
  scheduledFor: Schema.optional(IsoDateTime),
  completedAt: Schema.optional(IsoDateTime),
  targets: Schema.Array(ScheduledTaskRunTarget),
  detail: Schema.optional(TrimmedNonEmptyString),
});
export type ScheduledTaskRun = typeof ScheduledTaskRun.Type;

export const ScheduledTaskRunUpdate = Schema.Struct({
  status: Schema.optional(ScheduledTaskRunStatus),
  completedAt: Schema.optional(IsoDateTime),
  targets: Schema.optional(Schema.Array(ScheduledTaskRunTarget)),
  detail: Schema.optional(TrimmedNonEmptyString),
});
export type ScheduledTaskRunUpdate = typeof ScheduledTaskRunUpdate.Type;

export const ScheduledTask = Schema.Struct({
  id: ScheduledTaskId,
  name: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  /**
   * Workspace the run happens in. Absent runs in the server's own
   * scheduled-tasks folder, for prompts that need no repository.
   */
  projectId: Schema.optional(ProjectId),
  targets: Schema.Array(ScheduledTaskTarget),
  schedule: ScheduledTaskSchedule,
  enabled: Schema.Boolean,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastRun: Schema.optional(ScheduledTaskLastRun),
  /** Newest first; older servers may omit this field. */
  runHistory: Schema.optional(Schema.Array(ScheduledTaskRun)),
});
export type ScheduledTask = typeof ScheduledTask.Type;

export const ScheduledTaskList = Schema.Struct({
  tasks: Schema.Array(ScheduledTask),
});
export type ScheduledTaskList = typeof ScheduledTaskList.Type;

/** Everything a client may set. The server owns ids, stamps and run history. */
export const ScheduledTaskDraft = Schema.Struct({
  /** Absent creates a task; present updates that one. */
  id: Schema.optional(ScheduledTaskId),
  name: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  targets: Schema.Array(ScheduledTaskTarget),
  schedule: ScheduledTaskSchedule,
  enabled: Schema.Boolean,
  runtimeMode: Schema.optional(RuntimeMode),
});
export type ScheduledTaskDraft = typeof ScheduledTaskDraft.Type;

const MINUTES_PER_DAY = 24 * 60;

/**
 * Every send `schedule` makes for the day `dayOffset` days from the day
 * containing `ms`, in order. Repeats step on the local wall clock, so a
 * five-hour repeat stays five hours of clock time across DST.
 */
function slotsForDay(
  schedule: ScheduledTaskSchedule,
  ms: number,
  dayOffset: number,
  makeDate: (ms: number) => Date,
): Date[] {
  const [hours, minutes] = schedule.timeOfDay.split(":").map(Number) as [number, number];
  const first = makeDate(ms);
  first.setDate(first.getDate() + dayOffset);
  first.setHours(hours, minutes, 0, 0);
  if (schedule.daysOfWeek.length > 0 && !schedule.daysOfWeek.includes(first.getDay())) return [];
  const slots = [first];
  const repeat = schedule.repeat;
  if (!repeat) return slots;
  // A day's repeats stop short of the next day's first send.
  for (let index = 1; index < repeat.count; index += 1) {
    const offsetMinutes = index * repeat.everyMinutes;
    if (offsetMinutes >= MINUTES_PER_DAY) break;
    const slot = new Date(first.getTime());
    slot.setMinutes(slot.getMinutes() + offsetMinutes);
    slots.push(slot);
  }
  return slots;
}

/** Local wall-clock times of every send in a day, for display. */
export function scheduledTimesOfDay(schedule: ScheduledTaskSchedule): string[] {
  const [hours, minutes] = schedule.timeOfDay.split(":").map(Number) as [number, number];
  const first = hours * 60 + minutes;
  const count = schedule.repeat?.count ?? 1;
  const every = schedule.repeat?.everyMinutes ?? MINUTES_PER_DAY;
  const times: string[] = [];
  for (let index = 0; index < count && index * every < MINUTES_PER_DAY; index += 1) {
    const total = (first + index * every) % MINUTES_PER_DAY;
    times.push(
      `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`,
    );
  }
  return times;
}

/**
 * Next time this schedule fires strictly after `afterMs`, as epoch ms.
 *
 * Local wall-clock, by design: "05:00" means five in the morning where the
 * server is, across DST changes, rather than a fixed offset that drifts an
 * hour twice a year. A schedule always fires within a week, so the bounded
 * scan is exact. Yesterday is scanned too because its repeats can run past
 * midnight.
 */
export function nextScheduledRunAt(
  schedule: ScheduledTaskSchedule,
  afterMs: number,
  makeDate: (ms: number) => Date = (ms) => new Date(ms),
): number {
  let next: number | undefined;
  for (let dayOffset = -1; dayOffset <= 7; dayOffset += 1) {
    for (const slot of slotsForDay(schedule, afterMs, dayOffset, makeDate)) {
      const at = slot.getTime();
      if (at > afterMs && (next === undefined || at < next)) next = at;
    }
  }
  return next ?? afterMs;
}

/** Most recent time this schedule fired at or before `atMs`, as epoch ms. */
export function previousScheduledRunAt(
  schedule: ScheduledTaskSchedule,
  atMs: number,
  makeDate: (ms: number) => Date = (ms) => new Date(ms),
): number | undefined {
  let previous: number | undefined;
  for (let dayOffset = 1; dayOffset >= -8; dayOffset -= 1) {
    for (const slot of slotsForDay(schedule, atMs, dayOffset, makeDate)) {
      const at = slot.getTime();
      if (at <= atMs && (previous === undefined || at > previous)) previous = at;
    }
  }
  return previous;
}

/** How late a missed run may still fire before it is skipped to the next slot. */
export const SCHEDULED_TASK_GRACE_MS = 60 * 60 * 1000;

/**
 * Whether a task should fire now.
 *
 * Driven by the most recent slot that has passed, not by counting forward from
 * the last run: a task whose machine was off for a week must fire once when it
 * comes back, not replay every slot it missed.
 *
 * The grace window is the other half of that. A "start my 5am window" prompt
 * firing at noon because the machine was asleep spends the window it existed
 * to open, so a slot older than the grace period is skipped rather than
 * honoured late.
 */
export function isScheduledTaskDue(
  task: ScheduledTask,
  nowMs: number,
  makeDate?: (ms: number) => Date,
): boolean {
  if (!task.enabled) return false;
  const slot = previousScheduledRunAt(task.schedule, nowMs, makeDate);
  if (slot === undefined) return false;
  if (nowMs - slot > SCHEDULED_TASK_GRACE_MS) return false;

  // Never run the same slot twice, and never fire a slot that predates the
  // edit that created or changed this task.
  const lastRunAt = Date.parse(task.lastRun?.at ?? "");
  if (!Number.isNaN(lastRunAt) && lastRunAt >= slot) return false;
  const updatedAt = Date.parse(task.updatedAt);
  if (!Number.isNaN(updatedAt) && updatedAt > slot) return false;
  return true;
}
