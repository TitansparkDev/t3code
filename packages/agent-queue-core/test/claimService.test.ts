// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { describe, expect, it } from "vite-plus/test";
import { openQueueDatabase } from "../src/db.ts";
import { claimTask, renewLease, releaseClaim } from "../src/claimService.ts";
import { createTestGitRepo } from "./harness/gitHarness.ts";

describe("AgentQueue Atomic Reservation & Claims (AQ-010)", () => {
  it("claims ready task using CAS and rejects race contestants", async () => {
    const repo = await createTestGitRepo("aq-claim-race-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = new Date().toISOString();

      // Seed task
      db.prepare(`
        INSERT INTO tasks (id, title, status, version, created_at, updated_at)
        VALUES ('AQ-TEST-1', 'Race Task', 'pending', 1, ?, ?)
      `).run(now, now);

      // Worker 1 attempts claim
      const res1 = claimTask(db, {
        taskId: "AQ-TEST-1",
        workerPid: 1001,
        worktreePath: "/tmp/wt-1",
        branch: "aq/aq-test-1-w1",
      });
      expect(res1.success).toBe(true);
      if (!res1.success) return;
      expect(res1.version).toBe(2);
      expect(res1.claim.workerPid).toBe(1001);

      // Worker 2 attempts claim on the same task simultaneously
      const res2 = claimTask(db, {
        taskId: "AQ-TEST-1",
        workerPid: 1002,
        worktreePath: "/tmp/wt-2",
        branch: "aq/aq-test-1-w2",
      });
      expect(res2.success).toBe(false);
      if (!res2.success) {
        expect(res2.reason).toContain("TASK_NOT_PENDING");
      }

      // Check task in database has status 'claimed'
      const row = db.prepare("SELECT status, version FROM tasks WHERE id = ?").get("AQ-TEST-1") as {
        status: string;
        version: number;
      };
      expect(row.status).toBe("claimed");
      expect(row.version).toBe(2);

      db.close();
    } finally {
      await repo.cleanup();
    }
  });

  it("renews lease and records heartbeats", async () => {
    const repo = await createTestGitRepo("aq-lease-renew-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO tasks (id, title, status, version, created_at, updated_at)
        VALUES ('AQ-RENEW-1', 'Renew Task', 'pending', 1, ?, ?)
      `).run(now, now);

      const res = claimTask(db, {
        taskId: "AQ-RENEW-1",
        workerPid: 2001,
        worktreePath: "/tmp/wt-renew",
        branch: "aq/renew",
        leaseSeconds: 60,
      });
      expect(res.success).toBe(true);
      if (!res.success) return;

      const renewed = renewLease(db, res.claim.ownerToken, 180);
      expect(renewed).toBe(true);

      const claimRow = db
        .prepare("SELECT heartbeat_at, expires_at FROM task_claims WHERE owner_token = ?")
        .get(res.claim.ownerToken) as { heartbeat_at: string; expires_at: string };
      expect(claimRow.expires_at).toBeDefined();

      db.close();
    } finally {
      await repo.cleanup();
    }
  });

  it("releases claim and transitions task state", async () => {
    const repo = await createTestGitRepo("aq-claim-release-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO tasks (id, title, status, version, created_at, updated_at)
        VALUES ('AQ-REL-1', 'Release Task', 'pending', 1, ?, ?)
      `).run(now, now);

      const res = claimTask(db, {
        taskId: "AQ-REL-1",
        workerPid: 3001,
        worktreePath: "/tmp/wt-rel",
        branch: "aq/rel",
      });
      expect(res.success).toBe(true);
      if (!res.success) return;

      const released = releaseClaim(db, {
        ownerToken: res.claim.ownerToken,
        finalStatus: "completed",
      });
      expect(released).toBe(true);

      const taskRow = db.prepare("SELECT status FROM tasks WHERE id = ?").get("AQ-REL-1") as {
        status: string;
      };
      expect(taskRow.status).toBe("completed");

      // Verify event was emitted
      const eventRow = db
        .prepare("SELECT event_type FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 1")
        .get("AQ-REL-1") as { event_type: string };
      expect(eventRow.event_type).toBe("task_landed");

      db.close();
    } finally {
      await repo.cleanup();
    }
  });
});
