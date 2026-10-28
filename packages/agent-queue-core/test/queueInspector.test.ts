// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { describe, expect, it } from "vite-plus/test";
import { openQueueDatabase } from "../src/db.ts";
import {
  getQueueProgressFacts,
  getQueueSnapshot,
  evaluateDeadlock,
} from "../src/queueInspector.ts";
import { recordEvent } from "../src/eventStream.ts";
import { createTestGitRepo } from "./harness/gitHarness.ts";

describe("AgentQueue Diagnostics & Deadlock Evaluator (AQ-014)", () => {
  it("computes accurate queue snapshot counts and active leases", async () => {
    const repo = await createTestGitRepo("aq-inspector-snap-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = "2026-01-01T00:00:00.000Z";
      const future = "2099-01-01T00:00:00.000Z";

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
      const now = "2026-01-01T00:00:00.000Z";
      const future = "2099-01-01T00:00:00.000Z";
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
      const now = "2026-01-01T00:00:00.000Z";

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
      const now = "2026-01-01T00:00:00.000Z";

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

  it("reports bounded dependency order, oldest waits, and completed parent versus repair tasks", async () => {
    const repo = await createTestGitRepo("aq-progress-facts-");
    const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
    try {
      db.prepare(`
        INSERT INTO plans (id, file_path, checksum, title, status, registered_at, updated_at)
        VALUES ('P', 'PLAN.md', 'sum', 'Progress plan', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `).run();
      const insertTask = db.prepare(`
        INSERT INTO tasks (id, plan_id, title, status, dependencies, version, created_at, updated_at)
        VALUES (?, 'P', ?, ?, ?, 1, ?, ?)
      `);
      const stamp = (day: string) => `2026-01-${day}T00:00:00.000Z`;
      insertTask.run("PARENT", "Parent", "completed", "[]", stamp("01"), stamp("01"));
      insertTask.run("REPAIR", "Repair", "completed", "[]", stamp("01"), stamp("01"));
      recordEvent(db, "REPAIR", "task_followup_created", {
        kind: "repair",
        parentTaskId: "PARENT",
      });
      insertTask.run("CYCLE-A", "Cycle A", "pending", '["CYCLE-B"]', stamp("01"), stamp("04"));
      insertTask.run("CYCLE-B", "Cycle B", "pending", '["CYCLE-A"]', stamp("01"), stamp("04"));
      for (let index = 0; index < 22; index += 1) {
        const id = `D${String(index).padStart(2, "0")}`;
        const dependencies = index === 0 ? [] : [`D${String(index - 1).padStart(2, "0")}`];
        const updatedAt = index === 1 ? stamp("03") : stamp("04");
        insertTask.run(id, id, "pending", JSON.stringify(dependencies), stamp("01"), updatedAt);
      }
      insertTask.run("Z-BLOCKED", "Blocked", "blocked", "[]", stamp("01"), stamp("01"));
      insertTask.run(
        "INTEGRATION",
        "Waiting integration",
        "verifying",
        "[]",
        stamp("01"),
        stamp("03"),
      );
      db.prepare(
        "UPDATE tasks SET integration_state = 'pending', integration_updated_at = ? WHERE id = ?",
      ).run(stamp("02"), "INTEGRATION");

      const facts = getQueueProgressFacts(db, "P");
      const repeated = getQueueProgressFacts(db, "P");
      expect(facts.completedParentTasks).toBe(1);
      expect(facts.completedRepairTasks).toBe(1);
      expect(facts.remainingDependencyTaskIds).toHaveLength(20);
      expect(new Set(facts.remainingDependencyTaskIds).size).toBe(20);
      expect(facts.omittedDependencyCount).toBe(6);
      expect(facts.remainingDependencyTaskIds).toEqual(repeated.remainingDependencyTaskIds);
      expect(facts.remainingDependencyTaskIds.indexOf("D00")).toBeLessThan(
        facts.remainingDependencyTaskIds.indexOf("D01"),
      );
      expect(facts.oldestWait).toEqual({
        taskId: "Z-BLOCKED",
        since: stamp("01"),
        reason: "blocked",
      });
      db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run("Z-BLOCKED");
      expect(getQueueProgressFacts(db, "P").oldestWait).toEqual({
        taskId: "INTEGRATION",
        since: stamp("02"),
        reason: "integration",
      });
    } finally {
      db.close();
      await repo.cleanup();
    }
  });
});
