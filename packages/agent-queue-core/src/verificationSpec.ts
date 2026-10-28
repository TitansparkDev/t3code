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
import { XMLParser, XMLValidator } from "fast-xml-parser";
import {
  redactVerificationOutput,
  runVerification,
  type VerificationExecutionResult,
} from "./verifier.ts";
import { inferResources, withBrokerResources } from "./resourceRunner.ts";

export interface VerificationCheck {
  readonly run: string;
  /** Directory relative to the worktree root; null = not stated (derived checks only). */
  readonly cwd: string | null;
  readonly timeoutSeconds: number;
  /** Shared resources the check needs exclusively, e.g. "android", "gpu", "docker". */
  readonly requires: ReadonlyArray<string>;
  readonly expectExitCode: number;
  readonly id?: string;
  readonly dependsOn?: ReadonlyArray<string>;
  readonly produces?: ReadonlyArray<string>;
  readonly consumes?: ReadonlyArray<string>;
  readonly reuseInputs?: ReadonlyArray<string>;
  readonly junit?: {
    readonly reports: ReadonlyArray<string>;
    readonly minTests: number;
    readonly maxSkipped: number;
  };
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
const CHECK_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const GLOB_CHARS = /[*?{}[\]]/;

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
  if (cleaned === ".") return ".";
  return safeRepositoryPath(cleaned, false);
}

/** Repository-relative file or glob path accepted by check evidence metadata. */
export function safeRepositoryPath(value: string, allowGlob = true): string | null {
  const cleaned = value.trim().replace(/^`|`$/g, "");
  if (
    cleaned === "" ||
    cleaned === "." ||
    cleaned.startsWith("/") ||
    cleaned.startsWith("~") ||
    /^[A-Za-z]:/.test(cleaned) ||
    cleaned.includes("\\") ||
    /[\0\r\n,;]/.test(cleaned) ||
    (!allowGlob && GLOB_CHARS.test(cleaned))
  ) {
    return null;
  }
  const parts = cleaned.split("/");
  if (parts.some((part) => part === ".." || part === "")) return null;
  const normalized = NodePath.posix.normalize(cleaned);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

function hasStructuredMetadata(check: VerificationCheck): boolean {
  return (
    check.id !== undefined ||
    check.dependsOn !== undefined ||
    check.produces !== undefined ||
    check.consumes !== undefined ||
    check.reuseInputs !== undefined ||
    check.junit !== undefined
  );
}

/** Check references and artifact declarations are a DAG with one producer per possible path. */
export function validateVerificationSpec(spec: VerificationSpec): VerificationSpec {
  const checks = spec.checks;
  const byId = new Map<string, VerificationCheck[]>();
  const rejected = [...spec.rejected];
  const problems = new Map<VerificationCheck, string[]>();
  const reject = (check: VerificationCheck, reason: string) => {
    const reasons = problems.get(check) ?? [];
    if (!reasons.includes(reason)) reasons.push(reason);
    problems.set(check, reasons);
  };

  for (const check of checks) {
    if (check.id !== undefined) {
      if (!CHECK_ID.test(check.id)) reject(check, `invalid check id "${check.id}"`);
      const sameId = byId.get(check.id) ?? [];
      sameId.push(check);
      byId.set(check.id, sameId);
    }
  }
  for (const [id, sameId] of byId) {
    if (sameId.length > 1) for (const check of sameId) reject(check, `duplicate check id "${id}"`);
  }

  const deps = new Map<string, string[]>();
  for (const check of checks) {
    if (check.cwd !== null && safeRelativeDirectory(check.cwd) === null)
      reject(check, "working directory leaves the worktree");
    if (check.id) deps.set(check.id, [...(check.dependsOn ?? [])]);
    for (const id of check.dependsOn ?? []) {
      if (!CHECK_ID.test(id)) reject(check, `invalid dependency check id "${id}"`);
      else if (!byId.has(id)) reject(check, `unknown dependency check id "${id}"`);
    }
    for (const key of ["produces", "consumes", "reuseInputs"] as const) {
      for (const path of check[key] ?? []) {
        if (safeRepositoryPath(path) === null)
          reject(check, `${key} contains an unsafe repository path`);
      }
    }
    if (check.junit) {
      if (check.junit.reports.length === 0)
        reject(check, "junit must name at least one report path");
      if (!Number.isSafeInteger(check.junit.minTests) || check.junit.minTests < 0)
        reject(check, "junit minTests must be a non-negative integer");
      if (!Number.isSafeInteger(check.junit.maxSkipped) || check.junit.maxSkipped < 0)
        reject(check, "junit maxSkipped must be a non-negative integer");
      for (const path of check.junit.reports) {
        if (safeRepositoryPath(path) === null)
          reject(check, "junit contains an unsafe report path");
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, trail: string[]) => {
    if (visiting.has(id)) {
      const start = trail.indexOf(id);
      for (const cycleId of trail.slice(start)) {
        for (const check of byId.get(cycleId) ?? []) reject(check, "check dependency cycle");
      }
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of deps.get(id) ?? [])
      if (byId.has(dependency)) visit(dependency, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of deps.keys()) visit(id, []);

  const producers = checks.flatMap((check) =>
    (check.produces ?? []).map((path) => ({ check, path: safeRepositoryPath(path) ?? path })),
  );
  const staticPrefix = (path: string) => {
    const wildcard = path.search(GLOB_CHARS);
    return wildcard < 0 ? path : path.slice(0, wildcard).replace(/[^/]*$/, "");
  };
  const overlaps = (left: string, right: string) => {
    if (left === right) return true;
    const a = staticPrefix(left);
    const b = staticPrefix(right);
    return a === "" || b === "" || a.startsWith(b) || b.startsWith(a);
  };
  for (let i = 0; i < producers.length; i++) {
    for (let j = i + 1; j < producers.length; j++) {
      const left = producers[i]!;
      const right = producers[j]!;
      if (left.check !== right.check && overlaps(left.path, right.path)) {
        reject(left.check, `produced path "${left.path}" overlaps another producer`);
        reject(right.check, `produced path "${right.path}" overlaps another producer`);
      }
    }
  }

  for (const [check, reasons] of problems) {
    rejected.push(...reasons.map((reason) => ({ run: check.run, reason })));
  }
  if (problems.size === 0) return spec;
  return { ...spec, source: "none", checks: [], rejected };
}

/** Stable Markdown suffix for a structured check, leaving legacy check serialization untouched. */
export function formatCheckOptions(check: VerificationCheck): string {
  const options = [
    `cwd: ${check.cwd ?? "."}`,
    `timeout: ${check.timeoutSeconds}s`,
    ...(check.requires.length > 0 ? [`requires: ${check.requires.join(" ")}`] : []),
    `expect: exit ${check.expectExitCode}`,
    ...(check.id ? [`id: ${check.id}`] : []),
    ...(check.dependsOn?.length ? [`after: ${check.dependsOn.join("|")}`] : []),
    ...(check.produces?.length ? [`produces: ${check.produces.join("|")}`] : []),
    ...(check.consumes?.length ? [`consumes: ${check.consumes.join("|")}`] : []),
    ...(check.reuseInputs?.length ? [`reuse-inputs: ${check.reuseInputs.join("|")}`] : []),
    ...(check.junit
      ? [
          `junit: ${check.junit.reports.join("|")}`,
          `min-tests: ${check.junit.minTests}`,
          `max-skipped: ${check.junit.maxSkipped}`,
        ]
      : []),
  ];
  return options.join(", ");
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
  readonly metadata: Partial<
    Pick<VerificationCheck, "id" | "dependsOn" | "produces" | "consumes" | "reuseInputs" | "junit">
  >;
  readonly problems: ReadonlyArray<string>;
} {
  let cwd: string | null | "invalid" = null;
  let timeoutSeconds = DEFAULT_CHECK_TIMEOUT_SECONDS;
  let requires: string[] = [];
  let expectExitCode = 0;
  const metadata: Partial<
    Pick<VerificationCheck, "id" | "dependsOn" | "produces" | "consumes" | "reuseInputs" | "junit">
  > = {};
  const problems: string[] = [];
  for (const part of text.split(/[,;]/)) {
    const match = /^\s*([a-z-]+)\s*[:=]\s*(.+?)\s*$/i.exec(part);
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
    } else if (key === "id") {
      if (!CHECK_ID.test(value)) problems.push(`invalid check id "${value}"`);
      else metadata.id = value;
    } else if (key === "after") {
      const ids = value
        .split("|")
        .map((item) => item.trim())
        .filter(Boolean);
      if (ids.some((id) => !CHECK_ID.test(id))) problems.push("after contains an invalid check id");
      else metadata.dependsOn = ids;
    } else if (["produces", "consumes", "reuse-inputs"].includes(key)) {
      const rawPaths = value.split("|").map((item) => item.trim());
      const paths = rawPaths
        .map((item) => safeRepositoryPath(item))
        .filter((item): item is string => item !== null);
      if (paths.length !== rawPaths.length || paths.length === 0)
        problems.push(`${key} contains an unsafe repository path`);
      else if (key === "produces") metadata.produces = paths;
      else if (key === "consumes") metadata.consumes = paths;
      else metadata.reuseInputs = paths;
    } else if (["junit", "min-tests", "max-skipped"].includes(key)) {
      const current = metadata.junit ?? { reports: [], minTests: 0, maxSkipped: 0 };
      if (key === "junit") {
        const rawReports = value.split("|").map((item) => item.trim());
        const reports = rawReports
          .map((item) => safeRepositoryPath(item))
          .filter((item): item is string => item !== null);
        if (reports.length !== rawReports.length || reports.length === 0)
          problems.push("junit contains an unsafe report path");
        else current.reports = reports;
      } else {
        const n = Number(value);
        if (!Number.isSafeInteger(n) || n < 0)
          problems.push(`${key} must be a non-negative integer`);
        else if (key === "min-tests") current.minTests = n;
        else current.maxSkipped = n;
      }
      metadata.junit = current;
    }
  }
  return { cwd, timeoutSeconds, requires, expectExitCode, metadata, problems };
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
      ...options.metadata,
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
      if (value && Array.isArray(value.checks) && typeof value.source === "string")
        return validateVerificationSpec(value);
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

type CheckFailureKind =
  | "blocked"
  | "missing-input"
  | "missing-output"
  | "junit-missing"
  | "junit-stale"
  | "junit-malformed"
  | "junit-failed"
  | "exit-code"
  | "timed-out"
  | "working-directory";

const MAX_JUNIT_REPORTS = 100;
const MAX_JUNIT_BYTES = 10 * 1024 * 1024;
const junitParser = new XMLParser({
  attributeNamePrefix: "@_",
  ignoreAttributes: false,
  processEntities: false,
  maxNestedTags: 100,
});

function isWithin(directory: string, path: string): boolean {
  return path === directory || path.startsWith(`${directory}${NodePath.sep}`);
}

function matchingRepositoryPaths(
  root: string,
  patterns: ReadonlyArray<string>,
): {
  readonly paths: ReadonlyArray<string>;
  readonly missing: ReadonlyArray<string>;
  readonly unsafe: ReadonlyArray<string>;
} {
  const realRoot = NodeFS.realpathSync(root);
  const paths = new Set<string>();
  const missing: string[] = [];
  const unsafe: string[] = [];
  for (const pattern of patterns) {
    const target = NodePath.resolve(root, pattern);
    if (!isWithin(root, target)) {
      unsafe.push(pattern);
      continue;
    }
    let matches: string[];
    try {
      matches = GLOB_CHARS.test(pattern)
        ? NodeFS.globSync(pattern, { cwd: root })
        : NodeFS.existsSync(target)
          ? [pattern]
          : [];
    } catch {
      unsafe.push(pattern);
      continue;
    }
    if (matches.length === 0) {
      missing.push(pattern);
      continue;
    }
    for (const match of matches) {
      const candidate = NodePath.resolve(root, match);
      try {
        const realPath = NodeFS.realpathSync(candidate);
        if (!isWithin(root, candidate) || !isWithin(realRoot, realPath)) unsafe.push(pattern);
        else paths.add(realPath);
      } catch {
        unsafe.push(pattern);
      }
    }
  }
  return { paths: [...paths].sort(), missing, unsafe };
}

function fileSignature(path: string): string {
  const stat = NodeFS.statSync(path);
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function junitSnapshot(root: string, patterns: ReadonlyArray<string>): ReadonlyMap<string, string> {
  const snapshot = new Map<string, string>();
  const resolved = matchingRepositoryPaths(root, patterns);
  for (const path of resolved.paths) {
    try {
      snapshot.set(path, fileSignature(path));
    } catch {
      // The report will be missing or malformed when the post-run snapshot is checked.
    }
  }
  return snapshot;
}

function junitCounts(path: string):
  | {
      readonly counts: {
        readonly executed: number;
        readonly failed: number;
        readonly skipped: number;
      };
      readonly failureDetails: ReadonlyArray<string>;
    }
  | { readonly error: string } {
  try {
    const stat = NodeFS.statSync(path);
    if (!stat.isFile()) return { error: "report is not a file" };
    if (stat.size > MAX_JUNIT_BYTES) return { error: "report exceeds the 10 MiB limit" };
    const xml = NodeFS.readFileSync(path, "utf8");
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml))
      return { error: "DTD and entity declarations are not allowed" };
    const valid = XMLValidator.validate(xml, { allowBooleanAttributes: false });
    if (valid !== true)
      return { error: `malformed XML at ${valid.err.line}:${valid.err.col}: ${valid.err.msg}` };
    const document = junitParser.parse(xml) as Record<string, unknown>;
    if (!Object.hasOwn(document, "testsuite") && !Object.hasOwn(document, "testsuites"))
      return { error: "expected a testsuite or testsuites root element" };
    const cases: Array<Record<string, unknown>> = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
      } else if (value && typeof value === "object") {
        for (const [name, child] of Object.entries(value)) {
          if (name === "testcase") {
            for (const testCase of Array.isArray(child) ? child : [child]) {
              if (testCase && typeof testCase === "object")
                cases.push(testCase as Record<string, unknown>);
            }
          } else visit(child);
        }
      }
    };
    visit(document);
    const skipped = cases.filter((testCase) => Object.hasOwn(testCase, "skipped")).length;
    const failedCases = cases.filter(
      (testCase) => Object.hasOwn(testCase, "failure") || Object.hasOwn(testCase, "error"),
    ).length;
    const details = cases
      .filter((testCase) => Object.hasOwn(testCase, "failure") || Object.hasOwn(testCase, "error"))
      .slice(0, 8)
      .map((testCase) => {
        const name =
          typeof testCase["@_name"] === "string"
            ? testCase["@_name"]
            : typeof testCase["@_classname"] === "string"
              ? testCase["@_classname"]
              : "unnamed testcase";
        const issue = testCase.failure ?? testCase.error;
        const firstIssue = Array.isArray(issue) ? issue[0] : issue;
        const message =
          firstIssue && typeof firstIssue === "object"
            ? ["@_message", "@_type", "#text"]
                .map((key) => (firstIssue as Record<string, unknown>)[key])
                .find((value): value is string => typeof value === "string")
            : typeof firstIssue === "string"
              ? firstIssue
              : undefined;
        return message ? `${name}: ${message}` : name;
      });
    return {
      counts: { executed: cases.length - skipped, failed: failedCases, skipped },
      failureDetails: details,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "could not read report" };
  }
}

function checkJUnitEvidence(
  root: string,
  check: NonNullable<VerificationCheck["junit"]>,
  before: ReadonlyMap<string, string>,
  env: Readonly<Record<string, string>> | undefined,
): {
  readonly failureKind?: CheckFailureKind;
  readonly reason?: string;
  readonly diagnosticExcerpt?: string;
} {
  const reports = matchingRepositoryPaths(root, check.reports);
  if (reports.unsafe.length > 0)
    return {
      failureKind: "junit-malformed",
      reason: `Required JUnit report escapes the repository: ${reports.unsafe[0]}`,
    };
  if (reports.missing.length > 0 || reports.paths.length === 0)
    return {
      failureKind: "junit-missing",
      reason: `Required JUnit report missing: ${reports.missing.join(", ") || check.reports.join(", ")}`,
    };
  if (reports.paths.length > MAX_JUNIT_REPORTS)
    return {
      failureKind: "junit-malformed",
      reason: `JUnit report count exceeds ${MAX_JUNIT_REPORTS}`,
    };
  let executed = 0;
  let failed = 0;
  let skipped = 0;
  const failureDetails: string[] = [];
  for (const path of reports.paths) {
    let signature: string;
    try {
      signature = fileSignature(path);
    } catch {
      return { failureKind: "junit-missing", reason: `Required JUnit report disappeared: ${path}` };
    }
    if (before.get(path) === signature)
      return {
        failureKind: "junit-stale",
        reason: `Required JUnit report is stale: ${NodePath.relative(root, path)}`,
      };
    const parsed = junitCounts(path);
    if ("error" in parsed)
      return {
        failureKind: "junit-malformed",
        reason: `Required JUnit report malformed or unsafe (${NodePath.relative(root, path)}): ${parsed.error}`,
      };
    executed += parsed.counts.executed;
    failed += parsed.counts.failed;
    skipped += parsed.counts.skipped;
    failureDetails.push(...parsed.failureDetails);
  }
  if (executed === 0 || executed < check.minTests || failed > 0 || skipped > check.maxSkipped) {
    const diagnosticExcerpt = redactVerificationOutput(failureDetails.join("\n"), env).slice(
      0,
      4000,
    );
    return {
      failureKind: "junit-failed",
      reason: `JUnit requirements failed: ${executed} executed, ${failed} failed, ${skipped} skipped; requires at least ${check.minTests} executed and at most ${check.maxSkipped} skipped.${diagnosticExcerpt ? ` First failure: ${diagnosticExcerpt}` : ""}`,
      ...(diagnosticExcerpt ? { diagnosticExcerpt } : {}),
    };
  }
  return {};
}

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
  readonly failureKind?: CheckFailureKind;
  readonly failureReason?: string;
  readonly diagnosticExcerpt?: string;
  readonly diagnosticLogPath?: string | null;
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
  const acceptedSpec = validateVerificationSpec(spec);
  const verifiedAt = new Date().toISOString();
  const base = (
    state: SpecResult["state"],
    summary: string,
    checks: ReadonlyArray<CheckResult> = [],
  ): SpecResult => ({
    state,
    source: acceptedSpec.source,
    commit: "unknown",
    checks,
    exemptReason: acceptedSpec.exemptReason,
    rejected: acceptedSpec.rejected,
    verifiedAt,
    summary,
  });
  if (acceptedSpec.source === "exempt") {
    return base("exempt", `Exempt from executable checks: ${acceptedSpec.exemptReason}`);
  }
  if (acceptedSpec.checks.length === 0) {
    const why =
      acceptedSpec.rejected.length > 0
        ? ` Not runnable: ${acceptedSpec.rejected.map((entry) => `${entry.run} (${entry.reason})`).join("; ")}.`
        : "";
    return base("unverified", `No executable check or exemption is defined for ${taskId}.${why}`);
  }
  const structured = acceptedSpec.checks.some(hasStructuredMetadata);
  const pending = [...acceptedSpec.checks];
  const checks: VerificationCheck[] = [];
  const orderedIds = new Set<string>();
  while (pending.length > 0) {
    const index = pending.findIndex((check) =>
      (check.dependsOn ?? []).every((id) => orderedIds.has(id)),
    );
    if (index < 0) break;
    const [check] = pending.splice(index, 1);
    checks.push(check!);
    if (check!.id) orderedIds.add(check!.id);
  }
  checks.push(...pending);
  const results: CheckResult[] = [];
  const failedIds = new Set<string>();
  let state: SpecResult["state"] = "passed";
  let commit = "unknown";
  const root = NodePath.resolve(worktreePath);
  let realRoot = root;
  try {
    realRoot = NodeFS.realpathSync(root);
  } catch {
    // The first check will carry the actionable missing-directory result.
  }
  for (const check of checks) {
    const blockedBy = (check.dependsOn ?? []).find((id) => failedIds.has(id));
    if (blockedBy) {
      const failureReason = `Blocked: prerequisite check ${blockedBy} failed; this check was not run.`;
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
        stderrTail: failureReason,
        failureKind: "blocked",
        failureReason,
      });
      state = "failed";
      if (check.id) failedIds.add(check.id);
      continue;
    }
    const cwd = NodePath.resolve(root, check.cwd ?? ".");
    let realCwd: string | null = null;
    try {
      realCwd = NodeFS.realpathSync(cwd);
    } catch {
      // Missing directories are reported below.
    }
    if (!isWithin(root, cwd) || realCwd === null || !isWithin(realRoot, realCwd)) {
      const failureReason = `Working directory ${check.cwd} does not exist inside the checked repository.`;
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
        stderrTail: failureReason,
        failureKind: "working-directory",
        failureReason,
      });
      if (check.id) failedIds.add(check.id);
      state = "failed";
      if (!structured) break;
      continue;
    }
    if (check.consumes?.length) {
      const inputs = matchingRepositoryPaths(root, check.consumes);
      if (inputs.unsafe.length > 0 || inputs.missing.length > 0) {
        const failureKind = check.dependsOn?.length ? "blocked" : "missing-input";
        const failureReason =
          inputs.unsafe.length > 0
            ? `Blocked: required input escapes the repository: ${inputs.unsafe.join(", ")}`
            : `Blocked: required input is missing: ${inputs.missing.join(", ")}`;
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
          stderrTail: failureReason,
          failureKind,
          failureReason,
        });
        if (check.id) failedIds.add(check.id);
        state = "failed";
        if (!structured) break;
        continue;
      }
    }
    // The same shared pool a worker's `agentq run` uses: what the check declares, what the
    // repository's contract says, and what its command line shows it will touch.
    const attempt = await withBrokerResources(
      [...check.requires, ...(options.extraRequires ?? []), ...inferResources(check.run)],
      async (granted) => {
        const startedAt = Date.now();
        const beforeReports = check.junit ? junitSnapshot(root, check.junit.reports) : new Map();
        const result = await runVerification(
          taskId,
          realCwd,
          check.run,
          (timeoutOverrideSeconds ?? check.timeoutSeconds) * 1000,
          { ...options.env, ...granted },
        );
        const commandPassed =
          result.outcome !== "timed-out" &&
          result.signal === null &&
          result.exitCode === check.expectExitCode;
        let failureKind: CheckFailureKind | undefined;
        let failureReason: string | undefined;
        let diagnosticExcerpt = result.diagnosticExcerpt;
        if (result.outcome === "timed-out") {
          failureKind = "timed-out";
          failureReason = "The command did not finish before its deadline.";
        } else if (!commandPassed) {
          failureKind = "exit-code";
          failureReason = `Command exited ${result.exitCode}, expected ${check.expectExitCode}.`;
        } else if (check.produces?.length) {
          const outputs = matchingRepositoryPaths(root, check.produces);
          if (outputs.unsafe.length > 0) {
            failureKind = "missing-output";
            failureReason = `Declared output escapes the repository: ${outputs.unsafe.join(", ")}`;
          } else if (outputs.missing.length > 0) {
            failureKind = "missing-output";
            failureReason = `Declared output missing: ${outputs.missing.join(", ")}`;
          }
        }
        if (commandPassed && !failureReason && check.junit) {
          const junit = checkJUnitEvidence(root, check.junit, beforeReports, {
            ...options.env,
            ...granted,
          });
          failureKind = junit.failureKind;
          failureReason = junit.reason;
          diagnosticExcerpt = junit.diagnosticExcerpt ?? diagnosticExcerpt;
        }
        const passed = commandPassed && failureReason === undefined;
        return {
          result,
          passed,
          outcome: passed ? "passed" : result.outcome === "timed-out" ? "timed-out" : "failed",
          ...(failureKind ? { failureKind } : {}),
          ...(failureReason ? { failureReason } : {}),
          ...(diagnosticExcerpt ? { diagnosticExcerpt } : {}),
        };
      },
      { label: `check of ${taskId}: ${check.run.slice(0, 80)}`, ownerRef: taskId },
    );
    const result = attempt.result;
    commit = result.commitHash;
    if (check.id && !attempt.passed) failedIds.add(check.id);
    results.push({
      run: check.run,
      cwd: check.cwd ?? ".",
      expectExitCode: check.expectExitCode,
      exitCode: result.exitCode,
      outcome: attempt.passed ? "passed" : result.outcome === "timed-out" ? "timed-out" : "failed",
      signal: result.signal,
      passed: attempt.passed,
      durationMs: result.durationMs,
      stdoutTail: result.stdoutSnippet,
      stderrTail: attempt.failureReason
        ? `${attempt.failureReason}\n${result.stderrSnippet}`
        : result.stderrSnippet,
      ...(attempt.failureKind ? { failureKind: attempt.failureKind } : {}),
      ...(attempt.failureReason ? { failureReason: attempt.failureReason } : {}),
      ...(attempt.diagnosticExcerpt ? { diagnosticExcerpt: attempt.diagnosticExcerpt } : {}),
      ...(result.diagnosticLogPath ? { diagnosticLogPath: result.diagnosticLogPath } : {}),
    });
    if (!attempt.passed) {
      state = result.outcome === "timed-out" ? "timed-out" : "failed";
      if (!structured) break;
    }
  }
  const failed = results.find((entry) => !entry.passed);
  const summary = failed
    ? `Check \`${failed.run}\` (in ${failed.cwd}) failed: ${[
        failed.failureReason,
        failed.diagnosticExcerpt,
        failed.stderrTail || failed.stdoutTail,
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 1800)}`
    : `${results.length} check(s) passed${
        acceptedSpec.rejected.length > 0
          ? `; not run: ${acceptedSpec.rejected.map((entry) => entry.run).join(", ")}`
          : ""
      }.`;
  return { ...base(state, summary, results), commit };
}
