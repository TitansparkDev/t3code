import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/** Stores the durable timer/attempt marker on the thread shell. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN usage_limit_resume_json TEXT
  `;
  yield* sql`
    ALTER TABLE projection_thread_sessions
    ADD COLUMN last_error_class TEXT
  `;
  yield* sql`
    ALTER TABLE projection_thread_sessions
    ADD COLUMN retry_at TEXT
  `;
});
