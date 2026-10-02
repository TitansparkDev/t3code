// @effect-diagnostics globalDate:off - local wall-clock schedules are the thing under test.
import { describe, expect, it } from "vite-plus/test";

import { ProjectId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  isScheduledTaskDue,
  nextScheduledRunAt,
  previousScheduledRunAt,
  scheduledTimesOfDay,
  ScheduledTaskId,
  SCHEDULED_TASK_GRACE_MS,
  type ScheduledTask,
  type ScheduledTaskSchedule,
} from "./scheduledTasks.ts";

/**
 * Schedules are local wall-clock, so the tests build their instants the same
 * way the implementation reads them rather than hardcoding UTC offsets.
 */
function localMs(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute?: number;
}): number {
  return new Date(
    input.year,
    input.month - 1,
    input.day,
    input.hour,
    input.minute ?? 0,
    0,
    0,
  ).getTime();
}

const everyDayAt5 = { timeOfDay: "05:00", daysOfWeek: [] } satisfies ScheduledTaskSchedule;
// 2026-08-31 is a Monday.
const mondaysAt5 = { timeOfDay: "05:00", daysOfWeek: [1] } satisfies ScheduledTaskSchedule;

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: ScheduledTaskId.make("task-1"),
    name: "Open the window",
    prompt: "Say hello.",
    projectId: ProjectId.make("project-1"),
    targets: [{ instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" }],
    schedule: everyDayAt5,
    enabled: true,
    runtimeMode: "full-access",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("schedule arithmetic", () => {
  it("finds the next daily slot after a given instant", () => {
    const noon = localMs({ year: 2026, month: 8, day: 31, hour: 12 });
    expect(nextScheduledRunAt(everyDayAt5, noon)).toBe(
      localMs({ year: 2026, month: 9, day: 1, hour: 5 }),
    );
  });

  it("skips days the schedule does not include", () => {
    const mondayNoon = localMs({ year: 2026, month: 8, day: 31, hour: 12 });
    expect(nextScheduledRunAt(mondaysAt5, mondayNoon)).toBe(
      localMs({ year: 2026, month: 9, day: 7, hour: 5 }),
    );
  });

  it("finds the slot that has most recently passed", () => {
    const mondayNoon = localMs({ year: 2026, month: 8, day: 31, hour: 12 });
    expect(previousScheduledRunAt(everyDayAt5, mondayNoon)).toBe(
      localMs({ year: 2026, month: 8, day: 31, hour: 5 }),
    );
  });
});

describe("isScheduledTaskDue", () => {
  const slot = localMs({ year: 2026, month: 8, day: 31, hour: 5 });

  it("fires once the slot has passed", () => {
    expect(isScheduledTaskDue(task(), slot + 60_000)).toBe(true);
  });

  it("does not fire before the slot", () => {
    expect(isScheduledTaskDue(task(), slot - 60_000)).toBe(false);
  });

  it("does not run the same slot twice", () => {
    const alreadyRan = task({
      lastRun: {
        at: new Date(slot + 1_000).toISOString(),
        outcome: "started",
        startedTargets: [ProviderInstanceId.make("codex")],
      },
    });
    expect(isScheduledTaskDue(alreadyRan, slot + 120_000)).toBe(false);
  });

  it("skips a slot missed by more than the grace window", () => {
    // The machine was asleep: honouring "start my 5am window" at noon spends
    // the window it existed to open, so the run is dropped, not delayed.
    expect(isScheduledTaskDue(task(), slot + SCHEDULED_TASK_GRACE_MS + 60_000)).toBe(false);
    expect(isScheduledTaskDue(task(), slot + SCHEDULED_TASK_GRACE_MS - 60_000)).toBe(true);
  });

  it("does not fire a slot that predates the task's own edit", () => {
    const justEdited = task({ updatedAt: new Date(slot + 60_000).toISOString() });
    expect(isScheduledTaskDue(justEdited, slot + 120_000)).toBe(false);
  });

  it("never fires while disabled", () => {
    expect(isScheduledTaskDue(task({ enabled: false }), slot + 60_000)).toBe(false);
  });
});

describe("repeating schedules", () => {
  // 05:00 then every five hours, five sends: 05, 10, 15, 20, and 01:00 next day.
  const fiveWindows = {
    timeOfDay: "05:00",
    daysOfWeek: [],
    repeat: { everyMinutes: 300, count: 5 },
  } satisfies ScheduledTaskSchedule;

  it("lists each send of the day, past midnight included", () => {
    expect(scheduledTimesOfDay(fiveWindows)).toEqual(["05:00", "10:00", "15:00", "20:00", "01:00"]);
    expect(scheduledTimesOfDay(everyDayAt5)).toEqual(["05:00"]);
  });

  it("fires at every repeat in order, including the one after midnight", () => {
    const morning = localMs({ year: 2026, month: 9, day: 1, hour: 4 });
    const sends: number[] = [];
    let cursor = morning;
    for (let index = 0; index < 6; index += 1) {
      cursor = nextScheduledRunAt(fiveWindows, cursor);
      sends.push(cursor);
    }
    expect(sends).toEqual([
      localMs({ year: 2026, month: 9, day: 1, hour: 5 }),
      localMs({ year: 2026, month: 9, day: 1, hour: 10 }),
      localMs({ year: 2026, month: 9, day: 1, hour: 15 }),
      localMs({ year: 2026, month: 9, day: 1, hour: 20 }),
      localMs({ year: 2026, month: 9, day: 2, hour: 1 }),
      localMs({ year: 2026, month: 9, day: 2, hour: 5 }),
    ]);
  });

  it("finds the latest repeat that has passed", () => {
    expect(
      previousScheduledRunAt(fiveWindows, localMs({ year: 2026, month: 9, day: 2, hour: 2 })),
    ).toBe(localMs({ year: 2026, month: 9, day: 2, hour: 1 }));
    expect(
      previousScheduledRunAt(fiveWindows, localMs({ year: 2026, month: 9, day: 1, hour: 12 })),
    ).toBe(localMs({ year: 2026, month: 9, day: 1, hour: 10 }));
  });

  it("keeps repeats on the start day's weekday rule", () => {
    const mondayWindows = { ...fiveWindows, daysOfWeek: [1] } satisfies ScheduledTaskSchedule;
    // Monday's 20:00 send leads to Tuesday 01:00, then next Monday 05:00.
    const afterMondayEvening = localMs({ year: 2026, month: 8, day: 31, hour: 21 });
    expect(nextScheduledRunAt(mondayWindows, afterMondayEvening)).toBe(
      localMs({ year: 2026, month: 9, day: 1, hour: 1 }),
    );
    expect(
      nextScheduledRunAt(mondayWindows, localMs({ year: 2026, month: 9, day: 1, hour: 2 })),
    ).toBe(localMs({ year: 2026, month: 9, day: 7, hour: 5 }));
  });

  it("is due once per repeat and never replays a missed earlier send", () => {
    const repeating = task({
      schedule: fiveWindows,
      updatedAt: new Date(localMs({ year: 2026, month: 8, day: 30, hour: 0 })).toISOString(),
    });
    const at10 = localMs({ year: 2026, month: 9, day: 1, hour: 10, minute: 1 });
    expect(isScheduledTaskDue(repeating, at10)).toBe(true);
    const ranAt10 = task({
      ...repeating,
      lastRun: { at: new Date(at10).toISOString(), outcome: "started", startedTargets: [] },
    });
    expect(isScheduledTaskDue(ranAt10, at10 + 60_000)).toBe(false);
    expect(isScheduledTaskDue(ranAt10, localMs({ year: 2026, month: 9, day: 1, hour: 15 }))).toBe(
      true,
    );
  });
});
