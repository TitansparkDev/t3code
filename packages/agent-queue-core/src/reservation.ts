// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import type * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import { claimTask, releaseClaim } from "./claimService.ts";
import { environmentFingerprint, loadContract, matchesAny, resourcesNeededBy } from "./contract.ts";
import { parseStoredSpec } from "./verificationSpec.ts";
import { recordEvent } from "./eventStream.ts";
import {
  decideAfterFailure,
  holdTask,
  recordFailure,
  reviveHeldTasks,
  type FailureClass,
} from "./failures.ts";
import { syncIntegrationBranch } from "./integration.ts";
import { reconcileExpiredLeases } from "./leaseRecovery.ts";
import { getReadyTasks } from "./planGraph.ts";
import {
  assignabilityFindings,
  candidatePrefixes,
  preflightAssignment,
  titleTags,
  type ExpandedGuard,
  type PreflightFinding,
} from "./preflight.ts";
import { storedAmendments } from "./scopeAudit.ts";
import { ensureSlot, taskEnvironment } from "./taskEnvironment.ts";
import {
  alignToCandidate,
  branchExists,
  planWorktree,
  provisionWorktree,
  refreshUnworkedWorktree,
} from "./worktreeManager.ts";
import { getGitCommonDir } from "./repoManager.ts";

export interface RepairContext {
  readonly reason: string;
  readonly candidateCommit: string | null;
  /** The preserved commits (oldest first, `sha subject`) that must be merged, not redone. */
  readonly commits: ReadonlyArray<string>;
  /** Files the merge conflicted in. */
  readonly files: ReadonlyArray<string>;
}

export interface ReservedTask {
  readonly taskId: string;
  readonly title: string;
  readonly description: string | null;
  readonly verificationCommand: string | null;
  readonly claimToken: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly retryCount: number;
  readonly lastFailure: string | null;
  /** Set when the worker must repair a submitted candidate instead of implementing the task. */
  readonly repair: RepairContext | null;
  /** The task's declared scope, and everything it may touch (scope, generated, supporting, amended). */
  readonly scope: ReadonlyArray<string>;
  readonly allowedPaths: ReadonlyArray<string>;
  /** The repository's own commands the worker must run, with this task's values filled in. */
  readonly guards: ReadonlyArray<ExpandedGuard>;
  /** Isolated ports, database name, compose project and temp folder of this task. */
  readonly environment: Readonly<Record<string, string>>;
  /** Facts the worker should know: tools missing, corrections already made. */
  readonly notes: ReadonlyArray<string>;
  /** Commits already on the task's branch beyond the base (oldest first): kept work. */
  readonly existingCommits: ReadonlyArray<string>;
  /** Paths the contract declares generated; the integrator rebuilds them on conflict. */
  readonly generatedPaths: ReadonlyArray<string>;
  /** Exclusive resources this task holds for as long as its worker runs. */
  readonly resources: ReadonlyArray<string>;
}

export type ReserveOutcome =
  | { readonly kind: "reserved"; readonly task: ReservedTask }
  | {
      /** Nothing can start now. `ready` counts tasks that were ready but lost a claim race or scope. */
      readonly kind: "none";
      readonly skipped: ReadonlyArray<{ readonly taskId: string; readonly reason: string }>;
      /** Tasks held this pass because their assignment is not executable. */
      readonly held: ReadonlyArray<{ readonly taskId: string; readonly reason: string }>;
    };

export class WorktreeProvisionError extends Error {
  readonly taskId: string;
  constructor(taskId: string, cause: unknown) {
    super(
      `Could not prepare the worktree for ${taskId}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "WorktreeProvisionError";
    this.taskId = taskId;
  }
}

interface Row {
  id: string;
  title: string;
  description: string | null;
  status: string;
  dependencies: string | null;
  priority: number | null;
  verification_command: string | null;
  verification_spec: string | null;
  scope_patterns: string | null;
  retry_count: number;
  failure_reason: string | null;
}

const json = <A>(text: string | null | undefined, fallback: A): A => {
  try {
    return text ? (JSON.parse(text) as A) : fallback;
  } catch {
    return fallback;
  }
};

/** The branch an unfinished task already works on, if its name is still a branch. */
function existingBranchOf(
  db: NodeSqlite.DatabaseSync,
  repoRoot: string,
  taskId: string,
): string | undefined {
  const rows = db
    .prepare(`SELECT branch FROM task_claims WHERE task_id = ? ORDER BY id DESC LIMIT 5`)
    .all(taskId) as Array<{ branch: string }>;
  const candidate = db.prepare("SELECT candidate_branch FROM tasks WHERE id = ?").get(taskId) as
    | { candidate_branch: string | null }
    | undefined;
  for (const name of [candidate?.candidate_branch, ...rows.map((row) => row.branch)]) {
    if (name && branchExists(repoRoot, name)) return name;
  }
  return undefined;
}

function repairContext(
  repoRoot: string,
  baseBranch: string,
  reason: string,
  candidate: string | null,
): RepairContext {
  const commits = candidate
    ? NodeChildProcess.spawnSync(
        "git",
        ["log", "--reverse", "--format=%h %s", `refs/heads/${baseBranch}..${candidate}`],
        { cwd: repoRoot, encoding: "utf8" },
      )
        .stdout.split("\n")
        .filter(Boolean)
        .slice(0, 40)
    : [];
  const files = [...reason.matchAll(/conflicts in: (.+)$/gm)]
    .flatMap((match) => match[1]!.split(/,\s*/))
    .map((file) => file.trim())
    .filter(Boolean);
  return { reason, candidateCommit: candidate, commits, files };
}

/**
 * Reserves the next ready task of a plan for one worker, but only a task whose assignment
 * is executable. The claim (a compare-and-swap in one transaction) is taken BEFORE the
 * worktree is created, so two reservers can never both build a worktree for the same task.
 * Before any worker exists the assignment is checked against the repository's contract
 * (see preflight.ts): a correctable problem is corrected, an uncorrectable one holds the
 * task with its reason and the next ready task is tried. Only a worktree that cannot be
 * created at all raises an error.
 */
export async function reserveNextTask(
  db: NodeSqlite.DatabaseSync,
  options: {
    readonly repoRoot: string;
    readonly baseBranch: string;
    readonly planId: string;
    readonly workerSessionId: string;
    readonly workerPid?: number;
    readonly leaseSeconds?: number;
    readonly isOwnerAlive?: (pid: number, sessionId: string | null) => boolean;
    readonly gitCommonDir?: string;
    /** The plan's target branch; contract and guards are read from it first. */
    readonly targetBranch?: string;
  },
): Promise<ReserveOutcome> {
  reconcileExpiredLeases(
    db,
    options.isOwnerAlive ? { isOwnerAlive: options.isOwnerAlive } : undefined,
  );
  const gitCommonDir = options.gitCommonDir ?? getGitCommonDir(options.repoRoot);
  const refs = [...new Set([options.targetBranch ?? options.baseBranch, options.baseBranch])];
  if (options.targetBranch && options.targetBranch !== options.baseBranch) {
    // Keep the plan's branch current with the target when that merges cleanly, so a fix to a
    // guard or hook made on the target reaches the workers' base.
    await syncIntegrationBranch(
      options.repoRoot,
      gitCommonDir,
      options.targetBranch,
      options.baseBranch,
    ).catch(() => undefined);
  }
  const loaded = loadContract({ repoRoot: options.repoRoot, gitCommonDir, refs });
  const fingerprints = new Map<string, string>();
  const currentFingerprint = (failureClass?: FailureClass) => {
    const key = failureClass === "external" ? "external" : "all";
    let value = fingerprints.get(key);
    if (value === undefined) {
      value = environmentFingerprint({
        repoRoot: options.repoRoot,
        loaded,
        refs,
        ...(key === "external" ? { only: "capabilities" as const } : {}),
      });
      fingerprints.set(key, value);
    }
    return value;
  };
  reviveHeldTasks(db, options.planId, (failureClass) => currentFingerprint(failureClass));

  const rows = db
    .prepare(
      `SELECT id, title, description, status, dependencies, priority, verification_command,
              verification_spec, scope_patterns, retry_count, failure_reason
       FROM tasks WHERE plan_id = ? ORDER BY created_at ASC, rowid ASC`,
    )
    .all(options.planId) as unknown as Row[];

  const readyIds = getReadyTasks(
    rows.map((row) => ({
      id: row.id,
      status: row.status,
      dependencies: json<string[]>(row.dependencies, []),
      priority: row.priority ?? 100,
    })),
  );

  const skipped: Array<{ taskId: string; reason: string }> = [];
  const held: Array<{ taskId: string; reason: string }> = [];
  const resourcesOf = (
    _taskId: string,
    scope: ReadonlyArray<string>,
    specJson: string | null,
    command: string | null,
  ) =>
    resourcesNeededBy(
      loaded.contract,
      scope,
      parseStoredSpec(specJson, command).checks.map((check) => check.run),
    );
  /** How many running tasks hold each exclusive resource right now. */
  const holders = () => {
    const counts = new Map<string, number>();
    const running = db
      .prepare(
        `SELECT t.id, t.scope_patterns, t.verification_spec, t.verification_command FROM tasks t
         JOIN task_claims c ON c.task_id = t.id WHERE c.released_at IS NULL AND t.plan_id = ?`,
      )
      .all(options.planId) as Array<{
      id: string;
      scope_patterns: string | null;
      verification_spec: string | null;
      verification_command: string | null;
    }>;
    for (const task of running) {
      for (const name of resourcesOf(
        task.id,
        json<string[]>(task.scope_patterns, []),
        task.verification_spec,
        task.verification_command,
      )) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    return counts;
  };
  /** The name of a resource that has no room for this task, or null. */
  const busyResource = (scope: ReadonlyArray<string>, row: Row) => {
    const needed = resourcesOf(row.id, scope, row.verification_spec, row.verification_command);
    if (needed.length === 0) return null;
    const counts = holders();
    return (
      needed.find(
        (name) =>
          (counts.get(name) ?? 0) >=
          (loaded.contract.resources.find((r) => r.name === name)?.limit ?? 1),
      ) ?? null
    );
  };
  const toolCache = new Map<string, boolean>();
  const capabilityCache = new Map<string, boolean>();
  const prefix = candidatePrefixes(loaded, gitCommonDir, options.repoRoot)[0];

  /** Records why an assignment cannot run and parks the task (or its candidate). */
  const holdForFindings = (
    taskId: string,
    findings: ReadonlyArray<PreflightFinding>,
    repair: boolean,
  ) => {
    const errors = findings.filter((finding) => finding.level === "error");
    const failureClass = (errors[0]?.failureClass ?? "configuration") as FailureClass;
    const message = errors
      .map((finding) => finding.message)
      .join(" ")
      .slice(0, 1500);
    const head = repair
      ? (
          db.prepare("SELECT candidate_commit FROM tasks WHERE id = ?").get(taskId) as {
            candidate_commit: string | null;
          }
        ).candidate_commit
      : null;
    const recorded = recordFailure(db, taskId, {
      failureClass,
      message,
      headCommit: head,
      evidence: errors,
    });
    recordEvent(db, taskId, "task_preflight_failed", {
      class: failureClass,
      findings: errors.map((f) => f.code),
    });
    decideAfterFailure(failureClass, recorded);
    const print = currentFingerprint(failureClass);
    if (repair) {
      db.prepare(
        `UPDATE tasks SET integration_state = 'repair_needed', integration_error = ?, failure_class = ?,
           failure_signature = ?, unblock_fingerprint = ?, updated_at = ? WHERE id = ?`,
      ).run(message, failureClass, recorded.signature, print, new Date().toISOString(), taskId);
      recordEvent(db, taskId, "task_held", {
        class: failureClass,
        repair: true,
        message: message.slice(0, 300),
      });
    } else {
      holdTask(db, taskId, {
        failureClass,
        message,
        signature: recorded.signature,
        fingerprint: print,
      });
    }
    held.push({ taskId, reason: message });
  };

  const provisionFor = async (
    taskId: string,
    title: string,
    repair: RepairContext | null,
  ): Promise<{ worktreePath: string; branch: string }> => {
    const existing = existingBranchOf(db, options.repoRoot, taskId);
    const provisioned = await provisionWorktree(
      options.repoRoot,
      taskId,
      options.baseBranch,
      title,
      {
        ...(prefix ? { prefix } : {}),
        ...(existing ? { branch: existing } : {}),
        ignore: loaded.contract.ignoredPaths,
      },
    );
    if (!repair) refreshUnworkedWorktree(provisioned.worktreePath, options.baseBranch);
    if (repair?.candidateCommit) {
      const aligned = alignToCandidate(
        provisioned.worktreePath,
        options.repoRoot,
        provisioned.branch,
        repair.candidateCommit,
      );
      if (!aligned.ok)
        throw new Error(`The preserved candidate cannot be restored: ${aligned.detail}`);
    }
    return provisioned;
  };

  const finish = (
    claimToken: string,
    row: Pick<
      Row,
      | "id"
      | "title"
      | "description"
      | "verification_command"
      | "retry_count"
      | "failure_reason"
      | "verification_spec"
      | "dependencies"
    >,
    scope: string[],
    provisioned: { worktreePath: string; branch: string },
    repair: RepairContext | null,
  ): ReservedTask | null => {
    const slot = ensureSlot(db, row.id);
    const environment = taskEnvironment({
      taskId: row.id,
      slot,
      gitCommonDir,
      contract: loaded.contract,
    });
    const amendments = storedAmendments(db, row.id);
    const allowed = [
      ...scope,
      ...loaded.contract.generated.flatMap((rule) => rule.paths),
      ...loaded.contract.supportingPaths,
      ...amendments,
    ];
    const result = preflightAssignment({
      db,
      repoRoot: options.repoRoot,
      gitCommonDir,
      baseRef: options.baseBranch,
      loaded,
      task: {
        id: row.id,
        title: row.title,
        scope,
        dependencies: json<string[]>(row.dependencies, []),
        verification_spec: row.verification_spec,
        verification_command: row.verification_command,
      },
      worktreePath: provisioned.worktreePath,
      branch: provisioned.branch,
      claimToken,
      allowedPaths: allowed,
      env: environment.variables,
      toolCache,
    });
    if (!result.ok) {
      releaseClaim(db, { ownerToken: claimToken, finalStatus: "pending", failureReason: null });
      holdForFindings(row.id, result.findings, repair !== null);
      return null;
    }
    if (result.branch !== provisioned.branch || result.repairs.length > 0) {
      db.prepare("UPDATE task_claims SET worktree_path = ?, branch = ? WHERE owner_token = ?").run(
        provisioned.worktreePath,
        result.branch,
        claimToken,
      );
      if (result.branch !== provisioned.branch) {
        db.prepare(
          "UPDATE tasks SET candidate_branch = ? WHERE id = ? AND candidate_branch = ?",
        ).run(result.branch, row.id, provisioned.branch);
      }
      for (const repairNote of result.repairs)
        recordEvent(db, row.id, "task_preflight_repaired", { repair: repairNote });
    }
    const resources = resourcesOf(row.id, scope, row.verification_spec, row.verification_command);
    const notes = [
      ...result.repairs,
      ...(resources.length > 0
        ? [
            `You hold the exclusive resource(s) ${resources.join(", ")} while you work: no other worker runs tests that need them at the same time.`,
          ]
        : []),
      ...result.optionalToolsMissing.map(
        (tool) =>
          `The optional tool "${tool}" is not available; skip the checks that need it and say so.`,
      ),
    ];
    return {
      taskId: row.id,
      title: row.title,
      description: row.description,
      verificationCommand: row.verification_command,
      claimToken,
      worktreePath: provisioned.worktreePath,
      branch: result.branch,
      baseBranch: options.baseBranch,
      retryCount: row.retry_count,
      lastFailure: repair ? repair.reason : row.failure_reason,
      repair,
      scope,
      allowedPaths: allowed,
      guards: result.guards,
      environment: environment.variables,
      notes,
      existingCommits: NodeChildProcess.spawnSync(
        "git",
        [
          "log",
          "--reverse",
          "--format=%h %s",
          `refs/heads/${options.baseBranch}..refs/heads/${result.branch}`,
        ],
        { cwd: options.repoRoot, encoding: "utf8" },
      )
        .stdout.split("\n")
        .filter(Boolean)
        .slice(0, 30),
      generatedPaths: loaded.contract.generated.flatMap((rule) => rule.paths),
      resources,
    };
  };

  // Submitted work that failed to merge is repaired before any new task starts.
  const repairs = db
    .prepare(
      `SELECT id, title, description, verification_command, verification_spec, scope_patterns, dependencies,
              retry_count, integration_error, candidate_commit, failure_reason
       FROM tasks WHERE plan_id = ? AND status = 'verifying' AND integration_state = 'conflict'
       ORDER BY integration_updated_at, rowid`,
    )
    .all(options.planId) as unknown as Array<
    Row & { integration_error: string | null; candidate_commit: string | null }
  >;
  for (const repair of repairs) {
    const busyRepair = busyResource(json<string[]>(repair.scope_patterns, []), repair);
    if (busyRepair) {
      skipped.push({ taskId: repair.id, reason: `RESOURCE_BUSY (${busyRepair})` });
      continue;
    }
    const planned = planWorktree(options.repoRoot, repair.id, repair.title, prefix);
    const claim = claimTask(db, {
      taskId: repair.id,
      workerPid: options.workerPid ?? process.pid,
      workerSessionId: options.workerSessionId,
      worktreePath: planned.worktreePath,
      branch: planned.branch,
      leaseSeconds: options.leaseSeconds ?? 300,
      repair: true,
    });
    if (!claim.success) {
      skipped.push({ taskId: repair.id, reason: claim.reason });
      continue;
    }
    const context = repairContext(
      options.repoRoot,
      options.baseBranch,
      repair.integration_error ?? "The candidate could not be merged.",
      repair.candidate_commit,
    );
    try {
      const provisioned = await provisionFor(repair.id, repair.title, context);
      db.prepare("UPDATE task_claims SET worktree_path = ?, branch = ? WHERE owner_token = ?").run(
        provisioned.worktreePath,
        provisioned.branch,
        claim.claim.ownerToken,
      );
      const task = finish(
        claim.claim.ownerToken,
        repair,
        json<string[]>(repair.scope_patterns, []),
        provisioned,
        context,
      );
      if (task) return { kind: "reserved", task };
    } catch (error) {
      releaseClaim(db, {
        ownerToken: claim.claim.ownerToken,
        finalStatus: "pending",
        failureReason: error instanceof Error ? error.message : String(error),
      });
      throw new WorktreeProvisionError(repair.id, error);
    }
  }

  for (const taskId of readyIds) {
    const row = rows.find((candidate) => candidate.id === taskId)!;
    const scope = json<string[]>(row.scope_patterns, []);
    // A task this environment cannot do is held without a claim, a worktree or a worker.
    const unassignable = assignabilityFindings({
      loaded,
      repoRoot: options.repoRoot,
      title: row.title,
      capabilityCache,
    });
    if (unassignable.length > 0) {
      holdForFindings(taskId, unassignable, false);
      continue;
    }
    const busy = busyResource(scope, row);
    if (busy) {
      skipped.push({ taskId, reason: `RESOURCE_BUSY (${busy})` });
      continue;
    }
    const planned = planWorktree(options.repoRoot, taskId, row.title, prefix);
    const claim = claimTask(db, {
      taskId,
      workerPid: options.workerPid ?? process.pid,
      workerSessionId: options.workerSessionId,
      worktreePath: planned.worktreePath,
      branch: planned.branch,
      leaseSeconds: options.leaseSeconds ?? 300,
    });
    if (!claim.success) {
      skipped.push({ taskId, reason: claim.reason });
      continue;
    }
    try {
      const provisioned = await provisionFor(taskId, row.title, null);
      if (
        provisioned.worktreePath !== planned.worktreePath ||
        provisioned.branch !== planned.branch
      ) {
        db.prepare(
          "UPDATE task_claims SET worktree_path = ?, branch = ? WHERE owner_token = ?",
        ).run(provisioned.worktreePath, provisioned.branch, claim.claim.ownerToken);
      }
      const task = finish(claim.claim.ownerToken, row, scope, provisioned, null);
      if (task) return { kind: "reserved", task };
    } catch (error) {
      releaseClaim(db, {
        ownerToken: claim.claim.ownerToken,
        finalStatus: "pending",
        failureReason: error instanceof Error ? error.message : String(error),
      });
      recordEvent(db, taskId, "task_provision_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new WorktreeProvisionError(taskId, error);
    }
  }
  return { kind: "none", skipped, held };
}

export { matchesAny, titleTags };
