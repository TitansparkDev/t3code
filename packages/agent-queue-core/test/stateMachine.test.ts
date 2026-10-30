// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { describe, expect, it } from "vite-plus/test";
import { openQueueDatabase } from "../src/db.ts";
import {
  transitionTask,
  InvalidStateTransitionError,
  unwaiveTask,
  waiveTask,
} from "../src/stateMachine.ts";
import { createTestGitRepo } from "./harness/gitHarness.ts";

describe("AgentQueue State Machine & Transitions (AQ-011)", () => {
  it("allows legal progression of task states", async () => {
    const repo = await createTestGitRepo("aq-statemachine-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = "2026-01-01T00:00:00.000Z";

      db.prepare(`
        INSERT INTO tasks (id, title, status, version, created_at, updated_at)
        VALUES ('T-FLOW', 'Flow Task', 'pending', 1, ?, ?)
      `).run(now, now);

      // pending -> claimed
      const s1 = transitionTask(db, { taskId: "T-FLOW", nextStatus: "claimed" });
      expect(s1.success).toBe(true);

      // claimed -> running
      const s2 = transitionTask(db, { taskId: "T-FLOW", nextStatus: "running" });
      expect(s2.success).toBe(true);

      // running -> verifying
      const s3 = transitionTask(db, { taskId: "T-FLOW", nextStatus: "verifying" });
      expect(s3.success).toBe(true);

      // verifying -> completed
      const s4 = transitionTask(db, {
        taskId: "T-FLOW",
        nextStatus: "completed",
        note: "All tests green",
      });
      expect(s4.success).toBe(true);

      const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get("T-FLOW") as {
        status: string;
      };
      expect(task.status).toBe("completed");

      // Verify event history recorded notes
      const events = db
        .prepare(
          "SELECT event_type, payload_json FROM task_events WHERE task_id = ? ORDER BY id ASC",
        )
        .all("T-FLOW") as Array<{ event_type: string; payload_json: string }>;
      expect(events).toHaveLength(4);
      const lastPayload = JSON.parse(events[3].payload_json);
      expect(lastPayload.note).toBe("All tests green");

      db.close();
    } finally {
      await repo.cleanup();
    }
  });

  it("rejects illegal transitions with typed errors", async () => {
    const repo = await createTestGitRepo("aq-statemachine-illegal-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = "2026-01-01T00:00:00.000Z";

      db.prepare(`
        INSERT INTO tasks (id, title, status, version, created_at, updated_at)
        VALUES ('T-ILLEGAL', 'Illegal Task', 'completed', 1, ?, ?)
      `).run(now, now);

      // completed -> running is strictly illegal
      expect(() => transitionTask(db, { taskId: "T-ILLEGAL", nextStatus: "running" })).toThrow(
        InvalidStateTransitionError,
      );

      db.close();
    } finally {
      await repo.cleanup();
    }
  });

  it("waives pending and failed tasks, recording the reason and clearing the failure", async () => {
    const repo = await createTestGitRepo("aq-statemachine-waive-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = "2026-01-01T00:00:00.000Z";
      db.prepare(`
        INSERT INTO tasks (id, title, status, version, failure_reason, created_at, updated_at)
        VALUES ('T-PENDING', 'Pending', 'pending', 1, NULL, ?, ?),
          ('T-FAILED', 'Failed', 'failed', 2, 'Tests red', ?, ?)
      `).run(now, now, now, now);

      const pending = waiveTask(db, {
        taskId: "T-PENDING",
        reason: "  Superseded by the manual fix  ",
      });
      expect(pending).toEqual({ success: true, version: 2 });
      const pendingRow = db
        .prepare("SELECT status, waived_reason, waived_at FROM tasks WHERE id = 'T-PENDING'")
        .get() as { status: string; waived_reason: string; waived_at: string };
      expect(pendingRow.status).toBe("completed");
      expect(pendingRow.waived_reason).toBe("Superseded by the manual fix");
      expect(pendingRow.waived_at).toEqual(expect.any(String));

      waiveTask(db, { taskId: "T-FAILED", reason: "Not needed for this plan" });
      const failedRow = db
        .prepare("SELECT status, failure_reason FROM tasks WHERE id = 'T-FAILED'")
        .get() as { status: string; failure_reason: string | null };
      expect(failedRow).toEqual({ status: "completed", failure_reason: null });

      const events = db
        .prepare(
          "SELECT event_type, payload_json FROM task_events WHERE task_id = 'T-PENDING' ORDER BY id",
        )
        .all() as Array<{ event_type: string; payload_json: string }>;
      expect(events).toEqual([
        {
          event_type: "task_waived",
          payload_json: JSON.stringify({
            from: "pending",
            reason: "Superseded by the manual fix",
          }),
        },
      ]);
      db.close();
    } finally {
      await repo.cleanup();
    }
  });

  it("refuses to waive claimed tasks, completed tasks and short reasons", async () => {
    const repo = await createTestGitRepo("aq-statemachine-waive-refuse-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = "2026-01-01T00:00:00.000Z";
      db.prepare(`
        INSERT INTO tasks (id, title, status, version, created_at, updated_at)
        VALUES ('T-CLAIMED', 'Claimed', 'claimed', 1, ?, ?),
          ('T-DONE', 'Done', 'completed', 1, ?, ?),
          ('T-SHORT', 'Short', 'pending', 1, ?, ?)
      `).run(now, now, now, now, now, now);

      expect(() => waiveTask(db, { taskId: "T-CLAIMED", reason: "Dropped from the plan" })).toThrow(
        /T-CLAIMED cannot be waived from 'claimed'/,
      );
      expect(() => waiveTask(db, { taskId: "T-DONE", reason: "Dropped from the plan" })).toThrow(
        /T-DONE cannot be waived from 'completed'/,
      );
      expect(() => waiveTask(db, { taskId: "T-SHORT", reason: "  too few  " })).toThrow(
        /T-SHORT.*at least 10 characters/,
      );
      expect(() => waiveTask(db, { taskId: "T-MISSING", reason: "Dropped from the plan" })).toThrow(
        /T-MISSING not found/,
      );

      const statuses = db
        .prepare("SELECT id, status, waived_reason FROM tasks ORDER BY id")
        .all() as Array<{ id: string; status: string; waived_reason: string | null }>;
      expect(statuses).toEqual([
        { id: "T-CLAIMED", status: "claimed", waived_reason: null },
        { id: "T-DONE", status: "completed", waived_reason: null },
        { id: "T-SHORT", status: "pending", waived_reason: null },
      ]);
      db.close();
    } finally {
      await repo.cleanup();
    }
  });

  it("unwaives a task back to pending, but not once a dependent has started", async () => {
    const repo = await createTestGitRepo("aq-statemachine-unwaive-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = "2026-01-01T00:00:00.000Z";
      db.prepare(`
        INSERT INTO tasks (id, title, status, version, dependencies, created_at, updated_at)
        VALUES ('T-ROOT', 'Root', 'pending', 1, '[]', ?, ?),
          ('T-LEAF', 'Leaf', 'pending', 1, '["T-ROOT"]', ?, ?),
          ('T-OTHER', 'Other', 'pending', 1, '["T-ROOT"]', ?, ?)
      `).run(now, now, now, now, now, now);

      waiveTask(db, { taskId: "T-ROOT", reason: "Replaced by T-OTHER" });
      expect(unwaiveTask(db, "T-ROOT")).toEqual({ success: true, version: 3 });
      const root = db
        .prepare("SELECT status, waived_reason, waived_at FROM tasks WHERE id = 'T-ROOT'")
        .get() as { status: string; waived_reason: string | null; waived_at: string | null };
      expect(root).toEqual({ status: "pending", waived_reason: null, waived_at: null });
      const unwaiveEvent = db
        .prepare(
          "SELECT payload_json FROM task_events WHERE task_id = 'T-ROOT' AND event_type = 'task_unwaived'",
        )
        .get() as { payload_json: string };
      expect(unwaiveEvent.payload_json).toBe("{}");

      expect(() => unwaiveTask(db, "T-ROOT")).toThrow(/T-ROOT is not waived/);

      waiveTask(db, { taskId: "T-ROOT", reason: "Replaced by T-OTHER" });
      db.prepare("UPDATE tasks SET status = 'completed' WHERE id = 'T-LEAF'").run();
      expect(() => unwaiveTask(db, "T-ROOT")).toThrow(
        /T-ROOT cannot be unwaived: dependents already started: T-LEAF/,
      );
      const stillWaived = db
        .prepare("SELECT status, waived_reason FROM tasks WHERE id = 'T-ROOT'")
        .get() as { status: string; waived_reason: string | null };
      expect(stillWaived.status).toBe("completed");
      expect(stillWaived.waived_reason).toBe("Replaced by T-OTHER");
      db.close();
    } finally {
      await repo.cleanup();
    }
  });
});
