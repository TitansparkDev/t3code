import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";

it.effect("upgrades a database whose ledger holds the fork's migrations 55 and 56", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 54 });
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'ProjectionThreadUsageLimitResume')`;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (56, 'ProjectionThreadSchemaCompatibility')`;

    const executed = yield* runMigrations();
    assert.strictEqual(executed[0]?.[0], 55);

    const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
    `;
    assert.deepStrictEqual(
      history.map((row) => [row.migration_id, row.name] as const),
      migrationManifest,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
