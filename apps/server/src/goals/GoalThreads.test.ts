import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { goalThreadViewOf } from "./GoalThreads.ts";

const at = DateTime.makeUnsafe("2026-10-18T12:00:00.000Z");

const shell = (overrides: Record<string, unknown> = {}) =>
  ({
    latestRunId: "run-1",
    activeRunId: null,
    status: "completed",
    lastError: null,
    lastErrorClass: null,
    usageLimitResetAt: null,
    pendingBackgroundTasks: [],
    itemCount: 1,
    updatedAt: at,
    modelSelection: { instanceId: "codex", model: "gpt-6" },
    ...overrides,
  }) as never;

const projection = (
  runStatus: string,
  messages: ReadonlyArray<[string, string]> = [],
  turnItems: ReadonlyArray<{ type: string; nativeItemRef: unknown }> = [],
) =>
  ({
    messages: messages.map(([role, text]) => ({ role, text, streaming: false })),
    turnItems,
    runs: [
      {
        id: "run-1",
        status: runStatus,
        requestedAt: at,
        completedAt: runStatus === "running" ? null : at,
        checkpointId: runStatus === "completed" ? "checkpoint-1" : null,
      },
    ],
  }) as never;

it("reads a finished turn as completed, with its reply and a stored checkpoint", () => {
  const view = goalThreadViewOf(
    shell(),
    projection("completed", [
      ["user", "Go"],
      ["assistant", "Merged."],
    ]),
  );
  expect(view.latestTurn).toMatchObject({ turnId: "run-1", state: "completed" });
  expect(view.session).toMatchObject({ status: "ready", activeTurnId: null });
  expect(view.messages.at(-1)).toEqual({ role: "assistant", text: "Merged." });
  expect(view.madeProgress).toBe(true);
  expect(view.checkpointSaved).toBe(true);
});

it("reads an active run as a busy session with a running turn", () => {
  const view = goalThreadViewOf(
    shell({ activeRunId: "run-1", status: "running" }),
    projection("running"),
  );
  expect(view.session).toMatchObject({ status: "running", activeTurnId: "run-1" });
  expect(view.latestTurn?.state).toBe("running");
  expect(view.madeProgress).toBe(false);
});

it("carries a usage limit's class and reset time, and background work", () => {
  const view = goalThreadViewOf(
    shell({
      status: "failed",
      lastError: "You hit your usage limit",
      lastErrorClass: "usage_limit",
      usageLimitResetAt: "2026-10-18T15:00:00.000Z",
      pendingBackgroundTasks: [{ id: "task" }],
    }),
    projection("failed"),
  );
  expect(view.session).toMatchObject({
    status: "error",
    lastErrorClass: "usage_limit",
    retryAt: "2026-10-18T15:00:00.000Z",
  });
  expect(view.latestTurn?.state).toBe("error");
  expect(view.backgroundWork).toBe(true);
  expect(view.checkpointSaved).toBe(false);
});

it("treats an interrupted run as ended without an error", () => {
  const view = goalThreadViewOf(shell({ status: "interrupted" }), projection("interrupted"));
  expect(view.latestTurn?.state).toBe("interrupted");
  expect(view.session.status).toBe("ready");
});

it("does not count the prompt, workspace preparation and a provider error as progress", () => {
  const view = goalThreadViewOf(
    shell({ status: "failed", itemCount: 3 }),
    projection(
      "failed",
      [["user", "T3-OVERSEER/1"]],
      [
        { type: "user_message", nativeItemRef: null },
        { type: "command_execution", nativeItemRef: null },
        { type: "error", nativeItemRef: null },
      ],
    ),
  );
  expect(view.madeProgress).toBe(false);
});

it("counts a provider's own tool call as progress", () => {
  const view = goalThreadViewOf(
    shell({ status: "failed", itemCount: 2 }),
    projection(
      "failed",
      [["user", "Go"]],
      [
        { type: "user_message", nativeItemRef: null },
        { type: "command_execution", nativeItemRef: { id: "call-1" } },
      ],
    ),
  );
  expect(view.madeProgress).toBe(true);
});
