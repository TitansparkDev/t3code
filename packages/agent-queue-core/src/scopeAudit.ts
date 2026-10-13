// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * Does a candidate change only what its task is allowed to change?
 *
 * Strict but practical. A path is allowed when it is in the task's declared scope, in a
 * generated-file rule or supporting-path rule of the repository contract, or in a scope
 * amendment. Everything else is a violation and is sent back to the worker, which may
 * revert it or ask for an amendment with a reason. An amendment is granted by rules, not by
 * the act of having changed the file: it must name concrete paths, give a real reason, and
 * may not reach protected paths or another running task's scope.
 *
 * @module scopeAudit
 */
import type * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import { matchesAny, normalizeRepoPath, type RepoContract } from "./contract.ts";
import { recordEvent } from "./eventStream.ts";
import { scopesIntersect } from "./scopeManager.ts";

export interface ScopeVerdict {
  readonly changed: ReadonlyArray<string>;
  readonly inScope: ReadonlyArray<string>;
  /** Allowed because the contract declares them generated; conflicts on them are resolved by the integrator. */
  readonly generated: ReadonlyArray<string>;
  readonly supporting: ReadonlyArray<string>;
  readonly amended: ReadonlyArray<string>;
  readonly violations: ReadonlyArray<string>;
  /** Every pattern the candidate may touch: given to the repository's own scope guard too. */
  readonly allowed: ReadonlyArray<string>;
}

/** Paths a branch changed relative to the branch it started from (committed work only). */
export function changedPaths(worktree: string, baseRef: string): string[] {
  try {
    const out = NodeChildProcess.execFileSync(
      "git",
      ["diff", "--name-only", "-z", `${baseRef}...HEAD`],
      { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.split("\0").filter(Boolean).map(normalizeRepoPath);
  } catch {
    return [];
  }
}

export function auditScope(input: {
  readonly changed: ReadonlyArray<string>;
  readonly scope: ReadonlyArray<string>;
  readonly contract: RepoContract;
  readonly amendments: ReadonlyArray<string>;
}): ScopeVerdict {
  const generatedPatterns = input.contract.generated.flatMap((rule) => rule.paths);
  const allowed = [
    ...input.scope,
    ...generatedPatterns,
    ...input.contract.supportingPaths,
    ...input.amendments,
  ];
  const unscoped = input.scope.length === 0;
  const buckets = {
    inScope: [] as string[],
    generated: [] as string[],
    supporting: [] as string[],
    amended: [] as string[],
    violations: [] as string[],
  };
  for (const path of input.changed) {
    if (matchesAny(path, input.scope) || unscoped) buckets.inScope.push(path);
    else if (matchesAny(path, generatedPatterns)) buckets.generated.push(path);
    else if (
      matchesAny(path, input.contract.supportingPaths) ||
      matchesAny(path, input.contract.ignoredPaths)
    ) {
      buckets.supporting.push(path);
    } else if (matchesAny(path, input.amendments)) buckets.amended.push(path);
    else buckets.violations.push(path);
  }
  return { changed: input.changed, ...buckets, allowed };
}

export function storedAmendments(db: NodeSqlite.DatabaseSync, taskId: string): string[] {
  return (
    db
      .prepare("SELECT pattern FROM scope_amendments WHERE task_id = ? ORDER BY id")
      .all(taskId) as Array<{
      pattern: string;
    }>
  ).map((row) => row.pattern);
}

export interface ScopeRequest {
  readonly paths: ReadonlyArray<string>;
  readonly reason: string;
}

/**
 * `SCOPE-REQUEST: path/a, path/b — why the task cannot be done without them`, one per line,
 * in the worker's final message.
 */
export function parseScopeRequests(reply: string): ScopeRequest[] {
  const requests: ScopeRequest[] = [];
  for (const line of reply.split("\n")) {
    const match = /^\s*(?:[-*]\s*)?SCOPE[- ]REQUEST\s*:\s*(.+?)\s+(?:—|–|--|-)\s+(.{3,})$/i.exec(
      line,
    );
    if (!match) continue;
    const paths = match[1]!
      .split(/[,\s]+/)
      .map((p) => normalizeRepoPath(p.replace(/^`|`$/g, "")))
      .filter(Boolean);
    if (paths.length > 0) requests.push({ paths, reason: match[2]!.trim() });
  }
  return requests;
}

export interface AmendmentOutcome {
  readonly granted: ReadonlyArray<string>;
  readonly denied: ReadonlyArray<{ readonly path: string; readonly why: string }>;
  /** Granted without the worker asking: a necessary, unowned, non-sensitive file. */
  readonly auto: ReadonlyArray<string>;
  /** Paths another running task holds right now; the caller waits for them instead of failing. */
  readonly waits: ReadonlyArray<{ readonly path: string; readonly ownerTaskId: string }>;
}

const MIN_REASON = 20;
const MAX_PATHS = 25;

/** Files whose change needs a stated reason: credentials, live data, CI, version-control internals. */
const SENSITIVE_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)\.env(\.(?!example$|sample$|template$|dist$)|$)/,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)/,
  /(^|\/)(secrets?|credentials?)(\/|\.|$)/i,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.github\/(workflows|actions)\//,
  /(^|\/)(userdata|\.t3)\//,
  /\.(sqlite3?|db)(-wal|-shm)?$/i,
];

export const isSensitivePath = (path: string): boolean =>
  SENSITIVE_PATTERNS.some((pattern) => pattern.test(path));

/** Tasks (other than `taskId`) that hold a path right now: a live worker, or work waiting to be merged. */
function activeOwnersOf(db: NodeSqlite.DatabaseSync, taskId: string, path: string): string[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.scope_patterns FROM tasks t
       WHERE t.id != ? AND (
         EXISTS (SELECT 1 FROM task_claims c WHERE c.task_id = t.id AND c.released_at IS NULL)
         OR t.integration_state IN ('pending', 'conflict', 'repairing')
       )`,
    )
    .all(taskId) as Array<{ id: string; scope_patterns: string }>;
  return rows
    .filter((row) => scopesIntersect([path], JSON.parse(row.scope_patterns || "[]") as string[]))
    .map((row) => row.id);
}

/**
 * Settles every path a candidate changed outside its scope, without a person and without a
 * worker turn where the answer is knowable:
 *  - protected paths are refused;
 *  - a path another running task holds is waited for (the caller parks the task, it is not an error);
 *  - a sensitive path is granted only with a stated reason (`SCOPE-REQUEST`);
 *  - any other necessary file is granted automatically and recorded.
 * Making a change never grants it by itself: the audit found the path, and a rule allowed it.
 */
export function decideScope(
  db: NodeSqlite.DatabaseSync,
  input: {
    readonly taskId: string;
    readonly requests: ReadonlyArray<ScopeRequest>;
    readonly contract: RepoContract;
    /** Paths the audit found outside the scope: only these can be granted. */
    readonly violations: ReadonlyArray<string>;
  },
): AmendmentOutcome {
  const granted: string[] = [];
  const auto: string[] = [];
  const denied: Array<{ path: string; why: string }> = [];
  const waits: Array<{ path: string; ownerTaskId: string }> = [];
  const already = storedAmendments(db, input.taskId);
  const reasons = new Map<string, string>();
  for (const request of input.requests) {
    for (const path of request.paths) reasons.set(normalizeRepoPath(path), request.reason);
  }
  const grant = (path: string, reason: string, source: "worker-request" | "auto") => {
    if (!already.includes(path)) {
      db.prepare(
        "INSERT OR IGNORE INTO scope_amendments (task_id, pattern, reason, source, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(input.taskId, path, reason.slice(0, 500), source, new Date().toISOString());
    }
    granted.push(path);
    if (source === "auto") auto.push(path);
  };
  for (const raw of input.violations.slice(0, MAX_PATHS * 4)) {
    const path = normalizeRepoPath(raw);
    const reason = reasons.get(path);
    if (matchesAny(path, input.contract.protectedPaths)) {
      denied.push({ path, why: "this path is protected" });
      continue;
    }
    const owners = activeOwnersOf(db, input.taskId, path);
    if (owners.length > 0) {
      waits.push({ path, ownerTaskId: owners[0]! });
      continue;
    }
    if (reason !== undefined && reason.length < MIN_REASON) {
      denied.push({ path, why: "the reason is too short to judge" });
      continue;
    }
    if (reason !== undefined) {
      grant(path, reason, "worker-request");
      continue;
    }
    if (isSensitivePath(path)) {
      denied.push({
        path,
        why: "this kind of file needs a reason: add `SCOPE-REQUEST: <path> — <why the task needs it>` or revert it",
      });
      continue;
    }
    if (auto.length >= MAX_PATHS) {
      denied.push({
        path,
        why: `more than ${MAX_PATHS} files outside the scope; the task is too wide for its scope`,
      });
      continue;
    }
    grant(
      path,
      "Changed by the task itself; not protected, sensitive or owned by another running task.",
      "auto",
    );
  }
  if (granted.length > 0 || denied.length > 0 || waits.length > 0) {
    recordEvent(db, input.taskId, "scope_amendment", {
      granted: granted.slice(0, 25),
      auto: auto.slice(0, 25),
      denied: denied.slice(0, 10),
      waits: waits.slice(0, 10),
    });
  }
  return { granted, denied, auto, waits };
}

/** Kept for callers that only handle explicit requests. */
export function requestAmendments(
  db: NodeSqlite.DatabaseSync,
  input: {
    readonly taskId: string;
    readonly requests: ReadonlyArray<ScopeRequest>;
    readonly contract: RepoContract;
    readonly violations: ReadonlyArray<string>;
  },
): AmendmentOutcome {
  const asked = new Set(input.requests.flatMap((request) => request.paths.map(normalizeRepoPath)));
  return decideScope(db, {
    ...input,
    violations: input.violations.filter((path) => asked.has(normalizeRepoPath(path))),
  });
}

/** Whether a task's temporary waits have cleared: nobody holds the paths it needed any more. */
export function pendingWaits(db: NodeSqlite.DatabaseSync, taskId: string): string[] {
  const row = db.prepare("SELECT waits_for FROM tasks WHERE id = ?").get(taskId) as
    | { waits_for: string | null }
    | undefined;
  const ids = JSON.parse(row?.waits_for || "[]") as string[];
  return ids.filter((id) => {
    const holder = db
      .prepare(
        `SELECT 1 FROM tasks t WHERE t.id = ? AND (
           EXISTS (SELECT 1 FROM task_claims c WHERE c.task_id = t.id AND c.released_at IS NULL)
           OR t.integration_state IN ('pending', 'conflict', 'repairing'))`,
      )
      .get(id);
    return holder !== undefined;
  });
}
