// @effect-diagnostics nodeBuiltinImport:off - the broker's SQLite home is a real temp directory.
import { assert, describe, it } from "@effect/vitest";
import { MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  createJobRunner,
  openBroker,
  ResourceBroker,
} from "../../../../packages/agent-queue-core/src/index.ts";
import {
  createThreadResourceJobs,
  type ThreadJobPort,
  type ThreadJobThread,
} from "./ThreadResourceJobs.ts";

const PROJECT = ProjectId.make("project-1");
const THREAD = ThreadId.make("thread-1");
const IDLE: ThreadJobThread = { projectId: PROJECT, busy: false };
const BUSY: ThreadJobThread = { projectId: PROJECT, busy: true };

const withBroker = <A>(body: (broker: ResourceBroker, home: string) => Effect.Effect<A>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "thread-jobs-"))),
    (home) =>
      Effect.acquireUseRelease(
        Effect.sync(() =>
          openBroker({
            home,
            host: () => ({
              totalMb: 25_430,
              availableMb: 20_000,
              budgetAvailableMb: 20_000,
              swapUsedMb: 0,
              swapTotalMb: 8_000,
              cpus: 16,
              load1: 1,
              memoryPressure: 0,
              swapPressure: false,
              diskFreeMb: 100_000,
            }),
          }),
        ),
        (broker) => body(broker, home),
        (broker) => Effect.sync(() => broker.close()),
      ),
    (home) => Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
  );

/** A stored job that already finished, owned by `ownerRef`, as the runner would leave it. */
const finishedJob = (broker: ResourceBroker, ownerRef: string) => {
  const ticket = broker.enqueue({
    resources: [{ name: "heavy_build" }],
    label: "vp test run",
    ownerRef,
    repo: ResourceBroker.THREAD_JOBS_REPO,
    job: { command: "vp test run", cwd: "/tmp", env: {} },
  });
  broker.finish(ticket.id, { outcome: "ok", exitCode: 0, tail: "all green\n" });
  return ticket.id;
};

const fakePort = (threads: Map<string, ThreadJobThread>) => {
  const sent: Array<{
    readonly threadId: string;
    readonly messageId: string;
    readonly text: string;
  }> = [];
  const port: ThreadJobPort = {
    thread: (threadId) => Effect.succeed(threads.get(threadId) ?? null),
    send: (input) =>
      Effect.sync(() => {
        sent.push({
          threadId: input.threadId,
          messageId: input.messageId,
          text: input.text,
        });
      }),
  };
  return { port, sent };
};

describe("ThreadResourceJobs", () => {
  it.effect("posts a finished thread job once into an idle thread and marks it reported", () =>
    withBroker((broker) =>
      Effect.gen(function* () {
        const ticketId = finishedJob(broker, `thread:${THREAD}`);
        const threads = new Map<string, ThreadJobThread>([[THREAD, IDLE]]);
        const { port, sent } = fakePort(threads);
        const jobs = createThreadResourceJobs({
          broker,
          runner: createJobRunner({ repo: ResourceBroker.THREAD_JOBS_REPO, broker }),
          port,
        });

        yield* jobs.deliverOnce();
        yield* jobs.deliverOnce();

        assert.lengthOf(sent, 1);
        assert.strictEqual(sent[0]!.threadId, THREAD);
        assert.strictEqual(sent[0]!.messageId, MessageId.make(`thread-job:${ticketId}`));
        assert.include(sent[0]!.text, ticketId);
        assert.deepStrictEqual(
          broker.unreportedJobs().map((ticket) => ticket.id),
          [],
        );
      }),
    ),
  );

  it.effect("holds the result while the thread is busy and sends it once the thread is idle", () =>
    withBroker((broker) =>
      Effect.gen(function* () {
        const ticketId = finishedJob(broker, `thread:${THREAD}`);
        const threads = new Map<string, ThreadJobThread>([[THREAD, BUSY]]);
        const { port, sent } = fakePort(threads);
        const jobs = createThreadResourceJobs({
          broker,
          runner: createJobRunner({ repo: ResourceBroker.THREAD_JOBS_REPO, broker }),
          port,
        });

        yield* jobs.deliverOnce();
        assert.lengthOf(sent, 0);
        assert.deepStrictEqual(
          broker.unreportedJobs().map((ticket) => ticket.id),
          [ticketId],
        );

        threads.set(THREAD, IDLE);
        yield* jobs.deliverOnce();
        assert.lengthOf(sent, 1);
        assert.deepStrictEqual(broker.unreportedJobs(), []);
      }),
    ),
  );

  it.effect("marks a job reported without sending when its thread no longer exists", () =>
    withBroker((broker) =>
      Effect.gen(function* () {
        finishedJob(broker, `thread:${THREAD}`);
        const { port, sent } = fakePort(new Map());
        const jobs = createThreadResourceJobs({
          broker,
          runner: createJobRunner({ repo: ResourceBroker.THREAD_JOBS_REPO, broker }),
          port,
        });

        yield* jobs.deliverOnce();

        assert.lengthOf(sent, 0);
        assert.deepStrictEqual(broker.unreportedJobs(), []);
      }),
    ),
  );

  it.effect("leaves goal-owned jobs to the goal service", () =>
    withBroker((broker) =>
      Effect.gen(function* () {
        const ticketId = finishedJob(broker, "task-owned-by-a-goal");
        const threads = new Map<string, ThreadJobThread>([[THREAD, IDLE]]);
        const { port, sent } = fakePort(threads);
        const jobs = createThreadResourceJobs({
          broker,
          runner: createJobRunner({ repo: ResourceBroker.THREAD_JOBS_REPO, broker }),
          port,
        });

        yield* jobs.deliverOnce();

        assert.lengthOf(sent, 0);
        assert.deepStrictEqual(
          broker.unreportedJobs().map((ticket) => ticket.id),
          [ticketId],
        );
      }),
    ),
  );
});
