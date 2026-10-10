// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
export type ConflictMode = "exclusive" | "shared";

export interface TaskScopeDescriptor {
  readonly taskId: string;
  readonly patterns: ReadonlyArray<string>;
  readonly conflictMode?: ConflictMode;
  readonly resourceClass?: string | null;
}

export const DEFAULT_RESOURCE_LIMITS: Readonly<Record<string, number>> = {
  package_install: 1,
  heavy_build: 1,
  browser: 2,
  codegen: 2,
  android: 1,
};

/**
 * Normalizes pattern string for uniform matching.
 */
function normalizePattern(p: string): string {
  let s = p.trim().replace(/^\.?\//, "");
  if (s.endsWith("/")) s = s + "**";
  return s;
}

/**
 * Checks whether two glob/directory patterns could match an overlapping set of files.
 */
export function patternsOverlap(patternA: string, patternB: string): boolean {
  const a = normalizePattern(patternA);
  const b = normalizePattern(patternB);

  // Exact match
  if (a === b) return true;

  // Root wildcard matches everything
  if (a === "**" || a === "*" || b === "**" || b === "*") return true;

  // Strip trailing wildcard to check prefix relationship
  const prefixA = a.replace(/(\/\*\*|\/\*|\*\*|\*)$/, "");
  const prefixB = b.replace(/(\/\*\*|\/\*|\*\*|\*)$/, "");

  if (prefixA === "" || prefixB === "") return true;

  if (prefixA === prefixB) return true;
  if (prefixA.startsWith(prefixB + "/")) return true;
  if (prefixB.startsWith(prefixA + "/")) return true;

  return false;
}

/**
 * Checks whether two arrays of scope patterns intersect.
 */
export function scopesIntersect(
  patternsA: ReadonlyArray<string>,
  patternsB: ReadonlyArray<string>,
): boolean {
  if (patternsA.length === 0 || patternsB.length === 0) {
    // If either task specifies no scopes, it does not hold a specific file reservation.
    return false;
  }

  for (const pa of patternsA) {
    for (const pb of patternsB) {
      if (patternsOverlap(pa, pb)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Determines whether a candidate task conflicts with any actively running tasks.
 */
export function hasScopeConflict(
  candidate: TaskScopeDescriptor,
  activeTasks: ReadonlyArray<TaskScopeDescriptor>,
): boolean {
  const candidateMode = candidate.conflictMode ?? "exclusive";

  for (const active of activeTasks) {
    if (active.taskId === candidate.taskId) continue;

    const activeMode = active.conflictMode ?? "exclusive";

    // If both are explicitly shared, no collision
    if (candidateMode === "shared" && activeMode === "shared") {
      continue;
    }

    // If either is exclusive and patterns intersect, conflict exists
    if (scopesIntersect(candidate.patterns, active.patterns)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks whether a candidate task can acquire its requested resource class under active limits.
 */
export function hasResourceConflict(
  candidateResourceClass: string | null | undefined,
  activeTasks: ReadonlyArray<{ resourceClass?: string | null }>,
  limits: Record<string, number> = DEFAULT_RESOURCE_LIMITS,
): boolean {
  if (!candidateResourceClass) return false;

  const limit = limits[candidateResourceClass] ?? 1;
  const currentCount = activeTasks.filter((t) => t.resourceClass === candidateResourceClass).length;

  return currentCount >= limit;
}
