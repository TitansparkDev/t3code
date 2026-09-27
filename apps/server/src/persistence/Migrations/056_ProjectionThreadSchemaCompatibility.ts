import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Reconciles the two development migrations that independently claimed id 51.
 * Existing fork databases may have either schema, so every alteration is guarded.
 * Fork databases from 0.0.48 recorded id 52 for the old compatibility step, so
 * upstream's 052 title state column never ran there and is added here too.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "title_state_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN title_state_json TEXT`;
  }
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

  const messageColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  if (!messageColumns.some((column) => column.name === "context_json")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN context_json TEXT
    `;
  }
});
