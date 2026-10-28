// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * A merge without executable checks remains unverified until its integration-tip audit passes.
 * Audit failures create blocking repairs rather than marking the plan complete.
 */
import { environmentFailureOf } from "./toolchain.ts";
import type * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { loadContract, matchesAny, resourcesNeededBy } from "./contract.ts";
import { scopesIntersect } from "./scopeManager.ts";
import { recordEvent, summarizePlanAudit, type PlanAuditSummary } from "./eventStream.ts";
import { prepareVerificationDependencies } from "./baseline.ts";
import { acquireLandingLock, prepareStagingWorktree } from "./integration.ts";
import { addFollowUpTask } from "./overseerRepairs.ts";
import { ensureSlot, taskEnvironment } from "./taskEnvironment.ts";
import { ResourceWaitError } from "./resourceRunner.ts";
import { parseStoredSpec, runSpec } from "./verificationSpec.ts";

interface Landing {
  readonly taskId: string;
  readonly commit: string;
}

/** Files one landing changed on the integration branch (its first-parent diff). */
function landingFiles(repoRoot: string, commit: string, cache: Map<string, string[]>): string[] {
  const cached = cache.get(commit);
  if (cached) return cached;
  const out = NodeChildProcess.spawnSync("git", ["diff", "--name-only", `${commit}^1`, commit], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const files = (out.stdout ?? "").split("\n").filter(Boolean);
  cache.set(commit, files);
  return files;
}

/**
 * The landings after `taskId`'s own that touched what the task owns or changed: the only ones that
 * can have broken its checks. Everything else could not have, so its checks are not run again.
 */
function impactingLandings(
  db: NodeSqlite.DatabaseSync,
  repoRoot: string,
  planId: string,
  taskId: string,
  scope: ReadonlyArray<string>,
  cache: Map<string, string[]>,
  shared: (file: string) => boolean,
): Landing[] {
  const landings = (
    db
      .prepare(
        `SELECT l.task_id AS taskId, l.commit_hash AS sha FROM landing_queue l
         JOIN tasks t ON t.id = l.task_id WHERE t.plan_id = ? AND l.status = 'landed' ORDER BY l.id`,
      )
      .all(planId) as unknown as Array<{ taskId: string; sha: string | null }>
  )
    .filter((landing) => landing.sha)
    .map((landing) => ({ taskId: landing.taskId, commit: landing.sha! }));
  const own = landings.findIndex((landing) => landing.taskId === taskId);
  if (own === -1) return [];
  // Files every task touches by design (a changelog, a generated list) say nothing about whether
  // one task could have broken another.
  const mine = new Set(
    landingFiles(repoRoot, landings[own]!.commit, cache).filter((f) => !shared(f)),
  );
  const amended = (
    db.prepare("SELECT pattern FROM scope_amendments WHERE task_id = ?").all(taskId) as Array<{
      pattern: string;
    }>
  ).map((row) => row.pattern);
  const owned = [...scope, ...amended];
  return landings.slice(own + 1).filter((landing) =>
    landingFiles(repoRoot, landing.commit, cache)
      .filter((file) => !shared(file))
      .some((file) => mine.has(file) || matchesAny(file, owned) || scopesIntersect([file], owned)),
  );
}

export interface AuditReport {
  readonly audited: ReadonlyArray<{ readonly taskId: string; readonly state: string }>;
  readonly followUps: ReadonlyArray<string>;
  /** Merged tasks that have no check at all, so nothing can be audited. */
  readonly unauditable: ReadonlyArray<string>;
  /** Persisted completion and audit counts, with original tasks separate from repair entries. */
  readonly summary: PlanAuditSummary;
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
  const report = (): AuditReport => ({
    audited,
    followUps,
    unauditable,
    summary: summarizePlanAudit(db, input.planId),
  });
  if (!tip) return report();

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
      state === undefined ||
      state === "unverified" ||
      state === "failed" ||
      state === "timed-out" ||
      state === "baseline-failed"
    );
  });
  // Change impact: a task that passed when it landed is run again only if something landed since
  // that touched what it owns or changed, and only once per integration tip.
  const fileCache = new Map<string, string[]>();
  const contractOfPlan = loadContract({
    repoRoot: input.repoRoot,
    gitCommonDir: input.gitCommonDir,
    refs: [input.baseBranch, input.integrationBranch],
  }).contract;
  const impact = new Map<string, Landing[]>();
  for (const task of tasks) {
    if (needs.includes(task)) continue;
    const last = db
      .prepare(
        "SELECT payload_json FROM task_events WHERE task_id = ? AND event_type = 'task_audited' ORDER BY id DESC LIMIT 1",
      )
      .get(task.id) as { payload_json: string } | undefined;
    if (last && (JSON.parse(last.payload_json) as { commit?: string }).commit === tip) continue;
    const spec = parseStoredSpec(task.verification_spec, task.verification_command);
    if (spec.checks.length === 0) continue;
    const scope = JSON.parse(
      (
        db.prepare("SELECT scope_patterns FROM tasks WHERE id = ?").get(task.id) as {
          scope_patterns: string | null;
        }
      ).scope_patterns || "[]",
    ) as string[];
    const later = impactingLandings(
      db,
      input.repoRoot,
      input.planId,
      task.id,
      scope,
      fileCache,
      (file) =>
        matchesAny(file, [
          ...contractOfPlan.supportingPaths,
          ...contractOfPlan.generated.flatMap((rule) => rule.paths),
          ...contractOfPlan.unionMerge,
          ...contractOfPlan.ignoredPaths,
        ]),
    );
    if (later.length > 0) {
      impact.set(task.id, later);
      needs.push(task);
    }
  }
  if (needs.length === 0) return report();

  const loaded = loadContract({
    repoRoot: input.repoRoot,
    gitCommonDir: input.gitCommonDir,
    refs: [input.baseBranch, input.integrationBranch],
  });
  const release = await acquireLandingLock(input.gitCommonDir);
  try {
    const staging = prepareStagingWorktree(input.repoRoot, tip);
    const preparation = prepareVerificationDependencies({
      stage: "audit",
      sourceRoot: input.repoRoot,
      probeRoot: staging,
    });
    if (preparation) {
      // Nothing was checked: every task stays unaudited until the environment can run the checks.
      for (const task of needs) {
        recordEvent(db, task.id, "task_audit_environment_wait", {
          commit: tip,
          reason: preparation,
        });
      }
      return report();
    }
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
      let receipt: Awaited<ReturnType<typeof runSpec>>;
      try {
        receipt = await runSpec(task.id, staging, spec, undefined, {
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
          allowReuse: false,
        });
      } catch (error) {
        if (error instanceof ResourceWaitError) continue; // looked at again on the next pass
        throw error;
      }
      const machine =
        receipt.state === "failed" || receipt.state === "timed-out"
          ? environmentFailureOf(
              receipt.checks
                .filter((check) => !check.passed)
                .map((check) => `${check.stdoutTail}\n${check.stderrTail}`)
                .join("\n"),
            )
          : null;
      if (machine) {
        // The machine cannot run this check: that says nothing about the code, and a repair task
        // could not fix it. It is audited again when the toolchain is there.
        recordEvent(db, task.id, "task_audit_environment_wait", { commit: tip, reason: machine });
        continue;
      }
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
        // Which landing broke it? Search the ones that could have, instead of blaming the task.
        let culprit = task.id;
        const suspects = impact.get(task.id) ?? [];
        if (suspects.length > 0) {
          let low = 0;
          let high = suspects.length - 1; // the tip itself fails; look for the first failing landing
          while (low < high) {
            const mid = Math.floor((low + high) / 2);
            const probe = prepareStagingWorktree(input.repoRoot, suspects[mid]!.commit);
            const probeProblem = prepareVerificationDependencies({
              stage: "audit",
              sourceRoot: input.repoRoot,
              probeRoot: probe,
            });
            if (probeProblem) {
              recordEvent(db, task.id, "task_audit_environment_wait", {
                commit: suspects[mid]!.commit,
                reason: probeProblem,
              });
              return report();
            }
            const earlier = await runSpec(task.id, probe, spec, undefined, {
              env: taskEnvironment({
                taskId: task.id,
                slot,
                gitCommonDir: input.gitCommonDir,
                contract: loaded.contract,
              }).variables,
              allowReuse: false,
              extraRequires: resourcesNeededBy(
                loaded.contract,
                scope,
                spec.checks.map((check) => check.run),
              ),
            });
            if (earlier.state === "failed" || earlier.state === "timed-out") high = mid;
            else low = mid + 1;
          }
          culprit = suspects[low]!.taskId;
        }
        const blamed =
          culprit === task.id ? "" : ` The first landing after which it fails is ${culprit}'s.`;
        const followUp = addFollowUpTask(db, {
          planId: input.planId,
          parentTaskId: culprit,
          kind: "repair",
          blocking: true,
          title: `Repair ${task.id}'s checks, broken on the integrated plan`.slice(0, 120),
          note: `The checks of ${task.id} (${spec.checks.map((check) => `\`${check.run}\``).join(", ")}) were run against the integration branch at ${tip.slice(0, 9)} and fail.${blamed}\n${receipt.summary.slice(0, 1500)}\nFix the cause in the code, whoever's change it was, and make them pass; do not weaken the checks.`,
        });
        followUps.push(followUp.taskId);
      }
    }
  } finally {
    release();
  }
  return report();
}
