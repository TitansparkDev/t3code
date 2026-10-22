// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { runMigrations } from "./migrations.ts";

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
  if (!NodeFS.existsSync(dbDir)) {
    NodeFS.mkdirSync(dbDir, { recursive: true });
  }

  const dbPath = resolveDatabasePath(options.gitCommonDir);
  const db = new NodeSqlite.DatabaseSync(dbPath, {
    readOnly: options.readonly ?? false,
  });

  // Concurrency pragmas (ADR-0001)
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  // Under heavy machine load a writer can hold the lock for several seconds; 5 s made every
  // queue call fail with "database is locked" on 2026-10-22.
  db.exec("PRAGMA busy_timeout = 30000;");
  db.exec("PRAGMA foreign_keys = ON;");

  if (!options.readonly) {
    runMigrations(db);
  }

  return db;
}
