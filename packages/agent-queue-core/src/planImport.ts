// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import type * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { openQueueDatabase } from "./db.ts";
import {
  computePlanChecksum,
  getReadyTasks,
  parsePlanMarkdown,
  validatePlanDag,
  type PlanTaskDefinition,
} from "./planGraph.ts";

/** Why a plan can or cannot back an AgentQueue Goal right now. */
export type PlanReadiness =
  /** Valid, has unfinished tasks, and no legacy worker owns any of them. */
  | "ready"
  /** No plan file with tasks was found in the repository. */
  | "no-plan"
  /** The file exists but cannot be used (parse, cycle, missing dependency, duplicate ids). */
  | "invalid"
  /** Every task is already done. */
  | "complete"
  /** A legacy `plan-work` worker still owns a task of this plan. */
  | "legacy-active"
  /** More than one plan could be the active one and none was chosen. */
  | "ambiguous"
  /** The repository cannot host AgentQueue (not a git repository, detached HEAD). */
  | "repo-unusable";

export interface PlanCandidate {
  /** Path relative to the repository root. */
  readonly path: string;
  readonly title: string;
  readonly taskCount: number;
  readonly unfinishedCount: number;
}

export interface PlanPreview {
  readonly readiness: PlanReadiness;
  readonly repoRoot: string;
  readonly gitCommonDir: string | null;
  readonly baseBranch: string | null;
  /** Plan path relative to the repository root, when one is selected. */
  readonly planPath: string | null;
  readonly planId: string | null;
  readonly title: string | null;
  readonly checksum: string | null;
  readonly errors: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly counts: {
    readonly total: number;
    /** Ticked in the plan file or already completed in the queue. */
    readonly completed: number;
    /** Pending with every dependency done. */
    readonly ready: number;
    /** Pending and waiting on other tasks. */
    readonly waiting: number;
    /** In progress in the queue (claimed, running, verifying). */
    readonly active: number;
    readonly failed: number;
    readonly withoutVerification: number;
  };
  /** Task ids a legacy `plan-work` worker still owns. */
  readonly legacyOwnedTaskIds: ReadonlyArray<string>;
  /** Whether the plan was imported into the repository queue already. */
  readonly imported: boolean;
  readonly candidates: ReadonlyArray<PlanCandidate>;
}

export interface ImportedPlan {
  readonly planId: string;
  readonly planPath: string;
  readonly title: string;
  readonly checksum: string;
  readonly added: number;
  readonly updated: number;
  readonly synced: number;
  readonly total: number;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return NodeChildProcess.execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** The git directory shared by every worktree of the repository at `repoRoot`. */
export function resolveRepoGit(repoRoot: string): {
  readonly gitCommonDir: string;
  readonly baseBranch: string | null;
} | null {
  const common = git(repoRoot, ["rev-parse", "--git-common-dir"]);
  if (common === null || common === "") return null;
  const branch = git(repoRoot, ["branch", "--show-current"]);
  return {
    gitCommonDir: NodePath.resolve(repoRoot, common),
    baseBranch: branch ? branch : null,
  };
}

/** `plan-work` names its owner directory after the plan file stem. */
function legacyPlanSlug(planPath: string): string {
  return NodePath.basename(planPath, NodePath.extname(planPath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Task ids that a legacy `plan-work` worker still owns for this plan. An owner record
 * exists from `plan-work select` until `plan-work land`, so its presence means a worker
 * may be alive and its claim must not be taken over.
 */
export function findLegacyOwners(gitCommonDir: string, planPath: string): string[] {
  const dir = NodePath.join(gitCommonDir, "plan-work-owners", legacyPlanSlug(planPath));
  let names: string[];
  try {
    names = NodeFS.readdirSync(dir);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, name), "utf8")) as {
        task_id?: string;
      };
      ids.push(record.task_id ?? NodePath.basename(name, ".json").toUpperCase());
    } catch {
      ids.push(NodePath.basename(name, ".json").toUpperCase());
    }
  }
  return ids;
}

const PLAN_FILE_PATTERN = /(^|[/_-])plan([._-]|$)/i;

/** Plan-like markdown files in the repository root and `docs/`, best candidates first. */
export function discoverPlanFiles(repoRoot: string): string[] {
  const found: string[] = [];
  for (const dir of ["", "docs"]) {
    let names: string[];
    try {
      names = NodeFS.readdirSync(NodePath.join(repoRoot, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.toLowerCase().endsWith(".md") || !PLAN_FILE_PATTERN.test(name)) continue;
      const rel = dir ? `${dir}/${name}` : name;
      try {
        if (NodeFS.statSync(NodePath.join(repoRoot, rel)).isFile()) found.push(rel);
      } catch {
        // Unreadable entries are not plans.
      }
    }
  }
  return found.sort((a, b) => (a === "PLAN.md" ? -1 : b === "PLAN.md" ? 1 : a.localeCompare(b)));
}

function emptyCounts(): PlanPreview["counts"] {
  return {
    total: 0,
    completed: 0,
    ready: 0,
    waiting: 0,
    active: 0,
    failed: 0,
    withoutVerification: 0,
  };
}

/** Why a parsed plan cannot be imported, in plain language; empty when it can. */
export function planProblems(tasks: ReadonlyArray<PlanTaskDefinition>): string[] {
  const problems: string[] = [];
  if (tasks.length === 0) {
    return ["The plan has no tasks AgentQueue can read."];
  }
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) problems.push(`Task id ${task.id} appears more than once.`);
    seen.add(task.id);
  }
  try {
    validatePlanDag(tasks);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  return problems;
}

function readPlan(
  repoRoot: string,
  planPath: string,
): { content: string; parsed: ReturnType<typeof parsePlanMarkdown> } | null {
  try {
    const content = NodeFS.readFileSync(NodePath.join(repoRoot, planPath), "utf8");
    return { content, parsed: parsePlanMarkdown(content) };
  } catch {
    return null;
  }
}

/** Stable plan id: the file stem, widened to the path when two plans share a stem. */
export function planIdFor(db: NodeSqlite.DatabaseSync | null, planPath: string): string {
  const stem = `plan_${NodePath.basename(planPath, NodePath.extname(planPath))}`;
  if (db) {
    const existing = db.prepare("SELECT file_path FROM plans WHERE id = ?").get(stem) as
      | { file_path: string }
      | undefined;
    if (existing && existing.file_path !== planPath) {
      return `plan_${planPath.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9]+/g, "_")}`;
    }
  }
  return stem;
}

/**
 * Looks at a repository and a plan without changing anything: is the repository usable,
 * does the plan parse into a valid graph, how many tasks are ready, and does a legacy
 * worker still own part of it. `planPath` selects a plan; without it the repository's
 * single active plan (preferring `PLAN.md`) is used.
 */
export function previewPlan(repoRoot: string, planPath?: string): PlanPreview {
  const base = {
    repoRoot,
    gitCommonDir: null,
    baseBranch: null,
    planPath: null,
    planId: null,
    title: null,
    checksum: null,
    errors: [] as string[],
    warnings: [] as string[],
    counts: emptyCounts(),
    legacyOwnedTaskIds: [] as string[],
    imported: false,
    candidates: [] as PlanCandidate[],
  };

  const repoGit = resolveRepoGit(repoRoot);
  if (!repoGit) {
    return {
      ...base,
      readiness: "repo-unusable",
      errors: ["The project folder is not a Git repository."],
    };
  }
  const withRepo = { ...base, gitCommonDir: repoGit.gitCommonDir, baseBranch: repoGit.baseBranch };
  if (!repoGit.baseBranch) {
    return {
      ...withRepo,
      readiness: "repo-unusable",
      errors: ["The repository has a detached HEAD. Check out the branch work should land on."],
    };
  }

  const candidates: PlanCandidate[] = [];
  for (const rel of discoverPlanFiles(repoRoot)) {
    const plan = readPlan(repoRoot, rel);
    if (!plan || plan.parsed.tasks.length === 0) continue;
    candidates.push({
      path: rel,
      title: plan.parsed.title,
      taskCount: plan.parsed.tasks.length,
      unfinishedCount: plan.parsed.tasks.filter((task) => !task.checked).length,
    });
  }

  let chosen = planPath;
  if (chosen === undefined) {
    const active = candidates.filter((candidate) => candidate.unfinishedCount > 0);
    const rootPlan = active.find((candidate) => candidate.path === "PLAN.md");
    if (rootPlan) chosen = rootPlan.path;
    else if (active.length === 1) chosen = active[0]!.path;
    else if (active.length > 1) {
      return {
        ...withRepo,
        candidates,
        readiness: "ambiguous",
        errors: [
          `More than one plan has unfinished tasks (${active.map((c) => c.path).join(", ")}). Choose one.`,
        ],
      };
    } else {
      return {
        ...withRepo,
        candidates,
        readiness: candidates.length > 0 ? "complete" : "no-plan",
        errors: candidates.length > 0 ? [] : ["No plan file with tasks was found."],
      };
    }
  }

  const normalized = chosen.replace(/\\/g, "/").replace(/^\.\//, "");
  if (NodePath.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    return {
      ...withRepo,
      candidates,
      readiness: "invalid",
      errors: ["The plan must be a file inside the project's repository."],
    };
  }
  const plan = readPlan(repoRoot, normalized);
  if (!plan) {
    return {
      ...withRepo,
      candidates,
      planPath: normalized,
      readiness: "invalid",
      errors: [`Plan file ${normalized} could not be read.`],
    };
  }

  const { parsed, content } = plan;
  const problems = planProblems(parsed.tasks);
  const checksum = computePlanChecksum(content);
  const warnings: string[] = [];
  const dirty = git(repoRoot, ["status", "--porcelain", "--", normalized]);
  if (dirty)
    warnings.push(`${normalized} has uncommitted changes; workers branch from the last commit.`);

  // Merge the queue's own state over the file, so a half-finished plan previews truthfully.
  let queueStatus = new Map<string, string>();
  let imported = false;
  let planId = planIdFor(null, normalized);
  const dbFile = NodePath.join(repoGit.gitCommonDir, "agentqueue", "queue.sqlite");
  if (NodeFS.existsSync(dbFile)) {
    const db = openQueueDatabase({ gitCommonDir: repoGit.gitCommonDir });
    try {
      planId = planIdFor(db, normalized);
      const rows = db
        .prepare("SELECT id, status FROM tasks WHERE plan_id = ?")
        .all(planId) as Array<{ id: string; status: string }>;
      queueStatus = new Map(rows.map((row) => [row.id, row.status]));
      imported = rows.length > 0;
      for (const task of parsed.tasks) {
        const owner = db.prepare("SELECT plan_id FROM tasks WHERE id = ?").get(task.id) as
          | { plan_id: string | null }
          | undefined;
        if (owner && owner.plan_id !== planId) {
          problems.push(
            `Task ${task.id} already belongs to queue plan ${owner.plan_id ?? "(none)"}.`,
          );
        }
      }
    } finally {
      db.close();
    }
  }

  const statusOf = (task: PlanTaskDefinition) =>
    queueStatus.get(task.id) ?? (task.checked ? "completed" : "pending");
  const resolved = parsed.tasks.map((task) => ({
    id: task.id,
    status: statusOf(task),
    dependencies: task.dependencies,
    priority: task.priority ?? 100,
  }));
  const readyIds = new Set(getReadyTasks(resolved));
  const counts: PlanPreview["counts"] = {
    total: parsed.tasks.length,
    completed: resolved.filter((task) => task.status === "completed").length,
    ready: readyIds.size,
    waiting: resolved.filter((task) => task.status === "pending" && !readyIds.has(task.id)).length,
    active: resolved.filter((task) => ["claimed", "running", "verifying"].includes(task.status))
      .length,
    failed: resolved.filter((task) => task.status === "failed" || task.status === "blocked").length,
    withoutVerification: parsed.tasks.filter((task) => !task.verificationCommand).length,
  };
  if (counts.withoutVerification > 0 && counts.total > 0) {
    warnings.push(
      `${counts.withoutVerification} of ${counts.total} tasks name no runnable Verify command; they land after the worker's commit, rebase and clean-worktree checks only.`,
    );
  }

  const legacyOwnedTaskIds = findLegacyOwners(repoGit.gitCommonDir, normalized);
  let readiness: PlanReadiness = "ready";
  if (problems.length > 0) readiness = "invalid";
  else if (legacyOwnedTaskIds.length > 0) readiness = "legacy-active";
  else if (counts.completed === counts.total) readiness = "complete";
  else if (counts.ready === 0 && counts.active === 0) {
    warnings.push("No task is ready: every unfinished task waits on a task that is not done.");
  }

  return {
    ...withRepo,
    readiness,
    planPath: normalized,
    planId,
    title: parsed.title,
    checksum,
    errors:
      readiness === "legacy-active"
        ? [
            `Legacy plan-work workers still own ${legacyOwnedTaskIds.join(", ")}. AgentQueue will not take them over.`,
          ]
        : problems,
    warnings,
    counts,
    legacyOwnedTaskIds,
    imported,
    candidates,
  };
}

/**
 * Imports (or refreshes) a plan in the repository queue. Safe to repeat: tasks already in
 * the queue keep their status, claims and history; only new tasks are added and the
 * description and dependencies of tasks that nobody has started are refreshed. A task id
 * that belongs to another plan, a cyclic plan or a plan with a legacy owner is refused.
 */
export function importPlanFile(repoRoot: string, planPath: string): ImportedPlan {
  const preview = previewPlan(repoRoot, planPath);
  if (preview.readiness !== "ready" && preview.readiness !== "complete") {
    throw new Error(
      preview.errors[0] ?? `Plan ${planPath} cannot be imported (${preview.readiness}).`,
    );
  }
  const plan = readPlan(repoRoot, preview.planPath!)!;
  const gitCommonDir = preview.gitCommonDir!;
  const db = openQueueDatabase({ gitCommonDir });
  try {
    const planId = planIdFor(db, preview.planPath!);
    const now = new Date().toISOString();
    let added = 0;
    let updated = 0;
    let synced = 0;
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.prepare(`
        INSERT INTO plans (id, file_path, checksum, title, status, registered_at, updated_at, final_verification)
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          checksum = excluded.checksum,
          title = excluded.title,
          status = 'active',
          final_verification = excluded.final_verification,
          updated_at = excluded.updated_at
      `).run(
        planId,
        preview.planPath,
        preview.checksum,
        plan.parsed.title,
        now,
        now,
        plan.parsed.finalVerification ?? null,
      );

      for (const task of plan.parsed.tasks) {
        const existing = db
          .prepare("SELECT status, plan_id FROM tasks WHERE id = ?")
          .get(task.id) as { status: string; plan_id: string | null } | undefined;
        if (!existing) {
          db.prepare(`
            INSERT INTO tasks (
              id, plan_id, title, description, status, priority,
              scope_patterns, dependencies, verification_command, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            task.id,
            planId,
            task.title,
            task.description ?? null,
            task.checked ? "completed" : "pending",
            task.priority ?? 100,
            JSON.stringify(task.scopePatterns ?? []),
            JSON.stringify(task.dependencies ?? []),
            task.verificationCommand ?? null,
            now,
            now,
          );
          db.prepare(
            "INSERT INTO task_events (task_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)",
          ).run(
            task.id,
            "task_imported",
            JSON.stringify({ planId, checked: task.checked === true }),
            now,
          );
          added++;
          continue;
        }
        if (existing.plan_id !== planId) {
          throw new Error(`Task ${task.id} already belongs to queue plan ${existing.plan_id}.`);
        }
        if (
          existing.status === "pending" ||
          existing.status === "failed" ||
          existing.status === "blocked"
        ) {
          db.prepare(`
            UPDATE tasks SET title = ?, description = ?, priority = ?, scope_patterns = ?,
              dependencies = ?, verification_command = ?, updated_at = ?
            WHERE id = ?
          `).run(
            task.title,
            task.description ?? null,
            task.priority ?? 100,
            JSON.stringify(task.scopePatterns ?? []),
            JSON.stringify(task.dependencies ?? []),
            task.verificationCommand ?? null,
            now,
            task.id,
          );
          updated++;
        }
        // A task ticked in the plan file by hand or by plan-work is done for the queue too.
        if (task.checked && existing.status === "pending") {
          db.prepare(
            "UPDATE tasks SET status = 'completed', version = version + 1, updated_at = ? WHERE id = ?",
          ).run(now, task.id);
          db.prepare(
            "INSERT INTO task_events (task_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)",
          ).run(task.id, "task_synced", JSON.stringify({ planId, from: "plan-checkbox" }), now);
          synced++;
        }
      }
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
    return {
      planId,
      planPath: preview.planPath!,
      title: plan.parsed.title,
      checksum: preview.checksum!,
      added,
      updated,
      synced,
      total: plan.parsed.tasks.length,
    };
  } finally {
    db.close();
  }
}

/**
 * Branches `plan-work` made for this plan (`agent-plan/<plan>/<task>`) that still hold
 * commits the base branch does not have: work that was done but never landed.
 */
export function findUnmergedLegacyBranches(
  repoRoot: string,
  baseBranch: string,
  planPath?: string | null,
): string[] {
  const prefix = planPath
    ? `refs/heads/agent-plan/${legacyPlanSlug(planPath)}/`
    : "refs/heads/agent-plan/";
  const refs = git(repoRoot, ["for-each-ref", "--format=%(refname)", prefix]);
  if (!refs) return [];
  return refs
    .split("\n")
    .filter(Boolean)
    .filter(
      (ref) => git(repoRoot, ["rev-list", "--count", `refs/heads/${baseBranch}..${ref}`]) !== "0",
    )
    .map((ref) => ref.replace("refs/heads/", ""));
}
