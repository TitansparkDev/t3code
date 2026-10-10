// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { describe, expect, it } from "vite-plus/test";
import { openQueueDatabase } from "../src/db.ts";
import { getQueueSnapshot, evaluateDeadlock } from "../src/queueInspector.ts";
import { createTestGitRepo } from "./harness/gitHarness.ts";

describe("AgentQueue Diagnostics & Deadlock Evaluator (AQ-014)", () => {
  it("computes accurate queue snapshot counts and active leases", async () => {
    const repo = await createTestGitRepo("aq-inspector-snap-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = new Date().toISOString();
      const future = new Date(Date.now() + 60_000).toISOString();

      db.prepare(`
        INSERT INTO tasks (id, title, status, version, created_at, updated_at)
        VALUES
          ('T-1', 'Pending 1', 'pending', 1, ?, ?),
          ('T-2', 'Pending 2', 'pending', 1, ?, ?),
          ('T-3', 'Claimed 1', 'claimed', 1, ?, ?),
          ('T-4', 'Completed 1', 'completed', 1, ?, ?)
      `).run(now, now, now, now, now, now, now, now);

      db.prepare(`
        INSERT INTO task_claims (task_id, owner_token, worker_pid, worktree_path, branch, leased_at, heartbeat_at, expires_at)
        VALUES ('T-3', 'tok-active-3', 1234, '/tmp/wt-3', 'aq/t-3', ?, ?, ?)
      `).run(now, now, future);

      const snapshot = getQueueSnapshot(db);
      expect(snapshot.counts.pending).toBe(2);
      expect(snapshot.counts.claimed).toBe(1);
      expect(snapshot.counts.completed).toBe(1);
      expect(snapshot.counts.total).toBe(4);
      expect(snapshot.activeLeases).toHaveLength(1);
      expect(snapshot.activeLeases[0].taskId).toBe("T-3");
      expect(snapshot.activeLeases[0]).not.toHaveProperty("ownerToken");

      db.close();
    } finally {
      await repo.cleanup();
    }
  });

  it("scopes snapshots and leases to the selected plan", async () => {
    const repo = await createTestGitRepo("aq-inspector-plan-scope-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = new Date().toISOString();
      const future = new Date(Date.now() + 60_000).toISOString();
      db.prepare(`
        INSERT INTO plans (id, file_path, checksum, title, status, registered_at, updated_at)
        VALUES ('P-1', 'plan.md', 'sum-1', 'Plan 1', 'active', ?, ?),
          ('P-2', 'plan-2.md', 'sum-2', 'Plan 2', 'active', ?, ?)
      `).run(now, now, now, now);
      db.prepare(`
        INSERT INTO tasks (id, plan_id, title, status, version, created_at, updated_at)
        VALUES ('P1-T1', 'P-1', 'Plan 1 task', 'pending', 1, ?, ?),
          ('P2-T1', 'P-2', 'Plan 2 task', 'completed', 1, ?, ?)
      `).run(now, now, now, now);
      db.prepare(`
        INSERT INTO task_claims (task_id, owner_token, worker_pid, worktree_path, branch, leased_at, heartbeat_at, expires_at)
        VALUES ('P1-T1', 'secret-token', 1234, '/tmp/p1', 'aq/p1', ?, ?, ?)
      `).run(now, now, future);

      const snapshot = getQueueSnapshot(db, "P-1");
      expect(snapshot.counts.total).toBe(1);
      expect(snapshot.counts.pending).toBe(1);
      expect(snapshot.counts.completed).toBe(0);
      expect(snapshot.activeLeases.map((lease) => lease.taskId)).toEqual(["P1-T1"]);

      db.close();
    } finally {
      await repo.cleanup();
    }
  });

  it("detects queue deadlock when dependency failure permanently stalls waiting tasks", async () => {
    const repo = await createTestGitRepo("aq-inspector-deadlock-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = new Date().toISOString();

      // T-ROOT failed, T-BLOCKED depends on T-ROOT. No active workers.
      db.prepare(`
        INSERT INTO tasks (id, title, status, version, dependencies, created_at, updated_at)
        VALUES
          ('T-ROOT', 'Root Task', 'failed', 1, '[]', ?, ?),
          ('T-BLOCKED', 'Blocked Task', 'pending', 1, '["T-ROOT"]', ?, ?)
      `).run(now, now, now, now);

      const evaluation = evaluateDeadlock(db);
      expect(evaluation.isDeadlocked).toBe(true);
      expect(evaluation.blockedTaskIds).toContain("T-BLOCKED");
      expect(evaluation.reason).toContain("unsatisfied or failed dependencies");

      db.close();
    } finally {
      await repo.cleanup();
    }
  });

  it("reports no deadlock when pending tasks are runnable or active workers exist", async () => {
    const repo = await createTestGitRepo("aq-inspector-runnable-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO tasks (id, title, status, version, dependencies, created_at, updated_at)
        VALUES ('T-READY', 'Ready Task', 'pending', 1, '[]', ?, ?)
      `).run(now, now);

      const eval1 = evaluateDeadlock(db);
      expect(eval1.isDeadlocked).toBe(false);

      db.close();
    } finally {
      await repo.cleanup();
    }
  });
});
