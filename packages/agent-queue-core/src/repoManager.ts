// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { openQueueDatabase, resolveDatabasePath } from "./db.ts";

export interface RepoDoctorResult {
  healthy: boolean;
  checks: {
    isGitRepo: { ok: boolean; details?: string };
    gitCommonDirWritable: { ok: boolean; details?: string };
    dbIntegrity: { ok: boolean; details?: string };
    legacyLockClear: { ok: boolean; details?: string };
    orphanedWorktrees: { ok: boolean; count: number };
  };
}

export interface RepoAssessment {
  repoPath: string;
  classification: "safe_to_register" | "safe_to_import_only" | "defer_active_plan" | "incompatible";
  reasons: string[];
  hasPlanFile: boolean;
  activePlanWorkClaims: number;
  hasDirtyWorkingTree: boolean;
}

/**
 * Resolves the git common dir for a repository or worktree.
 */
export function getGitCommonDir(repoPath: string): string {
  try {
    const res = NodeChildProcess.execSync("git rev-parse --git-common-dir", {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return NodePath.isAbsolute(res) ? res : NodePath.resolve(repoPath, res);
  } catch {
    const defaultDotGit = NodePath.join(repoPath, ".git");
    if (NodeFS.existsSync(defaultDotGit)) {
      return defaultDotGit;
    }
    throw new Error(`Directory '${repoPath}' is not a valid git repository`);
  }
}

/**
 * Idempotently initializes AgentQueue for a git repository.
 */
export function initRepo(rootDir: string): { gitCommonDir: string; dbPath: string } {
  const gitCommonDir = getGitCommonDir(rootDir);
  const queueDir = NodePath.join(gitCommonDir, "agentqueue");
  if (!NodeFS.existsSync(queueDir)) {
    NodeFS.mkdirSync(queueDir, { recursive: true });
  }

  const db = openQueueDatabase({ gitCommonDir });
  const dbPath = resolveDatabasePath(gitCommonDir);
  db.close();

  return { gitCommonDir, dbPath };
}

/**
 * Runs diagnostics on a repository's AgentQueue configuration and environment.
 */
export function doctorRepo(rootDir: string): RepoDoctorResult {
  const result: RepoDoctorResult = {
    healthy: true,
    checks: {
      isGitRepo: { ok: false },
      gitCommonDirWritable: { ok: false },
      dbIntegrity: { ok: false },
      legacyLockClear: { ok: false },
      orphanedWorktrees: { ok: true, count: 0 },
    },
  };

  let gitCommonDir = "";
  try {
    gitCommonDir = getGitCommonDir(rootDir);
    result.checks.isGitRepo = { ok: true, details: gitCommonDir };
  } catch (err) {
    result.checks.isGitRepo = { ok: false, details: (err as Error).message };
    result.healthy = false;
    return result;
  }

  // Writable check
  try {
    const testFile = NodePath.join(gitCommonDir, ".test_write_" + Date.now());
    NodeFS.writeFileSync(testFile, "test");
    NodeFS.unlinkSync(testFile);
    result.checks.gitCommonDirWritable = { ok: true };
  } catch (err) {
    result.checks.gitCommonDirWritable = { ok: false, details: (err as Error).message };
    result.healthy = false;
  }

  // DB integrity check
  try {
    const db = openQueueDatabase({ gitCommonDir });
    const checkRow = db.prepare("PRAGMA integrity_check").get() as
      | { integrity_check?: string }
      | undefined;
    const ok = checkRow?.integrity_check === "ok";
    result.checks.dbIntegrity = { ok, details: checkRow?.integrity_check ?? "unknown" };
    if (!ok) result.healthy = false;
    db.close();
  } catch (err) {
    result.checks.dbIntegrity = { ok: false, details: (err as Error).message };
    result.healthy = false;
  }

  // Legacy landing lock check
  const legacyLockFile = NodePath.join(gitCommonDir, "plan-work-landing.lock");
  if (NodeFS.existsSync(legacyLockFile)) {
    result.checks.legacyLockClear = {
      ok: false,
      details: `Legacy lock file exists: ${legacyLockFile}`,
    };
    result.healthy = false;
  } else {
    result.checks.legacyLockClear = { ok: true };
  }

  return result;
}

/**
 * Assesses a repository for AgentQueue onboarding readiness.
 */
export function assessRepoOnboarding(repoPath: string): RepoAssessment {
  const reasons: string[] = [];
  let gitCommonDir = "";

  try {
    gitCommonDir = getGitCommonDir(repoPath);
  } catch {
    return {
      repoPath,
      classification: "incompatible",
      reasons: ["Not a Git repository"],
      hasPlanFile: false,
      activePlanWorkClaims: 0,
      hasDirtyWorkingTree: false,
    };
  }

  // Check dirty tree
  let hasDirtyWorkingTree = false;
  try {
    const statusOut = NodeChildProcess.execSync("git status --porcelain", {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    hasDirtyWorkingTree = statusOut.length > 0;
    if (hasDirtyWorkingTree) {
      reasons.push("Working tree contains uncommitted changes");
    }
  } catch {
    // Ignore git error
  }

  // Check for plan file
  const planPaths = [
    NodePath.join(repoPath, "PLAN.md"),
    NodePath.join(repoPath, "docs/PLAN.md"),
    NodePath.join(repoPath, "FIXUP_PLAN.md"),
  ];
  const hasPlanFile = planPaths.some((p) => NodeFS.existsSync(p));

  // Check active plan-work claims / worktrees
  let activePlanWorkClaims = 0;
  const legacyLockFile = NodePath.join(gitCommonDir, "plan-work-landing.lock");
  if (NodeFS.existsSync(legacyLockFile)) {
    activePlanWorkClaims++;
    reasons.push("Legacy plan-work landing lock is currently held");
  }

  // Inspect existing worktrees
  try {
    const wtOut = NodeChildProcess.execSync("git worktree list --porcelain", {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const planWorkWts = wtOut
      .split("\n")
      .filter((line: string) => line.startsWith("worktree ") && line.includes("plan-work"));
    if (planWorkWts.length > 0) {
      activePlanWorkClaims += planWorkWts.length;
      reasons.push(`Found ${planWorkWts.length} active plan-work worktree(s)`);
    }
  } catch {
    // Ignore
  }

  let classification: RepoAssessment["classification"] = "safe_to_register";
  if (activePlanWorkClaims > 0) {
    classification = "defer_active_plan";
  } else if (!hasPlanFile) {
    classification = "safe_to_register";
  } else if (hasDirtyWorkingTree) {
    classification = "safe_to_import_only";
  }

  return {
    repoPath,
    classification,
    reasons,
    hasPlanFile,
    activePlanWorkClaims,
    hasDirtyWorkingTree,
  };
}

/**
 * Generates an onboarding manifest for multiple repositories.
 */
export function generateOnboardingManifest(repoPaths: string[]): RepoAssessment[] {
  return repoPaths.map((p) => assessRepoOnboarding(p));
}

/**
 * Safely cuts over a repository to AgentQueue mode after checking preconditions.
 */
export function cutoverRepo(rootDir: string): { success: boolean; message: string } {
  const assessment = assessRepoOnboarding(rootDir);
  if (assessment.classification === "defer_active_plan") {
    return {
      success: false,
      message: `Cutover rejected: repository has active plan-work claims or locks (${assessment.reasons.join(", ")})`,
    };
  }

  initRepo(rootDir);
  return {
    success: true,
    message: `Successfully initialized AgentQueue in repository: ${rootDir}`,
  };
}
