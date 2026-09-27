import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "056_ProjectionThreadSchemaCompatibility",
  (it) => {
    it.effect("keeps an upstream context column while adding fork columns", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 53 });
        yield* runMigrations({ toMigrationInclusive: 54 });

        yield* runMigrations({ toMigrationInclusive: 56 });

        const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
        const sessionColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_sessions)
      `;
        const messageColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_messages)
      `;

        assert.isTrue(threadColumns.some((column) => column.name === "usage_limit_resume_json"));
        assert.isTrue(sessionColumns.some((column) => column.name === "last_error_class"));
        assert.isTrue(sessionColumns.some((column) => column.name === "retry_at"));
        assert.isTrue(messageColumns.some((column) => column.name === "context_json"));
        assert.equal(messageColumns.filter((column) => column.name === "context_json").length, 1);
      }),
    );
  },
);

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "056_ProjectionThreadSchemaCompatibility from a 0.0.48 fork database",
  (it) => {
    it.effect("upgrades a database that recorded the old compatibility step as 52", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 51 });
        // 0.0.48 added the usage limit columns under ids 51 and 52 and never ran 052 title state.
        yield* sql`ALTER TABLE projection_threads ADD COLUMN usage_limit_resume_json TEXT`;
        yield* sql`ALTER TABLE projection_thread_sessions ADD COLUMN last_error_class TEXT`;
        yield* sql`ALTER TABLE projection_thread_sessions ADD COLUMN retry_at TEXT`;
        yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (52, 'ProjectionThreadSchemaCompatibility')
      `;

        yield* runMigrations({ toMigrationInclusive: 56 });

        const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
        assert.isTrue(threadColumns.some((column) => column.name === "title_state_json"));
        assert.isTrue(threadColumns.some((column) => column.name === "auto_settle_disabled_at"));
        assert.equal(
          threadColumns.filter((column) => column.name === "usage_limit_resume_json").length,
          1,
        );
      }),
    );
  },
);
