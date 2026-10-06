/**
 * Reads a project's Beads queue (the `bd` command) for goals that schedule
 * from it. Beads owns what exists, what is ready, what is blocked and who has
 * claimed it; a goal only asks, and starts an agent when a chunk is ready.
 *
 * @module goals/GoalBeads
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export class GoalBeadsError extends Schema.TaggedError<GoalBeadsError>()("GoalBeadsError", {
  message: Schema.String,
}) {}

export interface Bead {
  readonly id: string;
  readonly title: string;
}

/** An unfinished chunk and what holds it up or who holds it, for an overseer to read. */
export interface BeadDetail {
  readonly id: string;
  readonly title: string;
  /** Chunks it waits on (blocked) or who has claimed it (claimed). */
  readonly note: string;
}

export interface BeadsSnapshot {
  /** Chunks nobody has claimed whose blockers are all finished, best first. */
  readonly ready: ReadonlyArray<Bead>;
  /** Claimed and being worked on. */
  readonly working: number;
  /** Unfinished and waiting on other chunks. */
  readonly blocked: number;
  readonly done: number;
}

export class GoalBeads extends Context.Service<
  GoalBeads,
  {
    /** Whether the folder has a Beads database this goal can use. */
    readonly available: (workspaceRoot: string) => Effect.Effect<boolean>;
    readonly snapshot: (
      workspaceRoot: string,
      scope: string | undefined,
    ) => Effect.Effect<BeadsSnapshot, GoalBeadsError>;
    /** Blocked chunks (with what blocks them) and claimed chunks (with who), for the overseer. */
    readonly describe: (
      workspaceRoot: string,
      scope: string | undefined,
    ) => Effect.Effect<{
      readonly blocked: ReadonlyArray<BeadDetail>;
      readonly claimed: ReadonlyArray<BeadDetail>;
    }>;
    /** The chunk's status, or undefined when it cannot be read. */
    readonly statusOf: (workspaceRoot: string, beadId: string) => Effect.Effect<string | undefined>;
    /** Give a claimed chunk back so another agent can take it. */
    readonly release: (workspaceRoot: string, beadId: string) => Effect.Effect<void>;
  }
>()("t3/goals/GoalBeads") {}

interface Row {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly status?: unknown;
  readonly issue_type?: unknown;
  readonly assignee?: unknown;
  readonly blocked_by?: unknown;
}

const rows = (json: string): ReadonlyArray<Row> => {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as ReadonlyArray<Row>) : [];
  } catch {
    return [];
  }
};

/**
 * Counts from `bd list --all` and `bd ready`. Epics only group chunks, so they
 * are left out. A chunk that is unfinished but neither ready nor claimed is
 * waiting on something.
 */
export function summarizeBeads(allJson: string, readyJson: string): BeadsSnapshot {
  const chunks = rows(allJson).filter((row) => row.issue_type !== "epic");
  const ready = rows(readyJson)
    .filter(
      (row) =>
        row.issue_type !== "epic" && typeof row.id === "string" && typeof row.title === "string",
    )
    .map((row) => ({ id: row.id as string, title: row.title as string }));
  const working = chunks.filter((row) => row.status === "in_progress").length;
  const done = chunks.filter((row) => row.status === "closed").length;
  const unfinished = chunks.length - done;
  return { ready, working, done, blocked: Math.max(0, unfinished - working - ready.length) };
}

const detail = (row: Row, note: string): BeadDetail | undefined =>
  typeof row.id === "string" && typeof row.title === "string"
    ? { id: row.id, title: row.title, note }
    : undefined;

/** Blocked and claimed chunks from `bd blocked` and `bd list --status in_progress`. */
export function describeBeads(blockedJson: string, claimedJson: string) {
  const keep = (row: Row) => row.issue_type !== "epic";
  return {
    blocked: rows(blockedJson)
      .filter(keep)
      .flatMap(
        (row) =>
          detail(
            row,
            Array.isArray(row.blocked_by) ? `waits on ${row.blocked_by.join(", ")}` : "blocked",
          ) ?? [],
      ),
    claimed: rows(claimedJson)
      .filter(keep)
      .flatMap(
        (row) =>
          detail(
            row,
            typeof row.assignee === "string" ? `claimed by ${row.assignee}` : "claimed",
          ) ?? [],
      ),
  };
}

const BD_TIMEOUT = "20 seconds";

export const layer = Layer.effect(
  GoalBeads,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const bd = (workspaceRoot: string, args: ReadonlyArray<string>) =>
      spawner
        .string(
          ChildProcess.make("bd", args, { cwd: workspaceRoot, stdin: "ignore", stderr: "ignore" }),
        )
        .pipe(Effect.timeout(BD_TIMEOUT));

    return GoalBeads.of({
      available: (workspaceRoot) =>
        fs.exists(path.join(workspaceRoot, ".beads")).pipe(Effect.orElseSucceed(() => false)),
      snapshot: (workspaceRoot, scope) => {
        const parent = scope?.trim() ? ["--parent", scope.trim()] : [];
        return Effect.all([
          bd(workspaceRoot, ["list", "--json", "-n", "0", "--all", ...parent]),
          bd(workspaceRoot, ["ready", "--json", "-n", "0", "--exclude-type", "epic", ...parent]),
        ]).pipe(
          Effect.map(([all, ready]) => summarizeBeads(all, ready)),
          Effect.mapError(
            (cause) => new GoalBeadsError({ message: `Could not read Beads: ${String(cause)}` }),
          ),
        );
      },
      describe: (workspaceRoot, scope) => {
        const parent = scope?.trim() ? ["--parent", scope.trim()] : [];
        return Effect.all([
          bd(workspaceRoot, ["blocked", "--json", ...parent]),
          bd(workspaceRoot, ["list", "--json", "-n", "0", "--status", "in_progress", ...parent]),
        ]).pipe(
          Effect.map(([blocked, claimed]) => describeBeads(blocked, claimed)),
          Effect.orElseSucceed(() => ({ blocked: [], claimed: [] })),
        );
      },
      statusOf: (workspaceRoot, beadId) =>
        bd(workspaceRoot, ["show", beadId, "--json"]).pipe(
          Effect.map((json) => {
            const status = rows(json)[0]?.status;
            return typeof status === "string" ? status : undefined;
          }),
          Effect.orElseSucceed(() => undefined),
        ),
      release: (workspaceRoot, beadId) =>
        bd(workspaceRoot, [
          "unclaim",
          beadId,
          "--reason",
          "goal chat ended without finishing",
        ]).pipe(Effect.ignoreCause({ log: true })),
    });
  }),
);

/** No Beads anywhere: goals run plain agents. */
export const layerNone = Layer.succeed(
  GoalBeads,
  GoalBeads.of({
    available: () => Effect.succeed(false),
    snapshot: () => Effect.fail(new GoalBeadsError({ message: "Beads is not available." })),
    describe: () => Effect.succeed({ blocked: [], claimed: [] }),
    statusOf: () => Effect.succeed(undefined),
    release: () => Effect.void,
  }),
);
