import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("052_ProjectionThreadSchemaCompatibility", (it) => {
  it.effect("keeps an upstream context column while adding fork columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 50 });
      yield* runMigrations({ toMigrationInclusive: 51 });
      yield* sql`
        ALTER TABLE projection_thread_messages
        ADD COLUMN context_json TEXT
      `;

      yield* runMigrations({ toMigrationInclusive: 52 });

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
});
