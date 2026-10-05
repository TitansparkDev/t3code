import { describe, expect, it } from "vite-plus/test";

import { describeGoalPauses, describeGoalProgress, describeGoalQueue } from "./goalProgress.ts";

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
  it("shows what Beads has ready and blocked", () => {
    const queue = {
      ready: 3,
      working: 14,
      blocked: 21,
      done: 26,
      checkedAt: "2026-10-04T12:00:00Z",
    };
    expect(describeGoalQueue({ useBeads: true, queue })).toBe(
      "Beads: 3 ready · 14 in progress · 21 blocked · 26 done",
    );
    expect(describeGoalQueue({ useBeads: false, queue })).toBeUndefined();
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
