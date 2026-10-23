import type {
  EnvironmentId,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import {
  collectLimitAccountSnapshot,
  collectLimitPools,
  remainingPercent,
  type LimitAccount,
  type LimitAccountSnapshot,
  type LimitPoolWindow,
  type LimitPresentations,
  type UnreadLimitAccount,
} from "@t3tools/shared/usageLimits";

const MINUTE = 60_000;
const FRESH_SAMPLE_MS = 15 * MINUTE;
// A sample stamped later than this device's clock is a clock problem, not a fresh reading.
const CLOCK_SKEW_MS = MINUTE;
const UNKNOWN = "—";

export type UsageBannerProvider = "codex" | "claudeAgent" | "antigravity";
export type UsageBannerStaleReason =
  | "age"
  | "clock"
  | "unchecked"
  | "disconnected"
  | "probeFailed"
  | "reset";

type WindowKind = ServerProviderUsageWindow["kind"];
type PresentationEntry =
  LimitPresentations extends ReadonlyMap<EnvironmentId, infer Entry> ? Entry : never;

export type UsageBannerEntry = PresentationEntry & {
  readonly connection: { readonly phase: string };
};
export type UsageBannerPresentations = ReadonlyMap<EnvironmentId, UsageBannerEntry>;

export interface UsageBannerWindowRef {
  /** The id the Usage account detail route looks a pool up by (codex pools are keyed by kind). */
  readonly id: string;
  readonly kind: WindowKind;
}

export interface UsageBannerAccountRef {
  readonly accountKey: string;
  readonly environmentIds: readonly string[] | null;
  readonly window: UsageBannerWindowRef | null;
}

export interface UsageBannerReset {
  /** Absolute reset instant in epoch ms, or null when the window does not report one. */
  readonly at: number | null;
  readonly countdown: string;
  readonly speech: string;
}

export interface UsageBannerCoverage {
  /** Accounts in the family pool that contributed a reading. */
  readonly reporting: number;
  readonly accounts: number;
  /** Contributing accounts whose reset instant is known. */
  readonly timed: number;
}

export interface UsageBannerRow {
  readonly slot: "short" | "weekly";
  readonly label: string;
  /** Quota family that fills a short row with no session window; null for plain session/weekly rows. */
  readonly family: string | null;
  readonly percent: number | null;
  readonly reset: UsageBannerReset;
  readonly window: UsageBannerWindowRef | null;
  readonly coverage: UsageBannerCoverage | null;
  readonly staleReasons: readonly UsageBannerStaleReason[];
}

export interface UsageBannerAccountCell {
  readonly kind: "account";
  readonly id: string;
  readonly provider: UsageBannerProvider;
  /** 1-based position among the provider's accounts when it has two or more. */
  readonly badge: number | null;
  readonly name: string | null;
  /** Why no quota is shown; null when the account has readings. */
  readonly placeholder: string | null;
  readonly rows: readonly [UsageBannerRow, UsageBannerRow];
  readonly checkedAt: number | null;
  readonly staleReasons: readonly UsageBannerStaleReason[];
  readonly navigation: UsageBannerAccountRef;
  readonly accessibleLabel: string;
}

export interface UsageBannerFamilyPool {
  readonly kind: Exclude<WindowKind, "monthly">;
  readonly label: string;
  readonly percent: number;
  readonly coverage: UsageBannerCoverage;
}

export interface UsageBannerSummaryCell {
  readonly kind: "antigravity";
  readonly id: "antigravity";
  readonly accountCount: number;
  readonly rows: readonly [UsageBannerRow, UsageBannerRow];
  /** Every family pool behind the summary, for details; never averaged into one quota. */
  readonly families: readonly UsageBannerFamilyPool[];
  /** Per-account chips in stable key order; each shows its own lowest quota per slot. */
  readonly accounts: readonly UsageBannerAccountCell[];
  readonly staleReasons: readonly UsageBannerStaleReason[];
  readonly accessibleLabel: string;
}

export type UsageBannerCell = UsageBannerAccountCell | UsageBannerSummaryCell;

export interface UsageBannerModel {
  readonly cells: readonly UsageBannerCell[];
}

interface Candidate {
  readonly identity: string;
  readonly key: string;
  readonly provider: UsageBannerProvider;
  readonly displayName: string | null;
  readonly environmentIds: readonly string[];
  readonly reporters: readonly EnvironmentId[];
  readonly limits: ServerProviderUsageLimits | undefined;
  /** Present only for readable accounts, which feed the Antigravity family pools. */
  readonly account: LimitAccount | null;
  readonly placeholder: string | null;
  readonly unavailable: boolean;
}

interface Pick {
  readonly percent: number;
  readonly resetAt: number | null;
  readonly window: UsageBannerWindowRef;
  readonly family: string | null;
  readonly coverage: UsageBannerCoverage | null;
}

type Slot = UsageBannerRow["slot"];

const PROVIDER_NAMES: Record<UsageBannerProvider, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
  antigravity: "Antigravity",
};

const SLOT_LABEL: Record<Slot, string> = { short: "short limit", weekly: "weekly limit" };

const STALE_PHRASES: Record<UsageBannerStaleReason, string> = {
  age: "last checked more than 15 minutes ago",
  clock: "the device clock disagrees with the sample",
  unchecked: "never checked",
  disconnected: "environment not connected",
  probeFailed: "last read failed",
  reset: "reset time passed",
};

function providerOf(driver: ServerProvider["driver"]): UsageBannerProvider | null {
  switch (driver) {
    case "codex":
      return "codex";
    case "claudeAgent":
      return "claudeAgent";
    case "antigravity":
      return "antigravity";
    default:
      return null;
  }
}

function resetMillis(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * Compact countdown for the strip. Rounds up so a reset is never shown as sooner than it is:
 * 1–59 minutes → `48min`, 60–1,439 → `4:25`, 1,440–2,879 → `35h`, then `6d`, capped at `>99d`.
 */
export function formatCountdown(remainingMs: number): string {
  const minutes = Math.ceil(remainingMs / MINUTE);
  if (minutes < 60) return `${minutes}min`;
  if (minutes < 1440) {
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
  }
  if (minutes < 2880) return `${Math.ceil(minutes / 60)}h`;
  const days = Math.ceil(minutes / 1440);
  return days >= 100 ? ">99d" : `${days}d`;
}

/** Spoken form of the same rounding, so the accessible text agrees with the countdown. */
export function spokenDuration(remainingMs: number): string {
  const minutes = Math.ceil(remainingMs / MINUTE);
  if (minutes < 60) return plural(minutes, "minute");
  if (minutes < 1440) {
    const hours = plural(Math.floor(minutes / 60), "hour");
    const rest = minutes % 60;
    return rest === 0 ? hours : `${hours} ${plural(rest, "minute")}`;
  }
  if (minutes < 2880) return plural(Math.ceil(minutes / 60), "hour");
  return plural(Math.ceil(minutes / 1440), "day");
}

function resetFor(at: number | null, now: number): UsageBannerReset {
  if (at === null) return { at, countdown: UNKNOWN, speech: "reset time unknown" };
  const remaining = at - now;
  if (remaining <= 0) {
    return { at, countdown: "now", speech: "reset time has passed, awaiting an update" };
  }
  return {
    at,
    countdown: formatCountdown(remaining),
    speech: `resets in ${spokenDuration(remaining)}`,
  };
}

/** Lowest remaining wins; equal values fall to the smallest stable id, never provider order. */
function lowest<T>(
  items: readonly T[],
  remaining: (item: T) => number,
  id: (item: T) => string,
): T | undefined {
  let best: T | undefined;
  for (const item of items) {
    if (
      best === undefined ||
      remaining(item) < remaining(best) ||
      (remaining(item) === remaining(best) && id(item) < id(best))
    ) {
      best = item;
    }
  }
  return best;
}

/**
 * The short row prefers session windows. An `other` quota fills it only when no session
 * window exists; its family is kept as the label rather than a made-up duration.
 */
function accountPick(
  provider: UsageBannerProvider,
  windows: readonly ServerProviderUsageWindow[],
  slot: Slot,
): Pick | null {
  const sessions = windows.filter((window) => window.kind === "session");
  const fallback = slot === "short" && sessions.length === 0;
  const candidates =
    slot === "weekly"
      ? windows.filter((window) => window.kind === "weekly")
      : fallback
        ? windows.filter((window) => window.kind === "other")
        : sessions;
  const window = lowest(candidates, remainingPercent, (candidate) => candidate.id);
  if (window === undefined) return null;
  return {
    percent: remainingPercent(window),
    resetAt: resetMillis(window),
    window: { id: provider === "codex" ? window.kind : window.id, kind: window.kind },
    family: fallback ? window.label : null,
    coverage: null,
  };
}

/**
 * Next capacity-restoring reset in a pool. A future reset wins; a passed one is kept only so the
 * row can say the reset passed while it awaits a fresh reading. Members that restore nothing
 * never drive the countdown.
 */
function nextRefill(pool: LimitPoolWindow, now: number): number | null {
  const restoring = pool.resets
    .filter((reset) => reset.member.refillPercent > 0)
    .map((reset) => reset.at);
  const future = restoring.filter((at) => at > now);
  if (future.length > 0) return Math.min(...future);
  if (restoring.length > 0) return Math.max(...restoring);
  return null;
}

function poolPick(
  pools: readonly LimitPoolWindow[],
  slot: Slot,
  now: number,
  accounts: number,
): Pick | null {
  const sessions = pools.filter((pool) => pool.kind === "session");
  const fallback = slot === "short" && sessions.length === 0;
  const candidates =
    slot === "weekly"
      ? pools.filter((pool) => pool.kind === "weekly")
      : fallback
        ? pools.filter((pool) => pool.kind === "other")
        : sessions;
  const pool = lowest(
    candidates,
    (candidate) => candidate.remainingPercent,
    (candidate) => candidate.id,
  );
  if (pool === undefined) return null;
  return {
    percent: pool.remainingPercent,
    resetAt: nextRefill(pool, now),
    window: { id: pool.id, kind: pool.kind },
    family: fallback ? pool.label : null,
    coverage: {
      reporting: pool.members.length,
      accounts,
      timed: pool.resets.length,
    },
  };
}

function staleFor(
  candidate: Candidate,
  connected: ReadonlySet<EnvironmentId>,
  now: number,
): UsageBannerStaleReason[] {
  const limits = candidate.limits;
  if (limits === undefined) return [];
  const reasons: UsageBannerStaleReason[] = [];
  const checked = Date.parse(limits.checkedAt);
  if (!Number.isFinite(checked)) {
    reasons.push("unchecked");
  } else if (checked - now > CLOCK_SKEW_MS) {
    reasons.push("clock");
  } else if (now - checked > FRESH_SAMPLE_MS) {
    reasons.push("age");
  }
  if (
    candidate.reporters.length > 0 &&
    !candidate.reporters.some((environmentId) => connected.has(environmentId))
  ) {
    reasons.push("disconnected");
  }
  if (candidate.unavailable || limits.unavailable?.reason === "probeFailed") {
    reasons.push("probeFailed");
  }
  return reasons;
}

function rowFor(
  slot: Slot,
  label: string,
  pick: Pick | null,
  stale: readonly UsageBannerStaleReason[],
  now: number,
): UsageBannerRow {
  const reset = resetFor(pick?.resetAt ?? null, now);
  const reasons =
    pick === null ? [] : reset.countdown === "now" ? [...stale, "reset" as const] : stale;
  return {
    slot,
    label,
    family: pick?.family ?? null,
    percent: pick?.percent ?? null,
    reset,
    window: pick?.window ?? null,
    coverage: pick?.coverage ?? null,
    staleReasons: reasons,
  };
}

function accountRows(
  candidate: Candidate,
  connected: ReadonlySet<EnvironmentId>,
  now: number,
): readonly [UsageBannerRow, UsageBannerRow] {
  const windows = candidate.limits?.windows ?? [];
  const stale = staleFor(candidate, connected, now);
  const provider = candidate.provider;
  const short = accountPick(provider, windows, "short");
  const weekly = accountPick(provider, windows, "weekly");
  return [
    rowFor("short", short?.family ? `${short.family} quota` : SLOT_LABEL.short, short, stale, now),
    rowFor("weekly", SLOT_LABEL.weekly, weekly, stale, now),
  ];
}

function checkedSpeech(checkedAt: number | null, now: number): string {
  if (checkedAt === null) return "never checked";
  const age = now - checkedAt;
  if (age < MINUTE) return "checked just now";
  return `checked ${spokenDuration(Math.floor(age / MINUTE) * MINUTE)} ago`;
}

function rowSpeech(row: UsageBannerRow): string {
  if (row.percent === null) return `${row.label} unknown, ${row.reset.speech}`;
  return `${row.percent} percent of ${row.label} left, ${row.reset.speech}`;
}

function accountCell(
  candidate: Candidate,
  badge: number | null,
  connected: ReadonlySet<EnvironmentId>,
  now: number,
): UsageBannerAccountCell {
  const rows = accountRows(candidate, connected, now);
  const hasReadings = rows.some((row) => row.percent !== null);
  const placeholder = hasReadings ? null : candidate.placeholder;
  const staleReasons = [...new Set(rows.flatMap((row) => row.staleReasons))];
  const checked = candidate.limits ? Date.parse(candidate.limits.checkedAt) : Number.NaN;
  const checkedAt = Number.isFinite(checked) ? checked : null;
  const who = [
    PROVIDER_NAMES[candidate.provider],
    badge === null ? null : `account ${badge}`,
    candidate.displayName,
  ].filter((part): part is string => part !== null);
  const body =
    placeholder !== null
      ? placeholder
      : [
          rowSpeech(rows[0]),
          rowSpeech(rows[1]),
          checkedSpeech(checkedAt, now),
          ...(staleReasons.length > 0
            ? [staleReasons.map((reason) => STALE_PHRASES[reason]).join(", ")]
            : []),
        ].join("; ");
  return {
    kind: "account",
    id: candidate.identity,
    provider: candidate.provider,
    badge,
    name: candidate.displayName,
    placeholder,
    rows,
    checkedAt,
    staleReasons,
    navigation: {
      accountKey: candidate.key,
      environmentIds: candidate.environmentIds.length > 0 ? candidate.environmentIds : null,
      window: rows[0].window ?? rows[1].window,
    },
    accessibleLabel: `${who.join(", ")}, ${body}. Open account limits.`,
  };
}

function summaryCell(
  candidates: readonly Candidate[],
  connected: ReadonlySet<EnvironmentId>,
  now: number,
): UsageBannerSummaryCell {
  const accounts = candidates.map((candidate, index) =>
    accountCell(candidate, index + 1, connected, now),
  );
  const pools =
    collectLimitPools(
      candidates.flatMap((candidate) => (candidate.account ? [candidate.account] : [])),
      now,
    ).find((pool) => pool.driver === "antigravity")?.windows ?? [];
  const stale = [
    ...new Set(candidates.flatMap((candidate) => staleFor(candidate, connected, now))),
  ];
  const picks = {
    short: poolPick(pools, "short", now, candidates.length),
    weekly: poolPick(pools, "weekly", now, candidates.length),
  } as const;
  const labelFor = (slot: Slot, pick: Pick | null) =>
    pick?.family && slot === "short"
      ? `lowest ${pick.family} quota pool`
      : `lowest ${SLOT_LABEL[slot]} pool`;
  const shortRow = rowFor("short", labelFor("short", picks.short), picks.short, stale, now);
  const weeklyRow = rowFor("weekly", labelFor("weekly", picks.weekly), picks.weekly, stale, now);
  const coverage = shortRow.coverage ?? weeklyRow.coverage;
  const coverageSpeech = coverage
    ? `${coverage.reporting} of ${candidates.length} accounts reporting, refill time known for ${coverage.timed}`
    : "no account reporting";
  const families = pools.flatMap((pool) =>
    pool.kind === "monthly"
      ? []
      : [
          {
            kind: pool.kind,
            label: pool.label,
            percent: pool.remainingPercent,
            coverage: {
              reporting: pool.members.length,
              accounts: candidates.length,
              timed: pool.resets.length,
            },
          },
        ],
  );
  return {
    kind: "antigravity",
    id: "antigravity",
    accountCount: candidates.length,
    rows: [shortRow, weeklyRow],
    families,
    accounts,
    staleReasons: stale,
    accessibleLabel:
      [
        `Antigravity, ${plural(candidates.length, "account")}, ${coverageSpeech}`,
        rowSpeech(shortRow),
        rowSpeech(weeklyRow),
      ].join("; ") + ". Expand accounts.",
  };
}

function unreadReason(account: UnreadLimitAccount): string {
  if (!account.signedIn) return "Sign in to read limits";
  if (!account.available) return "Provider unavailable";
  if (account.limits === undefined) return "Waiting for a first reading";
  if (account.limits.unavailable?.reason === "unsupported") return "No subscription limits";
  if (account.limits.unavailable?.reason === "probeFailed") return "Last reading failed";
  return "No limits reported";
}

function candidatesFor(snapshot: LimitAccountSnapshot, provider: UsageBannerProvider): Candidate[] {
  const read = snapshot.read.flatMap(({ identity, account, reporters }): Candidate[] =>
    providerOf(account.driver) === provider
      ? [
          {
            identity,
            key: account.key,
            provider,
            displayName: account.displayName,
            environmentIds: account.environments.map((environment) => environment.environmentId),
            reporters,
            limits: account.limits,
            account,
            placeholder: null,
            unavailable: false,
          },
        ]
      : [],
  );
  // A configured account that already reads under the same identity is shown once, as read.
  const seen = new Set(read.map((candidate) => candidate.identity));
  const unread = snapshot.unread.flatMap((account): Candidate[] => {
    if (providerOf(account.driver) !== provider || seen.has(account.identity)) return [];
    seen.add(account.identity);
    return [
      {
        identity: account.identity,
        key: account.key,
        provider,
        displayName: account.displayName,
        environmentIds: account.environments.map((environment) => environment.environmentId),
        reporters: account.reporters,
        limits: account.limits,
        account: null,
        placeholder: account.limits?.windows.length ? null : unreadReason(account),
        unavailable: !account.available || account.limits?.unavailable?.reason === "probeFailed",
      },
    ];
  });
  return [...read, ...unread].sort((left, right) =>
    left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0,
  );
}

/**
 * Derives the strip from the same snapshot the Usage screen uses, so identity merging and
 * account keys match. Pass only environments the viewer may read diagnostics from: values from
 * other environments are absent, not stale.
 */
export function buildUsageBannerModel(
  presentations: UsageBannerPresentations,
  now: number,
): UsageBannerModel {
  const snapshot = collectLimitAccountSnapshot(presentations);
  const connected = new Set(
    [...presentations]
      .filter(([, presentation]) => presentation.connection.phase === "connected")
      .map(([environmentId]) => environmentId),
  );
  const cells: UsageBannerCell[] = [];
  for (const provider of ["codex", "claudeAgent"] as const) {
    const group = candidatesFor(snapshot, provider);
    group.forEach((candidate, index) => {
      cells.push(accountCell(candidate, group.length >= 2 ? index + 1 : null, connected, now));
    });
  }
  const antigravity = candidatesFor(snapshot, "antigravity");
  if (antigravity.length > 0) cells.push(summaryCell(antigravity, connected, now));
  return { cells };
}

/** Keeps the previous model object when nothing shown has changed, so unchanged strips do not re-render. */
export function reuseUsageBannerModel(
  previous: UsageBannerModel | null,
  next: UsageBannerModel,
): UsageBannerModel {
  return previous !== null && JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}
