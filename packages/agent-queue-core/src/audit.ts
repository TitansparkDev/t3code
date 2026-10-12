// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * Landed is not checked. A task can merge with no executable check at the time (its plan had
 * none then, or the check could not run) and the plan then cannot complete: "unverified" is
 * never a pass. This runs the task's stored checks, once, against the plan's real integration
 * tip, records the result as the task's audit, and turns a failure into a blocking repair task
 * instead of silently counting the task as done.
 *
 * @module audit
 */
import type * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { loadContract, resourcesNeededBy } from "./contract.ts";
import { recordEvent } from "./eventStream.ts";
import { acquireLandingLock, prepareStagingWorktree } from "./integration.ts";
import { addFollowUpTask } from "./overseerRepairs.ts";
import { ensureSlot, taskEnvironment } from "./taskEnvironment.ts";
import { parseStoredSpec, runSpec } from "./verificationSpec.ts";

export interface AuditReport {
  readonly audited: ReadonlyArray<{ readonly taskId: string; readonly state: string }>;
  readonly followUps: ReadonlyArray<string>;
  /** Merged tasks that have no check at all, so nothing can be audited. */
  readonly unauditable: ReadonlyArray<string>;
}

export async function auditUnverifiedTasks(
  db: NodeSqlite.DatabaseSync,
  input: {
    readonly repoRoot: string;
    readonly gitCommonDir: string;
    readonly baseBranch: string;
    readonly integrationBranch: string;
    readonly planId: string;
  },
): Promise<AuditReport> {
  const tip = NodeChildProcess.spawnSync(
    "git",
    ["rev-parse", `refs/heads/${input.integrationBranch}`],
    {
      cwd: input.repoRoot,
      encoding: "utf8",
    },
  ).stdout.trim();
  const tasks = db
    .prepare(
      `SELECT id, receipt_json, verification_spec, verification_command FROM tasks
       WHERE plan_id = ? AND status = 'completed'`,
    )
    .all(input.planId) as Array<{
    id: string;
    receipt_json: string | null;
    verification_spec: string | null;
    verification_command: string | null;
  }>;
  const audited: Array<{ taskId: string; state: string }> = [];
  const followUps: string[] = [];
  const unauditable: string[] = [];
  if (!tip) return { audited, followUps, unauditable };

  const needs = tasks.filter((task) => {
    const checkedByHand = db
      .prepare(
        `SELECT 1 FROM task_events WHERE task_id = ? AND ((event_type = 'task_imported' AND payload_json LIKE '%"checked":true%')
           OR (event_type = 'task_synced' AND payload_json LIKE '%plan-checkbox%')
           OR event_type = 'task_followup_resolved')`,
      )
      .get(task.id);
    if (checkedByHand) return false;
    const last = db
      .prepare(
        "SELECT payload_json FROM task_events WHERE task_id = ? AND event_type = 'task_audited' ORDER BY id DESC LIMIT 1",
      )
      .get(task.id) as { payload_json: string } | undefined;
    if (last) {
      const audit = JSON.parse(last.payload_json) as { state?: string; commit?: string };
      if (audit.state === "passed" || audit.state === "exempt") return false;
      // A failed audit is not repeated on the same tip: its repair task is the next step.
      if (audit.commit === tip) return false;
    }
    let state: string | undefined;
    try {
      state = (JSON.parse(task.receipt_json ?? "{}") as { state?: string }).state;
    } catch {
      state = undefined;
    }
    return (
      state === undefined || state === "unverified" || state === "failed" || state === "timed-out"
    );
  });
  if (needs.length === 0) return { audited, followUps, unauditable };

  const loaded = loadContract({
    repoRoot: input.repoRoot,
    gitCommonDir: input.gitCommonDir,
    refs: [input.baseBranch, input.integrationBranch],
  });
  const release = await acquireLandingLock(input.gitCommonDir);
  try {
    const staging = prepareStagingWorktree(input.repoRoot, tip);
    for (const task of needs) {
      const spec = parseStoredSpec(task.verification_spec, task.verification_command);
      if (spec.checks.length === 0) {
        unauditable.push(task.id);
        continue;
      }
      const slot = ensureSlot(db, task.id);
      const scope = JSON.parse(
        (
          db.prepare("SELECT scope_patterns FROM tasks WHERE id = ?").get(task.id) as {
            scope_patterns: string | null;
          }
        ).scope_patterns || "[]",
      ) as string[];
      const receipt = await runSpec(task.id, staging, spec, undefined, {
        extraRequires: resourcesNeededBy(
          loaded.contract,
          scope,
          spec.checks.map((check) => check.run),
        ),
        env: taskEnvironment({
          taskId: task.id,
          slot,
          gitCommonDir: input.gitCommonDir,
          contract: loaded.contract,
        }).variables,
        lockDir: NodePath.join(input.gitCommonDir, "agentqueue", "locks"),
      });
      recordEvent(db, task.id, "task_audited", {
        state: receipt.state,
        commit: tip,
        summary: receipt.summary.slice(0, 600),
        checks: receipt.checks.map((check) => ({
          run: check.run,
          cwd: check.cwd,
          passed: check.passed,
          exitCode: check.exitCode,
        })),
      });
      audited.push({ taskId: task.id, state: receipt.state });
      if (receipt.state === "failed" || receipt.state === "timed-out") {
        const followUp = addFollowUpTask(db, {
          planId: input.planId,
          parentTaskId: task.id,
          kind: "repair",
          blocking: true,
          title: `Repair ${task.id}: its checks fail on the integrated plan`,
          note: `The checks of ${task.id} were run against the integration branch at ${tip.slice(0, 9)} and failed.\n${receipt.summary.slice(0, 1500)}\nFix the cause in the code and make them pass; do not weaken the checks.`,
        });
        followUps.push(followUp.taskId);
      }
    }
  } finally {
    release();
  }
  return { audited, followUps, unauditable };
}
