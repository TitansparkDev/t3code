// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { openQueueDatabase } from "../src/db.ts";
import { claimTask, renewLease } from "../src/claimService.ts";
import {
  reconcileExpiredLeases,
  isProcessAlive,
  preserveWorktreeChanges,
} from "../src/leaseRecovery.ts";
import { createTestGitRepo, createTestWorktree, execCommand } from "./harness/gitHarness.ts";

describe("AgentQueue Lease Expiration & Recovery (AQ-012)", () => {
  it("a live expired owner retains its files and prevents an overlapping claim", async () => {
    const repo = await createTestGitRepo("aq-retained-scope-");
    const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
    try {
      const now = new Date().toISOString();
      for (const id of ["A", "B"])
        db.prepare(`INSERT INTO tasks
        (id,title,status,version,scope_patterns,created_at,updated_at)
        VALUES (?,?,'pending',1,'["shared/"]',?,?)`).run(id, id, now, now);
      const owner = claimTask(db, {
        taskId: "A",
        workerPid: process.pid,
        worktreePath: repo.rootDir,
        branch: "agent/a",
      });
      expect(owner.success).toBe(true);
      db.prepare("UPDATE task_claims SET expires_at = '2000-01-01T00:00:00Z'").run();
      expect(reconcileExpiredLeases(db)[0]?.action).toBe("retained_alive");
      expect(
        claimTask(db, {
          taskId: "B",
          workerPid: process.pid,
          worktreePath: repo.rootDir + "-b",
          branch: "agent/b",
        }),
      ).toMatchObject({
        success: false,
        reason: "SCOPE_CONFLICT (held by A)",
      });
    } finally {
      db.close();
      await repo.cleanup();
    }
  });

  it("a lease renewed after the expired snapshot is not recovered", async () => {
    const repo = await createTestGitRepo("aq-renew-race-");
    const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
    try {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO tasks (id,title,status,version,created_at,updated_at)
        VALUES ('A','A','pending',1,?,?)`).run(now, now);
      const owner = claimTask(db, {
        taskId: "A",
        workerPid: 99999999,
        worktreePath: repo.rootDir,
        branch: "agent/a",
      });
      if (!owner.success) throw new Error(owner.reason);
      db.prepare("UPDATE task_claims SET expires_at = '2000-01-01T00:00:00Z'").run();
      const results = reconcileExpiredLeases(db, {
        isOwnerAlive: () => {
          renewLease(db, owner.claim.ownerToken, 300);
          return false;
        },
      });
      expect(results).toEqual([]);
      expect(db.prepare("SELECT status FROM tasks WHERE id='A'").get()).toMatchObject({
        status: "claimed",
      });
    } finally {
      db.close();
      await repo.cleanup();
    }
  });
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
      const originalHead = (await execCommand("git", ["rev-parse", "HEAD"], worktreePath)).stdout.trim();

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
      expect((await execCommand("git", ["rev-parse", "HEAD"], worktreePath)).stdout.trim()).toBe(originalHead);
      expect((await execCommand("git", ["status", "--porcelain"], worktreePath)).stdout).toContain("partial_progress.txt");

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
        const savedContent = await execCommand("git", ["show", `${results[0].recoveryBranch}:partial_progress.txt`], worktreePath);
        expect(savedContent.stdout).toBe("Important unsaved work\n");
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
