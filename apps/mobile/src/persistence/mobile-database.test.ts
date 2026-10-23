import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

const openDatabaseAsync = vi.hoisted(() => vi.fn());

vi.mock("expo-sqlite", () => ({ openDatabaseAsync }));

import * as MobileDatabase from "./mobile-database";

async function sqliteDatabase() {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA user_version = 1");
  const database = {
    execAsync: async (sql: string) => sqlite.exec(sql),
    runAsync: async (sql: string, ...args: Array<string | number>) =>
      sqlite.prepare(sql).run(...args),
    getFirstAsync: async (sql: string, ...args: Array<string | number>) =>
      sqlite.prepare(sql).get(...args),
    getAllAsync: async (sql: string, ...args: Array<string | number>) =>
      sqlite.prepare(sql).all(...args),
    withExclusiveTransactionAsync: async (run: (transaction: unknown) => Promise<void>) => {
      await run(database);
    },
    closeAsync: async () => sqlite.close(),
  };
  openDatabaseAsync.mockResolvedValueOnce(database);
  return sqlite;
}

describe("mobile database legacy cache migration", () => {
  it("maps legacy thread records to their SQLite identity", () => {
    const payload = JSON.stringify({
      schemaVersion: 2,
      environmentId: "environment-1",
      threadId: "thread-1",
      snapshot: {},
    });

    expect(MobileDatabase.decodeLegacyCacheRecord("connection-thread-snapshots", payload)).toEqual({
      environmentId: "environment-1",
      kind: "thread",
      cacheKey: "thread-1",
      schemaVersion: 2,
      payload,
    });
  });

  it("skips malformed legacy records", () => {
    expect(MobileDatabase.decodeLegacyCacheRecord("connection-vcs-refs", "{not-json")).toBeNull();
    expect(
      MobileDatabase.decodeLegacyCacheRecord(
        "connection-vcs-refs",
        JSON.stringify({ schemaVersion: 1, environmentId: "environment-1" }),
      ),
    ).toBeNull();
  });
});

describe("offline pull request cache", () => {
  const environmentId = "cached-environment" as import("@t3tools/contracts").EnvironmentId;
  const otherEnvironment = "other-environment" as import("@t3tools/contracts").EnvironmentId;

  it.effect("restores saved records and clears them with the environment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.promise(sqliteDatabase);
        const database = yield* MobileDatabase.make;
        yield* database.saveCache(environmentId, "pull-request", "v1:list", 1, '{"entries":[]}');
        yield* database.saveCache(otherEnvironment, "pull-request", "v1:list", 1, "other");
        expect(yield* database.loadCache(environmentId, "pull-request", "v1:list")).toEqual(
          Option.some('{"entries":[]}'),
        );
        yield* database.clearEnvironmentCache(environmentId);
        expect((yield* database.loadCache(environmentId, "pull-request", "v1:list"))._tag).toBe(
          "None",
        );
        expect((yield* database.loadCache(otherEnvironment, "pull-request", "v1:list"))._tag).toBe(
          "Some",
        );
      }),
    ),
  );
});

describe("bounded mobile thread cache", () => {
  const environmentId = "thread-cache-environment" as import("@t3tools/contracts").EnvironmentId;

  it.effect("evicts the oldest successful write above one hundred thread records", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.promise(sqliteDatabase);
        const database = yield* MobileDatabase.make;
        for (let index = 0; index <= 100; index += 1) {
          yield* database.saveCache(environmentId, "thread", `thread-${index}`, 5, `${index}`);
        }

        expect((yield* database.loadCache(environmentId, "thread", "thread-0"))._tag).toBe("None");
        expect((yield* database.loadCache(environmentId, "thread", "thread-100"))._tag).toBe(
          "Some",
        );
        expect(yield* database.inspectCaches).toContainEqual({
          environmentId,
          kind: "thread",
          recordCount: 100,
          payloadBytes: 192,
        });
      }),
    ),
  );

  it.effect("counts encoded Unicode bytes and keeps the current write inside the byte budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.promise(sqliteDatabase);
        const database = yield* MobileDatabase.make;
        yield* database.saveCache(
          environmentId,
          "thread",
          "older-large",
          5,
          "x".repeat(63 * 1024 * 1024),
        );
        const unicode = "🧪".repeat((2 * 1024 * 1024) / 4);
        yield* database.saveCache(environmentId, "thread", "current-unicode", 5, unicode);

        expect((yield* database.loadCache(environmentId, "thread", "older-large"))._tag).toBe(
          "None",
        );
        expect(yield* database.inspectCaches).toContainEqual({
          environmentId,
          kind: "thread",
          recordCount: 1,
          payloadBytes: 2 * 1024 * 1024,
        });
      }),
    ),
  );
});
