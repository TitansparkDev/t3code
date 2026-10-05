/**
 * ChatAgentsAdapterLive — ordinary ChatGPT desktop chats, driven through W's
 * desktop worker the way W's Telegram service drives them.
 *
 * Each T3 turn is one run of `chatgpt_worker_w.py --role owner`. The first turn
 * opens a new ChatGPT conversation; the conversation id the worker reports is
 * kept in the resume cursor, so every later turn continues the same chat.
 *
 * - **Coarse streaming.** The worker returns when ChatGPT has finished, so the
 *   reply arrives as one piece. There is no tool-by-tool activity.
 * - **One turn at a time.** The worker's owner slot is single and refuses a
 *   second caller, so turns queue here instead of failing, across all threads.
 * - **Stop.** Interrupting a turn terminates the worker process, which closes
 *   its window.
 * - **A lost conversation** (deleted in ChatGPT) starts a new chat with a
 *   warning rather than failing the thread.
 *
 * @module ChatAgentsAdapterLive
 */
import {
  CHAT_AGENTS_MODEL,
  type ChatAgentsSettings,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("chatAgents");
const RESUME_VERSION = 1 as const;
/** How long a refused run waits before asking for the owner slot again. */
const CAPACITY_RETRY_SECONDS = 20;
const CAPACITY_RETRIES = 30;

const decodeResume = Schema.decodeUnknownOption(
  Schema.Struct({
    schemaVersion: Schema.Literal(RESUME_VERSION),
    conversationId: Schema.String,
  }),
);

const decodeJsonLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;

/** What one worker run reported. The worker prints one JSON object; the last line is it. */
export interface WorkerResult {
  readonly status: string;
  readonly conversationId: string | undefined;
  readonly responseText: string | undefined;
  readonly failureCode: string | undefined;
  readonly message: string | undefined;
}

const EMPTY_RESULT: WorkerResult = {
  status: "error",
  conversationId: undefined,
  responseText: undefined,
  failureCode: undefined,
  message: undefined,
};

export function parseWorkerOutput(stdout: string): WorkerResult | undefined {
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  const last = lines.at(-1);
  if (last === undefined) return undefined;
  const decoded = decodeJsonLine(last);
  if (Option.isNone(decoded)) return { ...EMPTY_RESULT, message: last.slice(-300) };
  const value = decoded.value;
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const text = (key: string) => {
    const field = record[key];
    return typeof field === "string" && field.trim() !== "" ? field : undefined;
  };
  return {
    status: typeof record.status === "string" ? record.status : "error",
    conversationId: text("conversation_id"),
    responseText: text("response_text"),
    failureCode: text("failure_code"),
    message: text("message"),
  };
}

interface ChatAgentsSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  conversationId: string | undefined;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  runFiber: Fiber.Fiber<WorkerResult> | undefined;
  stopped: boolean;
}

export interface ChatAgentsAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
}

type ChatAgentsAdapterError =
  | ProviderAdapterRequestError
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterValidationError;

export function makeChatAgentsAdapter(
  settings: ChatAgentsSettings,
  options?: ChatAgentsAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("chatAgents");
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;

    const sessions = new Map<ThreadId, ChatAgentsSessionContext>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    // The worker's owner slot is single and refuses a second caller.
    const workerSlot = yield* Semaphore.make(1);

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate a Chat Agents identifier.",
            cause,
          }),
      ),
    );
    const makeEventStamp = () =>
      Effect.all({
        eventId: Effect.map(randomUUIDv4, (id) => EventId.make(id)),
        createdAt: nowIso,
      });
    const offer = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const turnTimeoutMs = Number(settings.turnTimeoutMinutes) * 60_000;

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<ChatAgentsSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      return !ctx || ctx.stopped
        ? Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }))
        : Effect.succeed(ctx);
    };

    /** One worker run for one prompt. Interrupting the effect terminates the process. */
    const runWorker = (prompt: string, conversationId: string | undefined, requestId: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const requestFile = yield* fs.makeTempFileScoped({ prefix: "chat-agents-" });
          yield* fs.writeFileString(
            requestFile,
            encodeJson({
              request_id: requestId,
              role: "owner",
              prompt,
              conversation_id: conversationId ?? null,
            }),
          );
          const stdout = yield* spawner.string(
            ChildProcess.make(
              settings.workerPath,
              ["--role", "owner", "--task-id", requestId, "--request-file", requestFile],
              {
                env: {
                  ...options?.environment,
                  CHATGPT_WORKER_PYTHON: settings.pythonPath,
                  CHATGPT_WORKER_DIAG_DIR: path.join(
                    settings.runtimeRoot,
                    "logs",
                    "desktop-diagnostics",
                  ),
                  CHATGPT_WORKER_CAPABILITY_PATH: path.join(
                    settings.runtimeRoot,
                    "telegram",
                    "t3code-capability.json",
                  ),
                },
                extendEnv: true,
                stdin: "ignore",
                stderr: "ignore",
              },
            ),
          );
          return (
            parseWorkerOutput(stdout) ?? { ...EMPTY_RESULT, message: "The worker said nothing." }
          );
        }),
      ).pipe(
        // A worker that cannot start is a failed turn, not a defect.
        Effect.catch((cause) =>
          Effect.succeed({
            ...EMPTY_RESULT,
            message: `Could not run W's desktop worker: ${String(cause).slice(0, 200)}`,
          } satisfies WorkerResult),
        ),
        Effect.timeoutOption(turnTimeoutMs),
        Effect.map((result) =>
          Option.getOrElse(result, (): WorkerResult => ({
            ...EMPTY_RESULT,
            failureCode: "TURN_TIMEOUT",
            message: `ChatGPT did not finish within ${settings.turnTimeoutMinutes} minutes.`,
          })),
        ),
      );

    /** Waits for the worker slot, and asks again while another caller holds it. */
    const runWhenFree = (
      prompt: string,
      conversationId: string | undefined,
      requestId: string,
    ): Effect.Effect<WorkerResult> =>
      workerSlot.withPermit(
        Effect.gen(function* () {
          for (let attempt = 0; attempt < CAPACITY_RETRIES; attempt += 1) {
            const result = yield* runWorker(prompt, conversationId, requestId);
            if (result.failureCode !== "GENERATION_CAPACITY") return result;
            yield* Effect.sleep(`${CAPACITY_RETRY_SECONDS} seconds`);
          }
          return {
            ...EMPTY_RESULT,
            failureCode: "GENERATION_CAPACITY",
            message: "ChatGPT's desktop worker stayed busy. Try again in a few minutes.",
          } satisfies WorkerResult;
        }),
      );

    const startSession: ProviderAdapterShape<ChatAgentsAdapterError>["startSession"] = (input) =>
      Effect.gen(function* () {
        const resume = decodeResume(input.resumeCursor);
        const now = yield* nowIso;
        const conversationId = Option.isSome(resume) ? resume.value.conversationId : undefined;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          model: CHAT_AGENTS_MODEL,
          threadId: input.threadId,
          ...(conversationId
            ? { resumeCursor: { schemaVersion: RESUME_VERSION, conversationId } }
            : {}),
          createdAt: now,
          updatedAt: now,
        };
        const [started, state, thread] = yield* Effect.all([
          makeEventStamp(),
          makeEventStamp(),
          makeEventStamp(),
        ]);
        sessions.set(input.threadId, {
          threadId: input.threadId,
          session,
          conversationId,
          turns: [],
          activeTurnId: undefined,
          runFiber: undefined,
          stopped: false,
        });
        yield* offer({
          type: "session.started",
          ...started,
          provider: PROVIDER,
          threadId: input.threadId,
          payload: conversationId ? { resume: { conversationId } } : {},
        });
        yield* offer({
          type: "session.state.changed",
          ...state,
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { state: "ready", reason: "Chat Agents ready" },
        });
        if (conversationId) {
          yield* offer({
            type: "thread.started",
            ...thread,
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: conversationId },
          });
        }
        return session;
      });

    const sendTurn: ProviderAdapterShape<ChatAgentsAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        if (ctx.activeTurnId !== undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "ChatGPT is still working on the last message in this thread.",
          });
        }
        if (input.attachments && input.attachments.length > 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Chat Agents cannot take attachments. Paste the text into the message.",
          });
        }
        const prompt = input.input?.trim();
        if (!prompt) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Chat Agents needs a message to send.",
          });
        }

        const turnId = TurnId.make(yield* randomUUIDv4);
        const requestId = `T3-${(yield* randomUUIDv4).replaceAll("-", "").slice(0, 12)}`;
        ctx.activeTurnId = turnId;
        ctx.session = {
          ...ctx.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };
        yield* offer({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { model: CHAT_AGENTS_MODEL },
        });

        const settle = (state: "completed" | "cancelled" | "failed", errorMessage?: string) =>
          Effect.gen(function* () {
            ctx.activeTurnId = undefined;
            ctx.runFiber = undefined;
            ctx.session = {
              ...ctx.session,
              status: "ready",
              activeTurnId: undefined,
              updatedAt: yield* nowIso,
            };
            yield* offer({
              type: "turn.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: { state, ...(errorMessage ? { errorMessage } : {}) },
            });
          });
        const started = { threadId: input.threadId, turnId };

        const fiber = yield* Effect.forkDetach(runWhenFree(prompt, ctx.conversationId, requestId));
        ctx.runFiber = fiber;
        let exit = yield* Fiber.await(fiber);
        if (Exit.hasInterrupts(exit)) {
          yield* settle("cancelled");
          return { ...started, resumeCursor: ctx.session.resumeCursor };
        }
        let result: WorkerResult | undefined = Exit.isSuccess(exit) ? exit.value : undefined;

        // The chat was deleted in ChatGPT: carry on in a new one.
        if (result?.failureCode === "CONVERSATION_NOT_FOUND" && ctx.conversationId) {
          ctx.conversationId = undefined;
          yield* offer({
            type: "runtime.warning",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: {
              message:
                "The earlier ChatGPT conversation could not be found, so this message started a new one.",
            },
          });
          const retry = yield* Effect.forkDetach(runWhenFree(prompt, undefined, `${requestId}-r`));
          ctx.runFiber = retry;
          exit = yield* Fiber.await(retry);
          if (Exit.hasInterrupts(exit)) {
            yield* settle("cancelled");
            return { ...started, resumeCursor: ctx.session.resumeCursor };
          }
          result = Exit.isSuccess(exit) ? exit.value : undefined;
        }

        if (!result || result.status !== "success" || result.responseText === undefined) {
          const detail =
            result?.message ??
            (result?.status === "success"
              ? "ChatGPT finished but its reply could not be read."
              : "The ChatGPT desktop worker failed.");
          const message = result?.failureCode ? `${detail} (${result.failureCode})` : detail;
          yield* settle("failed", message);
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "worker/run",
            detail: message,
          });
        }

        if (result.conversationId && CONVERSATION_ID.test(result.conversationId)) {
          const firstTime = ctx.conversationId === undefined;
          ctx.conversationId = result.conversationId;
          ctx.session = {
            ...ctx.session,
            resumeCursor: {
              schemaVersion: RESUME_VERSION,
              conversationId: result.conversationId,
            },
          };
          if (firstTime) {
            yield* offer({
              type: "thread.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { providerThreadId: result.conversationId },
            });
          }
        }

        const itemId = RuntimeItemId.make(yield* randomUUIDv4);
        yield* offer({
          type: "item.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          itemId,
          payload: { itemType: "assistant_message", status: "inProgress" },
        });
        yield* offer({
          type: "content.delta",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          itemId,
          payload: { streamKind: "assistant_text", delta: result.responseText },
        });
        yield* offer({
          type: "item.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          itemId,
          payload: { itemType: "assistant_message", status: "completed" },
        });
        ctx.turns.push({ id: turnId, items: [] });
        yield* settle("completed");
        return { ...started, resumeCursor: ctx.session.resumeCursor };
      });

    const stopSessionInternal = (ctx: ChatAgentsSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        if (ctx.runFiber) yield* Fiber.interrupt(ctx.runFiber);
        sessions.delete(ctx.threadId);
        yield* offer({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.ignore,
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        // One model; nothing to switch.
        sessionModelSwitch: "unsupported",
        supportsConversationRollback: false,
        consumesMcpServers: false,
      },
      startSession,
      sendTurn,
      interruptTurn: (threadId) =>
        requireSession(threadId).pipe(
          Effect.flatMap((ctx) => (ctx.runFiber ? Fiber.interrupt(ctx.runFiber) : Effect.void)),
        ),
      readThread: (threadId) =>
        requireSession(threadId).pipe(Effect.map((ctx) => ({ threadId, turns: ctx.turns }))),
      rollbackThread: (threadId) =>
        requireSession(threadId).pipe(
          Effect.flatMap(() =>
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "thread/rollback",
                detail: "Chat Agents conversations cannot be rolled back.",
              }),
            ),
          ),
        ),
      respondToRequest: (_threadId, requestId) =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "request/respond",
            detail: `Chat Agents has no pending approval request: ${requestId}`,
          }),
        ),
      respondToUserInput: (_threadId, requestId) =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "user-input",
            detail: `Chat Agents has no pending question: ${requestId}`,
          }),
        ),
      stopSession: (threadId) => requireSession(threadId).pipe(Effect.flatMap(stopSessionInternal)),
      listSessions: () =>
        Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session }))),
      hasSession: (threadId) =>
        Effect.sync(() => {
          const ctx = sessions.get(threadId);
          return ctx !== undefined && !ctx.stopped;
        }),
      stopAll: () => Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }),
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies ProviderAdapterShape<ChatAgentsAdapterError>;
  });
}
