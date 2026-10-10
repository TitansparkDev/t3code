// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { describe, expect, it } from "vite-plus/test";
import { openQueueDatabase } from "../src/db.ts";
import {
  transitionTask,
  isAllowedTransition,
  InvalidStateTransitionError,
} from "../src/stateMachine.ts";
import { createTestGitRepo } from "./harness/gitHarness.ts";

describe("AgentQueue State Machine & Transitions (AQ-011)", () => {
  it("allows legal progression of task states", async () => {
    const repo = await createTestGitRepo("aq-statemachine-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = new Date().toISOString();

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
      const now = new Date().toISOString();

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
});
