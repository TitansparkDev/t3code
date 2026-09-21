import {
  isQuotaSnapshotStale,
  primaryQuotaWindow,
  type AccountQuotaSnapshot,
  type QuotaGroup,
  type QuotaWindow,
} from "@t3tools/contracts/quota";
import type { ProviderDriverKind } from "@t3tools/contracts";

export interface QuotaAggregationAccount {
  readonly key: string;
  readonly instance: {
    readonly driverKind: ProviderDriverKind;
    readonly displayName: string;
  };
  readonly snapshot: AccountQuotaSnapshot | undefined;
}

export type QuotaPanelRow<TAccount extends QuotaAggregationAccount> = {
  readonly kind: "account";
  readonly account: TAccount;
};

export type QuotaWindowKindForDisplay = "short" | "long";

/** Pick the most constrained window of one duration from a provider snapshot. */
export function quotaWindowForKind(
  snapshot: AccountQuotaSnapshot | undefined,
  kind: QuotaWindowKindForDisplay,
  nowMs: number = Date.now(),
): QuotaWindow | undefined {
  if (!snapshot || isQuotaSnapshotStale(snapshot, nowMs)) return undefined;
  const windows = snapshot.groups.flatMap((group) => group.windows);
  const matching = windows.filter((window) => window.kind === kind);
  if (matching.length > 0) return primaryQuotaWindow(matching);

  // Some Claude SDK versions omit duration metadata but retain a descriptive
  // label. This fallback keeps those readings visible without using position
  // in the provider's response as an implicit contract.
  const labelPattern = kind === "short" ? /5.?hour|session/i : /week|seven.?day/i;
  return primaryQuotaWindow(windows.filter((window) => labelPattern.test(window.label ?? "")));
}

export type AntigravityQuotaPool = "gemini" | "claude-gpt";

/**
 * Average one duration across Antigravity instances. Each instance contributes
 * its most constrained pool for that duration, so a healthy Gemini pool never
 * hides an exhausted Claude/GPT pool on the same login.
 */
export function averageAntigravityWindowForKind(
  accounts: ReadonlyArray<QuotaAggregationAccount>,
  kind: QuotaWindowKindForDisplay,
  nowMs: number,
): QuotaWindow | undefined {
  const windows = accounts.flatMap((account) => {
    const window = quotaWindowForKind(account.snapshot, kind, nowMs);
    return window ? [window] : [];
  });
  if (windows.length === 0) return undefined;

  const resetTimes = new Set(windows.map((window) => window.resetsAt));
  const sharedReset = resetTimes.size === 1 ? windows[0]?.resetsAt : undefined;
  return {
    kind,
    label: kind === "short" ? "5-hour limit" : "Weekly limit",
    usedPercent: windows.reduce((sum, window) => sum + window.usedPercent, 0) / windows.length,
    windowDurationMins: kind === "short" ? 300 : 10_080,
    ...(sharedReset ? { resetsAt: sharedReset } : {}),
  };
}

/** State that an aggregate contains different provider reset times. */
export function antigravityResetLabelForKind(
  accounts: ReadonlyArray<QuotaAggregationAccount>,
  kind: QuotaWindowKindForDisplay,
  nowMs: number,
): string | undefined {
  const windows = accounts.flatMap((account) => {
    const window = quotaWindowForKind(account.snapshot, kind, nowMs);
    return window ? [window] : [];
  });
  if (windows.length === 0) return undefined;
  return new Set(windows.map((window) => window.resetsAt ?? "missing")).size > 1
    ? "reset varies"
    : undefined;
}

function groupMatchesPool(group: QuotaGroup, pool: AntigravityQuotaPool): boolean {
  const identity = `${group.key} ${group.displayName}`.toLowerCase();
  return pool === "gemini" ? /gemini|google/.test(identity) : /claude|gpt|other/.test(identity);
}

/** Find one Antigravity pool's weekly window. */
export function antigravityQuotaWindow(
  snapshot: AccountQuotaSnapshot | undefined,
  pool: AntigravityQuotaPool,
  nowMs: number = Date.now(),
  kind: QuotaWindowKindForDisplay = "long",
): QuotaWindow | undefined {
  if (!snapshot || isQuotaSnapshotStale(snapshot, nowMs)) return undefined;
  const group = snapshot.groups.find((candidate) => groupMatchesPool(candidate, pool));
  if (!group) return undefined;
  const matching = group.windows.filter(
    (window) =>
      (kind === "short" &&
        (window.kind === "short" || /5.?hour|session/i.test(window.label ?? ""))) ||
      (kind === "long" && (window.kind === "long" || /week|seven.?day/i.test(window.label ?? ""))),
  );
  return primaryQuotaWindow(matching);
}

/**
 * Average one Antigravity pool across fresh accounts. A reset is carried onto
 * the aggregate only when every contributing account publishes the same one;
 * otherwise the UI labels the aggregate as having varying reset times.
 */
export function averageAntigravityQuotaWindow(
  accounts: ReadonlyArray<QuotaAggregationAccount>,
  pool: AntigravityQuotaPool,
  nowMs: number,
  kind: QuotaWindowKindForDisplay = "long",
): QuotaWindow | undefined {
  const windows = freshAntigravityQuotaWindows(accounts, pool, nowMs, kind);
  if (windows.length === 0) return undefined;

  const resetTimes = new Set(windows.map((window) => window.resetsAt));
  const sharedReset = resetTimes.size === 1 ? windows[0]?.resetsAt : undefined;

  return {
    kind,
    label: kind === "short" ? "5-hour limit" : "Weekly limit",
    usedPercent: windows.reduce((sum, window) => sum + window.usedPercent, 0) / windows.length,
    windowDurationMins: kind === "short" ? 300 : 10_080,
    ...(sharedReset ? { resetsAt: sharedReset } : {}),
  };
}

/** Return a compact label when an aggregate cannot have one honest reset time. */
export function antigravityAggregateResetLabel(
  accounts: ReadonlyArray<QuotaAggregationAccount>,
  pool: AntigravityQuotaPool,
  nowMs: number,
  kind: QuotaWindowKindForDisplay = "long",
): string | undefined {
  const windows = freshAntigravityQuotaWindows(accounts, pool, nowMs, kind);
  if (windows.length === 0) return undefined;
  const resetTimes = new Set(windows.map((window) => window.resetsAt ?? "missing"));
  return resetTimes.size > 1 ? "reset varies" : undefined;
}

function freshAntigravityQuotaWindows(
  accounts: ReadonlyArray<QuotaAggregationAccount>,
  pool: AntigravityQuotaPool,
  nowMs: number,
  kind: QuotaWindowKindForDisplay = "long",
): ReadonlyArray<QuotaWindow> {
  return accounts.flatMap((account) => {
    const snapshot = account.snapshot;
    if (!snapshot || isQuotaSnapshotStale(snapshot, nowMs)) return [];
    const window = antigravityQuotaWindow(snapshot, pool, nowMs, kind);
    return window ? [window] : [];
  });
}

/**
 * One distinct account, plus every configured instance pointing at it.
 *
 * Antigravity instances are isolated by profile directory, but `agy`
 * authenticates from an OS-level credential store, so several instances can
 * turn out to be the same account. Grouping by the account the provider
 * reported stops the panel from showing one account's usage once per instance
 * — five identical rows read as five accounts that happen to match exactly.
 */
export interface QuotaAccountGroup<TAccount extends QuotaAggregationAccount> {
  readonly key: string;
  readonly accounts: ReadonlyArray<TAccount>;
  /** Present only when the provider told us which account this is. */
  readonly accountLabel: string | undefined;
  /** Representative account: the one with the newest snapshot. */
  readonly representative: TAccount;
}

/**
 * Collapse instances that report the same account.
 *
 * An instance whose account is unknown is always its own group: without an
 * identity there is no evidence it shares anything, and merging on a guess
 * would hide a real account.
 */
export function groupAccountsByIdentity<TAccount extends QuotaAggregationAccount>(
  accounts: ReadonlyArray<TAccount>,
): ReadonlyArray<QuotaAccountGroup<TAccount>> {
  const groups = new Map<string, { accounts: TAccount[]; accountLabel: string | undefined }>();

  for (const account of accounts) {
    const accountLabel = account.snapshot?.accountLabel?.trim();
    const key = accountLabel ? `account:${accountLabel.toLocaleLowerCase()}` : `row:${account.key}`;
    const existing = groups.get(key);
    if (existing) existing.accounts.push(account);
    else groups.set(key, { accounts: [account], accountLabel });
  }

  return [...groups.entries()].map(([key, group]) => ({
    key,
    accounts: group.accounts,
    accountLabel: group.accountLabel,
    representative: group.accounts.reduce((left, right) =>
      latestSnapshot(left.snapshot, right.snapshot) === right.snapshot && right.snapshot
        ? right
        : left,
    ),
  }));
}

/**
 * Keep one row per configured account label across all connected environments.
 *
 * Provider instance ids are routing keys inside one environment. The same
 * account configured on Windows and Linux can therefore arrive with different
 * environment-qualified row keys even when the user intentionally gave it the
 * same name. The configured display name is the account identity used by the
 * sidebar, preserving the first-seen order while selecting the newest snapshot
 * from the connected environments.
 */
export function groupQuotaPanelAccounts<TAccount extends QuotaAggregationAccount>(
  accounts: ReadonlyArray<TAccount>,
): ReadonlyArray<QuotaPanelRow<TAccount>> {
  const grouped = new Map<string, TAccount>();

  for (const account of accounts) {
    const displayName = account.instance.displayName.trim() || account.key;
    const identity = `${account.instance.driverKind}:${displayName.toLocaleLowerCase()}`;
    const existing = grouped.get(identity);
    if (!existing) {
      grouped.set(identity, { ...account, key: identity });
      continue;
    }

    const snapshot = latestSnapshot(existing.snapshot, account.snapshot);
    if (snapshot !== existing.snapshot) {
      grouped.set(identity, { ...existing, snapshot });
    }
  }

  return [...grouped.values()].map((account) => ({ kind: "account", account }));
}

function latestSnapshot(
  left: AccountQuotaSnapshot | undefined,
  right: AccountQuotaSnapshot | undefined,
): AccountQuotaSnapshot | undefined {
  if (!left) return right;
  if (!right) return left;

  const leftObservedAt = Date.parse(left.observedAt);
  const rightObservedAt = Date.parse(right.observedAt);
  if (Number.isNaN(leftObservedAt)) return right;
  if (Number.isNaN(rightObservedAt) || rightObservedAt <= leftObservedAt) return left;
  return right;
}

function quotaRemainingPercentExact(usedPercent: number): number {
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

/**
 * Compute one account's representative remaining percentage. Antigravity
 * publishes independent pools, so choose the closest-to-exhaustion window in
 * each pool and average those pool figures before rounding for display.
 */
export function accountQuotaRemainingPercent(
  snapshot: AccountQuotaSnapshot | undefined,
  nowMs: number,
): number | undefined {
  if (!snapshot || isQuotaSnapshotStale(snapshot, nowMs)) return undefined;

  const poolRemaining = snapshot.groups.flatMap((group) => {
    const primary = primaryQuotaWindow(group.windows);
    return primary ? [quotaRemainingPercentExact(primary.usedPercent)] : [];
  });
  if (poolRemaining.length === 0) return undefined;

  return Math.round(
    poolRemaining.reduce((sum, remaining) => sum + remaining, 0) / poolRemaining.length,
  );
}

export interface AntigravityQuotaSummary {
  readonly averageRemainingPercent: number | undefined;
  readonly accountsWithQuota: number;
  readonly accountsWithSnapshots: number;
  readonly accountsWithStaleSnapshots: number;
  readonly accountsWithExposedWindows: number;
}

/** Average account figures without allowing stale or missing accounts to skew the result. */
export function summarizeAntigravityQuota(
  accounts: ReadonlyArray<QuotaAggregationAccount>,
  nowMs: number,
): AntigravityQuotaSummary {
  const accountRemaining: number[] = [];
  let accountsWithSnapshots = 0;
  let accountsWithStaleSnapshots = 0;
  let accountsWithExposedWindows = 0;

  for (const account of accounts) {
    const snapshot = account.snapshot;
    if (!snapshot) continue;
    accountsWithSnapshots += 1;

    if (isQuotaSnapshotStale(snapshot, nowMs)) {
      accountsWithStaleSnapshots += 1;
      continue;
    }

    if (snapshot.groups.some((group) => group.windows.length > 0)) {
      accountsWithExposedWindows += 1;
    }

    const remaining = accountQuotaRemainingPercent(snapshot, nowMs);
    if (remaining !== undefined) accountRemaining.push(remaining);
  }

  return {
    averageRemainingPercent:
      accountRemaining.length > 0
        ? Math.round(
            accountRemaining.reduce((sum, remaining) => sum + remaining, 0) /
              accountRemaining.length,
          )
        : undefined,
    accountsWithQuota: accountRemaining.length,
    accountsWithSnapshots,
    accountsWithStaleSnapshots,
    accountsWithExposedWindows,
  };
}
