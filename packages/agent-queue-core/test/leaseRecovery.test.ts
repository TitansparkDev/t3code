// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { openQueueDatabase } from "../src/db.ts";
import {
  reconcileExpiredLeases,
  isProcessAlive,
  preserveWorktreeChanges,
} from "../src/leaseRecovery.ts";
import { createTestGitRepo, createTestWorktree, execCommand } from "./harness/gitHarness.ts";

describe("AgentQueue Lease Expiration & Recovery (AQ-012)", () => {
  it("accurately detects process liveness", () => {
    // Current process is alive
    expect(isProcessAlive(process.pid)).toBe(true);

    // PID 99999999 is dead / non-existent
    expect(isProcessAlive(99999999)).toBe(false);
  });

  it("treats task IDs as data when creating recovery branches", async () => {
    const repo = await createTestGitRepo("aq-recov-branch-args-");
    const marker = NodePath.join(NodePath.dirname(repo.rootDir), "agentqueue-recovery-injected");
    try {
      await NodeFSP.rm(marker, { force: true });
      await NodeFSP.writeFile(NodePath.join(repo.rootDir, "partial.txt"), "keep me\n");

      const result = preserveWorktreeChanges(repo.rootDir, `x; touch ${marker}; #`);

      expect(result.saved).toBe(false);
      expect(await NodeFSP.stat(marker).catch(() => undefined)).toBeUndefined();
    } finally {
      await NodeFSP.rm(marker, { force: true });
      await repo.cleanup();
    }
  });

  it("retains lease if worker process PID is still alive", async () => {
    const repo = await createTestGitRepo("aq-recov-alive-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const past = new Date(Date.now() - 60_000).toISOString();

      db.prepare(`
        INSERT INTO tasks (id, title, status, version, max_retries, retry_count, created_at, updated_at)
        VALUES ('T-ALIVE', 'Alive Task', 'claimed', 1, 3, 0, ?, ?)
      `).run(past, past);

      db.prepare(`
        INSERT INTO task_claims (task_id, owner_token, worker_pid, worktree_path, branch, leased_at, heartbeat_at, expires_at)
        VALUES ('T-ALIVE', 'tok-alive', ?, '/tmp/wt-alive', 'aq/alive', ?, ?, ?)
      `).run(process.pid, past, past, past); // process.pid is this test runner!

      const results = reconcileExpiredLeases(db);
      expect(results).toHaveLength(1);
      expect(results[0].action).toBe("retained_alive");

      const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get("T-ALIVE") as {
        status: string;
      };
      expect(task.status).toBe("claimed");

      db.close();
    } finally {
      await repo.cleanup();
    }
  });

  it("recovers abandoned task when dead PID is detected and preserves uncommitted work", async () => {
    const repo = await createTestGitRepo("aq-recov-dead-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const past = new Date(Date.now() - 60_000).toISOString();

      // Create a real worktree to test uncommitted work preservation
      const { worktreePath, branch } = await createTestWorktree(
        repo,
        "dead-worker",
        "aq/dead-worker",
      );
      await NodeFSP.writeFile(
        NodePath.join(worktreePath, "partial_progress.txt"),
        "Important unsaved work\n",
      );

      db.prepare(`
        INSERT INTO tasks (id, title, status, version, max_retries, retry_count, created_at, updated_at)
        VALUES ('T-DEAD', 'Dead Worker Task', 'claimed', 1, 3, 0, ?, ?)
      `).run(past, past);

      const deadPid = 99999999;
      db.prepare(`
        INSERT INTO task_claims (task_id, owner_token, worker_pid, worktree_path, branch, leased_at, heartbeat_at, expires_at)
        VALUES ('T-DEAD', 'tok-dead', ?, ?, ?, ?, ?, ?)
      `).run(deadPid, worktreePath, branch, past, past, past);

      const results = reconcileExpiredLeases(db);
      expect(results).toHaveLength(1);
      expect(results[0].action).toBe("recovered");
      expect(results[0].recoveryBranch).toBeDefined();

      // Verify task was reset to pending with retry_count incremented
      const task = db
        .prepare("SELECT status, retry_count FROM tasks WHERE id = ?")
        .get("T-DEAD") as {
        status: string;
        retry_count: number;
      };
      expect(task.status).toBe("pending");
      expect(task.retry_count).toBe(1);

      // Verify recovery branch exists in git
      if (results[0].recoveryBranch) {
        const { code } = await execCommand(
          "git",
          ["rev-parse", "--verify", results[0].recoveryBranch],
          worktreePath,
        );
        expect(code).toBe(0);
      }

      db.close();
      await execCommand("git", ["worktree", "remove", "--force", worktreePath], repo.rootDir);
    } finally {
      await repo.cleanup();
    }
  });

  it("quarantines task as failed when retry budget is exhausted", async () => {
    const repo = await createTestGitRepo("aq-recov-quarantine-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const past = new Date(Date.now() - 60_000).toISOString();

      db.prepare(`
        INSERT INTO tasks (id, title, status, version, max_retries, retry_count, created_at, updated_at)
        VALUES ('T-MAX-RETRY', 'Exhausted Task', 'claimed', 1, 2, 2, ?, ?)
      `).run(past, past);

      const deadPid = 99999998;
      db.prepare(`
        INSERT INTO task_claims (task_id, owner_token, worker_pid, worktree_path, branch, leased_at, heartbeat_at, expires_at)
        VALUES ('T-MAX-RETRY', 'tok-dead-2', ?, '/tmp/wt-dead-2', 'aq/dead-2', ?, ?, ?)
      `).run(deadPid, past, past, past);

      const results = reconcileExpiredLeases(db);
      expect(results).toHaveLength(1);
      expect(results[0].action).toBe("quarantined");

      const task = db
        .prepare("SELECT status, failure_reason FROM tasks WHERE id = ?")
        .get("T-MAX-RETRY") as {
        status: string;
        failure_reason: string;
      };
      expect(task.status).toBe("failed");
      expect(task.failure_reason).toContain("max retries (2) exhausted");

      db.close();
    } finally {
      await repo.cleanup();
    }
  });
});
