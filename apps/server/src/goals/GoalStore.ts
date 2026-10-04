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
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
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
  }
>()("t3/goals/GoalStore") {}

export const make = Effect.gen(function* () {
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

  const modify = <A>(
    change: (goals: ReadonlyArray<Goal>) => {
      readonly next: ReadonlyArray<Goal>;
      readonly value: A;
    },
  ): Effect.Effect<A> =>
    writeLock.withPermit(
      Effect.gen(function* () {
        const result = yield* Ref.modify(state, (goals) => {
          const changed = change(goals);
          return [changed, changed.next] as const;
        });
        yield* fs
          .writeFileString(filePath, `${encodeGoalFile({ goals: result.next })}\n`)
          .pipe(
            Effect.catch((cause) => Effect.logWarning("goals.persist-failed", { filePath, cause })),
          );
        return result.value;
      }),
    );

  return GoalStore.of({
    list: Ref.get(state),
    add: (goal) => modify((goals) => ({ value: undefined, next: [goal, ...goals] })),
    update: (id, update) =>
      modify((goals) => {
        const existing = goals.find((goal) => goal.id === id);
        if (!existing) return { value: undefined, next: goals };
        const updated = update(existing);
        return { value: updated, next: goals.map((goal) => (goal.id === id ? updated : goal)) };
      }),
    remove: (id) =>
      modify((goals) => ({ value: undefined, next: goals.filter((goal) => goal.id !== id) })),
  });
});

export const layer = Layer.effect(GoalStore, make);
