// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { describe, expect, it } from "vite-plus/test";
import { openQueueDatabase } from "../src/db.ts";
import {
  recordEvent,
  getEventsSince,
  pollEventsSince,
  summarizePlanAudit,
} from "../src/eventStream.ts";
import { createTestGitRepo } from "./harness/gitHarness.ts";

describe("AgentQueue Durable Event Stream (AQ-013)", () => {
  it("records and streams events sequentially without gaps or duplicates", async () => {
    const repo = await createTestGitRepo("aq-event-stream-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });

      const e1 = recordEvent(db, "AQ-100", "task_created", { title: "Init" });
      const e2 = recordEvent(db, "AQ-100", "task_claimed", { workerPid: 1234 });
      const e3 = recordEvent(db, "AQ-101", "task_created", { title: "Next" });

      expect(e1).toBeGreaterThan(0);
      expect(e2).toBeGreaterThan(e1);
      expect(e3).toBeGreaterThan(e2);

      // Read from cursor 0
      const batch1 = getEventsSince(db, 0, 2);
      expect(batch1.events).toHaveLength(2);
      expect(batch1.events[0].id).toBe(e1);
      expect(batch1.events[1].id).toBe(e2);
      expect(batch1.lastEventId).toBe(e2);

      // Read subsequent events from last cursor
      const batch2 = getEventsSince(db, batch1.lastEventId, 10);
      expect(batch2.events).toHaveLength(1);
      expect(batch2.events[0].id).toBe(e3);
      expect(batch2.events[0].taskId).toBe("AQ-101");
      expect(batch2.lastEventId).toBe(e3);

      // Read when up to date
      const emptyBatch = getEventsSince(db, e3, 10);
      expect(emptyBatch.events).toHaveLength(0);
      expect(emptyBatch.lastEventId).toBe(e3);

      db.close();
    } finally {
      await repo.cleanup();
    }
  });

  it("polls and receives asynchronously emitted events", async () => {
    const repo = await createTestGitRepo("aq-event-poll-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });

      // Start poll promise
      const pollPromise = pollEventsSince(db, 0, 1000, 20);

      // Emit event shortly after
      setTimeout(() => {
        recordEvent(db, "AQ-ASYNC", "task_heartbeat", { step: 1 });
      }, 50);

      const batch = await pollPromise;
      expect(batch.events).toHaveLength(1);
      expect(batch.events[0].eventType).toBe("task_heartbeat");

      db.close();
    } finally {
      await repo.cleanup();
    }
  });

  it("summarizes completed repair entries separately from their original tasks", async () => {
    const repo = await createTestGitRepo("aq-audit-summary-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      db.prepare(
        `INSERT INTO plans (id, file_path, checksum, title, status, registered_at, updated_at)
         VALUES ('P', 'PLAN.md', 'hash', 'Plan', 'active', 'now', 'now')`,
      ).run();
      const insertTask = db.prepare(
        `INSERT INTO tasks (id, plan_id, title, status, created_at, updated_at)
         VALUES (?, 'P', ?, ?, 'now', 'now')`,
      );
      insertTask.run("A", "Original A", "completed");
      insertTask.run("A-FU1", "Repair A", "pending");
      insertTask.run("B", "Original B", "completed");
      insertTask.run("B-FU1", "Repair B", "completed");
      insertTask.run("C", "Historical entry", "completed");
      recordEvent(db, "A", "task_imported", { planId: "P" });
      recordEvent(db, "B", "task_imported", { planId: "P" });
      recordEvent(db, "A-FU1", "task_followup_created", { kind: "repair", parentTaskId: "A" });
      recordEvent(db, "B-FU1", "task_followup_created", { kind: "repair", parentTaskId: "B" });
      recordEvent(db, "A", "task_audited", { state: "passed" });
      recordEvent(db, "B", "task_audited", { state: "failed" });
      recordEvent(db, "B-FU1", "task_audited", { state: "passed" });

      expect(summarizePlanAudit(db, "P")).toEqual({
        originalTasks: {
          total: 2,
          completed: 2,
          audited: 2,
          passed: 1,
          failed: 1,
          otherAuditStates: 0,
          unknown: 0,
        },
        repairEntries: {
          total: 2,
          completed: 1,
          audited: 1,
          passed: 1,
          failed: 0,
          otherAuditStates: 0,
          unknown: 0,
          created: 2,
        },
        unclassifiedEntries: {
          total: 1,
          completed: 1,
          audited: 0,
          passed: 0,
          failed: 0,
          otherAuditStates: 0,
          unknown: 1,
        },
      });
      db.close();
    } finally {
      await repo.cleanup();
    }
  });
});
