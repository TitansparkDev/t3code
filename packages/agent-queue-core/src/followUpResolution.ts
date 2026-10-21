// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * A repair follow-up whose problem is already gone.
 *
 * A follow-up exists because a check failed. By the time its worker looks, the failure may be
 * gone for reasons no commit can express: it was the machine (since fixed), it was flaky, or
 * something that landed in between fixed it. Demanding a commit then is demanding a fake one.
 * Nothing the worker says decides this: the server runs the follow-up's own stored checks on the
 * current integration tip, in the same private worktree and environment integration uses, and
 * only a pass it observed itself resolves the follow-up. A failure that is the machine's is held
 * for the machine; a failure that persists is a real defect and goes back to the worker.
 *
 * @module followUpResolution
 */
import type * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { prepareVerificationDependencies } from "./baseline.ts";
import { renewLease } from "./claimService.ts";
import { loadContract, resourcesNeededBy } from "./contract.ts";
import { recordEvent } from "./eventStream.ts";
import { ResourceWaitError } from "./resourceRunner.ts";
import { ensureSlot, taskEnvironment } from "./taskEnvironment.ts";
import { environmentFailureOf } from "./toolchain.ts";
import { parseStoredSpec, runSpec, type SpecResult } from "./verificationSpec.ts";

export type UnchangedFollowUpOutcome =
  | { readonly kind: "not-applicable" }
  | { readonly kind: "claim-lost" }
  | {
      readonly kind: "resolved";
      readonly tip: string;
      readonly receipt: SpecResult;
      /** It failed at first and passed on a rerun: resolved, and said so. */
      readonly flaky: boolean;
      readonly parentTaskId: string;
      /** The follow-up's parent was waiting on it and is set to merge again. */
      readonly parentRetried: boolean;
    }
  | { readonly kind: "environment"; readonly message: string; readonly receipt: SpecResult }
  | { readonly kind: "still-failing"; readonly message: string; readonly receipt: SpecResult }
  | { readonly kind: "resource-wait"; readonly message: string };

function git(cwd: string, args: ReadonlyArray<string>) {
  const result = NodeChildProcess.spawnSync("git", [...args], { cwd, encoding: "utf8" });
  return { code: result.status ?? 1, stderr: (result.stderr ?? "").trim() };
}

const outputOf = (receipt: SpecResult) =>
  receipt.checks
    .filter((check) => !check.passed)
    .map((check) => `${check.stdoutTail}\n${check.stderrTail}`)
    .join("\n");

/** The parent task and kind of a follow-up, or null when the task is not a repair follow-up. */
export function repairFollowUpOf(
  db: NodeSqlite.DatabaseSync,
  taskId: string,
): { readonly parentTaskId: string } | null {
  const created = db
    .prepare(
      "SELECT payload_json FROM task_events WHERE task_id = ? AND event_type = 'task_followup_created' ORDER BY id LIMIT 1",
    )
    .get(taskId) as { payload_json: string } | undefined;
  if (!created) return null;
  try {
    const payload = JSON.parse(created.payload_json) as { kind?: string; parentTaskId?: string };
    return payload.kind === "repair" && typeof payload.parentTaskId === "string"
      ? { parentTaskId: payload.parentTaskId }
      : null;
  } catch {
    return null;
  }
}

/**
 * The worker of a repair follow-up finished with no commit. Decide by running the follow-up's
 * checks on the integration tip (up to `attempts` times, so one flaky failure is not mistaken
 * for a defect and one flaky pass is recorded as such).
 */
export async function settleUnchangedFollowUp(
  db: NodeSqlite.DatabaseSync,
  input: {
    readonly taskId: string;
    readonly claimToken: string;
    readonly repoRoot: string;
    readonly gitCommonDir: string;
    readonly baseBranch: string;
    readonly targetBranch?: string | undefined;
    /** The follow-up worker's worktree: its installed dependencies are linked into the probe. */
    readonly worktreePath?: string | undefined;
    readonly attempts?: number;
  },
): Promise<UnchangedFollowUpOutcome> {
  const ownsClaim = () =>
    db
      .prepare(
        "SELECT id FROM task_claims WHERE owner_token = ? AND task_id = ? AND released_at IS NULL",
      )
      .get(input.claimToken, input.taskId) as { id: number } | undefined;
  if (!ownsClaim()) return { kind: "claim-lost" };
  const followUp = repairFollowUpOf(db, input.taskId);
  if (!followUp) return { kind: "not-applicable" };
  const stored = db
    .prepare(
      "SELECT verification_command, verification_spec, scope_patterns FROM tasks WHERE id = ?",
    )
    .get(input.taskId) as
    | {
        verification_command: string | null;
        verification_spec: string | null;
        scope_patterns: string | null;
      }
    | undefined;
  if (!stored) return { kind: "not-applicable" };
  const spec = parseStoredSpec(stored.verification_spec, stored.verification_command);
  // Without an executable check the server has nothing of its own to observe.
  if (spec.source === "exempt" || spec.checks.length === 0) return { kind: "not-applicable" };
  const tip = NodeChildProcess.spawnSync("git", ["rev-parse", `refs/heads/${input.baseBranch}`], {
    cwd: input.repoRoot,
    encoding: "utf8",
  }).stdout.trim();
  if (!tip) return { kind: "not-applicable" };

  const gitDir = NodePath.resolve(input.repoRoot, input.gitCommonDir);
  const contract = loadContract({
    repoRoot: input.repoRoot,
    gitCommonDir: gitDir,
    refs: [...new Set([input.targetBranch ?? input.baseBranch, input.baseBranch])],
  }).contract;
  const slot = ensureSlot(db, input.taskId);
  const scope = JSON.parse(stored.scope_patterns || "[]") as string[];
  const options = {
    env: taskEnvironment({ taskId: input.taskId, slot, gitCommonDir: gitDir, contract }).variables,
    lockDir: NodePath.join(gitDir, "agentqueue", "locks"),
    extraRequires: resourcesNeededBy(
      contract,
      scope,
      spec.checks.map((check) => check.run),
    ),
  };

  const attempts = Math.max(1, input.attempts ?? 2);
  let receipt: SpecResult | undefined;
  let flaky = false;
  // A private worktree of its own, not the shared staging one: a long check must not hold the
  // landing lock that every other task's merge needs.
  const probeRoot = NodePath.join(input.repoRoot, ".worktrees");
  NodeFS.mkdirSync(probeRoot, { recursive: true });
  // Each verification owns only its own directory, including concurrent processes and retries.
  const probe = NodeFS.mkdtempSync(
    NodePath.join(
      probeRoot,
      `agentqueue-followup-${input.taskId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-`,
    ),
  );
  const added = git(input.repoRoot, ["worktree", "add", "--detach", probe, tip]);
  if (added.code !== 0) {
    NodeFS.rmdirSync(probe);
    return {
      kind: "resource-wait",
      message: `Could not check out ${tip.slice(0, 9)}: ${added.stderr}`,
    };
  }
  renewLease(db, input.claimToken, 1800);
  const renewal = setInterval(() => {
    try {
      renewLease(db, input.claimToken, 1800);
    } catch {
      /* A database outage cannot authorize completing the task; ownership is rechecked below. */
    }
  }, 60_000);
  renewal.unref();
  try {
    const preparation = prepareVerificationDependencies({
      stage: "follow-up",
      sourceRoot: input.worktreePath ?? input.repoRoot,
      probeRoot: probe,
    });
    // Nothing ran, so nothing failed: the follow-up waits for the environment, with no repair.
    if (preparation) return { kind: "resource-wait", message: preparation };
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        receipt = await runSpec(input.taskId, probe, spec, undefined, options);
        if (!ownsClaim()) return { kind: "claim-lost" };
      } catch (error) {
        if (!(error instanceof ResourceWaitError)) throw error;
        return { kind: "resource-wait", message: error.message };
      }
      if (receipt.state === "passed") {
        flaky = attempt > 1;
        break;
      }
      // The machine is at fault: another run cannot differ, and no worker can fix it.
      const machine = environmentFailureOf(outputOf(receipt));
      if (machine) {
        return {
          kind: "environment",
          message: `The check cannot run on this machine: ${machine}`,
          receipt,
        };
      }
      // A check that ran out of time is not retried here: it would only repeat the wait.
      if (receipt.state === "timed-out") break;
    }
  } finally {
    clearInterval(renewal);
    git(input.repoRoot, ["worktree", "remove", "--force", probe]);
  }
  if (!receipt || receipt.state !== "passed") {
    return {
      kind: "still-failing",
      message: `The check still fails on ${input.baseBranch} at ${tip.slice(0, 9)}, and your branch has no commit that fixes it: ${(receipt?.summary ?? "it did not run").slice(-700)}`,
      receipt: receipt ?? {
        state: "unverified",
        source: spec.source,
        commit: tip,
        checks: [],
        exemptReason: null,
        rejected: [],
        verifiedAt: new Date().toISOString(),
        summary: "The check did not run.",
      },
    };
  }

  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE;");
  try {
    const active = ownsClaim();
    if (!active) {
      db.exec("ROLLBACK;");
      return { kind: "claim-lost" };
    }
    const currentTip = NodeChildProcess.spawnSync(
      "git",
      ["rev-parse", `refs/heads/${input.baseBranch}`],
      { cwd: input.repoRoot, encoding: "utf8" },
    ).stdout.trim();
    if (currentTip !== tip) {
      db.exec("ROLLBACK;");
      return {
        kind: "resource-wait",
        message:
          "The integration branch moved during the check; verify its current tip before resolving.",
      };
    }
    db.prepare("UPDATE task_claims SET released_at = ? WHERE id = ?").run(now, active.id);
    const summary = `No change was needed: the task's check passes on ${input.baseBranch} at ${tip.slice(0, 9)}${flaky ? " (it failed once and passed on a rerun)" : ""}.`;
    db.prepare(
      `UPDATE tasks SET status = 'completed', integration_state = NULL, integration_error = NULL,
         failure_reason = NULL, failure_class = NULL, failure_signature = NULL, unblock_fingerprint = NULL,
         receipt_json = ?, integration_updated_at = ?, version = version + 1, updated_at = ?
       WHERE id = ?`,
    ).run(
      JSON.stringify({
        state: "passed",
        source: receipt.source,
        commit: tip,
        verifiedAt: receipt.verifiedAt,
        summary,
        exemptReason: null,
        rejected: receipt.rejected,
        resolvedWithoutChange: true,
        flaky,
        checks: receipt.checks.map((check) => ({
          ...check,
          stdoutTail: check.stdoutTail.slice(-500),
          stderrTail: check.stderrTail.slice(-500),
        })),
      }),
      now,
      now,
      input.taskId,
    );
    recordEvent(db, input.taskId, "task_followup_resolved", {
      reason: "check-passes-without-change",
      tip,
      flaky,
      parentTaskId: followUp.parentTaskId,
      summary,
    });
    // The parent's merge may have failed only because of what this follow-up covered: let it merge
    // again now that the check is known to pass, without a worker and without spending a repair.
    const parent = db
      .prepare("SELECT status, integration_state FROM tasks WHERE id = ?")
      .get(followUp.parentTaskId) as
      | { status: string; integration_state: string | null }
      | undefined;
    let parentRetried = false;
    if (
      parent?.status === "verifying" &&
      (parent.integration_state === "conflict" || parent.integration_state === "repair_needed")
    ) {
      db.prepare(
        `UPDATE tasks SET integration_state = 'pending', integration_attempts = 0, integration_tip = NULL,
           integration_fingerprint = NULL, integration_updated_at = ?, updated_at = ? WHERE id = ?`,
      ).run(now, now, followUp.parentTaskId);
      recordEvent(db, followUp.parentTaskId, "task_integration_retried_after_followup", {
        followUpTaskId: input.taskId,
        tip,
      });
      parentRetried = true;
    }
    db.exec("COMMIT;");
    return {
      kind: "resolved",
      tip,
      receipt,
      flaky,
      parentTaskId: followUp.parentTaskId,
      parentRetried,
    };
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}
