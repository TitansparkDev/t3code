import { describe, expect, it } from "vite-plus/test";

import { describeGoalProgress } from "./goalProgress";

const chat = (status: string, waitingForLimit?: boolean) =>
  ({ status, ...(waitingForLimit ? { waitingForLimit } : {}) }) as never;

describe("describeGoalProgress", () => {
  it("counts working, finished, failed, and waiting chats", () => {
    expect(
      describeGoalProgress({
        lanes: 3,
        maxChats: 50,
        chats: [chat("completed"), chat("running"), chat("running", true), chat("failed")],
      }),
    ).toBe(
      "2 of 3 working · 1 finished · 1 failed · 1 waiting for a usage limit · 4 of up to 50 chats",
    );
  });

  it("leaves out failures and waits when there are none", () => {
    expect(describeGoalProgress({ lanes: 1, maxChats: 5, chats: [chat("running")] })).toBe(
      "1 of 1 working · 0 finished · 1 of up to 5 chats",
    );
  });
});
