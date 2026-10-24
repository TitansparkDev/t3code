import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EnvironmentId,
  EventId,
  NodeId,
  ProviderDriverKind,
  ProviderSessionId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  ThreadId,
  RunId,
  MessageId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { v2Projection, v2Now } from "./orchestrationV2TestFixtures.ts";
import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import { deriveThreadRuntime } from "./threadExecution.ts";
import { EMPTY_THREAD_HISTORY_META } from "./threadHistoryMerge.ts";
import { createEnvironmentThreadDetailAtoms } from "./threadDetail.ts";
import type { EnvironmentThreadState } from "./threads.ts";

const ref: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-detail"),
  threadId: ThreadId.make(v2Projection.thread.id),
};

function threadState(
  partial: Pick<EnvironmentThreadState, "data" | "status" | "error"> &
    Partial<Pick<EnvironmentThreadState, "history">>,
): EnvironmentThreadState {
  return { ...partial, history: partial.history ?? EMPTY_THREAD_HISTORY_META };
}

describe("createEnvironmentThreadDetailAtoms", () => {
  it("adds environment scope while preserving the pristine projection", () => {
    const initial: AsyncResult.AsyncResult<EnvironmentThreadState, never> = AsyncResult.success(
      threadState({
        data: Option.some(v2Projection),
        status: "cached",
        error: Option.none(),
      }),
    );
    const sourceAtom = Atom.make(initial);
    const details = createEnvironmentThreadDetailAtoms(() => sourceAtom);
    const registry = AtomRegistry.make();

    const thread = registry.get(details.threadAtom(ref));
    expect(thread).toEqual({ environmentId: ref.environmentId, projection: v2Projection });
    expect(thread?.projection).toBe(v2Projection);
    expect(registry.get(details.visibleTurnItemsAtom(ref))).toBe(v2Projection.visibleTurnItems);
    expect(registry.get(details.statusAtom(ref))).toBe("cached");
    expect(registry.get(details.historyAtom(ref))).toBe(EMPTY_THREAD_HISTORY_META);

    registry.set(
      sourceAtom,
      AsyncResult.success(
        threadState({
          data: Option.some(v2Projection),
          status: "synchronizing",
          error: Option.none(),
        }),
      ),
    );

    expect(registry.get(details.threadAtom(ref))).toBe(thread);
    expect(registry.get(details.statusAtom(ref))).toBe("synchronizing");

    const progressiveHistory = {
      ...EMPTY_THREAD_HISTORY_META,
      historyCursor: "cursor-1",
      hasMoreHistory: true,
    };
    registry.set(
      sourceAtom,
      AsyncResult.success(
        threadState({
          data: Option.some(v2Projection),
          status: "live",
          error: Option.some("Stream interrupted."),
          history: progressiveHistory,
        }),
      ),
    );

    expect(registry.get(details.threadAtom(ref))).toBe(thread);
    expect(registry.get(details.visibleTurnItemsAtom(ref))).toBe(v2Projection.visibleTurnItems);
    expect(registry.get(details.statusAtom(ref))).toBe("live");
    expect(registry.get(details.errorAtom(ref))).toBe("Stream interrupted.");
    expect(registry.get(details.historyAtom(ref))).toBe(progressiveHistory);

    registry.set(
      sourceAtom,
      AsyncResult.success(
        threadState({
          data: Option.none(),
          status: "deleted",
          error: Option.none(),
        }),
      ),
    );

    expect(registry.get(details.threadAtom(ref))).toBeNull();
    expect(registry.get(details.visibleTurnItemsAtom(ref))).toEqual([]);
    expect(registry.get(details.statusAtom(ref))).toBe("deleted");
    expect(registry.get(details.errorAtom(ref))).toBeNull();
    expect(registry.get(details.historyAtom(ref))).toBe(EMPTY_THREAD_HISTORY_META);
    registry.dispose();
  });
});

it("does not notify queue consumers for streaming text or execution nodes", () => {
  const projection = {
    ...v2Projection,
    runs: [
      {
        id: RunId.make("queued-run"),
        threadId: v2Projection.thread.id,
        ordinal: 1,
        providerInstanceId: v2Projection.thread.providerInstanceId,
        modelSelection: v2Projection.thread.modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("queued-message"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "queued" as const,
        requestedAt: v2Now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
  };
  const source = Atom.make(
    AsyncResult.success(
      threadState({ data: Option.some(projection), status: "live", error: Option.none() }),
    ),
  );
  const details = createEnvironmentThreadDetailAtoms(() => source);
  const registry = AtomRegistry.make();
  const dispose = registry.mount(details.queueWorkflowAtom(ref));
  const before = registry.get(details.queueWorkflowAtom(ref));
  const disposeCount = registry.mount(details.queuedCountAtom(ref));
  expect(registry.get(details.queuedCountAtom(ref))).toBe(1);
  registry.set(
    source,
    AsyncResult.success(
      threadState({
        data: Option.some({
          ...projection,
          nodes: [...v2Projection.nodes],
          turnItems: [...v2Projection.turnItems],
        }),
        status: "live",
        error: Option.none(),
      }),
    ),
  );
  expect(registry.get(details.queueWorkflowAtom(ref))).toBe(before);
  expect(registry.get(details.queuedCountAtom(ref))).toBe(1);
  registry.set(
    source,
    AsyncResult.success(
      threadState({ data: Option.none(), status: "deleted", error: Option.none() }),
    ),
  );
  expect(registry.get(details.queueWorkflowAtom(ref))).toBeNull();
  expect(registry.get(details.queuedCountAtom(ref))).toBe(0);
  disposeCount();
  dispose();
  registry.dispose();
});

it("does not notify the agents pill for unrelated projection updates", () => {
  const projection: OrchestrationV2ThreadProjection = {
    ...v2Projection,
    runs: [
      {
        id: RunId.make("active-run"),
        threadId: v2Projection.thread.id,
        ordinal: 1,
        providerInstanceId: v2Projection.thread.providerInstanceId,
        modelSelection: v2Projection.thread.modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: v2Now,
        startedAt: v2Now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    subagents: [
      {
        id: NodeId.make("subagent-1"),
        threadId: v2Projection.thread.id,
        runId: RunId.make("active-run"),
        parentNodeId: NodeId.make("root"),
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: v2Projection.thread.providerInstanceId,
        providerThreadId: null,
        childThreadId: ThreadId.make("thread-child"),
        nativeTaskRef: null,
        prompt: "Do the thing",
        title: "Worker",
        model: null,
        status: "running",
        result: null,
        startedAt: v2Now,
        completedAt: null,
        updatedAt: v2Now,
      },
    ],
  };
  const source = Atom.make(
    AsyncResult.success(
      threadState({ data: Option.some(projection), status: "live", error: Option.none() }),
    ),
  );
  const details = createEnvironmentThreadDetailAtoms(() => source);
  const registry = AtomRegistry.make();
  const dispose = registry.mount(details.turnSubagentsAtom(ref));
  const before = registry.get(details.turnSubagentsAtom(ref));
  expect(before?.liveCount).toBe(1);
  registry.set(
    source,
    AsyncResult.success(
      threadState({
        data: Option.some({ ...projection, turnItems: [...v2Projection.turnItems] }),
        status: "live",
        error: Option.none(),
      }),
    ),
  );
  expect(registry.get(details.turnSubagentsAtom(ref))).toBe(before);
  dispose();
  registry.dispose();
});

it("keeps worktree and pending requests stable during output updates, then reflects resolution", () => {
  const projection: OrchestrationV2ThreadProjection = {
    ...v2Projection,
    thread: { ...v2Projection.thread, worktreePath: "/workspace/task" },
    runtimeRequests: [
      {
        id: RuntimeRequestId.make("approval"),
        nodeId: NodeId.make("approval-node"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "pending",
        responseCapability: { type: "not_resumable", reason: "Provider exited" },
        createdAt: v2Now,
        resolvedAt: null,
      },
    ],
  };
  const source = Atom.make(
    AsyncResult.success(
      threadState({ data: Option.some(projection), status: "live", error: Option.none() }),
    ),
  );
  const details = createEnvironmentThreadDetailAtoms(() => source);
  const registry = AtomRegistry.make();
  const dispose = registry.mount(details.pendingRequestsAtom(ref));
  const before = registry.get(details.pendingRequestsAtom(ref));
  expect(before?.approvals).toHaveLength(1);
  const streaming: OrchestrationV2ThreadProjection = {
    ...projection,
    turnItems: [
      {
        id: TurnItemId.make("output"),
        threadId: projection.thread.id,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running",
        title: null,
        startedAt: v2Now,
        completedAt: null,
        updatedAt: v2Now,
        type: "command_execution",
        input: "pwd",
        output: "new output",
        exitCode: undefined,
      },
    ],
  };
  registry.set(
    source,
    AsyncResult.success(
      threadState({ data: Option.some(streaming), status: "live", error: Option.none() }),
    ),
  );
  expect(registry.get(details.pendingRequestsAtom(ref))).toBe(before);
  expect(registry.get(details.worktreePathAtom(ref))).toBe("/workspace/task");
  registry.set(
    source,
    AsyncResult.success(
      threadState({
        data: Option.some({
          ...streaming,
          thread: { ...projection.thread, worktreePath: "/workspace/moved" },
          runtimeRequests: projection.runtimeRequests.map((request) => ({
            ...request,
            status: "resolved",
            resolvedAt: v2Now,
          })),
        }),
        status: "live",
        error: Option.none(),
      }),
    ),
  );
  expect(registry.get(details.pendingRequestsAtom(ref))?.approvals).toEqual([]);
  expect(registry.get(details.worktreePathAtom(ref))).toBe("/workspace/moved");
  dispose();
  registry.dispose();
});

it("rebuilds checkpoint summaries only when checkpoints or messages change", () => {
  const checkpoint: OrchestrationV2ThreadProjection["checkpoints"][number] = {
    id: CheckpointId.make("checkpoint-1"),
    threadId: v2Projection.thread.id,
    scopeId: CheckpointScopeId.make("scope-1"),
    runId: RunId.make("run-1"),
    nodeId: NodeId.make("node-1"),
    parentCheckpointId: null,
    ordinalWithinScope: 1,
    appRunOrdinal: 1,
    ref: CheckpointRef.make("ref-1"),
    status: "ready",
    files: [],
    capturedAt: v2Now,
  };
  const projection: OrchestrationV2ThreadProjection = {
    ...v2Projection,
    checkpoints: [checkpoint],
  };
  const live = (data: OrchestrationV2ThreadProjection | null) =>
    AsyncResult.success(
      threadState({ data: Option.fromNullishOr(data), status: "live", error: Option.none() }),
    );
  const sourceAtom = Atom.make(live(projection));
  const details = createEnvironmentThreadDetailAtoms(() => sourceAtom);
  const registry = AtomRegistry.make();
  const dispose = registry.mount(details.checkpointSummariesAtom(ref));

  const summaries = registry.get(details.checkpointSummariesAtom(ref));
  expect(summaries.map((summary) => summary.runId)).toEqual(["run-1"]);

  registry.set(sourceAtom, live({ ...projection, runs: [] }));
  expect(registry.get(details.checkpointSummariesAtom(ref))).toBe(summaries);

  registry.set(sourceAtom, live({ ...projection, checkpoints: [] }));
  expect(registry.get(details.checkpointSummariesAtom(ref))).toEqual([]);

  registry.set(sourceAtom, live(null));
  expect(registry.get(details.checkpointSummariesAtom(ref))).toEqual([]);
  dispose();
  registry.dispose();
});

describe("failure recovery from decoded server events", () => {
  const threadId = v2Projection.thread.id;
  const rootNodeId = NodeId.make("root");
  const at = (iso: string) => DateTime.makeUnsafe(iso);
  const T1 = "2026-06-20T01:00:00.000Z";
  const T2 = "2026-06-20T01:01:00.000Z";
  const T3 = "2026-06-20T01:02:00.000Z";

  function runRecord(
    id: string,
    ordinal: number,
    status: OrchestrationV2Run["status"],
    completedAt: string | null,
  ): OrchestrationV2Run {
    return {
      id: RunId.make(id),
      threadId,
      ordinal,
      providerInstanceId: v2Projection.thread.providerInstanceId,
      modelSelection: v2Projection.thread.modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message-${id}`),
      rootNodeId,
      activeAttemptId: null,
      status,
      requestedAt: at(T1),
      startedAt: at(T1),
      completedAt: completedAt === null ? null : at(completedAt),
      checkpointId: null,
      contextHandoffId: null,
    };
  }

  function runEvent(run: OrchestrationV2Run): OrchestrationV2DomainEvent {
    return {
      id: EventId.make(`event-run-${run.id}-${run.status}`),
      type: "run.updated",
      threadId,
      occurredAt: run.completedAt ?? run.requestedAt,
      payload: run,
    };
  }

  function failureEvent(
    id: string,
    runId: string,
    updatedAt: string,
    failure: OrchestrationV2ProviderFailure,
  ): OrchestrationV2DomainEvent {
    const item: OrchestrationV2TurnItem = {
      id: TurnItemId.make(id),
      threadId,
      runId: RunId.make(runId),
      nodeId: rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "failed",
      title: "Provider error",
      startedAt: at(updatedAt),
      completedAt: at(updatedAt),
      updatedAt: at(updatedAt),
      type: "error",
      failure,
    };
    return {
      id: EventId.make(`event-${id}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: item.updatedAt,
      payload: item,
    };
  }

  // Only the identity and error fields are read by the thread runtime summary.
  function sessionEvent(lastError: string | null, updatedAt: string): OrchestrationV2DomainEvent {
    const session = {
      id: ProviderSessionId.make("session-1"),
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: v2Projection.thread.providerInstanceId,
      status: lastError === null ? "running" : "error",
      cwd: "/workspace/project",
      model: "gpt-5.4",
      createdAt: at(T1),
      updatedAt: at(updatedAt),
      lastError,
    } as OrchestrationV2ProviderSession;
    return {
      id: EventId.make(`event-session-${updatedAt}`),
      type: "provider-session.updated",
      threadId,
      occurredAt: at(updatedAt),
      payload: session,
    };
  }

  // The reducer only returns null for a null projection, so the fallback never applies.
  function replay(
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
  ): OrchestrationV2ThreadProjection {
    return events.reduce<OrchestrationV2ThreadProjection>(
      (projection, event) => applyOrchestrationV2ProjectionEvent(projection, event) ?? projection,
      v2Projection,
    );
  }

  const providerFailure = (
    stage: OrchestrationV2ProviderFailure["stage"],
    code: string | null,
  ): OrchestrationV2ProviderFailure => ({
    class: "provider_error",
    stage,
    message: "Provider turn failed.",
    code,
    retryable: null,
  });

  it("keeps a provider error that lands after a stop out of the thread's current error", () => {
    const running = runRecord("run-stop", 1, "running", null);
    const interrupted = runRecord("run-stop", 1, "interrupted", T2);

    // Disconnected while the stop settles: the runtime error is recorded, but the run is not failed.
    expect(
      deriveThreadRuntime(replay([runEvent(running), sessionEvent("Runtime exited.", T2)])),
    ).toMatchObject({ status: "running", lastError: null, lastErrorRecovery: null });

    // Reconnect after cleanup: the interrupted run and the delayed error both arrive.
    expect(
      deriveThreadRuntime(
        replay([runEvent(running), runEvent(interrupted), sessionEvent("Runtime exited.", T3)]),
      ),
    ).toMatchObject({ status: "interrupted", lastError: null, lastErrorRecovery: null });
  });

  it("presents a session error for a failed run and clears it once a later run completes", () => {
    const failed = runRecord("run-failed", 1, "failed", T2);
    const completed = runRecord("run-next", 2, "completed", T3);

    expect(
      deriveThreadRuntime(replay([runEvent(failed), sessionEvent("Runtime exited.", T3)])),
    ).toMatchObject({
      status: "failed",
      lastError: "Runtime exited.",
      lastErrorClass: null,
      lastErrorRecovery: "Review the error details.",
    });
    expect(
      deriveThreadRuntime(
        replay([runEvent(failed), sessionEvent("Runtime exited.", T3), runEvent(completed)]),
      ),
    ).toMatchObject({ status: "completed", lastError: null });
  });

  it("gives the same stage and recovery whichever order the failure updates arrive in", () => {
    const failed = runRecord("run-failed", 1, "failed", T3);
    const older = failureEvent(
      "item-startup",
      "run-failed",
      T1,
      providerFailure("startup", "startup-timeout"),
    );
    const newer = failureEvent(
      "item-provider",
      "run-failed",
      T2,
      providerFailure("provider", "rate-limited"),
    );
    const expected = {
      status: "failed",
      lastError: "Provider turn failed.",
      lastErrorClass: "provider_error",
      lastErrorStage: "provider",
      lastErrorCode: "rate-limited",
      lastErrorRecovery: "Review the provider error, then start a new message when ready.",
    };

    expect(deriveThreadRuntime(replay([runEvent(failed), older, newer]))).toMatchObject(expected);
    expect(deriveThreadRuntime(replay([runEvent(failed), newer, older]))).toMatchObject(expected);
  });

  it("isolates the same thread across environments", () => {
    const local = EnvironmentId.make("environment-local");
    const remote = EnvironmentId.make("environment-remote");
    const failed = runRecord("run-failed", 1, "failed", T2);
    const projections = new Map<EnvironmentId, OrchestrationV2ThreadProjection | null>([
      [local, replay([runEvent(failed), sessionEvent("Runtime exited.", T2)])],
      [remote, replay([runEvent(runRecord("run-ok", 1, "completed", T2))])],
    ]);
    const sources = new Map(
      [...projections].map(([environmentId, projection]) => [
        environmentId,
        Atom.make(
          AsyncResult.success(
            threadState({
              data: Option.fromNullishOr(projection),
              status: "live",
              error: Option.none(),
            }),
          ),
        ),
      ]),
    );
    const details = createEnvironmentThreadDetailAtoms((environmentId) => {
      const source = sources.get(environmentId);
      if (source === undefined) throw new Error(`Unexpected environment ${environmentId}`);
      return source;
    });
    const registry = AtomRegistry.make();
    const runtimeFor = (environmentId: EnvironmentId) => {
      const thread = registry.get(
        details.threadAtom({ environmentId, threadId: ThreadId.make(threadId) }),
      );
      return thread === null ? null : deriveThreadRuntime(thread.projection);
    };

    expect(runtimeFor(local)).toMatchObject({ status: "failed", lastError: "Runtime exited." });
    expect(runtimeFor(remote)).toMatchObject({ status: "completed", lastError: null });
    registry.dispose();
  });
});
