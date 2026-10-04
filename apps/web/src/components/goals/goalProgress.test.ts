import { describe, expect, it } from "vite-plus/test";

import { describeGoalProgress } from "./goalProgress";

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
      "2 of 3 working · 1 finished · 1 failed · 1 waiting for a usage limit · 4 of up to 50 started",
    );
  });

  it("shows chats that need the person", () => {
    expect(
      describeGoalProgress({
        concurrency: 2,
        maxChats: null,
        chats: [chat("attention"), chat("running")],
      }),
    ).toBe("1 of 2 working · 0 finished · 1 need you · 2 started, until complete");
  });

  it("says when there is no cap", () => {
    expect(describeGoalProgress({ concurrency: 2, maxChats: null, chats: [chat("running")] })).toBe(
      "1 of 2 working · 0 finished · 1 started, until complete",
    );
  });

  it("leaves out failures and waits when there are none", () => {
    expect(describeGoalProgress({ concurrency: 1, maxChats: 5, chats: [chat("running")] })).toBe(
      "1 of 1 working · 0 finished · 1 of up to 5 started",
    );
  });
});
