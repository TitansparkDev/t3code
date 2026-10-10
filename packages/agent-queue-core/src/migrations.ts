// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import type * as NodeSqlite from "node:sqlite";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: NodeSqlite.DatabaseSync) => void;
}

export const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    name: "initial_queue_schema",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS plans (
          id TEXT PRIMARY KEY,
          file_path TEXT NOT NULL,
          checksum TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'archived')),
          registered_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'running', 'verifying', 'completed', 'failed', 'blocked')),
          priority INTEGER NOT NULL DEFAULT 100,
          version INTEGER NOT NULL DEFAULT 1,
          scope_patterns TEXT NOT NULL DEFAULT '[]',
          dependencies TEXT NOT NULL DEFAULT '[]',
          verification_command TEXT,
          max_retries INTEGER NOT NULL DEFAULT 3,
          retry_count INTEGER NOT NULL DEFAULT 0,
          timeout_seconds INTEGER NOT NULL DEFAULT 1800,
          failure_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority DESC, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(plan_id);

        CREATE TABLE IF NOT EXISTS task_claims (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          owner_token TEXT NOT NULL UNIQUE,
          worker_pid INTEGER NOT NULL,
          worker_session_id TEXT,
          worktree_path TEXT NOT NULL,
          branch TEXT NOT NULL,
          leased_at TEXT NOT NULL,
          heartbeat_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          released_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_claims_active ON task_claims(task_id, expires_at) WHERE released_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_claims_token ON task_claims(owner_token);

        CREATE TABLE IF NOT EXISTS task_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, id ASC);
        CREATE INDEX IF NOT EXISTS idx_events_id ON task_events(id ASC);

        CREATE TABLE IF NOT EXISTS landing_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          source_branch TEXT NOT NULL,
          target_branch TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('queued', 'merging', 'testing', 'landed', 'failed')),
          commit_hash TEXT,
          error_message TEXT,
          queued_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_landing_status ON landing_queue(status, id ASC);
      `);
    },
  },
];

/**
 * Runs all pending migrations within an immediate transaction and records PRAGMA user_version.
 */
export function runMigrations(db: NodeSqlite.DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const currentVersion = row ? row.user_version : 0;

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      db.exec("BEGIN IMMEDIATE;");
      try {
        migration.up(db);
        db.exec(`PRAGMA user_version = ${migration.version};`);
        db.exec("COMMIT;");
      } catch (err) {
        db.exec("ROLLBACK;");
        throw err;
      }
    }
  }
}
