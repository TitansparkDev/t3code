import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The fork recorded two migrations of its own at ids 55 and 56, which upstream later gave to
// OrchestrationV2 and RemoveRedundantProjectionIndexes. The migrator skips every id at or below
// the highest one recorded, so those rows would leave V2 without its schema. Their effect (extra
// projection_threads columns that V2 never reads) needs no undoing, only their ledger rows.
const FORK_MIGRATIONS = new Map([
  [55, "ProjectionThreadUsageLimitResume"],
  [56, "ProjectionThreadSchemaCompatibility"],
]);

export const reconcileForkMigrations = Effect.fn("reconcileForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  for (const [id, name] of FORK_MIGRATIONS) {
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${id} AND name = ${name}`;
  }
});
