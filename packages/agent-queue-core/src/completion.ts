// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * The only definition of "this plan is finished". A worker's words, a ticked checkbox or
 * one successful merge never satisfy it; only the queue's records checked against Git do.
 *
 * @module completion
 */
import type * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import { acquireLandingLock, prepareStagingWorktree } from "./integration.ts";
import { runVerification } from "./verifier.ts";

export interface CompletionReport {
  readonly complete: boolean;
  /** Plain-language reason it is not complete yet, or null. */
  readonly reason: string | null;
  readonly total: number;
  readonly completed: number;
  /** Tasks that are not completed yet. */
  readonly outstanding: ReadonlyArray<string>;
  /** Tasks recorded as completed that Git does not show on the base branch. */
  readonly unverified: ReadonlyArray<string>;
  /**
   * Completed tasks that were merged without any executable check or exemption, or whose
   * latest recorded audit failed. Never counted as passed; the plan is not complete while
   * any remain.
   */
  readonly unchecked: ReadonlyArray<string>;
  /** Submitted candidates still waiting to merge or be repaired. */
  readonly integrationPending: ReadonlyArray<string>;
  /** Tasks someone still holds a claim on. */
  readonly activeClaims: ReadonlyArray<string>;
  readonly finalCheck: "none" | "passed" | "failed" | "moved";
  readonly baseHead: string | null;
  /** Where publishing the integration branch to the target branch stands. */
  readonly publication: "none" | "pending" | "blocked" | "published";
  readonly publicationNote: string | null;
}

function gitOk(cwd: string, args: ReadonlyArray<string>): boolean {
  try {
    NodeChildProcess.execFileSync("git", [...args], { cwd, stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function gitOut(cwd: string, args: ReadonlyArray<string>): string | null {
  try {
    return NodeChildProcess.execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Reads the plan's state in one consistent snapshot and checks it against Git. With
 * `runFinalCheck`, also runs the plan's `Final verification` command on a clean checkout
 * of the base branch (once per base commit), and refuses completion if the base branch
 * moved while it ran.
 */
export async function verifyPlanCompletion(
  db: NodeSqlite.DatabaseSync,
  input: {
    readonly repoRoot: string;
    readonly gitCommonDir: string;
    readonly baseBranch: string;
    readonly integrationBranch: string;
    readonly planId: string;
    readonly runFinalCheck: boolean;
  },
): Promise<CompletionReport> {
  const baseHead = gitOut(input.repoRoot, ["rev-parse", `refs/heads/${input.baseBranch}`]);
  const goalHead = gitOut(input.repoRoot, ["rev-parse", `refs/heads/${input.integrationBranch}`]);

  db.exec("BEGIN;");
  let tasks: Array<{
    id: string;
    status: string;
    integration_state: string | null;
    receipt_json: string | null;
  }>;
  let audits: Map<string, string>;
  let claims: Array<{ task_id: string }>;
  let landings: Map<string, string>;
  let imported: Set<string>;
  let plan:
    | {
        final_verification: string | null;
        final_receipt_json: string | null;
        publication_state: string | null;
        publication_note: string | null;
      }
    | undefined;
  try {
    tasks = db
      .prepare("SELECT id, status, integration_state, receipt_json FROM tasks WHERE plan_id = ?")
      .all(input.planId) as typeof tasks;
    // The newest recorded audit of a task decides: an audit is a real run of its checks later on.
    audits = new Map(
      (
        db
          .prepare(
            `SELECT e.task_id, e.payload_json FROM task_events e JOIN tasks t ON t.id = e.task_id
             WHERE t.plan_id = ? AND e.event_type = 'task_audited' ORDER BY e.id`,
          )
          .all(input.planId) as Array<{ task_id: string; payload_json: string }>
      ).map((row) => [row.task_id, row.payload_json]),
    );
    claims = db
      .prepare(
        `SELECT c.task_id FROM task_claims c JOIN tasks t ON t.id = c.task_id
         WHERE c.released_at IS NULL AND t.plan_id = ?`,
      )
      .all(input.planId) as typeof claims;
    landings = new Map(
      (
        db
          .prepare(
            `SELECT l.task_id, l.commit_hash FROM landing_queue l JOIN tasks t ON t.id = l.task_id
             WHERE t.plan_id = ? AND l.status = 'landed' AND l.commit_hash IS NOT NULL ORDER BY l.id`,
          )
          .all(input.planId) as Array<{ task_id: string; commit_hash: string }>
      ).map((row) => [row.task_id, row.commit_hash]),
    );
    imported = new Set(
      (
        db
          .prepare(
            `SELECT e.task_id FROM task_events e JOIN tasks t ON t.id = e.task_id
             WHERE t.plan_id = ? AND ((e.event_type = 'task_imported' AND e.payload_json LIKE '%"checked":true%')
               OR (e.event_type = 'task_synced' AND e.payload_json LIKE '%plan-checkbox%')
               OR e.event_type = 'task_followup_resolved')`,
          )
          .all(input.planId) as Array<{ task_id: string }>
      ).map((row) => row.task_id),
    );
    plan = db
      .prepare(
        "SELECT final_verification, final_receipt_json, publication_state, publication_note FROM plans WHERE id = ?",
      )
      .get(input.planId) as typeof plan;
  } finally {
    db.exec("COMMIT;");
  }

  const completedTasks = tasks.filter((task) => task.status === "completed");
  const outstanding = tasks.filter((task) => task.status !== "completed").map((task) => task.id);
  const integrationPending = tasks
    .filter((task) => task.integration_state !== null)
    .map((task) => task.id);
  const unverified = completedTasks
    .filter((task) => {
      if (imported.has(task.id)) return false;
      const commit = landings.get(task.id);
      return (
        !commit ||
        !goalHead ||
        !gitOk(input.repoRoot, ["merge-base", "--is-ancestor", commit, goalHead])
      );
    })
    .map((task) => task.id);
  const activeClaims = [...new Set(claims.map((claim) => claim.task_id))];
  const receiptState = (json: string | null): string | null => {
    // A merged task with no receipt at all has nothing showing its checks ever ran.
    if (!json) return "unverified";
    try {
      const receipt = JSON.parse(json) as { state?: string; command?: string };
      // Receipts from before structured checks: an empty command was never a check.
      return receipt.state ?? (receipt.command ? "passed" : "unverified");
    } catch {
      return "unverified";
    }
  };
  const unchecked = completedTasks
    .filter((task) => {
      const audit = audits.get(task.id);
      if (audit) {
        const state = (JSON.parse(audit) as { state?: string }).state;
        return state !== "passed" && state !== "exempt";
      }
      if (imported.has(task.id)) return false;
      const state = receiptState(task.receipt_json);
      return (
        state === "unverified" ||
        state === "failed" ||
        state === "timed-out" ||
        state === "baseline-failed"
      );
    })
    .map((task) => task.id);

  const base: Omit<
    CompletionReport,
    "complete" | "reason" | "finalCheck" | "publication" | "publicationNote"
  > = {
    total: tasks.length,
    completed: completedTasks.length,
    outstanding,
    unverified,
    unchecked,
    integrationPending,
    activeClaims,
    baseHead,
  };
  const publicationState = (plan?.publication_state ?? "none") as CompletionReport["publication"];
  const publicationNote = plan?.publication_note ?? null;
  const notYet = (reason: string, finalCheck: CompletionReport["finalCheck"] = "none") => ({
    ...base,
    complete: false,
    reason,
    finalCheck,
    publication: publicationState,
    publicationNote,
  });

  if (tasks.length === 0) return notYet("The plan has no tasks in the queue.");
  if (outstanding.length > 0)
    return notYet(
      `${outstanding.length} task(s) are not completed: ${outstanding.slice(0, 5).join(", ")}.`,
    );
  if (integrationPending.length > 0)
    return notYet(`Work is still waiting to merge: ${integrationPending.join(", ")}.`);
  if (activeClaims.length > 0) return notYet(`Still being worked on: ${activeClaims.join(", ")}.`);
  if (unverified.length > 0) {
    return notYet(
      `Recorded as done but not found on ${input.integrationBranch}: ${unverified.join(", ")}.`,
    );
  }
  if (unchecked.length > 0) {
    return notYet(
      `${unchecked.length} merged task(s) have no passing executable check or recorded exemption: ${unchecked.slice(0, 8).join(", ")}. Define checks (Checks:) or an exemption (Verify: none — reason) and audit them.`,
    );
  }
  if (!baseHead || !goalHead) {
    return notYet(`Branch ${input.baseBranch} or ${input.integrationBranch} was not found.`);
  }
  // Integrated is not finished: the target branch must actually contain the result.
  if (!gitOk(input.repoRoot, ["merge-base", "--is-ancestor", goalHead, baseHead])) {
    return notYet(
      `The plan is integrated on ${input.integrationBranch} but not yet published to ${input.baseBranch}${publicationNote ? `: ${publicationNote}` : "."}`,
    );
  }

  const finalCommand = plan?.final_verification?.trim();
  const done = (finalCheck: CompletionReport["finalCheck"]): CompletionReport => ({
    ...base,
    complete: true,
    reason: null,
    finalCheck,
    publication: "published",
    publicationNote,
  });
  if (!finalCommand) return done("none");

  const previous = plan?.final_receipt_json
    ? (JSON.parse(plan.final_receipt_json) as { baseHead?: string; passed?: boolean })
    : undefined;
  let passed = previous?.baseHead === baseHead && previous.passed === true;
  if (!passed) {
    if (!input.runFinalCheck)
      return notYet("The plan's final verification has not run on the current base yet.");
    // The staging worktree is shared with integration, so hold the landing lock while using it.
    const release = await acquireLandingLock(input.gitCommonDir);
    let receipt;
    try {
      const staging = prepareStagingWorktree(input.repoRoot, baseHead);
      receipt = await runVerification("plan", staging, finalCommand, 900_000);
    } finally {
      release();
    }
    passed = receipt.passed;
    db.prepare("UPDATE plans SET final_receipt_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify({
        baseHead,
        passed,
        exitCode: receipt.exitCode,
        command: finalCommand,
        verifiedAt: receipt.verifiedAt,
        tail: (receipt.stderrSnippet || receipt.stdoutSnippet).slice(-600),
      }),
      new Date().toISOString(),
      input.planId,
    );
    if (!passed) {
      return notYet(
        `The plan's final verification failed (exit ${receipt.exitCode}): ${(receipt.stderrSnippet || receipt.stdoutSnippet).slice(-300)}`,
        "failed",
      );
    }
    const after = gitOut(input.repoRoot, ["rev-parse", `refs/heads/${input.baseBranch}`]);
    if (after !== baseHead)
      return notYet(`${input.baseBranch} moved during the final check; checking again.`, "moved");
  }
  return done("passed");
}
