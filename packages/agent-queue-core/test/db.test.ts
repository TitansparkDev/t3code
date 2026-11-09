// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { describe, expect, it } from "vite-plus/test";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import { MIGRATIONS } from "../src/migrations.ts";
import { openQueueDatabase, resolveDatabaseDir, resolveDatabasePath } from "../src/db.ts";
import { createTestGitRepo } from "./harness/gitHarness.ts";

describe("AgentQueue SQLite Engine & Migrations (AQ-007)", () => {
  it("creates database directory and runs migrations idempotently", async () => {
    const repo = await createTestGitRepo("aq-db-test-");
    try {
      const db1 = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      expect(db1).toBeDefined();

      const versionRow = db1.prepare("PRAGMA user_version").get() as { user_version: number };
      expect(versionRow.user_version).toBe(7);

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
      expect(versionRow2.user_version).toBe(7);
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
      const now = "2026-01-01T00:00:00.000Z";
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

  it("backs up a version-6 database before migrating and keeps its rows", async () => {
    const repo = await createTestGitRepo("aq-db-upgrade-");
    try {
      const dbPath = resolveDatabasePath(repo.gitCommonDir);
      NodeFS.mkdirSync(resolveDatabaseDir(repo.gitCommonDir), { recursive: true });
      const old = new NodeSqlite.DatabaseSync(dbPath);
      for (const migration of MIGRATIONS.filter((m) => m.version <= 6)) {
        migration.up(old);
      }
      old.exec("PRAGMA user_version = 6;");
      const now = "2026-01-01T00:00:00.000Z";
      old
        .prepare(
          "INSERT INTO plans (id, file_path, checksum, title, status, registered_at, updated_at) VALUES ('P-1', 'plan.md', 'sum', 'Plan', 'active', ?, ?)",
        )
        .run(now, now);
      old
        .prepare(
          "INSERT INTO tasks (id, plan_id, title, status, created_at, updated_at) VALUES ('T-1', 'P-1', 'Task', 'claimed', ?, ?)",
        )
        .run(now, now);
      old
        .prepare(
          "INSERT INTO task_claims (task_id, owner_token, worker_pid, worktree_path, branch, leased_at, heartbeat_at, expires_at) VALUES ('T-1', 'tok-1', 1, '/tmp/wt', 'aq/t-1', ?, ?, '2099-01-01T00:00:00.000Z')",
        )
        .run(now, now);
      old
        .prepare(
          "INSERT INTO landing_queue (task_id, source_branch, target_branch, status, queued_at) VALUES ('T-1', 'aq/t-1', 'main', 'queued', ?)",
        )
        .run(now);
      old.close();

      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const columns = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      );
      expect(columns).toEqual(expect.arrayContaining(["waived_reason", "waived_at"]));
      expect(db.prepare("SELECT count(*) AS cnt FROM task_claims").get()).toEqual({ cnt: 1 });
      expect(db.prepare("SELECT count(*) AS cnt FROM landing_queue").get()).toEqual({ cnt: 1 });
      expect(db.prepare("SELECT status FROM tasks WHERE id = 'T-1'").get()).toEqual({
        status: "claimed",
      });
      db.close();

      const backup = new NodeSqlite.DatabaseSync(`${dbPath}.pre-v7.bak`, { readOnly: true });
      expect(backup.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
      expect(backup.prepare("SELECT count(*) AS cnt FROM tasks").get()).toEqual({ cnt: 1 });
      backup.close();
    } finally {
      await repo.cleanup();
    }
  });

  it("lets several processes open and migrate a new database at once", async () => {
    const repo = await createTestGitRepo("aq-db-race-");
    try {
      const dbSource = NodePath.resolve(import.meta.dirname, "../src/db.ts");
      const script = NodePath.join(repo.rootDir, "open-queue.mts");
      NodeFS.writeFileSync(
        script,
        `import { openQueueDatabase } from ${JSON.stringify(dbSource)};
const db = openQueueDatabase({ gitCommonDir: process.argv[2] });
db.close();
`,
      );
      const runChild = () =>
        new Promise<number | null>((resolve, reject) =>
          NodeChildProcess.spawn(process.execPath, [script, repo.gitCommonDir], {
            stdio: "ignore",
          })
            .on("error", reject)
            .on("close", resolve),
        );
      const codes = await Promise.all([runChild(), runChild(), runChild(), runChild()]);
      expect(codes).toEqual([0, 0, 0, 0]);

      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
      db.close();
    } finally {
      await repo.cleanup();
    }
  });
});
