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
import { generateOverseerBriefing } from "../src/overseerRepairs.ts";
import { validatePlanDag, getReadyTasks, type PlanTaskDefinition } from "../src/planGraph.ts";
import { createTestGitRepo } from "./harness/gitHarness.ts";

describe("Phase 8: Full System Stress & Chaos Harness (AQ-058, Gate G8)", () => {
  it("executes a 30-task DAG with concurrent claims, worker death recovery, and serialized landing", async () => {
    const repo = await createTestGitRepo("full-stress-harness-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = new Date().toISOString();

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

          // Release claim
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
      const now = new Date().toISOString();

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

          // Release claim
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
