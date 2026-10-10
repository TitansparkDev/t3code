// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { describe, expect, it } from "vite-plus/test";
import { openQueueDatabase } from "../src/db.ts";
import {
  retryTask,
  addPrerequisite,
  removeDependency,
  unblockTask,
  generateOverseerBriefing,
  RetryBudgetExceededError,
} from "../src/overseerRepairs.ts";
import { DependencyCycleError } from "../src/planGraph.ts";
import { createTestGitRepo } from "./harness/gitHarness.ts";

describe("Phase 5: Structured Overseer & Autonomous Recovery (AQ-039 - AQ-041, Gate G5)", () => {
  it("enforces failure budgets and quarantines poison tasks without stopping other branches (AQ-041)", async () => {
    const repo = await createTestGitRepo("overseer-recovery-budget-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO tasks (id, title, status, retry_count, dependencies, created_at, updated_at)
        VALUES
          ('POISON-1', 'Failing Task', 'failed', 0, '[]', ?, ?),
          ('INDEPENDENT-2', 'Independent Task', 'pending', 0, '[]', ?, ?)
      `).run(now, now, now, now);

      // Attempt 1, 2, 3 should succeed
      expect(retryTask(db, "POISON-1", 3).success).toBe(true);
      expect(retryTask(db, "POISON-1", 3).success).toBe(true);
      expect(retryTask(db, "POISON-1", 3).success).toBe(true);

      // Attempt 4 must exceed failure budget and throw RetryBudgetExceededError
      expect(() => retryTask(db, "POISON-1", 3)).toThrow(RetryBudgetExceededError);

      // Verify INDEPENDENT-2 is still pending and runnable
      const task2 = db.prepare("SELECT status FROM tasks WHERE id = 'INDEPENDENT-2'").get() as {
        status: string;
      };
      expect(task2.status).toBe("pending");

      db.close();
    } finally {
      await repo.cleanup();
    }
  });

  it("adds and removes prerequisites with cycle detection (AQ-040)", async () => {
    const repo = await createTestGitRepo("overseer-cycle-test-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO tasks (id, title, status, dependencies, created_at, updated_at)
        VALUES
          ('TASK-A', 'Task A', 'pending', '[]', ?, ?),
          ('TASK-B', 'Task B', 'pending', '["TASK-A"]', ?, ?),
          ('TASK-C', 'Task C', 'pending', '["TASK-B"]', ?, ?)
      `).run(now, now, now, now, now, now);

      // Self-dependency must fail
      expect(() => addPrerequisite(db, "TASK-A", "TASK-A")).toThrow("cannot depend on itself");

      // Adding cycle: A -> C when C already depends on B which depends on A
      expect(() => addPrerequisite(db, "TASK-A", "TASK-C")).toThrow(DependencyCycleError);

      // Valid removal: remove B from C
      const removeRes = removeDependency(db, "TASK-C", "TASK-B");
      expect(removeRes.success).toBe(true);
      expect(removeRes.updatedDependencies).toEqual([]);

      // Now adding A -> C is valid and acyclic
      const addRes = addPrerequisite(db, "TASK-C", "TASK-A");
      expect(addRes.success).toBe(true);
      expect(addRes.updatedDependencies).toContain("TASK-A");

      db.close();
    } finally {
      await repo.cleanup();
    }
  });

  it("unblocks blocked tasks and generates compact structured briefing (AQ-039)", async () => {
    const repo = await createTestGitRepo("overseer-briefing-test-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO tasks (id, title, status, retry_count, dependencies, created_at, updated_at)
        VALUES
          ('BLOCKED-1', 'Blocked Task', 'blocked', 1, '["MISSING-1"]', ?, ?)
      `).run(now, now);

      // Generate briefing
      const briefing = generateOverseerBriefing(db, repo.rootDir, "Worker stalled on dependency");
      expect(briefing).toContain("### AgentQueue Overseer Briefing");
      expect(briefing).toContain("Worker stalled on dependency");
      expect(briefing).toContain("BLOCKED-1");
      expect(briefing).toContain("Permitted Repair Operations");

      // Unblock task
      const unblockRes = unblockTask(db, "BLOCKED-1");
      expect(unblockRes.success).toBe(true);

      const task = db.prepare("SELECT status FROM tasks WHERE id = 'BLOCKED-1'").get() as {
        status: string;
      };
      expect(task.status).toBe("pending");

      db.close();
    } finally {
      await repo.cleanup();
    }
  });
});
