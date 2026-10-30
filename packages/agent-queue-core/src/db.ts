// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { MIGRATIONS, runMigrations } from "./migrations.ts";

const LATEST_SCHEMA_VERSION = Math.max(...MIGRATIONS.map((migration) => migration.version));

export interface QueueDatabaseOptions {
  readonly gitCommonDir: string;
  readonly readonly?: boolean;
}

export function resolveDatabaseDir(gitCommonDir: string): string {
  return NodePath.join(gitCommonDir, "agentqueue");
}

export function resolveDatabasePath(gitCommonDir: string): string {
  return NodePath.join(resolveDatabaseDir(gitCommonDir), "queue.sqlite");
}

/**
 * Opens the SQLite database for AgentQueue with WAL mode, foreign keys,
 * and 5000ms busy timeout. Runs pending migrations if not opened in read-only mode.
 */
export function openQueueDatabase(options: QueueDatabaseOptions): NodeSqlite.DatabaseSync {
  const dbDir = resolveDatabaseDir(options.gitCommonDir);
  if (!options.readonly && !NodeFS.existsSync(dbDir)) {
    NodeFS.mkdirSync(dbDir, { recursive: true });
  }

  const dbPath = resolveDatabasePath(options.gitCommonDir);
  const existed = NodeFS.existsSync(dbPath);
  if (options.readonly && !existed) {
    const db = new NodeSqlite.DatabaseSync(":memory:");
    db.exec("PRAGMA busy_timeout = 30000;");
    db.exec("PRAGMA foreign_keys = ON;");
    runMigrations(db);
    db.exec("PRAGMA query_only = ON;");
    return db;
  }

  const db = new NodeSqlite.DatabaseSync(dbPath, {
    readOnly: options.readonly ?? false,
  });

  // Concurrency pragmas (ADR-0001)
  // Under heavy machine load a writer can hold the lock for several seconds; 5 s made every
  // queue call fail with "database is locked" on 2026-10-22. Set first, so the WAL switch
  // below also waits when several processes open a new database together.
  db.exec("PRAGMA busy_timeout = 30000;");

  if (!options.readonly) {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    if (existed) {
      backupBeforeMigration(db, dbPath);
    }
    runMigrations(db);
  } else {
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA query_only = ON;");
  }

  return db;
}

/**
 * Keeps a copy of an older database before its first migration to the current schema.
 * The backup is published with a hard link, which fails if another process already published
 * one, so concurrent openers keep the first copy and never overwrite it.
 */
function backupBeforeMigration(db: NodeSqlite.DatabaseSync, dbPath: string): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (row.user_version < 1 || row.user_version >= LATEST_SCHEMA_VERSION) {
    return;
  }

  const backupPath = `${dbPath}.pre-v${LATEST_SCHEMA_VERSION}.bak`;
  if (NodeFS.existsSync(backupPath)) {
    return;
  }

  const stagingPath = `${backupPath}.${process.pid}.tmp`;
  db.exec(`VACUUM INTO '${stagingPath.replaceAll("'", "''")}';`);
  try {
    NodeFS.linkSync(stagingPath, backupPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
  } finally {
    NodeFS.rmSync(stagingPath, { force: true });
  }
}
