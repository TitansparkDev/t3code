// @effect-diagnostics effectFnOpportunity:off - fork service predating the rule; convert to Effect.fn as it is touched.
/**
 * Goals, kept in one JSON file in the state directory so they survive a
 * restart. Every change is serialized through one lock and written whole.
 *
 * @module goals/GoalStore
 */
import { Goal, type GoalId } from "@t3tools/contracts/goals";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";

const decodeGoal = Schema.decodeUnknownOption(Goal);
const GoalFile = Schema.fromJsonString(Schema.Struct({ goals: Schema.Array(Goal) }));
const encodeGoalFile = Schema.encodeSync(GoalFile);
const GoalFileGoals = Schema.fromJsonString(Schema.Struct({ goals: Schema.Array(Schema.Unknown) }));
const decodeGoalFileGoals = Schema.decodeUnknownOption(GoalFileGoals);

export class GoalStore extends Context.Service<
  GoalStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<Goal>>;
    readonly add: (goal: Goal) => Effect.Effect<void>;
    /** Replace one goal with `update(goal)`. Returns the new goal, or undefined if it is gone. */
    readonly update: (id: GoalId, update: (goal: Goal) => Goal) => Effect.Effect<Goal | undefined>;
    readonly remove: (id: GoalId) => Effect.Effect<void>;
    /**
     * Signals after every committed change, so a waiter re-reads `list` on each signal.
     * Subscribe before reading, or a change made in between is missed.
     */
    readonly subscribeChanges: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
  }
>()("t3/goals/GoalStore") {}

// Callers build `detail` from truncated messages; a trailing space or an empty string would
// fail the trimmed-string schema.
const normalizeDetail = (goal: Goal): Goal => {
  if (goal.detail === undefined) return goal;
  const detail = goal.detail.trim();
  if (detail === goal.detail) return goal;
  const { detail: _dropped, ...rest } = goal;
  return detail === "" ? rest : { ...goal, detail: detail as never };
};

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const filePath = path.join(serverConfig.stateDir, "goals.json");

  const loaded = yield* fs.readFileString(filePath).pipe(
    Effect.map((contents) => {
      const file = decodeGoalFileGoals(contents);
      if (file._tag === "None") return [] as ReadonlyArray<Goal>;
      // One unreadable goal must not take the rest of the file with it.
      return file.value.goals.flatMap((goal) => {
        const decoded = decodeGoal(goal);
        return decoded._tag === "Some" ? [decoded.value] : [];
      });
    }),
    Effect.orElseSucceed(() => [] as ReadonlyArray<Goal>),
  );

  const state = yield* Ref.make<ReadonlyArray<Goal>>(loaded);
  const writeLock = yield* Semaphore.make(1);
  const changes = yield* PubSub.unbounded<void>();

  // Encoding happens before the in-memory state changes. A goal that violates the schema
  // (a blank detail, a count out of range) must be refused here: if it reached memory first,
  // every later write would fail to encode, the file would go stale, and every read of that
  // goal would fail to encode too.
  const modify = <A>(
    change: (goals: ReadonlyArray<Goal>) => {
      readonly next: ReadonlyArray<Goal>;
      readonly value: A;
    },
  ): Effect.Effect<A> =>
    writeLock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const changed = change(current);
        const contents = yield* Effect.try(
          () => `${encodeGoalFile({ goals: changed.next })}\n`,
        ).pipe(
          Effect.tapError((cause) =>
            Effect.logError("goals.write-rejected", {
              filePath,
              reason: String(cause).slice(0, 500),
            }),
          ),
          Effect.orDie,
        );
        yield* Ref.set(state, changed.next);
        yield* PubSub.publish(changes, undefined);
        yield* fs
          .writeFileString(filePath, contents)
          .pipe(
            Effect.catch((cause) => Effect.logWarning("goals.persist-failed", { filePath, cause })),
          );
        return changed.value;
      }),
    );

  return GoalStore.of({
    list: Ref.get(state),
    add: (goal) =>
      modify((goals) => ({ value: undefined, next: [normalizeDetail(goal), ...goals] })),
    update: (id, update) =>
      modify((goals) => {
        const existing = goals.find((goal) => goal.id === id);
        if (!existing) return { value: undefined, next: goals };
        const updated = normalizeDetail(update(existing));
        return { value: updated, next: goals.map((goal) => (goal.id === id ? updated : goal)) };
      }),
    remove: (id) =>
      modify((goals) => ({ value: undefined, next: goals.filter((goal) => goal.id !== id) })),
    subscribeChanges: PubSub.subscribe(changes),
  });
});

export const layer = Layer.effect(GoalStore, make);
