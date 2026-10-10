import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ServerProvider,
} from "@t3tools/contracts";
import type { GoalSettings } from "@t3tools/contracts/goals";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { openQueueDatabase } from "../../../../packages/agent-queue-core/src/index.ts";
import {
  createTestGitRepo,
  execCommand,
} from "../../../../packages/agent-queue-core/test/harness/gitHarness.ts";

import * as ServerConfig from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { GoalBeads } from "./GoalBeads.ts";
import * as GoalService from "./GoalService.ts";
import * as GoalStore from "./GoalStore.ts";
import { AgentQueueServiceLive } from "../queue/AgentQueueService.ts";

const PROJECT = ProjectId.make("project-queue-lifecycle");
const CODEX = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" };
const encodeDependencies = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const providerSnapshot = (instanceId: string): ServerProvider =>
  ({
    instanceId,
    driver: instanceId,
    displayName: instanceId,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-04T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  }) as unknown as ServerProvider;

it.effect("starts only two workers for a 10-task DAG with four Goal slots", () =>
  Effect.gen(function* () {
    const repo = yield* Effect.promise(() => createTestGitRepo("goal-aq-10-task-dispatch-"));
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = "2026-10-10T00:00:00.000Z";
      const tasks = [
        { id: "T1", title: "Setup core schema", deps: [] },
        { id: "T2", title: "Setup auth utilities", deps: [] },
        { id: "T3", title: "Implement user migrations", deps: ["T1"] },
        { id: "T4", title: "Implement session migrations", deps: ["T1"] },
        { id: "T5", title: "Implement password hashing", deps: ["T2"] },
        { id: "T6", title: "Build user store", deps: ["T3", "T4"] },
        { id: "T7", title: "Generate auth tokens", deps: ["T5"] },
        { id: "T8", title: "Integrate user repository", deps: ["T6"] },
        { id: "T9", title: "Integrate auth middleware", deps: ["T7"] },
        { id: "T10", title: "Add end-to-end tests", deps: ["T8", "T9"] },
      ];
      const insertTask = db.prepare(`
        INSERT INTO tasks (id, title, status, version, dependencies, verification_command, created_at, updated_at)
        VALUES (?, ?, 'pending', 1, ?, 'git diff --check', ?, ?)
      `);
      for (const task of tasks) {
        insertTask.run(task.id, task.title, encodeDependencies(task.deps), now, now);
      }
      db.close();

      const commands = yield* Queue.unbounded<OrchestrationCommand>();
      const log: OrchestrationCommand[] = [];
      const events = yield* PubSub.unbounded<OrchestrationEvent>();
      const subscription = yield* PubSub.subscribe(events);
      const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([providerSnapshot("codex")]);

      const layer = GoalService.layer.pipe(
        Layer.provideMerge(GoalStore.layer),
        Layer.provideMerge(Layer.succeed(GoalService.StartSpacingMillis, 0)),
        Layer.provideMerge(AgentQueueServiceLive),
        Layer.provideMerge(
          Layer.succeed(
            GoalBeads,
            GoalBeads.of({
              available: () => Effect.succeed(false),
              snapshot: () => Effect.die("not used"),
              repoContext: () => Effect.succeed(""),
              describe: () => Effect.succeed({ blocked: [], claimed: [] }),
              statusOf: () => Effect.succeed("closed"),
              release: () => Effect.void,
            }),
          ),
        ),
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.mock(OrchestrationEngineService)({
              dispatch: (command) =>
                Queue.offer(commands, command).pipe(Effect.as({ sequence: 1 })),
              streamDomainEvents: Stream.fromSubscription(subscription),
            }),
            Layer.mock(ProviderRegistry)({ getProviders: Ref.get(providers) }),
            Layer.mock(ProjectionSnapshotQuery)({
              getProjectShells: (ids) =>
                Effect.succeed(
                  (ids ?? []).includes(PROJECT)
                    ? [{ id: PROJECT, workspaceRoot: repo.rootDir } as never]
                    : [],
                ),
              getThreadShellById: () => Effect.succeed(Option.none()),
              getThreadDetailById: () => Effect.succeed(Option.none()),
            }),
            Layer.fresh(
              ServerConfig.layerTest(repo.rootDir, { prefix: "t3code-goals-aq-dispatch-" }),
            ),
          ),
        ),
      );

      const testRun = Effect.gen(function* () {
        const goals = yield* GoalService.GoalService;
        const waitForCreates = Effect.fn("waitForCreates")(function* (count: number) {
          while (log.filter((command) => command.type === "thread.create").length < count) {
            log.push(yield* Queue.take(commands));
          }
          return log.filter(
            (command): command is Extract<OrchestrationCommand, { type: "thread.create" }> =>
              command.type === "thread.create",
          );
        });

        const settings: GoalSettings = {
          name: "10-Task Dependency Dispatch",
          projectId: PROJECT,
          agents: [{ modelSelection: CODEX, count: 4 }],
          concurrency: 4,
          maxChats: 30,
          runtimeMode: "full-access",
          autoResume: true,
          standardRules: true,
          useAgentQueue: true,
          queueMode: "agentqueue",
          overseer: false,
        };

        yield* goals.create(settings);
        const creates = yield* waitForCreates(2);
        expect(creates).toHaveLength(2);

        const afterDispatch = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
        const claims = afterDispatch
          .prepare(
            "SELECT task_id, worktree_path, branch FROM task_claims WHERE released_at IS NULL",
          )
          .all() as Array<{ task_id: string; worktree_path: string; branch: string }>;
        expect(claims.map((claim) => claim.task_id).sort()).toEqual(["T1", "T2"]);
        expect(new Set(claims.map((claim) => claim.worktree_path)).size).toBe(2);
        expect(new Set(claims.map((claim) => claim.branch)).size).toBe(2);
        const snapshot = afterDispatch
          .prepare("SELECT status, count(*) as count FROM tasks GROUP BY status")
          .all() as Array<{ status: string; count: number }>;
        expect(snapshot.find((row) => row.status === "pending")?.count).toBe(8);
        afterDispatch.close();

        // Drain already queued turn starts; no third thread may be waiting in the command queue.
        while (true) {
          const next = yield* Queue.poll(commands);
          if (Option.isNone(next)) break;
          log.push(next.value);
        }
        expect(log.filter((command) => command.type === "thread.create")).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(layer));

      yield* testRun;
    } finally {
      yield* Effect.promise(() => repo.cleanup());
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "executes a 10-task DAG end-to-end through Goal lifecycle, unlocking dependencies, landing commits, and completing the Goal",
  () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => createTestGitRepo("goal-aq-10-task-e2e-"));
      try {
        const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
        const now = "2026-10-10T00:00:00.000Z";
        const tasks = [
          { id: "T1", title: "Setup core schema", deps: [] },
          { id: "T2", title: "Setup auth utilities", deps: [] },
          { id: "T3", title: "Implement user migrations", deps: ["T1"] },
          { id: "T4", title: "Implement session migrations", deps: ["T1"] },
          { id: "T5", title: "Implement password hashing", deps: ["T2"] },
          { id: "T6", title: "Build user store", deps: ["T3", "T4"] },
          { id: "T7", title: "Generate auth tokens", deps: ["T5"] },
          { id: "T8", title: "Integrate user repository", deps: ["T6"] },
          { id: "T9", title: "Integrate auth middleware", deps: ["T7"] },
          { id: "T10", title: "Add end-to-end tests", deps: ["T8", "T9"] },
        ];
        const insertTask = db.prepare(`
        INSERT INTO tasks (id, title, status, version, dependencies, verification_command, created_at, updated_at)
        VALUES (?, ?, 'pending', 1, ?, 'node -e "process.exit(0)"', ?, ?)
      `);
        for (const task of tasks) {
          insertTask.run(task.id, task.title, encodeDependencies(task.deps), now, now);
        }
        db.close();

        const commands = yield* Queue.unbounded<OrchestrationCommand>();
        const events = yield* PubSub.unbounded<OrchestrationEvent>();
        const subscription = yield* PubSub.subscribe(events);
        const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([
          providerSnapshot("codex"),
        ]);

        const layer = GoalService.layer.pipe(
          Layer.provideMerge(GoalStore.layer),
          Layer.provideMerge(Layer.succeed(GoalService.StartSpacingMillis, 0)),
          Layer.provideMerge(AgentQueueServiceLive),
          Layer.provideMerge(
            Layer.succeed(
              GoalBeads,
              GoalBeads.of({
                available: () => Effect.succeed(false),
                snapshot: () => Effect.die("not used"),
                repoContext: () => Effect.succeed(""),
                describe: () => Effect.succeed({ blocked: [], claimed: [] }),
                statusOf: () => Effect.succeed("closed"),
                release: () => Effect.void,
              }),
            ),
          ),
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.mock(OrchestrationEngineService)({
                dispatch: (command) =>
                  Queue.offer(commands, command).pipe(Effect.as({ sequence: 1 })),
                streamDomainEvents: Stream.fromSubscription(subscription),
              }),
              Layer.mock(ProviderRegistry)({ getProviders: Ref.get(providers) }),
              Layer.mock(ProjectionSnapshotQuery)({
                getProjectShells: (ids) =>
                  Effect.succeed(
                    (ids ?? []).includes(PROJECT)
                      ? [{ id: PROJECT, workspaceRoot: repo.rootDir } as never]
                      : [],
                  ),
                getThreadShellById: () => Effect.succeed(Option.none()),
                getThreadDetailById: () =>
                  Effect.succeed(
                    Option.some({
                      latestTurn: { state: "completed" },
                      messages: [{ role: "assistant", text: "Task completed successfully" }],
                      activities: [],
                    } as unknown as OrchestrationThread),
                  ),
              }),
              Layer.fresh(ServerConfig.layerTest(repo.rootDir, { prefix: "t3code-goals-aq-e2e-" })),
            ),
          ),
        );

        const testRun = Effect.gen(function* () {
          const goals = yield* GoalService.GoalService;
          yield* Effect.forkScoped(goals.loop);
          yield* Effect.yieldNow;

          const settings: GoalSettings = {
            name: "10-Task Dependency E2E",
            projectId: PROJECT,
            agents: [{ modelSelection: CODEX, count: 4 }],
            concurrency: 4,
            maxChats: 30,
            runtimeMode: "full-access",
            autoResume: true,
            standardRules: true,
            useAgentQueue: true,
            queueMode: "agentqueue",
            overseer: false,
          };

          yield* goals.create(settings);

          let completedCount = 0;
          const processedThreads = new Set<string>();

          while (completedCount < 10) {
            const cmd = yield* Queue.take(commands);
            if (cmd.type !== "thread.create") continue;
            if (processedThreads.has(cmd.threadId)) continue;
            processedThreads.add(cmd.threadId);

            expect(cmd.worktreePath).toBeDefined();
            expect(cmd.branch).toBeDefined();

            // Simulate worker committing changes in the assigned worktree
            yield* Effect.promise(() =>
              execCommand(
                "git",
                ["commit", "--allow-empty", "-m", `feat: complete ${cmd.title}`],
                cmd.worktreePath!,
              ),
            );

            // Emit session events (running then completed) to trigger onSessionSet -> finishChat -> verifyAndLand
            yield* PubSub.publish(events, {
              sequence: 1,
              eventId: `e-run-${cmd.threadId}`,
              aggregateKind: "thread",
              aggregateId: cmd.threadId,
              occurredAt: "2026-10-10T00:01:00.000Z",
              type: "thread.session-set",
              payload: {
                threadId: cmd.threadId,
                session: {
                  activeTurnId: "turn-1",
                  status: "running",
                  updatedAt: "2026-10-10T00:01:00.000Z",
                },
              },
            } as unknown as OrchestrationEvent);

            yield* PubSub.publish(events, {
              sequence: 2,
              eventId: `e-idle-${cmd.threadId}`,
              aggregateKind: "thread",
              aggregateId: cmd.threadId,
              occurredAt: "2026-10-10T00:02:00.000Z",
              type: "thread.session-set",
              payload: {
                threadId: cmd.threadId,
                session: {
                  activeTurnId: null,
                  status: "idle",
                  updatedAt: "2026-10-10T00:02:00.000Z",
                },
              },
            } as unknown as OrchestrationEvent);

            completedCount++;
          }

          // Wait until Goal status settles to complete
          while ((yield* goals.list)[0]?.status === "running") {
            yield* Effect.yieldNow;
          }

          const [finalGoal] = yield* goals.list;
          expect(finalGoal?.status).toBe("complete");

          // Verify all 10 tasks in SQLite are completed
          const dbCheck = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
          const summary = dbCheck
            .prepare("SELECT status, count(*) as count FROM tasks GROUP BY status")
            .all() as Array<{ status: string; count: number }>;
          expect(summary).toEqual([{ status: "completed", count: 10 }]);
          dbCheck.close();

          // Verify git log in base branch has all 10 commits
          const { stdout: gitLog } = yield* Effect.promise(() =>
            execCommand("git", ["log", "--oneline"], repo.rootDir),
          );
          for (const task of tasks) {
            expect(gitLog).toContain(task.title);
          }
        }).pipe(Effect.scoped, Effect.provide(layer));

        yield* testRun;
      } finally {
        yield* Effect.promise(() => repo.cleanup());
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "recovers interrupted worker on restart, reconciling expired leases and continuing to Goal completion",
  () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => createTestGitRepo("goal-aq-recovery-"));
      try {
        const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
        const now = "2026-10-10T00:00:00.000Z";
        const tasks = [
          { id: "T1", title: "Crash recovery initial task", deps: [] },
          { id: "T2", title: "Crash recovery follow-up task", deps: ["T1"] },
        ];
        const insertTask = db.prepare(`
        INSERT INTO tasks (id, title, status, version, dependencies, verification_command, created_at, updated_at)
        VALUES (?, ?, 'pending', 1, ?, 'node -e "process.exit(0)"', ?, ?)
      `);
        for (const task of tasks) {
          insertTask.run(task.id, task.title, encodeDependencies(task.deps), now, now);
        }
        db.close();

        const commands = yield* Queue.unbounded<OrchestrationCommand>();
        const events = yield* PubSub.unbounded<OrchestrationEvent>();
        const subscription = yield* PubSub.subscribe(events);
        const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([
          providerSnapshot("codex"),
        ]);
        const interruptedThreads = yield* Ref.make(new Set<string>());

        const layer = GoalService.layer.pipe(
          Layer.provideMerge(GoalStore.layer),
          Layer.provideMerge(Layer.succeed(GoalService.StartSpacingMillis, 0)),
          Layer.provideMerge(AgentQueueServiceLive),
          Layer.provideMerge(
            Layer.succeed(
              GoalBeads,
              GoalBeads.of({
                available: () => Effect.succeed(false),
                snapshot: () => Effect.die("not used"),
                repoContext: () => Effect.succeed(""),
                describe: () => Effect.succeed({ blocked: [], claimed: [] }),
                statusOf: () => Effect.succeed("closed"),
                release: () => Effect.void,
              }),
            ),
          ),
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.mock(OrchestrationEngineService)({
                dispatch: (command) =>
                  Queue.offer(commands, command).pipe(Effect.as({ sequence: 1 })),
                streamDomainEvents: Stream.fromSubscription(subscription),
              }),
              Layer.mock(ProviderRegistry)({ getProviders: Ref.get(providers) }),
              Layer.mock(ProjectionSnapshotQuery)({
                getProjectShells: (ids) =>
                  Effect.succeed(
                    (ids ?? []).includes(PROJECT)
                      ? [{ id: PROJECT, workspaceRoot: repo.rootDir } as never]
                      : [],
                  ),
                getThreadShellById: () => Effect.succeed(Option.none()),
                getThreadDetailById: (id) =>
                  Ref.get(interruptedThreads).pipe(
                    Effect.map((interrupted) =>
                      Option.some({
                        latestTurn: { state: interrupted.has(id) ? "interrupted" : "completed" },
                        messages: [{ role: "assistant", text: "Task completed successfully" }],
                        activities: [],
                      } as unknown as OrchestrationThread),
                    ),
                  ),
              }),
              Layer.fresh(ServerConfig.layerTest(repo.rootDir, { prefix: "t3code-goals-aq-rec-" })),
            ),
          ),
        );

        const testRun = Effect.gen(function* () {
          const goals = yield* GoalService.GoalService;
          yield* Effect.forkScoped(goals.loop);
          yield* Effect.yieldNow;

          const settings: GoalSettings = {
            name: "Crash Recovery Goal",
            projectId: PROJECT,
            agents: [{ modelSelection: CODEX, count: 2 }],
            concurrency: 2,
            maxChats: 10,
            runtimeMode: "full-access",
            autoResume: true,
            standardRules: true,
            useAgentQueue: true,
            queueMode: "agentqueue",
            overseer: false,
          };

          yield* goals.create(settings);

          // Find initial thread create for T1
          let firstCmd: Extract<OrchestrationCommand, { type: "thread.create" }> | null = null;
          while (!firstCmd) {
            const cmd = yield* Queue.take(commands);
            if (cmd.type === "thread.create") {
              firstCmd = cmd;
            }
          }

          // Mark the first thread as interrupted
          yield* Ref.update(interruptedThreads, (s) => new Set([...s, firstCmd!.threadId]));

          // Simulate crash / interrupted lease:
          // Set claim expiration in the past and dead PID
          const dbCrash = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
          dbCrash
            .prepare(`
          UPDATE task_claims
          SET expires_at = '2026-10-09T00:00:00.000Z', worker_pid = 9999999
          WHERE task_id = 'T1' AND released_at IS NULL
        `)
            .run();
          dbCrash.close();

          // Abort the crashed thread
          yield* PubSub.publish(events, {
            type: "thread.session-set",
            payload: {
              threadId: firstCmd.threadId,
              session: {
                activeTurnId: null,
                status: "error",
                lastError: "Simulated worker crash",
                updatedAt: "2026-10-10T00:03:00.000Z",
              },
            },
          } as unknown as OrchestrationEvent);

          // Wait for next thread creation after lease reconciliation and lane refill
          let recoveredCmd: Extract<OrchestrationCommand, { type: "thread.create" }> | null = null;
          while (!recoveredCmd) {
            const cmd = yield* Queue.take(commands);
            if (cmd.type === "thread.create" && cmd.threadId !== firstCmd.threadId) {
              recoveredCmd = cmd;
            }
          }

          // Recovered thread is working on T1
          expect(recoveredCmd.title).toContain("T1");
          expect(recoveredCmd.worktreePath).toBeDefined();

          // Complete T1
          yield* Effect.promise(() =>
            execCommand(
              "git",
              ["commit", "--allow-empty", "-m", "feat: complete T1 after recovery"],
              recoveredCmd!.worktreePath!,
            ),
          );
          yield* PubSub.publish(events, {
            type: "thread.session-set",
            payload: {
              threadId: recoveredCmd.threadId,
              session: {
                activeTurnId: "turn-1",
                status: "running",
                updatedAt: "2026-10-10T00:04:00.000Z",
              },
            },
          } as unknown as OrchestrationEvent);
          yield* PubSub.publish(events, {
            type: "thread.session-set",
            payload: {
              threadId: recoveredCmd.threadId,
              session: {
                activeTurnId: null,
                status: "idle",
                updatedAt: "2026-10-10T00:05:00.000Z",
              },
            },
          } as unknown as OrchestrationEvent);

          // Next, T2 should be unlocked and scheduled
          let t2Cmd: Extract<OrchestrationCommand, { type: "thread.create" }> | null = null;
          while (!t2Cmd) {
            const cmd = yield* Queue.take(commands);
            if (cmd.type === "thread.create" && cmd.title?.includes("T2")) {
              t2Cmd = cmd;
            }
          }
          expect(t2Cmd).toBeDefined();

          // Complete T2
          yield* Effect.promise(() =>
            execCommand(
              "git",
              ["commit", "--allow-empty", "-m", "feat: complete T2"],
              t2Cmd!.worktreePath!,
            ),
          );
          yield* PubSub.publish(events, {
            type: "thread.session-set",
            payload: {
              threadId: t2Cmd!.threadId,
              session: {
                activeTurnId: "turn-1",
                status: "running",
                updatedAt: "2026-10-10T00:06:00.000Z",
              },
            },
          } as unknown as OrchestrationEvent);
          yield* PubSub.publish(events, {
            type: "thread.session-set",
            payload: {
              threadId: t2Cmd!.threadId,
              session: {
                activeTurnId: null,
                status: "idle",
                updatedAt: "2026-10-10T00:07:00.000Z",
              },
            },
          } as unknown as OrchestrationEvent);

          // Wait until Goal status settles to complete
          while ((yield* goals.list)[0]?.status === "running") {
            yield* Effect.yieldNow;
          }

          const [finalGoal] = yield* goals.list;
          expect(finalGoal?.status).toBe("complete");

          // Verify tasks in SQLite are completed
          const dbCheck = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
          const summary = dbCheck
            .prepare("SELECT status, count(*) as count FROM tasks GROUP BY status")
            .all() as Array<{ status: string; count: number }>;
          expect(summary).toEqual([{ status: "completed", count: 2 }]);
          dbCheck.close();
        }).pipe(Effect.scoped, Effect.provide(layer));

        yield* testRun;
      } finally {
        yield* Effect.promise(() => repo.cleanup());
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);
