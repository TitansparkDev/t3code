import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("051_ProjectionThreadUsageLimitResume", (it) => {
  it.effect("adds nullable resume and provider-reset columns to existing projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 50 });

      const beforeThreadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const beforeSessionColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_sessions)
      `;
      assert.isFalse(
        beforeThreadColumns.some((column) => column.name === "usage_limit_resume_json"),
      );
      assert.isFalse(beforeSessionColumns.some((column) => column.name === "last_error_class"));
      assert.isFalse(beforeSessionColumns.some((column) => column.name === "retry_at"));

      yield* runMigrations({ toMigrationInclusive: 51 });

      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const sessionColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_sessions)
      `;
      assert.isTrue(threadColumns.some((column) => column.name === "usage_limit_resume_json"));
      assert.isTrue(sessionColumns.some((column) => column.name === "last_error_class"));
      assert.isTrue(sessionColumns.some((column) => column.name === "retry_at"));

      const defaults = yield* sql<{
        readonly resume: string | null;
        readonly errorClass: string | null;
        readonly retryAt: string | null;
      }>`
        SELECT
          usage_limit_resume_json AS resume,
          (SELECT last_error_class FROM projection_thread_sessions LIMIT 1) AS "errorClass",
          (SELECT retry_at FROM projection_thread_sessions LIMIT 1) AS "retryAt"
        FROM projection_threads
        LIMIT 1
      `;
      assert.deepStrictEqual(defaults, []);
    }),
  );
});
