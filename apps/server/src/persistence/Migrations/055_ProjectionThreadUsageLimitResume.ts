import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Stores the durable timer/attempt marker on the thread shell. Fork databases
 * from 0.0.48 already have these columns under an earlier id, so each one is
 * guarded.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "usage_limit_resume_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN usage_limit_resume_json TEXT
    `;
  }

  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (!sessionColumns.some((column) => column.name === "last_error_class")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN last_error_class TEXT
    `;
  }
  if (!sessionColumns.some((column) => column.name === "retry_at")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN retry_at TEXT
    `;
  }
});
