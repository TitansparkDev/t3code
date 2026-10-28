/**
 * A fake {@link GoalThreads} for the goal tests. Tests describe the engine the way they always
 * have: commands that were dispatched, session events that arrive, and what a thread's detail
 * and shell currently say. This adapter turns those into the port the runner uses.
 *
 * @module goals/GoalThreads.testkit
 */
import type { ModelSelection, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { GoalThreads, GoalThreadsError, type GoalThreadView } from "./GoalThreads.ts";

/** What the runner asks of the engine, in the shape the goal tests assert on. */
export type OrchestrationCommand =
  | {
      readonly type: "thread.create";
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly title: string;
      readonly modelSelection: ModelSelection;
      readonly runtimeMode: string;
      readonly branch: string | null;
      readonly worktreePath: string | null;
    }
  | {
      readonly type: "thread.turn.start";
      readonly threadId: ThreadId;
      readonly message: { readonly role: "user"; readonly text: string; readonly attachments: [] };
      readonly modelSelection: ModelSelection;
      readonly runtimeMode?: string;
      readonly idempotencyKey?: string;
    }
  | {
      readonly type: "thread.workspace.bind";
      readonly threadId: ThreadId;
      readonly branch: string;
      readonly worktreePath: string;
    }
  | { readonly type: "thread.delete"; readonly threadId: ThreadId }
  | { readonly type: "thread.settle"; readonly threadId: ThreadId }
  | { readonly type: "thread.turn.interrupt"; readonly threadId: ThreadId }
  // Never sent now; kept so tests can assert that the runner does not.
  | { readonly type: "thread.archive"; readonly threadId: ThreadId }
  | { readonly type: "thread.session.stop"; readonly threadId: ThreadId }
  | { readonly type: "thread.usage-limit-resume.schedule"; readonly threadId: ThreadId };

export interface OrchestrationThread {
  readonly latestTurn: {
    readonly state: string;
    readonly turnId?: string;
    readonly requestedAt?: string;
    readonly completedAt?: string | null;
  } | null;
  readonly messages: ReadonlyArray<{
    readonly id?: string;
    readonly role: string;
    readonly text: string;
  }>;
  readonly activities: ReadonlyArray<unknown>;
  readonly checkpoints?: ReadonlyArray<{ readonly turnId: string; readonly status: string }>;
  readonly session: {
    readonly status?: string;
    readonly activeTurnId?: string | null;
    readonly lastError?: string | null;
    readonly lastErrorClass?: string | null;
    readonly retryAt?: string | undefined;
    readonly updatedAt?: string;
  } | null;
  readonly modelSelection?: ModelSelection;
}

export interface OrchestrationEvent {
  readonly type: string;
  readonly payload: {
    readonly threadId: ThreadId;
    readonly session: NonNullable<OrchestrationThread["session"]>;
  };
}

export const layerFromLegacyHarness = (harness: {
  readonly dispatch: (command: OrchestrationCommand) => Effect.Effect<unknown>;
  /** Taken one event at a time, so each is seen with the session it carried. */
  readonly events: PubSub.Subscription<OrchestrationEvent>;
  readonly detail: (threadId: ThreadId) => Effect.Effect<Option.Option<OrchestrationThread>>;
  readonly shell: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<{ readonly backgroundLiveness?: unknown }>>;
  readonly projectRoot: (projectId: ProjectId) => string | undefined;
  /** Whether the next workspace bind should fail before the engine commits it. */
  readonly failBind?: () => boolean;
}) => {
  /** The newest session each thread's events reported; the detail's own session is the fallback. */
  const sessions = new Map<string, NonNullable<OrchestrationThread["session"]>>();
  const sentKeys = new Set<string>();
  const sentMessages = new Map<
    string,
    Array<{ readonly id: string; readonly role: "user"; readonly text: string }>
  >();
  const viewOf = (threadId: ThreadId, thread: OrchestrationThread): GoalThreadView => {
    const session = sessions.get(threadId) ?? thread.session;
    const turnId = thread.latestTurn?.turnId;
    return {
      messages: [
        ...thread.messages.map((message) => ({
          ...(message.id !== undefined ? { id: message.id } : {}),
          role: message.role as "user" | "assistant" | "system",
          text: message.text,
        })),
        ...(sentMessages.get(threadId) ?? []),
      ],
      madeProgress:
        thread.messages.some((message) => message.role === "assistant") ||
        thread.activities.length > 0,
      session: {
        status: session?.status ?? "ready",
        activeTurnId: session?.activeTurnId ?? null,
        lastError: session?.lastError ?? null,
        lastErrorClass: session?.lastErrorClass ?? null,
        retryAt: session?.retryAt,
        updatedAt: session?.updatedAt ?? "2026-10-04T12:00:00.000Z",
      },
      latestTurn: thread.latestTurn
        ? {
            turnId: thread.latestTurn.turnId ?? "turn-1",
            state: thread.latestTurn.state as "running" | "completed" | "error" | "interrupted",
            requestedAt: thread.latestTurn.requestedAt ?? "2026-10-04T12:00:00.000Z",
            completedAt: thread.latestTurn.completedAt ?? null,
          }
        : null,
      modelSelection: thread.modelSelection as ModelSelection,
      backgroundWork: false,
      checkpointSaved:
        thread.checkpoints === undefined
          ? null
          : thread.checkpoints.some(
              (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
            ),
    };
  };

  return Layer.succeed(
    GoalThreads,
    GoalThreads.of({
      launch: (input) =>
        Effect.gen(function* () {
          yield* harness.dispatch({
            type: "thread.create",
            threadId: input.threadId,
            projectId: input.projectId,
            title: input.title,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            branch: input.branch,
            worktreePath: input.worktreePath,
          });
          yield* harness.dispatch({
            type: "thread.turn.start",
            threadId: input.threadId,
            message: { role: "user", text: input.text, attachments: [] },
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
          });
        }),
      send: (input) => {
        if (input.idempotencyKey !== undefined && sentKeys.has(input.idempotencyKey)) {
          return Effect.void;
        }
        return harness
          .dispatch({
            type: "thread.turn.start",
            threadId: input.threadId,
            message: { role: "user", text: input.text, attachments: [] },
            modelSelection: input.modelSelection,
            ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
          })
          .pipe(
            Effect.tap(() =>
              input.idempotencyKey === undefined
                ? Effect.void
                : Effect.sync(() => {
                    sentKeys.add(input.idempotencyKey!);
                    sentMessages.set(input.threadId, [
                      ...(sentMessages.get(input.threadId) ?? []),
                      { id: input.idempotencyKey!, role: "user", text: input.text },
                    ]);
                  }),
            ),
            Effect.asVoid,
          );
      },
      bindWorkspace: (input) =>
        Effect.gen(function* () {
          if (harness.failBind?.())
            return yield* new GoalThreadsError({
              operation: "bindWorkspace",
              message: "test bind outage",
            });
          yield* harness.dispatch({
            type: "thread.workspace.bind",
            threadId: input.threadId,
            branch: input.branch,
            worktreePath: input.worktreePath,
          });
        }).pipe(Effect.asVoid),
      remove: (threadId) =>
        harness.dispatch({ type: "thread.delete", threadId }).pipe(Effect.asVoid),
      interrupt: (input) =>
        harness
          .dispatch({ type: "thread.turn.interrupt", threadId: input.threadId })
          .pipe(Effect.asVoid),
      settle: (threadId) =>
        harness.dispatch({ type: "thread.settle", threadId }).pipe(Effect.asVoid),
      read: (threadId) =>
        harness.detail(threadId).pipe(
          Effect.map((thread) =>
            Option.isSome(thread) ? viewOf(threadId, thread.value) : undefined,
          ),
          // @effect-diagnostics-next-line effectSucceedWithVoid:off - callers read the value as `undefined`, not void.
          Effect.catchCause(() => Effect.succeed(undefined)),
        ),
      backgroundWork: (threadId) =>
        harness.shell(threadId).pipe(
          Effect.map(
            (shell) => Option.isSome(shell) && (shell.value.backgroundLiveness ?? null) !== null,
          ),
          Effect.catchCause(() => Effect.succeed(true)),
        ),
      workspaceRoot: (projectId) => Effect.succeed(harness.projectRoot(projectId)),
      runChanges: Stream.fromEffectRepeat(PubSub.take(harness.events)).pipe(
        Stream.filter((event) => event.type === "thread.session-set"),
        Stream.map((event) => {
          sessions.set(event.payload.threadId, event.payload.session);
          return event.payload.threadId;
        }),
      ),
    }),
  );
};
