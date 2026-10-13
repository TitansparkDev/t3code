// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * What it means for a task to be checked. A task has one of:
 *  - declared checks (`Checks:` / `Check:` / `Verify:` in the plan): run exactly as written;
 *  - derived checks (code spans of a prose `Done:` line that pass the safety policy): run too,
 *    but are labelled as derived because nobody wrote them as checks;
 *  - an explicit exemption with a reason (`Verify: none — <reason>`);
 *  - nothing: "unverified". That is never a pass; it is reported until someone defines a check
 *    or an exemption.
 *
 * @module verificationSpec
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { runVerification, type VerificationExecutionResult } from "./verifier.ts";
import { inferResources, withBrokerResources } from "./resourceRunner.ts";

export interface VerificationCheck {
  readonly run: string;
  /** Directory relative to the worktree root; null = not stated (derived checks only). */
  readonly cwd: string | null;
  readonly timeoutSeconds: number;
  /** Shared resources the check needs exclusively, e.g. "android", "gpu", "docker". */
  readonly requires: ReadonlyArray<string>;
  readonly expectExitCode: number;
}

export interface RejectedCheck {
  readonly run: string;
  readonly reason: string;
}

export interface VerificationSpec {
  readonly source: "declared" | "derived" | "exempt" | "none";
  readonly checks: ReadonlyArray<VerificationCheck>;
  readonly exemptReason: string | null;
  /** Commands that were written but are not allowed to run on the server. */
  readonly rejected: ReadonlyArray<RejectedCheck>;
}

export const NO_VERIFICATION: VerificationSpec = {
  source: "none",
  checks: [],
  exemptReason: null,
  rejected: [],
};

export const DEFAULT_CHECK_TIMEOUT_SECONDS = 1800;
export const MAX_CHECK_TIMEOUT_SECONDS = 4 * 3600;
const MIN_EXEMPT_REASON = 12;

/** First words that may start a check. Declared checks may use a few more. */
const RUNNERS = new Set([
  "uv",
  "pytest",
  "python",
  "python3",
  "ruff",
  "mypy",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "vp",
  "vpr",
  "node",
  "tsc",
  "cargo",
  "go",
  "make",
  "gradle",
  "./gradlew",
]);
const DECLARED_EXTRA = new Set(["bash", "sh", "test", "git", "grep", "cd", "true"]);

/** Words that mean deploying, publishing, deleting or reaching other machines. */
const FORBIDDEN_WORDS = new Set([
  "curl",
  "wget",
  "ssh",
  "scp",
  "rsync",
  "sftp",
  "nc",
  "ncat",
  "telnet",
  "docker",
  "podman",
  "kubectl",
  "helm",
  "terraform",
  "ansible",
  "systemctl",
  "service",
  "sudo",
  "su",
  "rm",
  "dd",
  "chmod",
  "chown",
  "kill",
  "pkill",
  "deploy",
  "publish",
  "release",
  "push",
  "destroy",
  "rollout",
  "--prod",
  "--production",
]);
const FORBIDDEN_GIT = new Set([
  "push",
  "commit",
  "reset",
  "clean",
  "checkout",
  "merge",
  "rebase",
  "stash",
  "worktree",
  "branch",
  "tag",
  "fetch",
  "pull",
  "remote",
  "config",
]);

/** Why a command may not run as a server-side check, or null when it may. */
export function inspectCheckCommand(
  run: string,
  options: { readonly declared: boolean },
): string | null {
  const text = run.trim();
  if (text === "") return "empty command";
  if (/[\n\r]/.test(text)) return "multi-line commands are not allowed";
  if (/[;`]|\$\(|\|\||>>?(?!&)|<\(/.test(text.replace(/2>&1/g, ""))) {
    return "shell control, substitution or redirection is not allowed; use one plain command";
  }
  if (/<[A-Za-z]|\.\.\.|\bTODO\b/.test(text)) return "contains a placeholder";
  for (const segment of text.split(/&&|\|/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
    const first = words[0] ?? "";
    if (first === "") return "empty command segment";
    if (first === "git" && (words[1] === undefined || FORBIDDEN_GIT.has(words[1]))) {
      return `git ${words[1] ?? ""} can change the repository`;
    }
    for (const word of words) {
      const bare = word.replace(/^['"]|['"]$/g, "");
      if (FORBIDDEN_WORDS.has(bare.toLowerCase())) {
        return `"${bare}" may change live services or infrastructure`;
      }
      if (
        /^https?:\/\//i.test(bare) &&
        !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/i.test(bare)
      ) {
        return `"${bare}" reaches an external address`;
      }
      if (/^(\/|~)/.test(bare) && !bare.startsWith("/tmp/")) {
        return `"${bare}" points outside the worktree`;
      }
      if (bare.split("/").includes("..")) return `"${bare}" leaves the worktree`;
      if (/^[A-Z_]*(PASSWORD|SECRET|TOKEN|KEY)[A-Z_]*=/.test(bare)) {
        return "passes a secret on the command line";
      }
    }
    const allowed = RUNNERS.has(first) || (options.declared && DECLARED_EXTRA.has(first));
    if (!allowed && !(options.declared && /^\.\/[\w./-]+$/.test(first))) {
      return `"${first}" is not a recognised test or build runner`;
    }
  }
  return null;
}

/**
 * A code span inside a prose `Done:` line. Only spans that start like a test runner (or like
 * something dangerous, which is reported) matter; paths, names and quotes are just prose.
 */
export function proseCheck(
  span: string,
): { readonly check?: VerificationCheck; readonly rejected?: RejectedCheck } | null {
  const first = span.trim().split(/\s+/)[0] ?? "";
  if (!RUNNERS.has(first) && !FORBIDDEN_WORDS.has(first.toLowerCase())) return null;
  const reason = inspectCheckCommand(span, { declared: false });
  if (reason) return { rejected: { run: span.trim(), reason } };
  return {
    check: {
      run: span.trim(),
      cwd: null,
      timeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS,
      requires: [],
      expectExitCode: 0,
    },
  };
}

/** A directory that stays inside the worktree. */
export function safeRelativeDirectory(value: string): string | null {
  const cleaned = value.trim().replace(/^`|`$/g, "").replace(/\/+$/, "") || ".";
  if (NodePath.isAbsolute(cleaned) || cleaned.split("/").includes("..")) return null;
  return cleaned;
}

export function parseDuration(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr)?$/i.exec(value.trim());
  if (!match) return null;
  const unit = (match[2] ?? "s").toLowerCase();
  const seconds = Number(match[1]) * (unit.startsWith("h") ? 3600 : unit.startsWith("m") ? 60 : 1);
  return Math.min(MAX_CHECK_TIMEOUT_SECONDS, Math.max(1, Math.round(seconds)));
}

/** Options in parentheses after a check: `(cwd: server/, timeout: 20m, requires: gpu, expect: exit 0)`. */
export function parseCheckOptions(text: string): {
  readonly cwd: string | null | "invalid";
  readonly timeoutSeconds: number;
  readonly requires: ReadonlyArray<string>;
  readonly expectExitCode: number;
  readonly problems: ReadonlyArray<string>;
} {
  let cwd: string | null | "invalid" = null;
  let timeoutSeconds = DEFAULT_CHECK_TIMEOUT_SECONDS;
  let requires: string[] = [];
  let expectExitCode = 0;
  const problems: string[] = [];
  for (const part of text.split(/[,;]/)) {
    const match = /^\s*([a-z]+)\s*[:=]\s*(.+?)\s*$/i.exec(part);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.replace(/^`|`$/g, "");
    if (key === "cwd" || key === "dir") {
      const directory = safeRelativeDirectory(value);
      if (directory === null) {
        cwd = "invalid";
        problems.push(`working directory "${value}" leaves the worktree`);
      } else cwd = directory;
    } else if (key === "timeout") {
      const seconds = parseDuration(value);
      if (seconds === null) problems.push(`unreadable timeout "${value}"`);
      else timeoutSeconds = seconds;
    } else if (key === "requires" || key === "resources") {
      requires = value
        .split(/[\s/+]+/)
        .map((word) => word.toLowerCase())
        .filter((word) => /^[a-z][a-z0-9-]*$/.test(word));
    } else if (key === "expect") {
      const code = /(?:exit\s*)?(\d+)/i.exec(value);
      if (code) expectExitCode = Number(code[1]);
    }
  }
  return { cwd, timeoutSeconds, requires, expectExitCode, problems };
}

/** One declared check from a code span and the text that follows it. */
export function declaredCheck(
  run: string,
  optionText: string,
): { readonly check?: VerificationCheck; readonly rejected?: RejectedCheck } {
  const options = parseCheckOptions(optionText);
  const reason = options.problems[0] ?? inspectCheckCommand(run, { declared: true });
  if (reason) return { rejected: { run, reason } };
  return {
    check: {
      run,
      cwd: options.cwd === "invalid" ? null : (options.cwd ?? "."),
      timeoutSeconds: options.timeoutSeconds,
      requires: options.requires,
      expectExitCode: options.expectExitCode,
    },
  };
}

export function exemptSpec(reason: string): VerificationSpec {
  const text = reason.trim().replace(/^[-–—:]\s*/, "");
  return text.length >= MIN_EXEMPT_REASON
    ? { source: "exempt", checks: [], exemptReason: text.slice(0, 500), rejected: [] }
    : {
        source: "none",
        checks: [],
        exemptReason: null,
        rejected: [
          {
            run: "none",
            reason: `an exemption needs a reason of at least ${MIN_EXEMPT_REASON} characters`,
          },
        ],
      };
}

/** Legacy rows hold a single shell string; it is a declared check run from the worktree root. */
export function specFromLegacyCommand(command: string | null | undefined): VerificationSpec {
  const run = command?.trim() ?? "";
  if (run === "") return NO_VERIFICATION;
  const reason = inspectCheckCommand(run, { declared: true });
  return reason
    ? { source: "none", checks: [], exemptReason: null, rejected: [{ run, reason }] }
    : {
        source: "declared",
        checks: [
          {
            run,
            cwd: ".",
            timeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS,
            requires: [],
            expectExitCode: 0,
          },
        ],
        exemptReason: null,
        rejected: [],
      };
}

export function parseStoredSpec(
  json: string | null | undefined,
  legacyCommand: string | null | undefined,
): VerificationSpec {
  if (json) {
    try {
      const value = JSON.parse(json) as VerificationSpec;
      if (value && Array.isArray(value.checks) && typeof value.source === "string") return value;
    } catch {
      // fall through to the legacy command
    }
  }
  return specFromLegacyCommand(legacyCommand);
}

/** A human line for prompts and listings. */
export function describeSpec(spec: VerificationSpec): string {
  if (spec.source === "exempt") return `exempt: ${spec.exemptReason}`;
  const parts: string[] = [];
  let directory: string | null = null;
  for (const check of spec.checks) {
    const cwd = check.cwd && check.cwd !== "." ? check.cwd : null;
    if (cwd !== directory) {
      if (cwd) parts.push(`cd ${cwd}`);
      directory = cwd;
    }
    parts.push(check.run);
  }
  return parts.join(" && ");
}

/**
 * Picks the directory for a derived check that did not name one: the root when it holds the
 * runner's project file, otherwise the one top-level directory of the task's scope that does.
 */
export function inferCheckDirectory(
  repoRoot: string,
  run: string,
  scopePatterns: ReadonlyArray<string>,
): string | null {
  const words = run.trim().split(/\s+/);
  const first = words[0] ?? "";
  const marker =
    first === "uv" ||
    first === "pytest" ||
    first === "ruff" ||
    first === "mypy" ||
    first.startsWith("python")
      ? ["pyproject.toml"]
      : ["npm", "pnpm", "yarn", "bun", "npx", "vp", "vpr", "node", "tsc"].includes(first)
        ? ["package.json"]
        : first === "cargo"
          ? ["Cargo.toml"]
          : first === "go"
            ? ["go.mod"]
            : null;
  if (marker === null) return ".";
  // Inline code needs no project directory.
  if ((first === "node" || first.startsWith("python")) && /^-[ec]$/.test(words[1] ?? ""))
    return ".";
  // A script path in the command names its own project: python3 server/deploy/x.py
  if (first.startsWith("python") || first === "node") {
    const script = words.find((word, index) => index > 0 && /\.(py|js|mjs|ts)$/.test(word));
    if (script && NodeFS.existsSync(NodePath.join(repoRoot, script))) return ".";
  }
  const has = (dir: string) =>
    marker.some((file) => NodeFS.existsSync(NodePath.join(repoRoot, dir, file)));
  if (has(".")) return ".";
  const tops = new Set(
    scopePatterns
      .map((pattern) => pattern.replace(/^\.?\//, "").split("/")[0]!)
      .filter((part) => part && !part.includes("*")),
  );
  const matches = [...tops].filter((dir) => has(dir));
  return matches.length === 1 ? matches[0]! : null;
}

/** Fill in the working directory of derived checks, rejecting the ones that cannot be placed. */
export function resolveDerivedDirectories(
  spec: VerificationSpec,
  repoRoot: string,
  scopePatterns: ReadonlyArray<string>,
): VerificationSpec {
  if (spec.source !== "derived") return spec;
  const checks: VerificationCheck[] = [];
  const rejected = [...spec.rejected];
  for (const check of spec.checks) {
    if (check.cwd !== null) {
      checks.push(check);
      continue;
    }
    const directory = inferCheckDirectory(repoRoot, check.run, scopePatterns);
    if (directory === null) {
      rejected.push({
        run: check.run,
        reason: "working directory not stated and could not be inferred",
      });
    } else checks.push({ ...check, cwd: directory });
  }
  return { ...spec, source: checks.length > 0 ? "derived" : "none", checks, rejected };
}

// ───────────────────────────── running ─────────────────────────────

export interface CheckResult {
  readonly run: string;
  readonly cwd: string;
  readonly expectExitCode: number;
  readonly exitCode: number;
  readonly outcome: VerificationExecutionResult["outcome"];
  readonly signal: string | null;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

export interface SpecResult {
  /**
   * "unverified" and "exempt" are never "passed". "baseline-failed": every check that could be
   * judged on this commit passed, and the rest already fail the same way on the integration branch
   * the commit started from. It is not a pass and is not repeated against the task.
   */
  readonly state: "passed" | "failed" | "timed-out" | "unverified" | "exempt" | "baseline-failed";
  readonly source: VerificationSpec["source"];
  readonly commit: string;
  readonly checks: ReadonlyArray<CheckResult>;
  readonly exemptReason: string | null;
  readonly rejected: ReadonlyArray<RejectedCheck>;
  readonly verifiedAt: string;
  readonly summary: string;
}

export interface RunSpecOptions {
  /** Applies to every check: the task's isolated ports, database names, temp folder. */
  readonly env?: Readonly<Record<string, string>>;
  /** Where cross-process resource locks live; without it locks only hold inside this process. */
  readonly lockDir?: string;
  /** Exclusive resources every check of this run needs besides its own `requires` (from the repository contract). */
  readonly extraRequires?: ReadonlyArray<string>;
}

export async function runSpec(
  taskId: string,
  worktreePath: string,
  spec: VerificationSpec,
  timeoutOverrideSeconds?: number,
  options: RunSpecOptions = {},
): Promise<SpecResult> {
  const verifiedAt = new Date().toISOString();
  const base = (
    state: SpecResult["state"],
    summary: string,
    checks: ReadonlyArray<CheckResult> = [],
  ): SpecResult => ({
    state,
    source: spec.source,
    commit: "unknown",
    checks,
    exemptReason: spec.exemptReason,
    rejected: spec.rejected,
    verifiedAt,
    summary,
  });
  if (spec.source === "exempt") {
    return base("exempt", `Exempt from executable checks: ${spec.exemptReason}`);
  }
  if (spec.checks.length === 0) {
    const why =
      spec.rejected.length > 0
        ? ` Not runnable: ${spec.rejected.map((entry) => `${entry.run} (${entry.reason})`).join("; ")}.`
        : "";
    return base("unverified", `No executable check or exemption is defined for ${taskId}.${why}`);
  }
  const results: CheckResult[] = [];
  let state: SpecResult["state"] = "passed";
  let commit = "unknown";
  for (const check of spec.checks) {
    const root = NodePath.resolve(worktreePath);
    const cwd = NodePath.resolve(root, check.cwd ?? ".");
    if (!(cwd === root || cwd.startsWith(root + NodePath.sep)) || !NodeFS.existsSync(cwd)) {
      results.push({
        run: check.run,
        cwd: check.cwd ?? ".",
        expectExitCode: check.expectExitCode,
        exitCode: 1,
        outcome: "failed",
        signal: null,
        passed: false,
        durationMs: 0,
        stdoutTail: "",
        stderrTail: `Working directory ${check.cwd} does not exist in the checked commit.`,
      });
      state = "failed";
      break;
    }
    // The same shared pool a worker's `agentq run` uses: what the check declares, what the
    // repository's contract says, and what its command line shows it will touch.
    const result = await withBrokerResources(
      [...check.requires, ...(options.extraRequires ?? []), ...inferResources(check.run)],
      (granted) =>
        runVerification(
          taskId,
          cwd,
          check.run,
          (timeoutOverrideSeconds ?? check.timeoutSeconds) * 1000,
          { ...options.env, ...granted },
        ),
      { label: `check of ${taskId}: ${check.run.slice(0, 80)}`, ownerRef: taskId },
    );
    commit = result.commitHash;
    const passed =
      result.outcome !== "timed-out" &&
      result.signal === null &&
      result.exitCode === check.expectExitCode;
    results.push({
      run: check.run,
      cwd: check.cwd ?? ".",
      expectExitCode: check.expectExitCode,
      exitCode: result.exitCode,
      outcome: passed ? "passed" : result.outcome === "timed-out" ? "timed-out" : "failed",
      signal: result.signal,
      passed,
      durationMs: result.durationMs,
      stdoutTail: result.stdoutSnippet,
      stderrTail: result.stderrSnippet,
    });
    if (!passed) {
      state = result.outcome === "timed-out" ? "timed-out" : "failed";
      break;
    }
  }
  const failed = results.find((entry) => !entry.passed);
  const summary = failed
    ? `Check \`${failed.run}\` (in ${failed.cwd}) ${
        failed.outcome === "timed-out"
          ? "did not finish"
          : `exited ${failed.exitCode}, expected ${failed.expectExitCode}`
      }: ${(failed.stderrTail || failed.stdoutTail).slice(-600)}`
    : `${results.length} check(s) passed${
        spec.rejected.length > 0
          ? `; not run: ${spec.rejected.map((entry) => entry.run).join(", ")}`
          : ""
      }.`;
  return { ...base(state, summary, results), commit };
}
