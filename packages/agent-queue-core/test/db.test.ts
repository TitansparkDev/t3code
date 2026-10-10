// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { describe, expect, it } from "vite-plus/test";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import { openQueueDatabase, resolveDatabasePath } from "../src/db.ts";
import { createTestGitRepo } from "./harness/gitHarness.ts";

describe("AgentQueue SQLite Engine & Migrations (AQ-007)", () => {
  it("creates database directory and runs migrations idempotently", async () => {
    const repo = await createTestGitRepo("aq-db-test-");
    try {
      const db1 = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      expect(db1).toBeDefined();

      const versionRow = db1.prepare("PRAGMA user_version").get() as { user_version: number };
      expect(versionRow.user_version).toBe(1);

      // Verify tables exist
      const tables = db1
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain("plans");
      expect(tableNames).toContain("tasks");
      expect(tableNames).toContain("task_claims");
      expect(tableNames).toContain("task_events");
      expect(tableNames).toContain("landing_queue");

      // Verify WAL mode
      const journalMode = db1.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(journalMode.journal_mode.toLowerCase()).toBe("wal");

      // Close and reopen (idempotence check)
      db1.close();
      const db2 = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const versionRow2 = db2.prepare("PRAGMA user_version").get() as { user_version: number };
      expect(versionRow2.user_version).toBe(1);
      db2.close();
    } finally {
      await repo.cleanup();
    }
  });

  it("handles concurrent connections and transactions safely under WAL mode", async () => {
    const repo = await createTestGitRepo("aq-db-concurrency-");
    try {
      const writer = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const reader = openQueueDatabase({ gitCommonDir: repo.gitCommonDir, readonly: true });

      // Insert task via writer
      const now = new Date().toISOString();
      writer.exec("BEGIN IMMEDIATE;");
      writer
        .prepare(
          `INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run("TASK-1", "Test task", "pending", now, now);
      writer.exec("COMMIT;");

      // Read immediately via reader
      const row = reader.prepare("SELECT * FROM tasks WHERE id = ?").get("TASK-1") as
        | {
            id: string;
            title: string;
          }
        | undefined;
      expect(row).toBeDefined();
      expect(row?.title).toBe("Test task");

      writer.close();
      reader.close();
    } finally {
      await repo.cleanup();
    }
  });
});
