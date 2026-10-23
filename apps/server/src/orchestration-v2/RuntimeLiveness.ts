/**
 * Runtime deadlines are absolute timestamps. Persisting `startedAt` and
 * `lastProgressAt` with the owning run/task lets recovery make the same
 * decision after a restart instead of granting abandoned work a fresh budget.
 */
export const OWNED_RUNTIME_DEADLINE_MS = 16 * 60 * 60 * 1_000;
export const OWNED_RUNTIME_SUSPICION_MS = 15 * 60 * 1_000;
const OWNED_RUNTIME_CLEANUP_GRACE_MS = 2 * 60 * 1_000;

export type RuntimeWaitState = "approval" | "quota" | "bounded" | null;

export interface RuntimeLivenessState {
  readonly startedAt: number;
  readonly lastProgressAt: number;
  readonly waitState: RuntimeWaitState;
  readonly waitChangedAt: number | null;
}

export type RuntimeLivenessDecision = "healthy" | "suspect" | "stop";

/**
 * Progress can postpone idle suspicion, but never extends the absolute
 * lifetime. Polls, CPU use and lease renewals must not update lastProgressAt.
 */
export function assessRuntimeLiveness(
  state: RuntimeLivenessState,
  now: number,
): RuntimeLivenessDecision {
  // Human approval and provider quota waits have no automatic expiry.
  if (state.waitState === "approval" || state.waitState === "quota") return "healthy";
  if (now >= state.startedAt + OWNED_RUNTIME_DEADLINE_MS) return "stop";
  if (state.waitState === "bounded") {
    // A bounded wait is valid for its declared lifetime; polls cannot renew it.
    if (state.waitChangedAt !== null && now < state.waitChangedAt + OWNED_RUNTIME_DEADLINE_MS) {
      return "healthy";
    }
  }
  if (now - state.lastProgressAt >= OWNED_RUNTIME_SUSPICION_MS + OWNED_RUNTIME_CLEANUP_GRACE_MS) {
    return "stop";
  }
  if (now - state.lastProgressAt >= OWNED_RUNTIME_SUSPICION_MS) return "suspect";
  return "healthy";
}

export function deadlineFromStartedAt(startedAt: number, requestedDeadlineMs?: number): number {
  return Math.min(
    startedAt + OWNED_RUNTIME_DEADLINE_MS,
    requestedDeadlineMs ?? Number.POSITIVE_INFINITY,
  );
}
