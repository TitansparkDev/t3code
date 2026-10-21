import { describe, expect, it } from "vite-plus/test";

import {
  describeGoalPauses,
  describeGoalProgress,
  describeGoalQueue,
  isEscalationOpen,
  sortEscalationsNewestFirst,
} from "./goalProgress.ts";

const chat = (status: string, waitingForLimit?: boolean) =>
  ({ status, ...(waitingForLimit ? { waitingForLimit } : {}) }) as never;

describe("describeGoalProgress", () => {
  it("counts working, finished, failed, and waiting chats", () => {
    expect(
      describeGoalProgress({
        concurrency: 3,
        maxChats: 50,
        chats: [chat("completed"), chat("running"), chat("running", true), chat("failed")],
      }),
    ).toBe(
      "2 of 3 running · 1 completed · 1 failed · 1 waiting for a usage limit · 4 of up to 50 started",
    );
  });

  it("shows chats that need the person", () => {
    expect(
      describeGoalProgress({
        concurrency: 2,
        maxChats: null,
        chats: [chat("attention"), chat("running")],
      }),
    ).toBe("1 of 2 running · 0 completed · 1 need you · 2 started, until complete");
  });

  it("says when there is no cap", () => {
    expect(describeGoalProgress({ concurrency: 2, maxChats: null, chats: [chat("running")] })).toBe(
      "1 of 2 running · 0 completed · 1 started, until complete",
    );
  });

  it("leaves out failures and waits when there are none", () => {
    expect(describeGoalProgress({ concurrency: 1, maxChats: 5, chats: [chat("running")] })).toBe(
      "1 of 1 running · 0 completed · 1 of up to 5 started",
    );
  });
});

describe("describeGoalQueue", () => {
  it("says nothing without AgentQueue progress", () => {
    expect(describeGoalQueue({})).toBeUndefined();
  });
});

describe("describeGoalQueue when ready tasks cannot start", () => {
  const progress = {
    total: 77,
    completed: 67,
    ready: 4,
    waiting: 2,
    running: 1,
    awaitingIntegration: 1,
    needsRepair: 0,
    failed: 2,
    phase: "implementing",
    checkedAt: "2026-10-14T03:00:00Z",
  } as const;
  const agentQueue = { planPath: "PLAN.md", baseBranch: "main" } as never;

  it("says what blocks them instead of that agents are working", () => {
    const text = describeGoalQueue({
      agentQueue,
      queueProgress: {
        ...progress,
        stall: {
          since: "2026-10-14T02:55:00Z",
          summary: "NR1, NR3 waiting for files held by NR2-FU1",
          taskIds: ["NR1", "NR3"],
        },
      },
    });
    expect(text).toContain("Stalled: NR1, NR3 waiting for files held by NR2-FU1");
    expect(text).not.toContain("Agents are working");
  });

  it("is unchanged when nothing is blocked", () => {
    expect(describeGoalQueue({ agentQueue, queueProgress: progress })).toContain(
      "Agents are working",
    );
  });
});

describe("describeGoalPauses", () => {
  it("lists providers still set aside, and drops the ones whose time has passed", () => {
    const goal = {
      pauses: [
        { instanceId: "codex", until: "2026-10-09T00:00:00.000Z", reason: "usage-limit" },
        {
          instanceId: "gemini",
          model: "flash",
          until: "2026-10-09T01:00:00.000Z",
          reason: "errors",
        },
        { instanceId: "old", until: "2026-10-01T00:00:00.000Z", reason: "usage-limit" },
      ],
    } as never;
    expect(
      describeGoalPauses(
        goal,
        Date.parse("2026-10-04T00:00:00.000Z"),
        (id) => id.toUpperCase(),
        (iso) => iso.slice(5, 10),
      ),
    ).toEqual([
      "CODEX is set aside (usage limit) until 10-09",
      "GEMINI flash is set aside (recent failures) until 10-09",
    ]);
  });
});

describe("sortEscalationsNewestFirst", () => {
  it("puts the latest escalation first without changing the input", () => {
    const older = { id: "a", createdAt: "2026-10-20T10:00:00.000Z" };
    const newer = { id: "b", createdAt: "2026-10-21T09:00:00.000Z" };
    const input = [older, newer];
    expect(sortEscalationsNewestFirst(input).map((item) => item.id)).toEqual(["b", "a"]);
    expect(input.map((item) => item.id)).toEqual(["a", "b"]);
  });
});

describe("isEscalationOpen", () => {
  it("treats only resolved and cancelled escalations as closed", () => {
    expect(
      ["open", "reviewing", "needs-person", "resolved", "cancelled"].map((status) =>
        isEscalationOpen({ status: status as never }),
      ),
    ).toEqual([true, true, true, false, false]);
  });
});
