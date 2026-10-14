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
import { startRepairMerge, syncIntegrationBranch, type RepairMerge } from "./integration.ts";
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
import { pendingWaits, storedAmendments } from "./scopeAudit.ts";
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
  /**
   * What the server already did in the worktree: `conflicted` = a merge of the integration branch is
   * in progress with `files` unresolved; `merged` = it is merged (cleanly, or by rule) and only the
   * reason's failing check remains; `none` = no merge was needed or possible.
   */
  readonly mergeState: "conflicted" | "merged" | "none";
  /** Files the server settled by rule (generated, union-merged). */
  readonly settledByRule: ReadonlyArray<string>;
  /** The branch that was merged in. */
  readonly integrationBranch: string;
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
  /**
   * Set when the task was parked for files another worker held and those are free now: the other
   * worker's merged work was brought into the task's worktree (any real conflict left in progress).
   */
  readonly waited: {
    readonly note: string;
    readonly mergeState: "conflicted" | "merged" | "none";
    readonly files: ReadonlyArray<string>;
    readonly settledByRule: ReadonlyArray<string>;
    readonly integrationBranch: string;
  } | null;
  /** The conversation accountable for this task so far (its owner), if one was recorded. */
  readonly ownerRef: string | null;
  /** How many times the owner has been resumed on this task. */
  readonly ownerTurns: number;
  /** Shared resources this task's checks will need, held only while a command runs (see resourceBroker.ts). */
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

/** How long a task whose worktree could not be made waits before it is tried again. */
const PROVISION_RETRY_MS = 30_000;

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
  wait_reason?: string | null;
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
  return {
    reason,
    candidateCommit: candidate,
    commits,
    files,
    mergeState: "none",
    settledByRule: [],
    integrationBranch: baseBranch,
  };
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
    /** Tasks to leave alone this time (their owner is temporarily unavailable and will be waited for). */
    readonly excludeTaskIds?: ReadonlySet<string>;
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
              verification_spec, scope_patterns, retry_count, failure_reason, wait_reason
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
  ).filter((id) => {
    // A task parked for a file another running task holds starts again by itself once it is free.
    return pendingWaits(db, id).length === 0;
  });

  const skipped: Array<{ taskId: string; reason: string }> = [];
  const held: Array<{ taskId: string; reason: string }> = [];
  const provisionCoolingDown = (taskId: string) => {
    const failedAt = (
      db
        .prepare(
          "SELECT created_at FROM task_events WHERE task_id = ? AND event_type = 'task_provision_failed' ORDER BY id DESC LIMIT 1",
        )
        .get(taskId) as { created_at: string } | undefined
    )?.created_at;
    return failedAt !== undefined && Date.now() - Date.parse(failedAt) < PROVISION_RETRY_MS;
  };
  const provisionFailed = (taskId: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    recordEvent(db, taskId, "task_provision_failed", { error: message });
    skipped.push({ taskId, reason: `WORKTREE_FAILED (${message.slice(0, 200)})` });
  };
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
    waited: ReservedTask["waited"] = null,
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
            `Your checks use shared machine resources (${resources.join(", ")}). Run them with \`agentq run -- <command>\`: it waits in the machine's fair queue, holds the resource only while the command runs, and never makes your task fail because another worker is using it.`,
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
      waited,
      ownerRef: (
        db.prepare("SELECT owner_ref FROM tasks WHERE id = ?").get(row.id) as {
          owner_ref: string | null;
        }
      ).owner_ref,
      ownerTurns: (
        db.prepare("SELECT owner_turns FROM tasks WHERE id = ?").get(row.id) as {
          owner_turns: number;
        }
      ).owner_turns,
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
  const integrationTip = NodeChildProcess.spawnSync(
    "git",
    ["rev-parse", `refs/heads/${options.baseBranch}`],
    { cwd: options.repoRoot, encoding: "utf8" },
  ).stdout.trim();
  for (const repair of repairs) {
    if (options.excludeTaskIds?.has(repair.id)) continue;
    if (provisionCoolingDown(repair.id)) {
      skipped.push({
        taskId: repair.id,
        reason: "WORKTREE_FAILED (its worktree could not be made; retrying)",
      });
      continue;
    }
    // The integration branch moved since this failed (a follow-up landed, the other side of the
    // conflict changed): the same candidate may merge now. Try that first; it costs no model turn.
    const failedAt = (
      db.prepare("SELECT integration_tip FROM tasks WHERE id = ?").get(repair.id) as {
        integration_tip: string | null;
      }
    ).integration_tip;
    if (failedAt && integrationTip && failedAt !== integrationTip) {
      db.prepare(
        "UPDATE tasks SET integration_state = 'pending', integration_tip = NULL, integration_updated_at = ? WHERE id = ? AND integration_state = 'conflict'",
      ).run(new Date().toISOString(), repair.id);
      recordEvent(db, repair.id, "task_integration_retried_after_change", {
        from: failedAt.slice(0, 9),
        to: integrationTip.slice(0, 9),
      });
      skipped.push({ taskId: repair.id, reason: "INTEGRATION_RETRY" });
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
    let context = repairContext(
      options.repoRoot,
      options.baseBranch,
      repair.integration_error ?? "The candidate could not be merged.",
      repair.candidate_commit,
    );
    try {
      const provisioned = await provisionFor(repair.id, repair.title, context);
      // The server does the git work: merge the integration branch into the task's worktree, settle
      // generated and union-merged files by rule, and leave only the real conflict for the owner.
      const merge: RepairMerge = startRepairMerge({
        worktreePath: provisioned.worktreePath,
        repoRoot: options.repoRoot,
        gitCommonDir,
        integrationBranch: options.baseBranch,
        baseBranch: options.targetBranch ?? options.baseBranch,
      });
      if (merge.state === "up-to-date") {
        // The candidate already contains the integration branch: it only needs to merge again.
        releaseClaim(db, {
          ownerToken: claim.claim.ownerToken,
          finalStatus: "pending",
          failureReason: null,
        });
        db.prepare(
          "UPDATE tasks SET status = 'verifying', integration_state = 'pending', integration_updated_at = ? WHERE id = ?",
        ).run(new Date().toISOString(), repair.id);
        recordEvent(db, repair.id, "task_repair_not_needed", { detail: merge.detail });
        continue;
      }
      context = {
        ...context,
        files: merge.files.length > 0 ? [...merge.files] : context.files,
        mergeState:
          merge.state === "conflicted"
            ? "conflicted"
            : merge.state === "merged"
              ? "merged"
              : "none",
        settledByRule: merge.settledByRule,
        commits: context.commits,
      };
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
      // A repair with a broken worktree must not block independent tasks behind it either.
      provisionFailed(repair.id, error);
      continue;
    }
  }

  for (const taskId of readyIds) {
    if (options.excludeTaskIds?.has(taskId)) continue;
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
    // A task whose worktree could not be made a moment ago is not retried on every pass.
    if (provisionCoolingDown(taskId)) {
      skipped.push({
        taskId,
        reason: "WORKTREE_FAILED (its worktree could not be made; retrying)",
      });
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
      // Parked for files another worker held, and they are free now: bring that worker's merged
      // work into this worktree so the task continues on top of it.
      let waited: ReservedTask["waited"] = null;
      if (row.wait_reason) {
        const merge = startRepairMerge({
          worktreePath: provisioned.worktreePath,
          repoRoot: options.repoRoot,
          gitCommonDir,
          integrationBranch: options.baseBranch,
          baseBranch: options.targetBranch ?? options.baseBranch,
        });
        waited = {
          note: row.wait_reason,
          mergeState:
            merge.state === "conflicted"
              ? "conflicted"
              : merge.state === "merged"
                ? "merged"
                : "none",
          files: merge.files,
          settledByRule: merge.settledByRule,
          integrationBranch: options.baseBranch,
        };
        db.prepare("UPDATE tasks SET waits_for = NULL, wait_reason = NULL WHERE id = ?").run(
          taskId,
        );
      }
      const task = finish(claim.claim.ownerToken, row, scope, provisioned, null, waited);
      if (task) return { kind: "reserved", task };
    } catch (error) {
      releaseClaim(db, {
        ownerToken: claim.claim.ownerToken,
        finalStatus: "pending",
        failureReason: error instanceof Error ? error.message : String(error),
      });
      // One task whose worktree cannot be made must not stop the independent tasks behind it. It is
      // reported as skipped with the reason and tried again shortly.
      provisionFailed(taskId, error);
      continue;
    }
  }
  return { kind: "none", skipped, held };
}

export { matchesAny, titleTags };
