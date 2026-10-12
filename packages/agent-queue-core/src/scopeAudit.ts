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
import { matchesAny, normalizeRepoPath, pathMatches, type RepoContract } from "./contract.ts";
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
}

const MIN_REASON = 20;
const MAX_PATHS = 25;

export function requestAmendments(
  db: NodeSqlite.DatabaseSync,
  input: {
    readonly taskId: string;
    readonly requests: ReadonlyArray<ScopeRequest>;
    readonly contract: RepoContract;
    /** Paths the audit actually found outside the scope: only these can be granted. */
    readonly violations: ReadonlyArray<string>;
  },
): AmendmentOutcome {
  const granted: string[] = [];
  const denied: Array<{ path: string; why: string }> = [];
  const others = db
    .prepare(
      `SELECT t.id, t.scope_patterns FROM tasks t JOIN task_claims c ON c.task_id = t.id
       WHERE c.released_at IS NULL AND t.id != ?`,
    )
    .all(input.taskId) as Array<{ id: string; scope_patterns: string }>;
  const already = storedAmendments(db, input.taskId);
  for (const request of input.requests) {
    for (const rawPath of request.paths.slice(0, MAX_PATHS)) {
      const path = normalizeRepoPath(rawPath);
      const refuse = (why: string) => denied.push({ path, why });
      if (request.reason.length < MIN_REASON) refuse("the reason is too short to judge");
      else if (/[*?]|^\.\.?$|(^|\/)\.\.(\/|$)|^\//.test(path))
        refuse("name concrete repository paths, no wildcards or parents");
      else if (matchesAny(path, input.contract.protectedPaths)) refuse("this path is protected");
      else if (!input.violations.some((violation) => pathMatches(violation, path)))
        refuse("the candidate does not change it outside its scope");
      else if (
        others.some((other) =>
          scopesIntersect([path], JSON.parse(other.scope_patterns || "[]") as string[]),
        )
      ) {
        refuse("another running task owns it");
      } else if (!already.includes(path)) {
        db.prepare(
          "INSERT OR IGNORE INTO scope_amendments (task_id, pattern, reason, source, created_at) VALUES (?, ?, ?, 'worker-request', ?)",
        ).run(input.taskId, path, request.reason.slice(0, 500), new Date().toISOString());
        granted.push(path);
      } else granted.push(path);
    }
  }
  if (granted.length > 0 || denied.length > 0) {
    recordEvent(db, input.taskId, "scope_amendment", { granted, denied: denied.slice(0, 10) });
  }
  return { granted, denied };
}
