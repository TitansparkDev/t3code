// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * What a worker runs before it finishes: the same scope decision and the same repository
 * finalizer the server will apply to its commit, with the same allowed paths. Files the server
 * would approve by itself are approved now (and recorded), so the worker never reverts a file the
 * task needs just because a guard it ran earlier did not know about it.
 *
 * @module finalize
 */
import type * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import { expandCommand, loadContract, runShell } from "./contract.ts";
import {
  auditScope,
  changedPaths,
  decideScope,
  storedAmendments,
  type ScopeRequest,
} from "./scopeAudit.ts";
import { ensureSlot, taskEnvironment } from "./taskEnvironment.ts";

export interface FinalizeReport {
  readonly ok: boolean;
  readonly taskId: string;
  /** Files outside the task's own paths that were approved (now, or earlier). */
  readonly approved: ReadonlyArray<string>;
  /** Files the server would wait for (another running task holds them) or refuse. */
  readonly problems: ReadonlyArray<string>;
  readonly guards: ReadonlyArray<{
    readonly name: string;
    readonly ok: boolean;
    readonly output: string;
  }>;
  readonly message: string;
}

export function finalizeTask(
  db: NodeSqlite.DatabaseSync,
  input: {
    readonly taskId: string;
    readonly worktree: string;
    readonly repoRoot: string;
    readonly gitCommonDir: string;
    readonly requests?: ReadonlyArray<ScopeRequest>;
  },
): FinalizeReport {
  const task = db
    .prepare(
      "SELECT t.scope_patterns, t.plan_id, p.integration_branch, p.base_branch FROM tasks t LEFT JOIN plans p ON p.id = t.plan_id WHERE t.id = ?",
    )
    .get(input.taskId) as
    | {
        scope_patterns: string | null;
        plan_id: string | null;
        integration_branch: string | null;
        base_branch: string | null;
      }
    | undefined;
  if (!task) throw new Error(`Unknown task ${input.taskId}.`);
  const base = task.integration_branch ?? task.base_branch ?? "HEAD";
  const target = task.base_branch ?? base;
  const loaded = loadContract({
    repoRoot: input.repoRoot,
    gitCommonDir: input.gitCommonDir,
    refs: [target, base],
  });
  const scope = JSON.parse(task.scope_patterns || "[]") as string[];
  const changed = changedPaths(input.worktree, `refs/heads/${base}`);
  const amendments = () => storedAmendments(db, input.taskId);
  let verdict = auditScope({ changed, scope, contract: loaded.contract, amendments: amendments() });
  let problems: string[] = [];
  if (verdict.violations.length > 0) {
    const decision = decideScope(db, {
      taskId: input.taskId,
      requests: input.requests ?? [],
      contract: loaded.contract,
      violations: verdict.violations,
    });
    verdict = auditScope({ changed, scope, contract: loaded.contract, amendments: amendments() });
    problems = [
      ...decision.denied.map((entry) => `${entry.path}: ${entry.why}`),
      ...decision.waits.map(
        (entry) =>
          `${entry.path}: held by ${entry.ownerTaskId}; the server pauses your task until it is free (commit it and finish)`,
      ),
    ];
  }
  const slot = ensureSlot(db, input.taskId);
  const env = taskEnvironment({
    taskId: input.taskId,
    slot,
    gitCommonDir: input.gitCommonDir,
    contract: loaded.contract,
  }).variables;
  const branch = NodeChildProcess.spawnSync("git", ["branch", "--show-current"], {
    cwd: input.worktree,
    encoding: "utf8",
  }).stdout.trim();
  const guards = loaded.contract.guards
    .filter((guard) => guard.phase === "submit")
    .map((guard) => {
      const ran = runShell(
        expandCommand(guard.run, {
          taskId: input.taskId,
          branch,
          base,
          worktree: input.worktree,
          allowedPaths: verdict.allowed,
        }),
        input.worktree,
        { env },
      );
      return {
        name: guard.name,
        ok: ran.code === 0 || guard.optional,
        output: ran.output.slice(-800),
      };
    });
  const ok = problems.length === 0 && guards.every((guard) => guard.ok);
  return {
    ok,
    taskId: input.taskId,
    approved: [...verdict.generated, ...verdict.supporting, ...verdict.amended],
    problems,
    guards,
    message: ok
      ? `Ready: ${verdict.changed.length} changed path(s) are inside what the server accepts for ${input.taskId}${verdict.amended.length ? `, including approved extra files: ${verdict.amended.join(", ")}` : ""}.`
      : `Not ready: ${[...problems, ...guards.filter((guard) => !guard.ok).map((guard) => `${guard.name} failed: ${guard.output.trim().split("\n").slice(-3).join(" | ")}`)].join("; ")}`,
  };
}
