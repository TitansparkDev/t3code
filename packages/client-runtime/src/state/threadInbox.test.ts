import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentThreadShell } from "./models.ts";
import {
  BACKGROUND_WAKE_GRACE_MS,
  WORKING_EXIT_GRACE_MS,
  createInboxReturnTracker,
  isThreadWorking,
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
} from "./threadInbox.ts";

const environmentId = EnvironmentId.make("environment-1");

type PendingBackgroundTasks = EnvironmentThreadShell["pendingBackgroundTasks"];

/**
 * A parent whose run ended. The server parks it at idle while awaited work is pending,
 * and reports its run status once that work has resolved.
 */
function endedThread(id: string, pendingBackgroundTasks: PendingBackgroundTasks) {
  return {
    ...thread(id, false),
    pendingBackgroundTasks,
    latestRun: {
      runId: RunId.make(`run:${id}`),
      status: "completed" as const,
      requestedAt: null,
      startedAt: null,
      completedAt: null,
      assistantMessageId: null,
    },
    runtime: {
      status: backgroundWorkHoldsCompletion(pendingBackgroundTasks)
        ? ("idle" as const)
        : ("completed" as const),
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: "Codex",
      lastError: null,
      updatedAt: "2026-06-01T00:00:00.000Z",
    },
  };
}

const awaitedCommand = { taskId: "watch", kind: "command", awaited: true } as const;
const subagent = { taskId: "child", kind: "subagent" } as const;
const backgroundTask = { taskId: "background", kind: "background_task" } as const;

function thread(id: string, working: boolean) {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt: "2026-06-01T00:00:00.000Z",
    unsettledAt: null,
    latestRun: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    runtime: working
      ? {
          status: "running" as const,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-06-01T00:00:00.000Z",
        }
      : null,
  };
}

describe("createInboxReturnTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  it("stamps a thread when it stops working, but never on the first observation", () => {
    const tracker = createInboxReturnTracker();
    const first = tracker.observe([thread("a", true), thread("b", false)]);
    expect(first.returnedAt(thread("a", true))).toBeUndefined();
    expect(first.returnedAt(thread("b", false))).toBeUndefined();

    const held = tracker.observe([thread("a", false), thread("b", false)]);
    vi.advanceTimersByTime(2_000);
    const second = tracker.observe([thread("a", false), thread("b", false)]);
    expect(second.returnedAt(thread("a", false))).toBeDefined();
    expect(second.returnedAt(thread("b", false))).toBeUndefined();
    expect(tracker.returnedAt(thread("a", false))).toBe(second.returnedAt(thread("a", false)));
    // An earlier observation keeps its answer, so lists built from it stay valid.
    expect(held.isWorking(thread("a", false))).toBe(true);
    expect(held.returnedAt(thread("a", false))).toBeUndefined();
  });

  it("holds only placement, then expires and notifies without another shell event", () => {
    const tracker = createInboxReturnTracker();
    const notify = vi.fn();
    const unsubscribe = tracker.subscribe(notify);
    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    expect(isThreadWorking(thread("a", false))).toBe(false);
    expect(tracker.isWorking(thread("a", false))).toBe(true);
    vi.advanceTimersByTime(1_999);
    tracker.observe([thread("a", false)]);
    expect(tracker.isWorking(thread("a", false))).toBe(true);
    expect(tracker.returnedAt(thread("a", false))).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(tracker.isWorking(thread("a", false))).toBe(false);
    expect(tracker.returnedAt(thread("a", false))).toBe(12_000);
    expect(notify).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("cancels a transient return on resume and grants a fresh grace after the next finish", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", false)]);
    expect(tracker.isWorking(thread("a", false))).toBe(false);
    tracker.observe([thread("a", true)]);
    expect(tracker.isWorking(thread("a", true))).toBe(true);
    tracker.observe([thread("a", false)]);
    vi.advanceTimersByTime(1_500);
    tracker.observe([thread("a", true)]);
    vi.advanceTimersByTime(1_000);
    expect(tracker.returnedAt(thread("a", true))).toBeUndefined();
    tracker.observe([thread("a", false)]);
    vi.advanceTimersByTime(1_999);
    expect(tracker.isWorking(thread("a", false))).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tracker.returnedAt(thread("a", false))).toBe(14_500);
  });

  it.each([
    { hasPendingApprovals: true },
    { hasPendingUserInput: true },
    { pendingSubagentRequest: "approval" as const },
    { pendingSubagentRequest: "user_input" as const },
    { pendingGuestMessageCount: 1 },
    { interactionMode: "plan" as const, hasActionableProposedPlan: true },
    { runtime: { ...thread("a", true).runtime!, status: "failed" as const, lastError: "failed" } },
    { pinnedAt: "2026-06-01T00:00:01Z" },
    { settledOverride: "settled" as const },
    { snoozedUntil: "2026-06-02T00:00:00Z" },
    { activeOrderKey: "manual-order" },
  ])("ends a grace immediately for attention or manual placement: %j", (change) => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    tracker.observe([{ ...thread("a", false), ...change }]);
    expect(tracker.isWorking(thread("a", false))).toBe(false);
    expect(tracker.returnedAt(thread("a", false))).toBe(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["interrupted", "cancelled", "rolled_back"] as const)(
    "holds a %s run, because the server can still settle it",
    (status) => {
      const tracker = createInboxReturnTracker();
      const stopped = {
        ...thread("a", false),
        latestRun: {
          runId: RunId.make("stopped"),
          status,
          requestedAt: null,
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
        },
      };
      tracker.observe([thread("a", true)]);
      tracker.observe([stopped]);
      expect(tracker.isWorking(stopped)).toBe(true);
      tracker.observe([{ ...stopped, settledOverride: "settled" as const }]);
      expect(tracker.isWorking(stopped)).toBe(false);
    },
  );

  it("grants grace after a retained expired snooze", () => {
    const tracker = createInboxReturnTracker();
    const retained = {
      snoozedAt: "1970-01-01T00:00:01.000Z",
      snoozedUntil: "1970-01-01T00:00:05.000Z",
      latestRun: {
        runId: RunId.make("completed-wake"),
        status: "completed" as const,
        requestedAt: "1970-01-01T00:00:02.000Z",
        startedAt: "1970-01-01T00:00:02.000Z",
        completedAt: "1970-01-01T00:00:09.000Z",
        assistantMessageId: null,
      },
    };
    const active = { ...thread("a", true), ...retained };
    const finished = { ...thread("a", false), ...retained };
    tracker.observe([active]);
    tracker.observe([finished]);
    expect(tracker.isWorking(finished)).toBe(true);
    expect(tracker.returnedAt(finished)).toBeUndefined();
    vi.advanceTimersByTime(1_999);
    expect(tracker.isWorking(finished)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tracker.isWorking(finished)).toBe(false);
    expect(tracker.returnedAt(finished)).toBe(12_000);
  });

  it("does not grant grace to a future snooze after background completion", () => {
    const tracker = createInboxReturnTracker();
    const retained = {
      snoozedAt: "1970-01-01T00:00:01.000Z",
      snoozedUntil: "1970-01-01T00:00:30.000Z",
    };
    tracker.observe([{ ...thread("a", true), ...retained }]);
    const finished = { ...thread("a", false), ...retained };
    tracker.observe([finished]);
    expect(tracker.isWorking(finished)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stamps only stable returns and sorts them in their actual return order", () => {
    const tracker = createInboxReturnTracker();
    const a = { ...thread("a", false), createdAt: "1970-01-01T00:00:00Z" };
    const b = { ...thread("b", false), createdAt: "1970-01-01T00:00:00Z" };
    tracker.observe([thread("a", true), thread("b", true)]);
    tracker.observe([a, thread("b", true)]);
    vi.advanceTimersByTime(500);
    tracker.observe([a, b]);
    vi.advanceTimersByTime(1_500);
    expect(tracker.returnedAt(a)).toBe(12_000);
    expect(tracker.returnedAt(b)).toBeUndefined();
    vi.advanceTimersByTime(500);
    expect(sortInboxThreadsByReturn([a, b], tracker.returnedAt).map((entry) => entry.id)).toEqual([
      "b",
      "a",
    ]);
  });

  it.each([
    { work: "awaited command", task: awaitedCommand },
    { work: "subagent", task: subagent },
    { work: "background task", task: backgroundTask },
  ])("keeps a parent waiting between continuations while its $work resolves", ({ task }) => {
    const tracker = createInboxReturnTracker();
    const waiting = endedThread("a", [task]);
    const resolved = endedThread("a", []);
    tracker.observe([waiting]);
    expect(tracker.isWorking(waiting)).toBe(true);

    tracker.observe([resolved]);
    // The short exit grace has passed, but the continuation that resolved work wakes has not started yet.
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    expect(tracker.isWorking(resolved)).toBe(true);
    expect(tracker.returnedAt(resolved)).toBeUndefined();

    vi.advanceTimersByTime(BACKGROUND_WAKE_GRACE_MS - WORKING_EXIT_GRACE_MS - 1);
    expect(tracker.isWorking(resolved)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tracker.isWorking(resolved)).toBe(false);
    expect(tracker.returnedAt(resolved)).toBe(10_000 + BACKGROUND_WAKE_GRACE_MS);
  });

  it("returns a parent after its wake window when no continuation follows", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([endedThread("a", [awaitedCommand])]);
    const resolved = endedThread("a", []);
    tracker.observe([resolved]);
    vi.advanceTimersByTime(BACKGROUND_WAKE_GRACE_MS);
    expect(tracker.returnedAt(resolved)).toBe(10_000 + BACKGROUND_WAKE_GRACE_MS);
  });

  it("keeps the normal exit grace for a detached command that is not awaited", () => {
    const tracker = createInboxReturnTracker();
    const detached = { taskId: "server", kind: "command" as const };
    tracker.observe([thread("a", true)]);
    const ended = endedThread("a", [detached]);
    tracker.observe([ended]);
    expect(tracker.isWorking(ended)).toBe(true);
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    expect(tracker.isWorking(ended)).toBe(false);
    expect(tracker.returnedAt(ended)).toBe(10_000 + WORKING_EXIT_GRACE_MS);
  });

  it.each([
    { hasPendingApprovals: true },
    { hasPendingUserInput: true },
    { pendingSubagentRequest: "approval" as const },
    { runtime: { ...endedThread("a", []).runtime, status: "failed" as const, lastError: "boom" } },
    { pinnedAt: "2026-06-01T00:00:01Z" },
  ])("ends a waiting hold at once for attention or manual placement: %j", (change) => {
    const tracker = createInboxReturnTracker();
    tracker.observe([endedThread("a", [subagent])]);
    const resolved = { ...endedThread("a", []), ...change };
    tracker.observe([resolved]);
    expect(tracker.isWorking(resolved)).toBe(false);
    expect(tracker.returnedAt(resolved)).toBe(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels pending timers for removed threads and disabled shelves", () => {
    const tracker = createInboxReturnTracker();
    const notify = vi.fn();
    tracker.subscribe(notify);
    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    tracker.observe([]);
    expect(vi.getTimerCount()).toBe(0);
    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    tracker.observe(null);
    vi.advanceTimersByTime(2_000);
    expect(notify).not.toHaveBeenCalled();
    expect(tracker.returnedAt(thread("a", false))).toBeUndefined();
  });
});

describe("isThreadWorking with owned background work", () => {
  it.each([
    { work: "awaited command", task: awaitedCommand },
    { work: "subagent", task: subagent },
    { work: "background task", task: backgroundTask },
  ])("counts a parent as working while its $work is pending", ({ task }) => {
    const ended = endedThread("a", [task]);
    expect(isThreadWorking({ ...ended, runtime: { ...ended.runtime, status: "completed" } })).toBe(
      true,
    );
  });

  it("does not hold a parent for a detached command it did not await", () => {
    const ended = endedThread("a", [{ taskId: "server", kind: "command" }]);
    expect(isThreadWorking(ended)).toBe(false);
  });

  it("does not hold a failed parent for its awaited work", () => {
    const failed = endedThread("a", [subagent]);
    expect(
      isThreadWorking({
        ...failed,
        latestRun: { ...failed.latestRun, status: "failed" as const },
        runtime: { ...failed.runtime, status: "failed" as const, lastError: "boom" },
      }),
    ).toBe(false);
  });
});

describe("sortWorkingThreadsBySend", () => {
  it("orders by the last message the user sent, not by later runs", () => {
    const sentFirst = {
      ...thread("sent-first", true),
      latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
      latestRun: {
        runId: RunId.make("run:wake"),
        status: "running" as const,
        requestedAt: "2026-06-01T04:00:00.000Z",
        startedAt: "2026-06-01T04:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const sentLast = {
      ...thread("sent-last", true),
      latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
    };
    const launched = { ...thread("launched", true), latestUserAuthoredMessageAt: null };
    expect(
      sortWorkingThreadsBySend([launched, sentFirst, sentLast]).map((thread) => thread.id),
    ).toEqual(["sent-last", "sent-first", "launched"]);
  });
});
