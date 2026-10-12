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
  {
    version: 2,
    name: "candidate_integration_state",
    up: (db) => {
      // A worker's finished work is a candidate that waits for integration on its own
      // (status stays 'verifying'); it is never confused with unimplemented work.
      // integration_state: pending | conflict | repairing | repair_needed.
      db.exec(`
        ALTER TABLE tasks ADD COLUMN integration_state TEXT;
        ALTER TABLE tasks ADD COLUMN candidate_commit TEXT;
        ALTER TABLE tasks ADD COLUMN candidate_branch TEXT;
        ALTER TABLE tasks ADD COLUMN candidate_worktree TEXT;
        ALTER TABLE tasks ADD COLUMN integration_attempts INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE tasks ADD COLUMN integration_error TEXT;
        ALTER TABLE tasks ADD COLUMN receipt_json TEXT;
        ALTER TABLE tasks ADD COLUMN integration_updated_at TEXT;
        ALTER TABLE plans ADD COLUMN final_verification TEXT;
        ALTER TABLE plans ADD COLUMN final_receipt_json TEXT;
        CREATE INDEX IF NOT EXISTS idx_tasks_integration ON tasks(integration_state) WHERE integration_state IS NOT NULL;
      `);
    },
  },
  {
    version: 3,
    name: "goal_integration_branch_and_publication",
    up: (db) => {
      // Each plan integrates into its own branch; publishing that branch to the target
      // branch is a separate, recorded step.
      db.exec(`
        ALTER TABLE plans ADD COLUMN integration_branch TEXT;
        ALTER TABLE plans ADD COLUMN base_branch TEXT;
        ALTER TABLE plans ADD COLUMN base_commit TEXT;
        ALTER TABLE plans ADD COLUMN publication_state TEXT;
        ALTER TABLE plans ADD COLUMN publication_note TEXT;
        ALTER TABLE plans ADD COLUMN published_commit TEXT;
        ALTER TABLE plans ADD COLUMN publication_updated_at TEXT;
      `);
    },
  },
  {
    version: 4,
    name: "task_verification_spec",
    up: (db) => {
      // Structured checks (cwd, timeout, resources, expected result) or an explicit exemption.
      db.exec("ALTER TABLE tasks ADD COLUMN verification_spec TEXT;");
    },
  },
  {
    version: 5,
    name: "failure_ledger_scope_amendments_and_ownership",
    up: (db) => {
      // Why a task stopped (class + signature), what must change before it may run again
      // (unblock_fingerprint), and the isolated resource slot it owns. Scope changes are
      // recorded rows, never an edit of the plan's declared scope.
      db.exec(`
        ALTER TABLE tasks ADD COLUMN failure_class TEXT;
        ALTER TABLE tasks ADD COLUMN failure_signature TEXT;
        ALTER TABLE tasks ADD COLUMN unblock_fingerprint TEXT;
        ALTER TABLE tasks ADD COLUMN env_slot INTEGER;
        CREATE TABLE IF NOT EXISTS task_failures (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          class TEXT NOT NULL,
          signature TEXT NOT NULL,
          message TEXT NOT NULL,
          head_commit TEXT,
          evidence_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_failures_task ON task_failures(task_id, id);
        CREATE TABLE IF NOT EXISTS scope_amendments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          pattern TEXT NOT NULL,
          reason TEXT NOT NULL,
          source TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(task_id, pattern)
        );
      `);
      // One active owner per worktree and per branch, enforced by the database. A repository
      // whose old rows already violate this keeps working without the index.
      for (const column of ["worktree_path", "branch"]) {
        try {
          db.exec(
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_active_${column} ON task_claims(${column}) WHERE released_at IS NULL`,
          );
        } catch {
          // Duplicate active claims from an older version; the claim transaction still guards the task.
        }
      }
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
