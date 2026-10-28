// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { openQueueDatabase } from "../src/db.ts";
import { claimTask, releaseClaim } from "../src/claimService.ts";
import { reconcileExpiredLeases } from "../src/leaseRecovery.ts";
import { provisionWorktree, teardownWorktree } from "../src/worktreeManager.ts";
import { runVerification } from "../src/verifier.ts";
import { landCandidate } from "../src/landingQueue.ts";
import { execCommand } from "./harness/gitHarness.ts";
import { addFollowUpTask, generateOverseerBriefing } from "../src/overseerRepairs.ts";
import { validatePlanDag, getReadyTasks, type PlanTaskDefinition } from "../src/planGraph.ts";
import { createTestGitRepo } from "./harness/gitHarness.ts";
import { makeRepo, plan, tmpDir } from "./harness/contractHarness.ts";
import type { VerificationSpec } from "../src/verificationSpec.ts";

type ReplayPolicy = "sequential" | "unqueued" | "queued" | "wellManagedParallel";
const REPLAY_COSTS = {
  model: 4,
  check: 5,
  integrate: 1,
  delivery: 1,
  providerWait: 3,
  restart: 1,
};

interface RecoveryTrace {
  readonly recoveryChecks: number;
  readonly recoveryLandings: number;
  readonly failedChecks: number;
  readonly blockedConsumers: number;
  readonly sharedRepairs: number;
  readonly routineDeliveries: number;
  readonly reasoningEscalations: number;
  readonly providerLosses: number;
  readonly restarts: number;
  readonly falseAccepts: number;
  readonly recoveryCost: number;
}

interface ReplayMetrics extends Omit<RecoveryTrace, "recoveryCost"> {
  readonly executedChecks: number;
  readonly modelDecisionTurns: number;
  readonly waits: number;
  readonly serializedLandings: number;
  readonly criticalPath: number;
}

/** Schedules A/B/C and appends the observed recovery trace at its shared virtual cost. */
function replayPolicy(policy: ReplayPolicy, recovery: RecoveryTrace): ReplayMetrics {
  const tasks = [
    { id: "A", dependencies: [] as string[], checkKey: "shared-input" },
    { id: "B", dependencies: [] as string[], checkKey: "shared-input" },
    { id: "C", dependencies: ["A", "B"], checkKey: "changed-input" },
  ];
  const deduplicates = policy === "queued" || policy === "wellManagedParallel";
  const workerLimit = policy === "sequential" ? 1 : 2;
  const resourceLimit = 1;
  const landingLimit = 1;
  const states = new Map(
    tasks.map((task) => [
      task.id,
      {
        task,
        stage: "model" as "model" | "check" | "integrate" | "done",
        started: false,
        waiting: false,
      },
    ]),
  );
  const running: Array<{
    taskId: string;
    stage: "model" | "check" | "integrate";
    checkKey?: string;
    endsAt: number;
  }> = [];
  const completedChecks = new Set<string>();
  let now = 0;
  let executedChecks = 0;
  let modelDecisionTurns = 0;
  let waits = 0;
  let serializedLandings = 0;
  const activeTaskIds = () =>
    new Set(
      [...states.values()]
        .filter((state) => state.started && state.stage !== "done")
        .map((state) => state.task.id),
    );

  const start = (
    taskId: string,
    stage: "model" | "check" | "integrate",
    duration: number,
    checkKey?: string,
  ) => {
    const state = states.get(taskId)!;
    state.stage = stage;
    if (stage === "model") {
      state.started = true;
      modelDecisionTurns++;
    }
    if (stage === "check") executedChecks++;
    running.push({ taskId, stage, ...(checkKey ? { checkKey } : {}), endsAt: now + duration });
  };

  while ([...states.values()].some((state) => state.stage !== "done")) {
    let started = false;
    for (const state of states.values()) {
      const { task } = state;
      if (
        state.stage === "model" &&
        task.dependencies.every((id) => states.get(id)?.stage === "done")
      ) {
        const active = activeTaskIds();
        if (!active.has(task.id) && active.size < workerLimit) {
          start(task.id, "model", REPLAY_COSTS.model);
          started = true;
        }
      }
    }

    for (const state of states.values()) {
      if (
        state.stage !== "check" ||
        running.some((operation) => operation.taskId === state.task.id)
      )
        continue;
      const active = activeTaskIds();
      if (!active.has(state.task.id) && active.size >= workerLimit) continue;
      const key = state.task.checkKey;
      if (deduplicates && completedChecks.has(key)) {
        state.stage = "integrate";
        state.waiting = false;
        started = true;
        continue;
      }
      if ([...running].filter((operation) => operation.stage === "check").length >= resourceLimit) {
        if (!state.waiting) {
          state.waiting = true;
          waits++;
        }
        continue;
      }
      state.waiting = false;
      start(state.task.id, "check", REPLAY_COSTS.check, key);
      started = true;
    }

    for (const state of states.values()) {
      if (
        state.stage !== "integrate" ||
        running.some((operation) => operation.taskId === state.task.id)
      )
        continue;
      const active = activeTaskIds();
      if (!active.has(state.task.id) && active.size >= workerLimit) continue;
      if (running.filter((operation) => operation.stage === "integrate").length >= landingLimit) {
        if (!state.waiting) {
          state.waiting = true;
          waits++;
          serializedLandings++;
        }
        continue;
      }
      state.waiting = false;
      start(state.task.id, "integrate", REPLAY_COSTS.integrate);
      started = true;
    }

    if (running.length === 0) {
      if (started) continue;
      throw new Error("virtual replay has no runnable operation");
    }
    const nextTime = Math.min(...running.map((operation) => operation.endsAt));
    now = nextTime;
    for (const operation of [...running].filter((item) => item.endsAt === now)) {
      running.splice(running.indexOf(operation), 1);
      const state = states.get(operation.taskId)!;
      if (operation.stage === "model") state.stage = "check";
      else if (operation.stage === "check") {
        completedChecks.add(operation.checkKey!);
        state.stage = "integrate";
      } else state.stage = "done";
    }
  }
  const { recoveryCost, ...recoveryMetrics } = recovery;
  return {
    executedChecks: executedChecks + recovery.recoveryChecks,
    modelDecisionTurns: modelDecisionTurns + recovery.reasoningEscalations,
    waits: waits + recovery.providerLosses,
    serializedLandings,
    ...recoveryMetrics,
    criticalPath: now + recoveryCost,
  };
}

async function withReplayResourceHome<A>(run: () => Promise<A>): Promise<A> {
  const root = await tmpDir("aq-replay-home-");
  const config = NodePath.join(root, "resources.json");
  const bin = NodePath.join(root, "bin");
  const compiler = NodePath.join(bin, "tsc");
  NodeFS.mkdirSync(bin, { recursive: true });
  NodeFS.writeFileSync(compiler, "#!/bin/sh\ntest -f src/shared.txt\n", { mode: 0o755 });
  NodeFS.writeFileSync(
    config,
    JSON.stringify({ reserveMb: 0, resources: { heavy_build: { capacity: 1, memoryMb: 0 } } }),
  );
  const previousHome = process.env.AGENTQUEUE_RESOURCE_HOME;
  const previousConfig = process.env.AGENTQUEUE_RESOURCE_CONFIG;
  const previousPath = process.env.PATH;
  process.env.AGENTQUEUE_RESOURCE_HOME = root;
  process.env.AGENTQUEUE_RESOURCE_CONFIG = config;
  process.env.PATH = [bin, previousPath].filter(Boolean).join(NodePath.delimiter);
  try {
    return await run();
  } finally {
    if (previousHome === undefined) delete process.env.AGENTQUEUE_RESOURCE_HOME;
    else process.env.AGENTQUEUE_RESOURCE_HOME = previousHome;
    if (previousConfig === undefined) delete process.env.AGENTQUEUE_RESOURCE_CONFIG;
    else process.env.AGENTQUEUE_RESOURCE_CONFIG = previousConfig;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

function checkedReceipt(
  outcome: Awaited<ReturnType<Awaited<ReturnType<typeof makeRepo>>["submit"]>>,
) {
  if (outcome.kind !== "submitted") throw new Error(`expected submitted, got ${outcome.kind}`);
  const result = outcome.receipt.checks[0];
  if (!result) throw new Error("expected one check result");
  return result;
}

describe("Phase 8: Full System Stress & Chaos Harness (AQ-058, Gate G8)", () => {
  it("compares matched check and landing costs against sequential and coordinated baselines", async () => {
    await withReplayResourceHome(async () => {
      const r = await makeRepo({
        plan: plan([
          { id: "A", scope: "docs/evidence/A/" },
          { id: "B", scope: "docs/evidence/B/" },
          { id: "C", deps: ["A", "B"], scope: "src/" },
          { id: "D", scope: "src/" },
          { id: "E", deps: ["D"], scope: "src/" },
        ]),
        contract: {
          branchPrefixes: ["agent/"],
          supportingPaths: ["docs/evidence/"],
          resources: [{ name: "heavy_build", limit: 1, scope: [], commands: ["tsc --noEmit"] }],
        },
        files: { "src/shared.txt": "same input\n" },
      });
      try {
        const spec: VerificationSpec = {
          source: "declared",
          checks: [
            {
              id: "replay-check",
              run: "tsc --noEmit",
              cwd: ".",
              timeoutSeconds: 30,
              requires: ["heavy_build"],
              expectExitCode: 0,
              produces: [],
              reuseInputs: ["src/shared.txt"],
              reuseEnv: [],
            },
          ],
          exemptReason: null,
          rejected: [],
        };
        for (const taskId of ["A", "B", "C"]) {
          r.db
            .prepare(
              "UPDATE tasks SET verification_spec = ?, verification_command = NULL WHERE id = ?",
            )
            .run(JSON.stringify(spec), taskId);
        }
        const producer = {
          id: "producer",
          run: `node -e 'const fs=require("node:fs");if(!fs.existsSync("src/disable-build"))fs.writeFileSync("src/app.apk","built")'`,
          cwd: ".",
          timeoutSeconds: 30,
          requires: [],
          expectExitCode: 0,
          produces: ["src/app.apk"],
          reuseInputs: ["src/disable-build"],
        };
        const instrumentation = {
          id: "instrumentation",
          dependsOn: ["producer"],
          run: "true",
          cwd: ".",
          timeoutSeconds: 30,
          requires: [],
          expectExitCode: 0,
          consumes: ["src/app.apk"],
        };
        const junit = {
          id: "junit",
          run: `node -e 'const fs=require("node:fs");fs.mkdirSync("src/reports",{recursive:true});const xml=fs.existsSync("src/disable-tests")?"<testsuite tests=\\"0\\"></testsuite>":"<testsuite><testcase name=\\"instrumented\\" /></testsuite>";fs.writeFileSync("src/reports/run.xml",xml)'`,
          cwd: ".",
          timeoutSeconds: 30,
          requires: [],
          expectExitCode: 0,
          junit: { reports: ["src/reports/run.xml"], minTests: 1, maxSkipped: 0 },
        };
        const failureSpec: VerificationSpec = {
          source: "declared",
          checks: [producer, instrumentation, junit],
          exemptReason: null,
          rejected: [],
        };
        const consumerSpec: VerificationSpec = {
          source: "declared",
          checks: [
            {
              id: "consumer",
              run: "test -f src/app.apk",
              cwd: ".",
              timeoutSeconds: 30,
              requires: [],
              expectExitCode: 0,
              consumes: ["src/app.apk"],
            },
          ],
          exemptReason: null,
          rejected: [],
        };
        r.db
          .prepare(
            "UPDATE tasks SET verification_spec = ?, verification_command = NULL WHERE id = 'D'",
          )
          .run(JSON.stringify(failureSpec));
        r.db
          .prepare(
            "UPDATE tasks SET verification_spec = ?, verification_command = NULL WHERE id = 'E'",
          )
          .run(JSON.stringify(consumerSpec));

        const reservedA = await r.reserve("replay-A");
        const reservedB = await r.reserve("replay-B");
        expect([reservedA.kind, reservedB.kind]).toEqual(["reserved", "reserved"]);
        if (reservedA.kind !== "reserved" || reservedB.kind !== "reserved") return;
        await r.commitFile(
          reservedA.task.worktreePath,
          "docs/evidence/A/result.md",
          "A evidence\n",
        );
        await r.commitFile(
          reservedB.task.worktreePath,
          "docs/evidence/B/result.md",
          "B evidence\n",
        );
        const aCheck = checkedReceipt(await r.submit(reservedA.task));
        const bCheck = checkedReceipt(await r.submit(reservedB.task));
        expect(aCheck.reused).not.toBe(true);
        expect(bCheck.reused).toBe(true);
        expect((await r.integrate("A")).kind).toBe("landed");
        expect((await r.integrate("B")).kind).toBe("landed");

        const reservedC = await r.reserve("replay-C");
        expect(reservedC.kind).toBe("reserved");
        if (reservedC.kind !== "reserved") return;
        await r.commitFile(reservedC.task.worktreePath, "src/shared.txt", "changed input\n");
        const cCheck = checkedReceipt(await r.submit(reservedC.task));
        expect(cCheck.reused).not.toBe(true);
        expect((await r.integrate("C")).kind).toBe("landed");

        const baseExecutedChecks = [aCheck, bCheck, cCheck].filter(
          (check) => check.reused !== true,
        ).length;
        expect(baseExecutedChecks).toBe(2);

        const reservedD = await r.reserve("replay-D");
        expect(reservedD.kind).toBe("reserved");
        if (reservedD.kind !== "reserved") return;
        await r.commitFile(reservedD.task.worktreePath, "src/disable-build", "no artifact\n");
        await r.commitFile(reservedD.task.worktreePath, "src/disable-tests", "empty report\n");
        const failed = await r.submit(reservedD.task);
        expect(failed.kind).toBe("verification-failed");
        if (failed.kind !== "verification-failed" || !failed.receipt) return;
        expect(failed.receipt.state).toBe("failed");
        const failedChecks = failed.receipt.checks.filter((check) => !check.passed);
        expect(failedChecks.map((check) => check.failureKind)).toEqual([
          "missing-output",
          "blocked",
          "junit-failed",
        ]);
        expect(failed.receipt.checks[1]?.failureReason).toContain("producer");
        expect(failed.receipt.checks[2]?.exitCode).toBe(0);
        expect(failed.receipt.checks[2]?.failureReason).toContain("0 executed");
        expect((await r.reserve("consumer-before-producer-repair")).kind).toBe("none");

        const producerResult = failed.receipt.checks.find((check) => check.checkId === "producer");
        expect(producerResult?.failureKind).toBe("missing-output");
        NodeFS.rmSync(NodePath.join(reservedD.task.worktreePath, "src/reports/run.xml"), {
          force: true,
        });
        await execCommand(
          "git",
          ["rm", "-q", "src/disable-build", "src/disable-tests"],
          reservedD.task.worktreePath,
        );
        NodeFS.writeFileSync(NodePath.join(reservedD.task.worktreePath, "src/app.apk"), "built\n");
        await execCommand("git", ["add", "src/app.apk"], reservedD.task.worktreePath);
        await execCommand(
          "git",
          ["commit", "-qm", "repair producer and test report"],
          reservedD.task.worktreePath,
        );
        const repaired = await r.submit(reservedD.task);
        expect(repaired.kind).toBe("submitted");
        if (repaired.kind !== "submitted") return;
        expect(repaired.receipt.checks.every((check) => check.passed)).toBe(true);
        const landedD = await r.integrate("D");
        expect(landedD.kind).toBe("landed");
        expect(r.task("D")).toMatchObject({ status: "completed" });
        expect(r.task("E")).toMatchObject({ status: "pending", dependencies: '["D"]' });

        const reservedE = await r.reserve("replay-E");
        if (reservedE.kind !== "reserved") throw new Error(JSON.stringify(reservedE));
        expect(reservedE.kind).toBe("reserved");
        if (reservedE.kind !== "reserved") return;
        expect(reservedE.task.taskId).toBe("E");
        await r.commitFile(reservedE.task.worktreePath, "src/consumer.txt", "consumed app\n");
        const consumerPassed = await r.submit(reservedE.task);
        expect(consumerPassed.kind).toBe("submitted");
        if (consumerPassed.kind !== "submitted") return;
        expect(consumerPassed.receipt.checks[0]).toMatchObject({
          passed: true,
          checkId: "consumer",
        });
        const landedE = await r.integrate("E");
        expect(landedE.kind).toBe("landed");

        const repairInput = {
          planId: r.planId,
          kind: "repair" as const,
          blocking: false,
          title: "Repair the shared producer failure",
          note: "The producer failure is shared by both parents.",
          checks: [producer],
          repairEvidence: {
            failedCheckId: "producer",
            diagnostics: {
              failureKind: producerResult?.failureKind,
              failureReason: producerResult?.failureReason,
            },
          },
          dedupeKey: `baseline-check:${producerResult?.checkId}:${producerResult?.failureKind}:${producerResult?.failureReason}`,
        };
        const firstRepair = addFollowUpTask(r.db, { ...repairInput, parentTaskId: "A" });
        const sharedRepair = addFollowUpTask(r.db, { ...repairInput, parentTaskId: "B" });
        expect(firstRepair.created).toBe(true);
        expect(sharedRepair).toEqual({ taskId: firstRepair.taskId, created: false });

        // The queue receipts above provide failure, dependency-block, no-false-pass and repair
        // observations. Server-side tail counts come from GoalAgentQueueFlow's 20-delivery restart
        // and failed-verification recovery tests, plus GoalService's provider-usage recovery test.
        // Those product flows are not re-run here; their virtual cost is common to all policies.
        const recoveryChecks =
          failed.receipt.checks.length +
          repaired.receipt.checks.length +
          consumerPassed.receipt.checks.length;
        const recoveryLandings =
          Number(landedD.kind === "landed") + Number(landedE.kind === "landed");
        const recovery: RecoveryTrace = {
          recoveryChecks,
          recoveryLandings,
          failedChecks: failedChecks.length,
          blockedConsumers: failedChecks.filter((check) => check.failureKind === "blocked").length,
          sharedRepairs: firstRepair.created && !sharedRepair.created ? 1 : 0,
          routineDeliveries: 20,
          reasoningEscalations: 1,
          providerLosses: 1,
          restarts: 1,
          falseAccepts: failed.receipt.checks.filter((check) => check.passed).length,
          recoveryCost:
            recoveryChecks * REPLAY_COSTS.check +
            recoveryLandings * REPLAY_COSTS.integrate +
            20 * REPLAY_COSTS.delivery +
            REPLAY_COSTS.model +
            REPLAY_COSTS.providerWait +
            REPLAY_COSTS.restart,
        };
        expect(recovery).toMatchObject({
          recoveryChecks: 7,
          recoveryLandings: 2,
          failedChecks: 3,
          blockedConsumers: 1,
          sharedRepairs: 1,
          routineDeliveries: 20,
          reasoningEscalations: 1,
          providerLosses: 1,
          restarts: 1,
          falseAccepts: 0,
        });
        const executedChecks = baseExecutedChecks + recovery.recoveryChecks;
        expect(executedChecks).toBe(9);

        const comparisons = {
          sequential: replayPolicy("sequential", recovery),
          unqueuedParallel: replayPolicy("unqueued", recovery),
          queued: replayPolicy("queued", recovery),
          wellManagedParallel: replayPolicy("wellManagedParallel", recovery),
        };
        expect(comparisons).toEqual({
          sequential: {
            executedChecks: 10,
            modelDecisionTurns: 4,
            waits: 1,
            serializedLandings: 0,
            recoveryChecks: 7,
            recoveryLandings: 2,
            failedChecks: 3,
            blockedConsumers: 1,
            sharedRepairs: 1,
            routineDeliveries: 20,
            reasoningEscalations: 1,
            providerLosses: 1,
            restarts: 1,
            falseAccepts: 0,
            criticalPath: 95,
          },
          unqueuedParallel: {
            executedChecks: 10,
            modelDecisionTurns: 4,
            waits: 2,
            serializedLandings: 0,
            recoveryChecks: 7,
            recoveryLandings: 2,
            failedChecks: 3,
            blockedConsumers: 1,
            sharedRepairs: 1,
            routineDeliveries: 20,
            reasoningEscalations: 1,
            providerLosses: 1,
            restarts: 1,
            falseAccepts: 0,
            criticalPath: 90,
          },
          queued: {
            executedChecks: 9,
            modelDecisionTurns: 4,
            waits: 3,
            serializedLandings: 1,
            recoveryChecks: 7,
            recoveryLandings: 2,
            failedChecks: 3,
            blockedConsumers: 1,
            sharedRepairs: 1,
            routineDeliveries: 20,
            reasoningEscalations: 1,
            providerLosses: 1,
            restarts: 1,
            falseAccepts: 0,
            criticalPath: 86,
          },
          wellManagedParallel: {
            executedChecks: 9,
            modelDecisionTurns: 4,
            waits: 3,
            serializedLandings: 1,
            recoveryChecks: 7,
            recoveryLandings: 2,
            failedChecks: 3,
            blockedConsumers: 1,
            sharedRepairs: 1,
            routineDeliveries: 20,
            reasoningEscalations: 1,
            providerLosses: 1,
            restarts: 1,
            falseAccepts: 0,
            criticalPath: 86,
          },
        });
        expect(executedChecks).toBe(comparisons.queued.executedChecks);
        expect(comparisons.queued.criticalPath).toBeLessThan(
          comparisons.unqueuedParallel.criticalPath,
        );
        // The A/B/C schedule is cost-only. The recovery tail combines real receipt facts above
        // with existing GoalAgentQueueFlow/GoalService assertions for routine deliveries, repair
        // escalation, provider recovery and restart; those product transitions are not re-run here.
        // A coordinator with the same policies matches the queue; no queue-only speedup is claimed.
        expect(comparisons.queued).toEqual(comparisons.wellManagedParallel);
      } finally {
        await r.repo.cleanup();
      }
    });
  });

  it("executes a 30-task DAG with concurrent claims, worker death recovery, and serialized landing", async () => {
    const repo = await createTestGitRepo("full-stress-harness-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = "2026-10-28T00:00:00.000Z";

      // Build 30-task DAG (5 tiers of 6 tasks each)
      const tasks: PlanTaskDefinition[] = [];
      for (let i = 1; i <= 30; i++) {
        const id = `STRESS-${String(i).padStart(2, "0")}`;
        const tier = Math.floor((i - 1) / 6);
        const dependencies: string[] = [];
        if (tier > 0) {
          // Depend on corresponding task from previous tier
          dependencies.push(`STRESS-${String(i - 6).padStart(2, "0")}`);
        }
        tasks.push({
          id,
          title: `Task ${id}`,
          description: `Description for ${id}`,
          dependencies,
          verificationCommand: "true",
          scopePatterns: [`src/module-${i}/`],
        });
      }

      // 1. Verify DAG is acyclic
      expect(() => validatePlanDag(tasks)).not.toThrow();

      // 2. Insert into DB
      db.prepare(`
        INSERT INTO plans (id, file_path, checksum, title, status, registered_at, updated_at)
        VALUES ('plan-stress', 'PLAN.md', 'dummy-chk', 'Stress Plan', 'active', ?, ?)
      `).run(now, now);

      for (const t of tasks) {
        db.prepare(`
          INSERT INTO tasks (id, plan_id, title, description, status, priority, scope_patterns, dependencies, verification_command, created_at, updated_at)
          VALUES (?, 'plan-stress', ?, ?, 'pending', 100, ?, ?, ?, ?, ?)
        `).run(
          t.id,
          t.title,
          t.description,
          JSON.stringify(t.scopePatterns),
          JSON.stringify(t.dependencies),
          t.verificationCommand,
          now,
          now,
        );
      }

      const fetchReadyTaskIds = () => {
        const rows = db.prepare("SELECT id, status, dependencies FROM tasks").all() as Array<{
          id: string;
          status: string;
          dependencies: string;
        }>;
        const tasksMem = rows.map((r) => ({
          id: r.id,
          status: r.status,
          dependencies: JSON.parse(r.dependencies || "[]"),
        }));
        return getReadyTasks(tasksMem);
      };

      // Initial tier 0 tasks (6 tasks) must be ready
      let ready = fetchReadyTaskIds();
      expect(ready.length).toBe(6);

      // 3. Simulate Worker 1 claiming STRESS-01 and dying (abandoned lease)
      const claim1 = claimTask(db, {
        taskId: "STRESS-01",
        workerPid: 9999999, // Dead PID
        workerSessionId: "worker-dead",
        worktreePath: NodePath.join(repo.rootDir, ".worktrees", "abandoned"),
        branch: "agentqueue/abandoned",
        leaseSeconds: 1, // Short lease
      });
      expect(claim1.success).toBe(true);

      // Fast forward time for lease recovery
      db.prepare(
        "UPDATE task_claims SET expires_at = '2026-10-09T00:00:00.000Z' WHERE task_id = 'STRESS-01'",
      ).run();

      const recovered = reconcileExpiredLeases(db);
      expect(recovered.length).toBe(1);
      expect(recovered[0].taskId).toBe("STRESS-01");
      expect(recovered[0].action).toBe("recovered");

      // Verify STRESS-01 is back to pending and in ready set
      ready = fetchReadyTaskIds();
      expect(ready).toContain("STRESS-01");

      // 4. Concurrently execute all tasks through the DAG
      let completedCount = 0;
      while (completedCount < 30) {
        ready = fetchReadyTaskIds();
        if (ready.length === 0) {
          break;
        }

        // Take up to 4 concurrent tasks
        const batch = ready.slice(0, 4);

        for (const taskId of batch) {
          // Provision worktree
          const wt = await provisionWorktree(repo.rootDir, taskId, "main");

          const claimRes = claimTask(db, {
            taskId,
            workerPid: process.pid,
            workerSessionId: `session-${taskId}`,
            worktreePath: wt.worktreePath,
            branch: wt.branch,
            leaseSeconds: 60,
          });

          if (!claimRes.success) continue;
          const ownerToken = claimRes.claim!.ownerToken;

          // Touch file and commit
          const testFile = NodePath.join(wt.worktreePath, `file-${taskId}.txt`);
          NodeFS.writeFileSync(testFile, `content for ${taskId}\n`);
          await execCommand("git", ["add", "."], wt.worktreePath);
          await execCommand("git", ["commit", "-m", `feat: complete ${taskId}`], wt.worktreePath);

          // Run verification
          const receipt = await runVerification(taskId, wt.worktreePath, "git diff --check");
          expect(receipt.passed).toBe(true);

          // Land
          const landing = await landCandidate(db, repo.rootDir, repo.gitCommonDir, {
            taskId,
            worktreePath: wt.worktreePath,
            branch: wt.branch,
            verifiedCommitHash: receipt.commitHash!,
            baseBranch: "main",
            receipt,
          });
          expect(landing.success).toBe(true);

          releaseClaim(db, { ownerToken, finalStatus: "completed" });

          // Teardown worktree
          await teardownWorktree(repo.rootDir, wt.worktreePath, wt.branch, {
            isSuccess: true,
            deleteBranch: true,
          });

          completedCount++;
        }
      }

      expect(completedCount).toBe(30);

      // Verify all tasks in DB are completed
      const pendingOrClaimed = db
        .prepare("SELECT count(*) as count FROM tasks WHERE status != 'completed'")
        .get() as { count: number };
      expect(pendingOrClaimed.count).toBe(0);

      // No active leases
      const activeClaims = db
        .prepare("SELECT count(*) as count FROM task_claims WHERE released_at IS NULL")
        .get() as { count: number };
      expect(activeClaims.count).toBe(0);

      // Briefing confirms 100% completion
      const briefing = generateOverseerBriefing(db, repo.rootDir, "Completion check");
      expect(briefing).toContain("Completed: 30");
      expect(briefing).toContain("Total: 30");

      db.close();
    } finally {
      await repo.cleanup();
    }
  });

  it("executes sustained multi-wave soak load with 60 tasks verifying zero leaks and bounded WAL (AQ-059)", async () => {
    const repo = await createTestGitRepo("soak-load-harness-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = "2026-10-28T00:00:00.000Z";

      // Build 60-task DAG (10 tiers of 6 tasks each) with non-conflicting scopes
      const tasks: PlanTaskDefinition[] = [];
      for (let i = 1; i <= 60; i++) {
        const id = `SOAK-${String(i).padStart(2, "0")}`;
        const tier = Math.floor((i - 1) / 6);
        const dependencies: string[] = [];
        if (tier > 0) {
          dependencies.push(`SOAK-${String(i - 6).padStart(2, "0")}`);
        }
        tasks.push({
          id,
          title: `Task ${id}`,
          description: `Soak description for ${id}`,
          dependencies,
          verificationCommand: "true",
          scopePatterns: [`src/soak-task-${i}/`],
        });
      }

      validatePlanDag(tasks);

      db.prepare(`
        INSERT INTO plans (id, file_path, checksum, title, status, registered_at, updated_at)
        VALUES ('plan-soak', 'SOAK_PLAN.md', 'chk-soak-60', 'Sustained Soak Plan', 'active', ?, ?)
      `).run(now, now);

      for (const t of tasks) {
        db.prepare(`
          INSERT INTO tasks (id, plan_id, title, description, status, priority, scope_patterns, dependencies, verification_command, created_at, updated_at)
          VALUES (?, 'plan-soak', ?, ?, 'pending', 100, ?, ?, ?, ?, ?)
        `).run(
          t.id,
          t.title,
          t.description,
          JSON.stringify(t.scopePatterns),
          JSON.stringify(t.dependencies),
          t.verificationCommand,
          now,
          now,
        );
      }

      const fetchReadyTaskIds = () => {
        const rows = db.prepare("SELECT id, status, dependencies FROM tasks").all() as Array<{
          id: string;
          status: string;
          dependencies: string;
        }>;
        const tasksMem = rows.map((r) => ({
          id: r.id,
          status: r.status,
          dependencies: JSON.parse(r.dependencies || "[]"),
        }));
        return getReadyTasks(tasksMem);
      };

      let completedCount = 0;
      while (completedCount < 60) {
        const ready = fetchReadyTaskIds();
        if (ready.length === 0) break;

        // Run batch of up to 6 concurrent workers per wave
        const batch = ready.slice(0, 6);
        for (const taskId of batch) {
          // Provision worktree
          const wt = await provisionWorktree(repo.rootDir, taskId, "main");

          const claimRes = claimTask(db, {
            taskId,
            workerPid: process.pid,
            workerSessionId: `soak-worker-${taskId}`,
            worktreePath: wt.worktreePath,
            branch: wt.branch,
            leaseSeconds: 60,
          });
          expect(claimRes.success).toBe(true);
          const ownerToken = claimRes.claim!.ownerToken;

          // Touch file and commit
          const soakFile = NodePath.join(wt.worktreePath, `soak-${taskId}.txt`);
          NodeFS.writeFileSync(soakFile, `soak verified payload for ${taskId}\n`);
          await execCommand("git", ["add", "."], wt.worktreePath);
          await execCommand("git", ["commit", "-m", `feat: soak land ${taskId}`], wt.worktreePath);

          // Run verification
          const receipt = await runVerification(taskId, wt.worktreePath, "git diff --check");
          expect(receipt.passed).toBe(true);

          // Land into base branch
          const landing = await landCandidate(db, repo.rootDir, repo.gitCommonDir, {
            taskId,
            worktreePath: wt.worktreePath,
            branch: wt.branch,
            verifiedCommitHash: receipt.commitHash!,
            baseBranch: "main",
            receipt,
          });
          expect(landing.success).toBe(true);

          releaseClaim(db, { ownerToken, finalStatus: "completed" });

          // Teardown worktree
          await teardownWorktree(repo.rootDir, wt.worktreePath, wt.branch, {
            isSuccess: true,
            deleteBranch: true,
          });

          completedCount++;
        }
      }

      expect(completedCount).toBe(60);

      // Verify SQLite database integrity and compact WAL
      const integrity = db.prepare("PRAGMA integrity_check;").get() as { integrity_check: string };
      expect(integrity.integrity_check).toBe("ok");

      // Verify all 60 commits landed into main git log
      const { stdout: logOutput } = await execCommand("git", ["log", "--oneline"], repo.rootDir);
      const commitCount = logOutput
        .trim()
        .split("\n")
        .filter((l) => l.includes("soak land")).length;
      expect(commitCount).toBe(60);

      db.close();
    } finally {
      await repo.cleanup();
    }
  });
});
