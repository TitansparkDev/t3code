/**
 * ClineAdapterLive — Cline CLI (`cline --acp`) via ACP.
 *
 * Lifecycle notes that differ from the other ACP adapters, all of them
 * consequences of the current Cline build rather than preferences:
 *
 * - **Scope handover is the last fallible step.** The ACP child and the
 *   notification fiber are created, then the session is registered and its
 *   scope is transferred. Every event id is minted *before* that handover so a
 *   failure cannot leave a Cline process alive for a session T3 never
 *   registered.
 * - **Turns always reach a terminal event.** `turn.started` is published before
 *   `session/prompt`, so the settlement path emits `turn.completed` on failure
 *   too, and clears the active turn once the last in-flight prompt is done.
 * - **Configuration and prompt are one serialized step.** Cline binds a
 *   session's model and mode on the first prompt, and two concurrent sends
 *   would otherwise write their model and then each prompt under the other's
 *   selection. A per-session semaphore covers configure → prompt → drain.
 * - **Permission handling is the whole access-mode story.** Cline offers one
 *   `auto_approve` boolean and no per-tool policy, so there is no middle
 *   setting to map onto. `approval-required` asks the user, and `full-access`
 *   answers each request with Cline's own accept option; the two in-between T3
 *   modes are rejected up front rather than widened.
 *
 * @module ClineAdapterLive
 */
import {
  ApprovalRequestId,
  type ClineSettings,
  EventId,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { errorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  applyAcpModelOptionSelections,
  mapAcpToAdapterError,
  selectAcpAutoApprovedPermissionOption,
  selectAcpPermissionOptionId,
} from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  applyClineAcpModelSelection,
  clineInitializeResultForSnapshot,
  clineModelsFromSessionSetup,
  clineSupportsRuntimeMode,
  makeClineAcpRuntime,
  resolveClineActModeId,
} from "../acp/ClineAcpSupport.ts";
import { type ClineAdapterShape } from "../Services/ClineAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const PROVIDER = ProviderDriverKind.make("cline");
const CLINE_RESUME_VERSION = 1 as const;

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface ClineAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly childProcessSpawner?: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly remoteCwdFor?: (cwd: string) => string | undefined;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /** Selections are honored when `modelSelection.instanceId` matches this value. */
  readonly instanceId?: ProviderInstanceId;
  /**
   * Optional per-session settings resolver. Production leaves this undefined —
   * the hydration layer rebuilds the adapter on config change — and test suites
   * that swap `binaryPath` mid-flight pass a resolver so the closure is not
   * stale.
   */
  readonly resolveSettings?: Effect.Effect<ClineSettings>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface ClineSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  /**
   * Serializes configure → prompt → drain. Cline binds the session's model and
   * mode on the first prompt, and `AcpSessionRuntime.prompt` only serializes the
   * RPC itself, so without this a second send could write its model and then
   * prompt under the first send's selection.
   */
  readonly promptLifecycle: Semaphore.Semaphore;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /**
   * Turns cancelled before their prompt reached the CLI. `session/cancel` is a
   * notification, so a Stop that lands while the model and mode are still being
   * configured has nothing to cancel on the Cline side; the sendTurn that owns
   * the turn checks this and abandons it instead of prompting anyway.
   */
  readonly interruptedTurnIds: Set<TurnId>;
  /** Number of sendTurn prompts in flight or being prepared. */
  promptsInFlight: number;
  stopped: boolean;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingApprovals.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

const decodeClineResume = Schema.decodeUnknownOption(
  Schema.Struct({
    schemaVersion: Schema.Literal(CLINE_RESUME_VERSION),
    sessionId: Schema.String,
  }),
);

function parseClineResume(raw: unknown): { sessionId: string } | undefined {
  const decoded = decodeClineResume(raw);
  if (Option.isNone(decoded)) {
    return undefined;
  }
  const sessionId = decoded.value.sessionId.trim();
  return sessionId ? { sessionId } : undefined;
}

const mapPermissionHandlerFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError(
      (cause) =>
        new EffectAcpErrors.AcpTransportError({
          detail: "Failed to process the Cline ACP permission request.",
          cause,
        }),
    ),
  );

/**
 * Maps a T3 decision onto Cline's option id, or onto a cancellation when the
 * decision or the matching option is gone. Cline offers only `allow_once`,
 * `allow_always` and `reject_once`, and a rejected request must answer
 * `cancelled` rather than an option Cline never offered.
 */
function permissionOutcome(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
): EffectAcpSchema.RequestPermissionResponse {
  const selectedOptionId =
    decision === "cancel" ? undefined : selectAcpPermissionOptionId(request, decision);
  return selectedOptionId
    ? { outcome: { outcome: "selected", optionId: selectedOptionId } }
    : { outcome: { outcome: "cancelled" } };
}

export function makeClineAdapter(clineSettings: ClineSettings, options?: ClineAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("cline");
    const path = yield* Path.Path;
    const childProcessSpawner =
      options?.childProcessSpawner ?? (yield* ChildProcessSpawner.ChildProcessSpawner);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, ClineSessionContext>();
    // Refcounted per-thread semaphores: a plain map would keep one semaphore
    // per thread id for the adapter's lifetime.
    interface ThreadLock {
      readonly semaphore: Semaphore.Semaphore;
      /** Holders plus queued waiters; the last one out removes the entry. */
      readonly waiters: number;
    }
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, ThreadLock>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Cline runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<ThreadLock> = Option.fromNullishOr(current.get(threadId));
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, { semaphore, waiters: 1 });
                return [semaphore, next] as const;
              }),
            ),
          onSome: (entry) =>
            Effect.succeed([
              entry.semaphore,
              new Map(current).set(threadId, { ...entry, waiters: entry.waiters + 1 }),
            ] as const),
        });
      });

    // Drops the entry once the last holder or waiter leaves, so the lock map
    // does not grow one semaphore per thread id for the adapter's lifetime.
    const releaseThreadLock = (threadId: string, semaphore: Semaphore.Semaphore) =>
      SynchronizedRef.update(threadLocksRef, (current) => {
        const entry = current.get(threadId);
        if (entry?.semaphore !== semaphore) {
          return current;
        }
        if (entry.waiters > 1) {
          return new Map(current).set(threadId, { ...entry, waiters: entry.waiters - 1 });
        }
        const next = new Map(current);
        next.delete(threadId);
        return next;
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) =>
        semaphore.withPermit(Effect.ensuring(effect, releaseThreadLock(threadId, semaphore))),
      );

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const emitPlanUpdate = (
      ctx: ClineSessionContext,
      payload: Parameters<typeof makeAcpPlanUpdatedEvent>[0]["payload"],
      rawPayload: unknown,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source: "acp.jsonrpc",
            method: "session/update",
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<ClineSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: ClineSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        // Settle before closing the scope: a pending permission handler is
        // parked on a Deferred, and closing its scope would interrupt the
        // handler rather than answering Cline's request.
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: ClineAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          // Only reject a *defined* mismatched provider. Other ACP adapters
          // accept legacy callers that omit it entirely.
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }
          if (!clineSupportsRuntimeMode(input.runtimeMode)) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue:
                "Cline supports Supervised and Full access only: its ACP tool approval is a single " +
                "approve-everything switch with no per-tool policy, so the intermediate access " +
                "modes cannot be honored without granting more than they promise.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const protocolCwd = options?.remoteCwdFor?.(cwd);
          const clineModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          // Until the scope is transferred this finalizer owns the ACP child, so
          // any failure above kills the process instead of leaking it.
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx!: ClineSessionContext;

          const resumeSessionId = parseClineResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });
          const effectiveClineSettings = options?.resolveSettings
            ? yield* options.resolveSettings
            : clineSettings;

          const acp = yield* makeClineAcpRuntime({
            clineSettings: effectiveClineSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            ...(protocolCwd ? { protocolCwd } : {}),
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to create the Cline ACP runtime.",
                  cause,
                }),
            ),
          );

          yield* acp.handleRequestPermission((params) =>
            Effect.gen(function* () {
              yield* logNative(input.threadId, "session/request_permission", params);
              if (input.runtimeMode === "full-access") {
                const autoApprovedOptionId = selectAcpAutoApprovedPermissionOption(params);
                if (autoApprovedOptionId !== undefined) {
                  return {
                    outcome: { outcome: "selected", optionId: autoApprovedOptionId },
                  } satisfies EffectAcpSchema.RequestPermissionResponse;
                }
              }
              const permissionRequest = parsePermissionRequest(params);
              const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
              const runtimeRequestId = RuntimeRequestId.make(requestId);
              const decision = yield* Deferred.make<ProviderApprovalDecision>();
              pendingApprovals.set(requestId, { decision, kind: permissionRequest.kind });
              yield* offerRuntimeEvent(
                makeAcpRequestOpenedEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  permissionRequest,
                  detail:
                    permissionRequest.detail ??
                    encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                    "[unserializable params]",
                  args: params,
                  source: "acp.jsonrpc",
                  method: "session/request_permission",
                  rawPayload: params,
                }),
              );
              const resolved = yield* Deferred.await(decision);
              pendingApprovals.delete(requestId);
              yield* offerRuntimeEvent(
                makeAcpRequestResolvedEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  permissionRequest,
                  decision: resolved,
                }),
              );
              return permissionOutcome(params, resolved);
            }).pipe(mapPermissionHandlerFailure),
          );

          const started = yield* acp
            .start()
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
              ),
            );

          // Cline reports its catalog in session setup. An empty one means the
          // CLI is not configured yet; synthesizing a model would send turns to
          // whatever Cline picks, which is not what the model picker showed.
          const discoveredModels = clineModelsFromSessionSetup(started.sessionSetupResult);
          if (discoveredModels.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue:
                "Cline did not advertise any usable models. Run `cline auth`, configure a provider " +
                "and model in Cline, then start a new session.",
            });
          }

          // Cline binds its mode on the first prompt, so the Act mode has to be
          // negotiated here, before any turn exists.
          const actModeId = resolveClineActModeId(yield* acp.getModeState);
          if (actModeId !== undefined) {
            yield* acp
              .setMode(actModeId)
              .pipe(
                Effect.mapError((cause) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_mode", cause),
                ),
              );
          }
          if (clineModelSelection) {
            yield* applyClineAcpModelSelection({
              runtime: acp,
              requestedModelId: clineModelSelection.model,
              mapError: (cause) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_config_option", cause),
            }).pipe(
              Effect.catchTag(
                "ClineModelSelectionError",
                (error): ProviderAdapterValidationError =>
                  new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "startSession",
                    issue: error.message,
                  }),
              ),
            );
          }

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: clineModelSelection?.model ?? discoveredModels.find((m) => m.isDefault)?.slug,
            threadId: input.threadId,
            resumeCursor: { schemaVersion: CLINE_RESUME_VERSION, sessionId: started.sessionId },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            promptLifecycle: yield* Semaphore.make(1),
            notificationFiber: undefined,
            pendingApprovals,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            interruptedTurnIds: new Set(),
            promptsInFlight: 0,
            stopped: false,
          };

          const notificationFiber = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "EventStreamBarrier":
                    yield* Deferred.succeed(event.acknowledge, undefined);
                    return;
                  case "ModeChanged":
                    return;
                  case "ConnectionTerminated":
                    // The Cline process is gone. Without this the session keeps
                    // reporting `ready` and every later turn fails against a
                    // dead connection, so retire it the same way a stop does.
                    yield* Effect.logWarning("Cline ACP connection terminated", {
                      threadId: ctx.threadId,
                      detail: event.error.message,
                    });
                    // Forked, not awaited: this runs on the notification fiber
                    // that stopSessionInternal interrupts, so waiting here
                    // would deadlock on itself.
                    yield* Effect.forkIn(ctx.scope)(stopSessionInternal(ctx));
                    return;
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* emitPlanUpdate(ctx, event.payload, event.rawPayload);
                    return;
                  case "ToolCallUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ThoughtDelta":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        streamKind: "reasoning_text",
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError(
                `Failed to process Cline runtime notification (${errorTag(cause)}).`,
                { cause },
              ),
            ),
            // Fork into the session scope, never as a child of startSession:
            // a child fiber is interrupted when startSession returns.
            Effect.forkIn(ctx.scope),
          );

          // Mint every event id before the handover. `makeEventStamp` can fail
          // (crypto), and after `sessionScopeTransferred` the surrounding scope
          // finalizer is a no-op, so a failure here would orphan the Cline
          // process for a session T3 never registered.
          const [sessionStartedStamp, sessionStateStamp, threadStartedStamp] = yield* Effect.all(
            [makeEventStamp(), makeEventStamp(), makeEventStamp()],
            { concurrency: "unbounded" },
          );

          ctx.notificationFiber = notificationFiber;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...sessionStartedStamp,
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: clineInitializeResultForSnapshot(started.initializeResult) },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...sessionStateStamp,
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Cline ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...threadStartedStamp,
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: ClineAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        // A sendTurn while a prompt is in flight steers the running turn.
        const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
        const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
        ctx.promptsInFlight += 1;

        // Only the last remaining prompt settles the turn, so the decrement
        // decides whether `turn.completed` is published.
        //
        // A turn that never published `turn.started` must not be settled with a
        // terminal event either: ingestion deliberately accepts a named
        // completion for a turn it never saw start, so a pre-flight validation
        // rejection would persist a phantom failed turn on top of the failure
        // activity the command reactor already appends. A steering prompt
        // inherits the started turn it is riding on.
        let turnStarted = steeringTurnId !== undefined;
        const settleTurn = (
          state: "completed" | "cancelled" | "failed",
          stopReason: string | null,
        ) =>
          withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              if (ctx.promptsInFlight !== 1 || ctx.stopped) {
                return;
              }
              if (!turnStarted) {
                return;
              }
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: { state, stopReason },
              });
            }),
          );

        // Captured out of band so the settlement branch below can report the
        // agent's stop reason on both the success and failure paths.
        let turnStopReason: string | null = null;

        return yield* ctx.promptLifecycle
          .withPermits(1)(
            Effect.gen(function* () {
              // Validate before any turn state or RPC changes, so a rejected
              // turn cannot leave a reserved turn behind.
              if (input.interactionMode === "plan") {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue:
                    "Cline Plan mode cannot be honored on a running session: Cline binds its tool set " +
                    "on the first prompt, so switching later would still allow file edits.",
                });
              }
              if (input.attachments && input.attachments.length > 0) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: "Cline cannot accept attachments over ACP: it discards non-text content.",
                });
              }
              const rawPrompt = input.input?.trim() ?? "";
              if (!rawPrompt) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: "Turn requires non-empty text.",
                });
              }
              if (!clineSupportsRuntimeMode(ctx.session.runtimeMode)) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue:
                    "Cline supports Supervised and Full access only: its ACP tool approval is a single " +
                    "approve-everything switch with no per-tool policy.",
                });
              }

              const turnModelSelection =
                input.modelSelection?.instanceId === boundInstanceId
                  ? input.modelSelection
                  : undefined;
              const requestedModelId = turnModelSelection?.model ?? ctx.session.model;

              yield* applyClineAcpModelSelection({
                runtime: ctx.acp,
                requestedModelId,
                mapError: (cause) =>
                  mapAcpToAdapterError(
                    PROVIDER,
                    input.threadId,
                    "session/set_config_option",
                    cause,
                  ),
              }).pipe(
                Effect.catchTag(
                  "ClineModelSelectionError",
                  (error): ProviderAdapterValidationError =>
                    new ProviderAdapterValidationError({
                      provider: PROVIDER,
                      operation: "sendTurn",
                      issue: error.message,
                    }),
                ),
              );
              if (turnModelSelection?.options && turnModelSelection.options.length > 0) {
                yield* applyAcpModelOptionSelections({
                  runtime: ctx.acp,
                  selections: turnModelSelection.options,
                  mapError: (cause) =>
                    mapAcpToAdapterError(
                      PROVIDER,
                      input.threadId,
                      "session/set_config_option",
                      cause,
                    ),
                });
              }
              // Re-select Act explicitly: Cline restores a loaded session in Act
              // but a resumed thread may carry a different mode.
              const actModeId = resolveClineActModeId(yield* ctx.acp.getModeState);
              if (actModeId !== undefined) {
                yield* ctx.acp
                  .setMode(actModeId)
                  .pipe(
                    Effect.mapError((cause) =>
                      mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_mode", cause),
                    ),
                  );
              }

              // A Stop that landed during the configuration RPCs above left no
              // prompt on the CLI to cancel, so honour it here instead of
              // starting a turn the user already dismissed.
              if (ctx.interruptedTurnIds.delete(turnId)) {
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "Cline turn was cancelled before the prompt was sent.",
                });
              }

              ctx.activeTurnId = turnId;
              if (steeringTurnId === undefined) {
                ctx.lastPlanFingerprint = undefined;
              }
              ctx.session = {
                ...ctx.session,
                activeTurnId: turnId,
                updatedAt: yield* nowIso,
                ...(requestedModelId !== undefined ? { model: requestedModelId } : {}),
              };
              if (steeringTurnId === undefined) {
                turnStarted = true;
                yield* offerRuntimeEvent({
                  type: "turn.started",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: { model: requestedModelId },
                });
              }

              const isSlashCommand = /^\/[^\s/]+(?:\s|$)/.test(rawPrompt);
              const promptParts: Array<EffectAcpSchema.ContentBlock> = [
                { type: "text", text: rawPrompt },
              ];
              if (!isSlashCommand) {
                promptParts.push({
                  type: "text",
                  text: buildRuntimeInstructions({ harness: "Cline", model: requestedModelId }),
                });
              }

              const result = yield* ctx.acp.prompt({ prompt: promptParts }).pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
                ),
                Effect.tap(() => ctx.acp.drainEvents),
              );
              turnStopReason = result.stopReason ?? null;

              // Cline stays the durable conversation owner, so this snapshot
              // keeps only turn identity; retaining prompt bodies here would
              // duplicate unbounded history in memory.
              if (!ctx.turns.some((turn) => turn.id === turnId)) {
                ctx.turns.push({ id: turnId, items: [] });
              }
              ctx.session = { ...ctx.session, updatedAt: yield* nowIso };

              return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
            }).pipe(
              // A prompt that fails after `turn.started` still owes the turn a
              // terminal event, or the UI keeps spinning forever.
              Effect.matchEffect({
                onFailure: (error) =>
                  settleTurn("failed", null).pipe(Effect.andThen(Effect.fail(error))),
                // `Effect.as` keeps the turn-start result as the success value;
                // without it the branch widens to `void` and erases it.
                onSuccess: (turnResult) =>
                  settleTurn(
                    turnStopReason === "cancelled" ? "cancelled" : "completed",
                    turnStopReason,
                  ).pipe(Effect.as(turnResult)),
              }),
            ),
          )
          .pipe(
            Effect.ensuring(
              withThreadLock(
                input.threadId,
                Effect.sync(() => {
                  ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
                  // Drop any record the turn never consumed, so a long-lived
                  // session does not accumulate cancelled turn ids.
                  ctx.interruptedTurnIds.delete(turnId);
                  // Clear the active turn once nothing is left running, so a
                  // finished session is not reported as active and later
                  // notifications are not attributed to a completed turn.
                  if (ctx.promptsInFlight === 0) {
                    ctx.activeTurnId = undefined;
                    ctx.session = { ...ctx.session, activeTurnId: undefined };
                  }
                }),
              ),
            ),
          );
      });

    const interruptTurn: ClineAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        // Record the cancellation for the sendTurn that still holds the prompt
        // permit: it takes no lock here, so a Stop during its configuration RPCs
        // would otherwise find no prompt on the CLI to cancel and the turn would
        // run to completion anyway.
        //
        // A turn id that disagrees with a running turn belongs to a different
        // turn, so it is ignored rather than cancelling the live prompt.
        const activeTurnId = ctx.activeTurnId;
        const targetTurnId = turnId ?? activeTurnId;
        if (activeTurnId !== undefined && targetTurnId !== activeTurnId) {
          return;
        }
        if (targetTurnId !== undefined) {
          ctx.interruptedTurnIds.add(targetTurnId);
        }
        // Answer any parked permission request before cancelling: the Cline
        // handler is blocked on its Deferred and would otherwise hold the
        // request open past the cancelled prompt.
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
          ),
        );
      });

    const respondToRequest: ClineAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        // Delete first so a second response is rejected rather than silently
        // replacing the first decision Cline already consumed.
        ctx.pendingApprovals.delete(requestId);
        const settled = yield* Deferred.succeed(pending.decision, decision);
        if (!settled) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Approval request was already resolved: ${requestId}`,
          });
        }
      });

    const respondToUserInput: ClineAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      _answers: ProviderUserInputAnswers,
    ) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "user-input",
          detail: `Cline ACP has no pending structured user-input request: ${requestId}`,
        });
      });

    const readThread: ClineAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: ClineAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "Cline ACP sessions do not support provider-side rollback.",
        });
      });

    const stopSession: ClineAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: ClineAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: ClineAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: ClineAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.catch((cause) =>
          Effect.logError(`Failed to emit Cline session shutdown event (${errorTag(cause)}).`, {
            cause,
          }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsConversationRollback: false,
        // Cline stores the ACP `mcpServers` field and never loads those servers.
        consumesMcpServers: false,
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies ClineAdapterShape;
  });
}
