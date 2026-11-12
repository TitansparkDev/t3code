import { CommandId, MessageId, ThreadId, type ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  createJobRunner,
  describeJob,
  openBroker,
  ResourceBroker,
  type JobRunner,
  type Ticket,
} from "../../../../packages/agent-queue-core/src/index.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

const THREAD_OWNER_PREFIX = "thread:";
const TICK_INTERVAL = "2 seconds";
/** Run states in which a thread cannot take a new message without it being queued behind work. */
const BUSY_STATUSES: ReadonlyArray<string> = ["preparing", "starting", "running", "waiting"];

export interface ThreadJobThread {
  readonly projectId: ProjectId;
  readonly busy: boolean;
}

export class ThreadJobError extends Schema.TaggedError<ThreadJobError>()("ThreadJobError", {
  operation: Schema.Literals(["tick", "read", "send"]),
  cause: Schema.Defect(),
}) {}

/** The thread operations a finished thread job needs; the layer maps them onto ThreadManagement. */
export interface ThreadJobPort {
  /** Null when the thread is missing, deleted or archived. */
  readonly thread: (threadId: ThreadId) => Effect.Effect<ThreadJobThread | null, ThreadJobError>;
  readonly send: (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly text: string;
  }) => Effect.Effect<void, ThreadJobError>;
}

export interface ThreadJobDeps {
  readonly broker: ResourceBroker;
  readonly runner: JobRunner;
  readonly port: ThreadJobPort;
}

const logFailure =
  (message: string) =>
  <E>(cause: Cause.Cause<E>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logWarning(message, { cause: Cause.pretty(cause) });

/**
 * The server's half of thread-job delivery. Each pass runs the thread-job runner, then posts the
 * result of every finished thread job into its thread once the thread is idle. The message id is
 * derived from the ticket, so a retry after a crash is the same message, not a second one.
 */
export function createThreadResourceJobs(deps: ThreadJobDeps) {
  const { broker, runner, port } = deps;

  const deliverOne = Effect.fn("ThreadResourceJobs.deliverOne")(function* (ticket: Ticket) {
    const threadId = ThreadId.make(ticket.ownerRef!.slice(THREAD_OWNER_PREFIX.length));
    const thread = yield* port.thread(threadId);
    if (thread === null) {
      broker.markReported(ticket.id);
      return;
    }
    if (thread.busy) return;
    yield* port.send({
      projectId: thread.projectId,
      threadId,
      messageId: MessageId.make(`thread-job:${ticket.id}`),
      text: describeJob(ticket),
    });
    broker.markReported(ticket.id);
  });

  const deliverOnce = Effect.fn("ThreadResourceJobs.deliverOnce")(function* () {
    yield* Effect.tryPromise({
      try: () => runner.tick(),
      catch: (cause) => new ThreadJobError({ operation: "tick", cause }),
    }).pipe(Effect.catchCause(logFailure("queue.thread-runner-tick-failed")));
    const finished = yield* Effect.sync(() => broker.unreportedJobs()).pipe(
      Effect.map((jobs) =>
        jobs.filter((ticket) => ticket.ownerRef?.startsWith(THREAD_OWNER_PREFIX) === true),
      ),
    );
    for (const ticket of finished) {
      yield* deliverOne(ticket).pipe(
        Effect.catchCause(logFailure("queue.thread-job-delivery-failed")),
      );
    }
  });

  const loop = Effect.forever(deliverOnce().pipe(Effect.andThen(Effect.sleep(TICK_INTERVAL))));

  return { deliverOnce, loop };
}

export class ThreadResourceJobs extends Context.Service<
  ThreadResourceJobs,
  { readonly loop: Effect.Effect<void> }
>()("t3/queue/ThreadResourceJobs") {}

const portOf = (threads: ThreadManagement.ThreadManagementServiceShape): ThreadJobPort => ({
  thread: (threadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.map((shell) =>
        shell === null || shell.deletedAt !== null || shell.archivedAt !== null
          ? null
          : {
              projectId: shell.projectId,
              busy: shell.activeRunId !== null || BUSY_STATUSES.includes(shell.status),
            },
      ),
      Effect.mapError((cause) => new ThreadJobError({ operation: "read", cause })),
    ),
  send: (input) =>
    threads
      .sendToThread({
        projectId: input.projectId,
        commandId: CommandId.make(`thread-job:${input.messageId}`),
        threadId: input.threadId,
        messageId: input.messageId,
        text: input.text,
        attachments: [],
        mode: "auto",
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError((cause) => new ThreadJobError({ operation: "send", cause })),
      ),
});

export const layer = Layer.effect(
  ThreadResourceJobs,
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    // A broken queue database must not stop the server: thread mode stays off (the CLI falls back).
    const opened = yield* Effect.acquireRelease(
      Effect.try({
        try: () => openBroker(),
        catch: (cause) => new ThreadJobError({ operation: "tick", cause }),
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("queue.thread-jobs-broker-unavailable", { cause: String(error.cause) }),
        ),
        Effect.option,
      ),
      (broker) => Effect.sync(() => Option.map(broker, (open) => open.close())),
    );
    if (Option.isNone(opened)) return ThreadResourceJobs.of({ loop: Effect.void });
    const broker = opened.value;
    const runner = createJobRunner({ repo: ResourceBroker.THREAD_JOBS_REPO, broker });
    return ThreadResourceJobs.of({
      loop: createThreadResourceJobs({ broker, runner, port: portOf(threads) }).loop,
    });
  }),
);
