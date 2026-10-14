// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * The private corner of the machine each task works in. Two workers running the same suite
 * must not meet over a fixed database name, port, container project or temp folder, so
 * every task owns a numbered *slot* for as long as it is unfinished, and the names derived
 * from it are handed to the worker (in its prompt) and to the server's own check runs.
 *
 * @module taskEnvironment
 */
import type * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { RepoContract } from "./contract.ts";
import { repoRootOfGitDir, toolchainEnvironment } from "./toolchain.ts";

const PORT_BASE = 21_000;
const PORTS_PER_SLOT = 50;

/** The task's slot; allocated once, kept until the task is completed, lowest free number first. */
export function ensureSlot(db: NodeSqlite.DatabaseSync, taskId: string): number {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const own = db.prepare("SELECT env_slot FROM tasks WHERE id = ?").get(taskId) as
      | { env_slot: number | null }
      | undefined;
    if (own?.env_slot !== null && own?.env_slot !== undefined) {
      db.exec("COMMIT;");
      return own.env_slot;
    }
    const used = new Set(
      (
        db
          .prepare(
            "SELECT env_slot FROM tasks WHERE env_slot IS NOT NULL AND status != 'completed'",
          )
          .all() as Array<{ env_slot: number }>
      ).map((row) => row.env_slot),
    );
    let slot = 1;
    while (used.has(slot)) slot++;
    db.prepare("UPDATE tasks SET env_slot = ? WHERE id = ?").run(slot, taskId);
    db.exec("COMMIT;");
    return slot;
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

const slug = (taskId: string) =>
  taskId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

export interface TaskEnvironment {
  readonly slot: number;
  readonly variables: Readonly<Record<string, string>>;
}

export function taskEnvironment(input: {
  readonly taskId: string;
  readonly slot: number;
  readonly gitCommonDir: string;
  readonly contract: RepoContract;
}): TaskEnvironment {
  const name = slug(input.taskId);
  const portBase = PORT_BASE + input.slot * PORTS_PER_SLOT;
  const tmp = NodePath.join(input.gitCommonDir, "agentqueue", "tmp", name);
  try {
    NodeFS.mkdirSync(tmp, { recursive: true });
  } catch {
    // The folder is a convenience; checks still run without it.
  }
  const own: Record<string, string> = {
    AGENTQUEUE_TASK_ID: input.taskId,
    AGENTQUEUE_SLOT: String(input.slot),
    AGENTQUEUE_PORT_BASE: String(portBase),
    AGENTQUEUE_PORT_COUNT: String(PORTS_PER_SLOT),
    AGENTQUEUE_DB_NAME: `aq_${name}`,
    AGENTQUEUE_NAMESPACE: `aq-${name.replace(/_/g, "-")}`,
    COMPOSE_PROJECT_NAME: `aq-${name.replace(/_/g, "-")}`,
    TMPDIR: tmp,
  };
  const replace = (value: string) =>
    value
      .replaceAll("{slot}", own.AGENTQUEUE_SLOT!)
      .replaceAll("{taskId}", input.taskId)
      .replaceAll("{portBase}", own.AGENTQUEUE_PORT_BASE!)
      .replaceAll("{dbName}", own.AGENTQUEUE_DB_NAME!);
  const extra = Object.fromEntries(
    Object.entries(input.contract.env).map(([key, value]) => [key, replace(value)]),
  );
  // What the machine provides but the server process may not export (the Android SDK), so a check
  // run here does not depend on the shell the service was started from.
  const toolchain = toolchainEnvironment({ repoRoot: repoRootOfGitDir(input.gitCommonDir) });
  return { slot: input.slot, variables: { ...toolchain, ...own, ...extra } };
}

/** The lines a worker's prompt shows so it uses its own names. */
export function describeEnvironment(environment: TaskEnvironment): string[] {
  const v = environment.variables;
  return [
    `Your private resources (other workers have different ones; never use fixed names or default ports for tests): ports ${v.AGENTQUEUE_PORT_BASE}-${Number(v.AGENTQUEUE_PORT_BASE) + Number(v.AGENTQUEUE_PORT_COUNT) - 1}, database name \`${v.AGENTQUEUE_DB_NAME}\`, container/compose project \`${v.COMPOSE_PROJECT_NAME}\`, temp folder \`${v.TMPDIR}\`.`,
    "They are exported in the environment of the server's own check runs as AGENTQUEUE_PORT_BASE, AGENTQUEUE_DB_NAME, COMPOSE_PROJECT_NAME and TMPDIR; export the same values before you run tests yourself.",
  ];
}
