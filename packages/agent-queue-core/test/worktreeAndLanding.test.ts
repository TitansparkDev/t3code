// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { openQueueDatabase } from "../src/db.ts";
import {
  provisionWorktree,
  rebaseOntoBase,
  teardownWorktree,
  sanitizeBranchName,
} from "../src/worktreeManager.ts";
import { runVerification } from "../src/verifier.ts";
import { landCandidate, acquireLegacyLandingLock } from "../src/landingQueue.ts";
import { createTestGitRepo, execCommand } from "./harness/gitHarness.ts";

describe("AgentQueue Worktrees, Verification & Landing (AQ-019 - AQ-028)", () => {
  it("sanitizes branch names cleanly", () => {
    expect(sanitizeBranchName("AQ-019", "Safe Worktree Provisioning")).toBe(
      "agentqueue/AQ-019-safe-worktree-provisioning",
    );
    expect(sanitizeBranchName("TASK!@#$")).toBe("agentqueue/TASK----");
  });

  it("provisions, runs verification with receipt, lands cleanly via dual locks, and tears down (AQ-019 to AQ-025, AQ-027)", async () => {
    const repo = await createTestGitRepo("aq-landing-clean-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = new Date().toISOString();

      // Seed task
      db.prepare(`
        INSERT INTO tasks (id, title, status, version, verification_command, created_at, updated_at)
        VALUES ('TASK-A', 'Add Feature A', 'pending', 1, 'node -e "process.exit(0)"', ?, ?)
      `).run(now, now);

      // 1. Provision worktree off main
      const { worktreePath, branch } = await provisionWorktree(
        repo.rootDir,
        "TASK-A",
        "main",
        "Add Feature A",
      );
      expect(branch).toBe("agentqueue/TASK-A-add-feature-a");

      // 2. Worker makes changes and commits
      const featureFile = NodePath.join(worktreePath, "featureA.txt");
      await NodeFSP.writeFile(featureFile, "Feature A content\n");
      await execCommand("git", ["add", "featureA.txt"], worktreePath);
      await execCommand("git", ["commit", "-m", "feat: add feature A"], worktreePath);

      // 3. Run verification runner and generate receipt (AQ-021, AQ-022)
      const receipt = await runVerification("TASK-A", worktreePath, 'node -e "process.exit(0)"');
      expect(receipt.passed).toBe(true);
      expect(receipt.exitCode).toBe(0);
      expect(receipt.commitHash).not.toBe("unknown");

      // 4. Land candidate via serialized landing queue with dual locking (AQ-023, AQ-024, AQ-027)
      const landingRes = await landCandidate(db, repo.rootDir, repo.gitCommonDir, {
        taskId: "TASK-A",
        worktreePath,
        branch,
        baseBranch: "main",
        receipt,
      });

      expect(landingRes.success).toBe(true);
      expect(landingRes.landedCommit).toBe(receipt.commitHash);

      // Verify main branch now points to the landed commit
      const { stdout: mainHead } = await execCommand("git", ["rev-parse", "main"], repo.rootDir);
      expect(mainHead.trim()).toBe(receipt.commitHash);

      // Verify database task status is completed
      const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get("TASK-A") as {
        status: string;
      };
      expect(task.status).toBe("completed");

      // 5. Teardown worktree (AQ-025)
      const teardownRes = await teardownWorktree(repo.rootDir, worktreePath, branch, {
        isSuccess: true,
        deleteBranch: true,
      });
      expect(teardownRes.preserved).toBe(false);

      db.close();
    } finally {
      await repo.cleanup();
    }
  });

  it("rejects a passing verification when the worker made no commit", async () => {
    const repo = await createTestGitRepo("aq-landing-no-change-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO tasks (id, title, status, version, created_at, updated_at)
        VALUES ('TASK-NOOP', 'No-op task', 'pending', 1, ?, ?)
      `).run(now, now);
      const { worktreePath, branch } = await provisionWorktree(
        repo.rootDir,
        "TASK-NOOP",
        "main",
        "No-op task",
      );
      const receipt = await runVerification("TASK-NOOP", worktreePath, 'node -e "process.exit(0)"');
      const result = await landCandidate(db, repo.rootDir, repo.gitCommonDir, {
        taskId: "TASK-NOOP",
        worktreePath,
        branch,
        baseBranch: "main",
        receipt,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("contains no commit beyond main");
      expect(
        (db.prepare("SELECT status FROM tasks WHERE id = 'TASK-NOOP'").get() as { status: string })
          .status,
      ).toBe("pending");
      db.close();
    } finally {
      await repo.cleanup();
    }
  });

  it("commits uncommitted worker edits before returning a task to the queue", async () => {
    const repo = await createTestGitRepo("aq-worktree-salvage-");
    try {
      const { worktreePath, branch } = await provisionWorktree(
        repo.rootDir,
        "TASK-SALVAGE",
        "main",
        "Salvage task",
      );
      await NodeFSP.writeFile(NodePath.join(worktreePath, "partial.txt"), "keep this work\n");

      const result = await teardownWorktree(repo.rootDir, worktreePath, branch, {
        isSuccess: false,
        preserveWorktreeOnFailure: true,
      });
      expect(result.preserved).toBe(true);
      expect(result.salvageBranch).toBeDefined();
      const saved = await execCommand(
        "git",
        ["show", `${result.salvageBranch}:partial.txt`],
        repo.rootDir,
      );
      expect(saved.code, saved.stderr).toBe(0);
      expect(saved.stdout).toBe("keep this work\n");
    } finally {
      await repo.cleanup();
    }
  });

  it("handles merge conflict during landing and signals replanning without corrupting base (AQ-026)", async () => {
    const repo = await createTestGitRepo("aq-landing-conflict-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = new Date().toISOString();

      // Seed task
      db.prepare(`
        INSERT INTO tasks (id, title, status, version, verification_command, created_at, updated_at)
        VALUES ('TASK-B', 'Conflicting Edit', 'pending', 1, 'node -e "process.exit(0)"', ?, ?)
      `).run(now, now);

      // Provision worktree for TASK-B
      const { worktreePath, branch } = await provisionWorktree(
        repo.rootDir,
        "TASK-B",
        "main",
        "Conflicting Edit",
      );

      // In worktree: edit shared.txt
      const sharedFile = NodePath.join(worktreePath, "shared.txt");
      await NodeFSP.writeFile(sharedFile, "Worker edited line 1\n");
      await execCommand("git", ["add", "shared.txt"], worktreePath);
      await execCommand("git", ["commit", "-m", "worker: edit shared.txt"], worktreePath);

      // Meanwhile on main: commit conflicting edit!
      const mainShared = NodePath.join(repo.rootDir, "shared.txt");
      await NodeFSP.writeFile(mainShared, "Main conflicting edit on line 1\n");
      await execCommand("git", ["add", "shared.txt"], repo.rootDir);
      await execCommand("git", ["commit", "-m", "main: conflicting edit"], repo.rootDir);

      // Run verification
      const receipt = await runVerification("TASK-B", worktreePath, 'node -e "process.exit(0)"');

      // Attempt landing
      const landingRes = await landCandidate(db, repo.rootDir, repo.gitCommonDir, {
        taskId: "TASK-B",
        worktreePath,
        branch,
        baseBranch: "main",
        receipt,
      });

      expect(landingRes.success).toBe(false);
      expect(landingRes.requiresReplanning).toBe(true);
      expect(landingRes.conflictFiles).toContain("shared.txt");

      // Verify base branch was NOT corrupted
      const { stdout: mainContent } = await execCommand("cat", ["shared.txt"], repo.rootDir);
      expect(mainContent).toBe("Main conflicting edit on line 1\n");

      // Verify task in DB marked as blocked with reason
      const task = db
        .prepare("SELECT status, failure_reason FROM tasks WHERE id = ?")
        .get("TASK-B") as {
        status: string;
        failure_reason: string;
      };
      expect(task.status).toBe("blocked");
      expect(task.failure_reason).toContain("Merge conflict");

      // Salvage on failure (AQ-025)
      const salvageRes = await teardownWorktree(repo.rootDir, worktreePath, branch, {
        isSuccess: false,
        preserveWorktreeOnFailure: true,
      });
      expect(salvageRes.preserved).toBe(true);
      expect(salvageRes.salvageBranch).toBeDefined();

      db.close();
      await teardownWorktree(repo.rootDir, worktreePath, branch, { isSuccess: true });
    } finally {
      await repo.cleanup();
    }
  });

  it("gate test: multi-worker concurrent git worktree execution & landing (Gate G3, AQ-028)", async () => {
    const repo = await createTestGitRepo("aq-multi-worker-g3-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = new Date().toISOString();

      // Seed 4 independent tasks
      for (let i = 1; i <= 4; i++) {
        db.prepare(`
          INSERT INTO tasks (id, title, status, version, verification_command, created_at, updated_at)
          VALUES (?, ?, 'pending', 1, 'node -e "process.exit(0)"', ?, ?)
        `).run(`PARALLEL-${i}`, `Parallel Task ${i}`, now, now);
      }

      // Concurrently execute 4 workers in separate worktrees
      const workerRun = async (workerId: number) => {
        const taskId = `PARALLEL-${workerId}`;
        const { worktreePath, branch } = await provisionWorktree(
          repo.rootDir,
          taskId,
          "main",
          `Parallel Task ${workerId}`,
        );

        // Make unique file changes
        const filePath = NodePath.join(worktreePath, `worker_${workerId}.txt`);
        await NodeFSP.writeFile(filePath, `Worker ${workerId} done\n`);
        await execCommand("git", ["add", `worker_${workerId}.txt`], worktreePath);
        await execCommand("git", ["commit", "-m", `feat: worker ${workerId}`], worktreePath);

        // Verification
        const receipt = await runVerification(taskId, worktreePath, 'node -e "process.exit(0)"');

        // Land via serialized landing queue
        const landingRes = await landCandidate(db, repo.rootDir, repo.gitCommonDir, {
          taskId,
          worktreePath,
          branch,
          baseBranch: "main",
          receipt,
        });

        expect(landingRes.success).toBe(true);

        // Clean teardown
        await teardownWorktree(repo.rootDir, worktreePath, branch, {
          isSuccess: true,
          deleteBranch: true,
        });
      };

      // Run sequentially or concurrently with landing serialization
      const p1 = workerRun(1);
      const p2 = workerRun(2);
      const p3 = workerRun(3);
      const p4 = workerRun(4);

      await Promise.all([p1, p2, p3, p4]);

      // Verify all 4 tasks completed in db
      const completedCount = db
        .prepare("SELECT count(*) as cnt FROM tasks WHERE status = 'completed'")
        .get() as { cnt: number };
      expect(completedCount.cnt).toBe(4);

      // Verify all 4 files exist in main branch
      for (let i = 1; i <= 4; i++) {
        const { code } = await execCommand(
          "git",
          ["cat-file", "-e", `HEAD:worker_${i}.txt`],
          repo.rootDir,
        );
        expect(code).toBe(0);
      }

      db.close();
    } finally {
      await repo.cleanup();
    }
  }, 40_000);
});
