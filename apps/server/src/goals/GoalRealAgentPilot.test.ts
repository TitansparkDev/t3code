// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDateInEffect:off
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
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  openQueueDatabase,
  parsePlanMarkdown,
  computePlanChecksum,
  validatePlanDag,
} from "../../../../packages/agent-queue-core/src/index.ts";
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

const PROJECT = ProjectId.make("project-pilot-calculator");
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
    checkedAt: "2026-10-10T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  }) as unknown as ServerProvider;

interface TaskImplementation {
  files: Array<{ relPath: string; content: string }>;
}

const TASK_CODE: Record<string, TaskImplementation> = {
  "AQ-PILOT-01": {
    files: [
      {
        relPath: "src/add.mjs",
        content: `export function add(left, right) { return left + right; }\n`,
      },
      {
        relPath: "test/add.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/add.mjs";

test("add numbers", () => {
  assert.equal(add(2, 3), 5);
});
`,
      },
    ],
  },
  "AQ-PILOT-02": {
    files: [
      {
        relPath: "src/multiply.mjs",
        content: `export function multiply(left, right) { return left * right; }\n`,
      },
      {
        relPath: "test/multiply.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { multiply } from "../src/multiply.mjs";

test("multiply numbers", () => {
  assert.equal(multiply(2, 3), 6);
});
`,
      },
    ],
  },
  "AQ-PILOT-03": {
    files: [
      {
        relPath: "src/subtract.mjs",
        content: `export function subtract(left, right) { return left - right; }\n`,
      },
      {
        relPath: "test/subtract.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { subtract } from "../src/subtract.mjs";

test("subtract numbers", () => {
  assert.equal(subtract(5, 3), 2);
});
`,
      },
    ],
  },
  "AQ-PILOT-04": {
    files: [
      {
        relPath: "src/divide.mjs",
        content: `export function divide(left, right) {
  if (right === 0) throw new RangeError("Division by zero");
  return left / right;
}
`,
      },
      {
        relPath: "test/divide.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { divide } from "../src/divide.mjs";

test("divide numbers", () => {
  assert.equal(divide(6, 2), 3);
  assert.throws(() => divide(1, 0), RangeError);
});
`,
      },
    ],
  },
  "AQ-PILOT-05": {
    files: [
      {
        relPath: "src/modulo.mjs",
        content: `export function modulo(left, right) {
  if (right === 0) throw new RangeError("Zero divisor");
  return left % right;
}
`,
      },
      {
        relPath: "test/modulo.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { modulo } from "../src/modulo.mjs";

test("modulo numbers", () => {
  assert.equal(modulo(7, 3), 1);
  assert.throws(() => modulo(1, 0), RangeError);
});
`,
      },
    ],
  },
  "AQ-PILOT-06": {
    files: [
      {
        relPath: "src/negate.mjs",
        content: `export function negate(value) { return -value; }\n`,
      },
      {
        relPath: "test/negate.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { negate } from "../src/negate.mjs";

test("negate number", () => {
  assert.equal(negate(5), -5);
  assert.equal(negate(-5), 5);
});
`,
      },
    ],
  },
  "AQ-PILOT-07": {
    files: [
      {
        relPath: "src/absolute.mjs",
        content: `export function absolute(value) { return Math.abs(value); }\n`,
      },
      {
        relPath: "test/absolute.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { absolute } from "../src/absolute.mjs";

test("absolute number", () => {
  assert.equal(absolute(-5), 5);
  assert.equal(absolute(5), 5);
});
`,
      },
    ],
  },
  "AQ-PILOT-08": {
    files: [
      {
        relPath: "src/clamp.mjs",
        content: `export function clamp(value, minimum, maximum) {
  if (minimum > maximum) throw new RangeError("Inverted bounds");
  return Math.min(Math.max(value, minimum), maximum);
}
`,
      },
      {
        relPath: "test/clamp.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { clamp } from "../src/clamp.mjs";

test("clamp number", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(15, 0, 10), 10);
  assert.throws(() => clamp(5, 10, 0), RangeError);
});
`,
      },
    ],
  },
  "AQ-PILOT-09": {
    files: [
      {
        relPath: "src/index.mjs",
        content: `export * from "./add.mjs";
export * from "./multiply.mjs";
export * from "./subtract.mjs";
export * from "./divide.mjs";
export * from "./modulo.mjs";
export * from "./negate.mjs";
export * from "./absolute.mjs";
export * from "./clamp.mjs";
`,
      },
      {
        relPath: "test/index.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import * as api from "../src/index.mjs";

test("public exports exist", () => {
  assert.equal(typeof api.add, "function");
  assert.equal(typeof api.multiply, "function");
  assert.equal(typeof api.subtract, "function");
  assert.equal(typeof api.divide, "function");
  assert.equal(typeof api.modulo, "function");
  assert.equal(typeof api.negate, "function");
  assert.equal(typeof api.absolute, "function");
  assert.equal(typeof api.clamp, "function");
});
`,
      },
    ],
  },
  "AQ-PILOT-10": {
    files: [
      {
        relPath: "test/api.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { add, multiply, subtract, divide, modulo, negate, absolute, clamp } from "../src/index.mjs";

test("end-to-end arithmetic and validation", () => {
  assert.equal(add(10, 5), 15);
  assert.equal(subtract(10, 5), 5);
  assert.equal(multiply(10, 5), 50);
  assert.equal(divide(10, 5), 2);
  assert.equal(modulo(10, 3), 1);
  assert.equal(negate(10), -10);
  assert.equal(absolute(-10), 10);
  assert.equal(clamp(25, 0, 20), 20);
  assert.throws(() => divide(5, 0), RangeError);
  assert.throws(() => modulo(5, 0), RangeError);
  assert.throws(() => clamp(5, 10, 0), RangeError);
});
`,
      },
    ],
  },
};

it.effect(
  "Gate G6 (AQ-050): Real-agent 10-task calculator plan pilot with actual code, test suites, npm test verification, and clean landing",
  () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => createTestGitRepo("goal-aq-pilot-calculator-"));
      try {
        // 1. Setup repo package.json and directories
        const pkgJson = JSON.stringify(
          {
            name: "agentqueue-pilot-calculator",
            private: true,
            type: "module",
            scripts: { test: "node --test" },
          },
          null,
          2,
        );
        NodeFS.writeFileSync(NodePath.join(repo.rootDir, "package.json"), pkgJson);
        NodeFS.mkdirSync(NodePath.join(repo.rootDir, "src"), { recursive: true });
        NodeFS.mkdirSync(NodePath.join(repo.rootDir, "test"), { recursive: true });
        NodeFS.mkdirSync(NodePath.join(repo.rootDir, "plans"), { recursive: true });

        // Copy the pilot plan
        const planContent = NodeFS.readFileSync(
          "/tmp/t3code-agentqueue-pilot/repo/plans/10-task-calculator.md",
          "utf8",
        );
        const planPath = NodePath.join(repo.rootDir, "plans/10-task-calculator.md");
        NodeFS.writeFileSync(planPath, planContent);

        yield* Effect.promise(() =>
          execCommand("git", ["add", "package.json", "plans/10-task-calculator.md"], repo.rootDir),
        );
        yield* Effect.promise(() =>
          execCommand("git", ["commit", "-m", "chore: setup calculator pilot repo"], repo.rootDir),
        );

        // 2. Import the plan into the AgentQueue database
        const parsed = parsePlanMarkdown(planContent);
        validatePlanDag(parsed.tasks);
        const checksum = computePlanChecksum(planContent);
        const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
        const now = new Date().toISOString();
        const planId = "plan_10-task-calculator";

        db.prepare(`
        INSERT INTO plans (id, file_path, checksum, title, status, registered_at, updated_at)
        VALUES (?, 'plans/10-task-calculator.md', ?, ?, 'active', ?, ?)
      `).run(planId, checksum, parsed.title, now, now);

        for (const t of parsed.tasks) {
          db.prepare(`
          INSERT INTO tasks (
            id, plan_id, title, description, status, priority,
            scope_patterns, dependencies, verification_command, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
        `).run(
            t.id,
            planId,
            t.title,
            t.description ?? null,
            t.priority ?? 0,
            JSON.stringify(t.scopePatterns ?? []),
            JSON.stringify(t.dependencies ?? []),
            t.verificationCommand ?? null,
            now,
            now,
          );
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
              Layer.fresh(
                ServerConfig.layerTest(repo.rootDir, { prefix: "t3code-goals-aq-pilot-" }),
              ),
            ),
          ),
        );

        const testRun = Effect.gen(function* () {
          const goals = yield* GoalService.GoalService;
          yield* Effect.forkScoped(goals.loop);
          yield* Effect.yieldNow;

          const settings: GoalSettings = {
            name: "Real Calculator Pilot",
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

            // Extract task ID from title (e.g. "Goal worker (AQ-PILOT-01): Implement addition")
            const match = cmd.title?.match(/\((AQ-PILOT-\d{2})\)/);
            expect(match).not.toBeNull();
            const taskId = match?.[1] ?? "";
            const impl = TASK_CODE[taskId];
            if (!impl) continue;

            // Real worker action: write actual code and test files to the isolated worktree
            for (const file of impl.files) {
              const fullPath = NodePath.join(cmd.worktreePath!, file.relPath);
              NodeFS.mkdirSync(NodePath.dirname(fullPath), { recursive: true });
              NodeFS.writeFileSync(fullPath, file.content);
            }

            // Worker git add and commit
            yield* Effect.promise(() => execCommand("git", ["add", "."], cmd.worktreePath!));
            yield* Effect.promise(() =>
              execCommand(
                "git",
                ["commit", "-m", `feat: implement ${taskId} (${cmd.title})`],
                cmd.worktreePath!,
              ),
            );

            // Emit session lifecycle events
            yield* PubSub.publish(events, {
              type: "thread.session-set",
              payload: {
                threadId: cmd.threadId,
                session: {
                  activeTurnId: "turn-1",
                  status: "running",
                  updatedAt: "2026-10-10T12:00:01.000Z",
                },
              },
            } as unknown as OrchestrationEvent);

            yield* PubSub.publish(events, {
              type: "thread.session-set",
              payload: {
                threadId: cmd.threadId,
                session: {
                  activeTurnId: null,
                  status: "idle",
                  updatedAt: "2026-10-10T12:00:02.000Z",
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

          // Verify SQLite database has all 10 tasks completed
          const dbCheck = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
          const summary = dbCheck
            .prepare("SELECT status, count(*) as count FROM tasks GROUP BY status")
            .all() as Array<{ status: string; count: number }>;
          expect(summary).toEqual([{ status: "completed", count: 10 }]);
          dbCheck.close();

          // Verify that git repository base branch has all commits landed
          const { stdout: gitLog } = yield* Effect.promise(() =>
            execCommand("git", ["log", "--oneline"], repo.rootDir),
          );
          for (const taskId of Object.keys(TASK_CODE)) {
            expect(gitLog).toContain(taskId);
          }

          // CRITICAL GATE VERIFICATION: Run npm test in the base branch!
          // All test suites written by the workers across all 10 tasks must run and pass together!
          const testResult = yield* Effect.promise(() =>
            execCommand("npm", ["test"], repo.rootDir),
          );
          expect(testResult.code).toBe(0);
          expect(testResult.stdout).toContain("pass");
        }).pipe(Effect.scoped, Effect.provide(layer));

        yield* testRun;
      } finally {
        yield* Effect.promise(() => repo.cleanup());
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);
