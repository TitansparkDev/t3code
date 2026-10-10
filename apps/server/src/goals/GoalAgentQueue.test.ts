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
import * as Stream from "effect/Stream";
import { openQueueDatabase } from "../../../../packages/agent-queue-core/src/index.ts";
import { createTestGitRepo } from "../../../../packages/agent-queue-core/test/harness/gitHarness.ts";

import * as ServerConfig from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { GoalBeads } from "./GoalBeads.ts";
import * as GoalService from "./GoalService.ts";
import * as GoalStore from "./GoalStore.ts";
import { AgentQueueServiceLive } from "../queue/AgentQueueService.ts";

const PROJECT = ProjectId.make("project-queue-1");
const CODEX = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" };

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

it.effect("Gate G4 (AQ-029 - AQ-038): Native T3 Code Goal scheduling with AgentQueue", () =>
  Effect.gen(function* () {
    const repo = yield* Effect.promise(() => createTestGitRepo("goal-agent-queue-g4-"));

    try {
      // 1. Seed two ready tasks in repo's AgentQueue db
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = "2026-10-10T00:00:00.000Z";
      db.prepare(`
        INSERT INTO tasks (id, title, status, version, verification_command, created_at, updated_at)
        VALUES
          ('TASK-Q1', 'First Queue Task', 'pending', 1, 'node -e "process.exit(0)"', ?, ?),
          ('TASK-Q2', 'Second Queue Task', 'pending', 1, 'node -e "process.exit(0)"', ?, ?)
      `).run(now, now, now, now);
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
              getThreadDetailById: () =>
                Effect.succeed(
                  Option.some({
                    latestTurn: { state: "completed" },
                    messages: [{ role: "assistant", text: "Working on it" }],
                    activities: [],
                  } as unknown as OrchestrationThread),
                ),
            }),
            Layer.fresh(ServerConfig.layerTest(repo.rootDir, { prefix: "t3code-goals-test-" })),
          ),
        ),
      );

      const testRun = Effect.gen(function* () {
        const goals = yield* GoalService.GoalService;

        const waitFor = Effect.fn("waitFor")(function* (
          type: OrchestrationCommand["type"],
          count: number,
        ) {
          while (log.filter((command) => command.type === type).length < count) {
            log.push(yield* Queue.take(commands));
          }
          return log.filter((command) => command.type === type);
        });

        // Create Goal with useAgentQueue: true and concurrency: 4
        const goalSettings: GoalSettings = {
          name: "AgentQueue Pipeline Goal",
          projectId: PROJECT,
          agents: [{ modelSelection: CODEX, count: 4 }],
          concurrency: 4,
          maxChats: 10,
          runtimeMode: "full-access",
          autoResume: true,
          standardRules: true,
          useAgentQueue: true,
          queueMode: "agentqueue",
          overseer: false,
        };

        const resultGoals = yield* goals.create(goalSettings);
        expect(resultGoals.length).toBe(1);

        // Find all thread.create commands dispatched
        const createCommands = (yield* waitFor("thread.create", 2)) as Array<
          Extract<OrchestrationCommand, { type: "thread.create" }>
        >;

        // Exactly 2 threads should be spawned (since only 2 ready tasks exist, despite concurrency 4!)
        expect(createCommands.length).toBe(2);

        // Verify each thread has a distinct worktreePath and branch assigned!
        for (const cmd of createCommands) {
          expect(cmd.worktreePath).not.toBeNull();
          expect(cmd.branch).not.toBeNull();
          expect(cmd.worktreePath).toContain(".worktrees/agentqueue");
          expect(cmd.branch).toContain("agentqueue/TASK-Q");
        }
      }).pipe(Effect.scoped, Effect.provide(layer));

      yield* testRun;
    } finally {
      yield* Effect.promise(() => repo.cleanup());
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
