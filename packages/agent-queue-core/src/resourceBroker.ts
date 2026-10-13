// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * One machine-wide queue for the things workers cannot share: an Android emulator, a heavy
 * Gradle build, Docker, a fixed database, a GPU. Every actor (a worker's shell command, the
 * server's own checks, a deferred job) asks this broker, so none can bypass another.
 *
 * - Capacities are configured (`~/.config/agentqueue/resources.json`) over measured defaults.
 * - Requests are tickets in a fair FIFO. An aged ticket that cannot run yet blocks everything
 *   behind it, so nothing starves; younger ones may be backfilled when they fit.
 * - A grant is one atomic SQLite transaction, so independent processes cannot both win.
 * - A holder proves it is alive by its process (pid + start time) and by heartbeats. A dead
 *   holder's units are freed at once; a holder whose heartbeats stopped is torn down first
 *   (its process group is killed) and only then freed.
 * - Memory is admission-controlled: a ticket is granted only when the host has headroom for it
 *   beyond what recent grants will still claim.
 * - A ticket can be a stored job (command, directory, environment). Jobs outlive the process
 *   that asked, are run by a runner when their resource is free, and keep their result.
 *
 * Physical exclusion on top of this (flock slot files shared with `agent-resources`, so older
 * scripts remain mutually exclusive) is done by `resourceRunner.ts`.
 *
 * @module resourceBroker
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { DEFAULT_RESERVE_MB, readHost, type HostSnapshot } from "./hostCapacity.ts";

export interface ResourceDefinition {
  /** Tickets that may hold this resource at once. 0 means this machine does not have it. */
  readonly capacity: number;
  /** Memory one unit is expected to need while it runs. */
  readonly memoryMb: number;
  readonly description?: string;
}

/**
 * Measured on this VM (25 GB, 16 vCPU, KVM, no GPU) on 2026-10-13: one headless emulator
 * is ~5.3 GB resident, a second (different AVD) ~3.2 GB and both boot; a Gradle build with a
 * 2 GB heap needs ~3.5 GB with its daemon and Kotlin daemon; a compose stack ~1.5 GB.
 */
export const BUILTIN_RESOURCES: Readonly<Record<string, ResourceDefinition>> = {
  heavy_build: {
    capacity: 2,
    memoryMb: 3500,
    description: "Gradle / large compiles; separate worktrees do not conflict, memory does",
  },
  android: {
    capacity: 2,
    memoryMb: 5500,
    description: "an Android emulator; each slot is its own port and serial",
  },
  docker: { capacity: 3, memoryMb: 1500, description: "Docker or compose stacks" },
  postgres: { capacity: 6, memoryMb: 600, description: "a per-task PostgreSQL instance" },
  browser: { capacity: 1, memoryMb: 1500, description: "a real browser session" },
  package_install: { capacity: 1, memoryMb: 800, description: "dependency installs" },
  codegen: { capacity: 1, memoryMb: 800, description: "code generators that rewrite shared state" },
  gpu: { capacity: 0, memoryMb: 0, description: "no GPU exists in this VM" },
};

export const RESOURCE_ALIASES: Readonly<Record<string, string>> = {
  gradle: "heavy_build",
  build: "heavy_build",
  emulator: "android",
  avd: "android",
  playwright: "browser",
  install: "package_install",
  npm: "package_install",
};

export const normalizeResource = (name: string): string => {
  const lower = name.trim().toLowerCase();
  return RESOURCE_ALIASES[lower] ?? lower;
};

export function accountHome(): string {
  try {
    return NodeOS.userInfo().homedir;
  } catch {
    return NodeOS.homedir();
  }
}

const underTest = () => process.env.VITEST !== undefined || process.env.NODE_ENV === "test";

/**
 * Where the broker keeps its state. Every profile of this account reaches the same one (the
 * account's passwd home, never $HOME). A test run gets a private directory so it can neither
 * queue behind nor disturb real work.
 */
export function brokerHome(): string {
  if (process.env.AGENTQUEUE_RESOURCE_HOME) return process.env.AGENTQUEUE_RESOURCE_HOME;
  if (underTest())
    return NodePath.join(NodeOS.tmpdir(), `agentqueue-test-resources-${process.pid}`);
  return NodePath.join(accountHome(), ".local", "share", "agentqueue", "resources");
}

/** Where the physical lock files live: the same directory `agent-resources` uses. */
export function lockRoot(): string {
  if (process.env.AGENTQUEUE_LOCK_ROOT) return process.env.AGENTQUEUE_LOCK_ROOT;
  if (underTest()) return NodePath.join(brokerHome(), "locks");
  return NodePath.join(accountHome(), ".local", "share", "agent-resources", "locks");
}

/** The legacy single Android lock older scripts take with `flock /tmp/android-heavy.lock`. */
export function legacyAndroidLock(): string | null {
  if (process.env.AGENTQUEUE_LEGACY_ANDROID_LOCK !== undefined)
    return process.env.AGENTQUEUE_LEGACY_ANDROID_LOCK || null;
  return underTest() ? null : "/tmp/android-heavy.lock";
}

function configPath(): string {
  return (
    process.env.AGENTQUEUE_RESOURCE_CONFIG ??
    (underTest()
      ? NodePath.join(brokerHome(), "no-config.json")
      : NodePath.join(accountHome(), ".config", "agentqueue", "resources.json"))
  );
}

export interface ResourceConfig {
  readonly resources: Readonly<Record<string, ResourceDefinition>>;
  readonly reserveMb: number;
}

/** Built-in defaults overlaid with the machine's configuration file. Never throws. */
export function loadResourceConfig(): ResourceConfig {
  const resources: Record<string, ResourceDefinition> = { ...BUILTIN_RESOURCES };
  // This VM has no GPU, so real runs get none; tests need a stand-in to exercise contention.
  if (underTest() && !process.env.AGENTQUEUE_RESOURCE_CONFIG) {
    resources.gpu = { capacity: 1, memoryMb: 0, description: "simulated GPU for tests" };
  }
  let reserveMb = DEFAULT_RESERVE_MB;
  try {
    const raw = JSON.parse(NodeFS.readFileSync(configPath(), "utf8")) as {
      resources?: Record<string, Partial<ResourceDefinition>>;
      reserveMb?: number;
    };
    for (const [name, value] of Object.entries(raw.resources ?? {})) {
      const key = normalizeResource(name);
      const base = resources[key] ?? { capacity: 1, memoryMb: 0 };
      resources[key] = {
        capacity: Number.isInteger(value.capacity) ? Math.max(value.capacity!, 0) : base.capacity,
        memoryMb: Number.isFinite(value.memoryMb) ? Math.max(value.memoryMb!, 0) : base.memoryMb,
        ...(value.description ? { description: value.description } : {}),
      };
    }
    if (typeof raw.reserveMb === "number" && raw.reserveMb >= 0) reserveMb = raw.reserveMb;
  } catch {
    // No file, or an unreadable one: the measured defaults stand.
  }
  return { resources, reserveMb };
}

export type TicketState = "waiting" | "granted" | "running" | "done" | "cancelled" | "expired";

/** How a ticket's work ended. `exhausted` and `timed-out` are different problems and are never conflated. */
export type TicketOutcome =
  | "ok"
  | "failed"
  | "timed-out" // the command ran past its own time limit
  | "exhausted" // the resource never became available within the wait limit
  | "unavailable" // the machine does not have the resource at all (capacity 0)
  | "interrupted" // the holder disappeared; the job may be retried
  | "cancelled";

export interface ResourceRequest {
  /** Resource name and units, e.g. [{name: "android", units: 1}]. */
  readonly resources: ReadonlyArray<{ readonly name: string; readonly units?: number }>;
  /** Who is asking, for status (a command, a task id). */
  readonly label?: string;
  /** The task or thread this work belongs to, so its owner can be told the result. */
  readonly ownerRef?: string;
  /** The repository (git common dir) the work belongs to; a runner only runs its own repository's jobs. */
  readonly repo?: string;
  /** Hints for resources the machine does not configure (a repository's own exclusive resource). */
  readonly hints?: Readonly<Record<string, { capacity?: number; memoryMb?: number }>>;
  /** Process that waits and (for `run`) holds; omitted for stored jobs. */
  readonly pid?: number;
  /** Longest the ticket may wait for its resources. */
  readonly waitMs?: number;
  /** Longest the work may run once it has them. */
  readonly runMs?: number;
  /** A stored job: the broker keeps what is needed to run it later. */
  readonly job?: {
    readonly command: string;
    readonly cwd: string;
    readonly env?: Record<string, string>;
  };
}

export interface Ticket {
  readonly id: string;
  readonly seq: number;
  readonly kind: "run" | "job";
  readonly state: TicketState;
  readonly resources: ReadonlyArray<{ readonly name: string; readonly units: number }>;
  readonly slots: Readonly<Record<string, ReadonlyArray<number>>>;
  readonly label: string;
  readonly ownerRef: string | null;
  readonly repo: string | null;
  readonly pid: number | null;
  readonly pgid: number | null;
  readonly enqueuedAt: number;
  readonly grantedAt: number | null;
  readonly heartbeatAt: number | null;
  readonly finishedAt: number | null;
  readonly waitDeadline: number | null;
  readonly runMs: number | null;
  readonly attempts: number;
  readonly outcome: TicketOutcome | null;
  readonly exitCode: number | null;
  readonly note: string | null;
  readonly job: {
    readonly command: string;
    readonly cwd: string;
    readonly env: Record<string, string>;
  } | null;
  readonly logPath: string | null;
  readonly tail: string | null;
  /** Set once the job's owner was told about the result. */
  readonly reportedAt: number | null;
}

interface TicketRow {
  seq: number;
  id: string;
  kind: string;
  state: string;
  resources_json: string;
  slots_json: string;
  label: string;
  owner_ref: string | null;
  repo: string | null;
  pid: number | null;
  pid_start: number | null;
  pgid: number | null;
  enqueued_at: number;
  granted_at: number | null;
  heartbeat_at: number | null;
  finished_at: number | null;
  wait_deadline: number | null;
  run_ms: number | null;
  attempts: number;
  outcome: string | null;
  exit_code: number | null;
  note: string | null;
  job_json: string | null;
  log_path: string | null;
  tail: string | null;
  reported_at: number | null;
}

const parse = <A>(text: string | null, fallback: A): A => {
  try {
    return text ? (JSON.parse(text) as A) : fallback;
  } catch {
    return fallback;
  }
};

const toTicket = (row: TicketRow): Ticket => ({
  id: row.id,
  seq: row.seq,
  kind: row.kind as Ticket["kind"],
  state: row.state as TicketState,
  resources: parse(row.resources_json, []),
  slots: parse(row.slots_json, {}),
  label: row.label,
  ownerRef: row.owner_ref,
  repo: row.repo,
  pid: row.pid,
  pgid: row.pgid,
  enqueuedAt: row.enqueued_at,
  grantedAt: row.granted_at,
  heartbeatAt: row.heartbeat_at,
  finishedAt: row.finished_at,
  waitDeadline: row.wait_deadline,
  runMs: row.run_ms,
  attempts: row.attempts,
  outcome: row.outcome as TicketOutcome | null,
  exitCode: row.exit_code,
  note: row.note,
  job: row.job_json ? parse(row.job_json, null) : null,
  logPath: row.log_path,
  tail: row.tail,
  reportedAt: row.reported_at,
});

export function processStartTicks(pid: number): number | null {
  try {
    return Number(
      NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8").split(")")[1]!.trim().split(/\s+/)[19],
    );
  } catch {
    return null;
  }
}

/** True when `pid` is a live (non-zombie) process; with `startTicks` it must be the same process, not a reused pid. */
export function processIsLive(pid: number, startTicks?: number | null): boolean {
  try {
    const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8")
      .split(")")[1]!
      .trim()
      .split(/\s+/);
    if (stat[0] === "Z") return false;
    return startTicks == null || Number(stat[19]) === startTicks;
  } catch {
    // No /proc (not Linux): fall back to a signal probe.
    try {
      process.kill(pid, 0);
      return NodeFS.existsSync("/proc") ? false : true;
    } catch (error: any) {
      return error.code === "EPERM";
    }
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  resources_json TEXT NOT NULL,
  slots_json TEXT NOT NULL DEFAULT '{}',
  label TEXT NOT NULL DEFAULT '',
  owner_ref TEXT,
  repo TEXT,
  pid INTEGER,
  pid_start INTEGER,
  pgid INTEGER,
  enqueued_at INTEGER NOT NULL,
  granted_at INTEGER,
  heartbeat_at INTEGER,
  finished_at INTEGER,
  wait_deadline INTEGER,
  run_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  outcome TEXT,
  exit_code INTEGER,
  note TEXT,
  job_json TEXT,
  log_path TEXT,
  tail TEXT,
  reported_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tickets_state ON tickets(state, seq);
CREATE INDEX IF NOT EXISTS idx_tickets_owner ON tickets(owner_ref);
CREATE TABLE IF NOT EXISTS runners (
  pid INTEGER PRIMARY KEY,
  pid_start INTEGER,
  repo TEXT,
  heartbeat_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS resource_hints (
  name TEXT PRIMARY KEY,
  capacity INTEGER NOT NULL,
  memory_mb INTEGER NOT NULL
);
`;

/** A ticket that has waited this long and still cannot run blocks everything behind it. */
export const STARVATION_MS = 30_000;
/** A holder that has not heartbeated for this long is torn down and its units are freed. */
export const LEASE_MS = 120_000;
/**
 * With nothing of ours running, a request that has waited this long for memory runs anyway: the
 * pressure comes from outside the queue and waiting longer would never end.
 */
export const IDLE_MEMORY_OVERRIDE_MS = 5 * 60_000;
/** Memory of a fresh grant keeps counting against headroom for this long, until it shows in MemAvailable. */
export const RAMP_MS = 90_000;
/** Finished tickets are kept this long for status and for owners to read results. */
const KEEP_FINISHED_MS = 24 * 3600_000;
export const DEFAULT_WAIT_MS = 3 * 3600_000;
const MAX_JOB_ATTEMPTS = 3;

export interface BrokerOptions {
  readonly home?: string;
  /** Replace the clock and host readings (tests). */
  readonly now?: () => number;
  readonly host?: () => HostSnapshot;
  readonly config?: () => ResourceConfig;
  /** Called to tear down a process group of a holder that stopped heartbeating. */
  readonly killGroup?: (pgid: number) => void;
}

export interface ResourceStatus {
  readonly name: string;
  readonly capacity: number;
  readonly active: number;
  readonly waiting: number;
  readonly holders: ReadonlyArray<{
    ticket: string;
    label: string;
    pid: number | null;
    sinceMs: number;
    slots: ReadonlyArray<number>;
  }>;
  readonly queue: ReadonlyArray<{
    ticket: string;
    label: string;
    waitingMs: number;
    position: number;
  }>;
}

export class ResourceBroker {
  readonly db: NodeSqlite.DatabaseSync;
  private readonly now: () => number;
  private readonly host: () => HostSnapshot;
  private readonly config: () => ResourceConfig;
  private readonly killGroup: (pgid: number) => void;

  constructor(options: BrokerOptions = {}) {
    const home = options.home ?? brokerHome();
    NodeFS.mkdirSync(home, { recursive: true });
    // Many processes may open a brand-new broker at the same moment; switching to WAL and creating
    // the tables can then report "locked" even with a busy timeout, so setup is simply tried again.
    let db: NodeSqlite.DatabaseSync | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        db = new NodeSqlite.DatabaseSync(NodePath.join(home, "broker.sqlite"));
        db.exec("PRAGMA busy_timeout = 15000;");
        db.exec("PRAGMA journal_mode = WAL;");
        db.exec("PRAGMA synchronous = NORMAL;");
        db.exec(SCHEMA);
        break;
      } catch (error) {
        try {
          db?.close();
        } catch {
          // nothing to close
        }
        if (attempt >= 8) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 + attempt * 150);
      }
    }
    this.db = db;
    this.now = options.now ?? Date.now;
    this.host = options.host ?? readHost;
    this.config = options.config ?? loadResourceConfig;
    this.killGroup =
      options.killGroup ??
      ((pgid) => {
        for (const signal of ["SIGTERM", "SIGKILL"] as const) {
          try {
            process.kill(-pgid, signal);
          } catch {
            return;
          }
          if (signal === "SIGTERM")
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
        }
      });
  }

  close(): void {
    this.db.close();
  }

  private tx<A>(body: () => A): A {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const value = body();
      this.db.exec("COMMIT;");
      return value;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // already rolled back
      }
      throw error;
    }
  }

  /** Effective capacity and memory of a resource: configuration, then a repository's hint, then 1/0. */
  definitionOf(name: string, config = this.config()): ResourceDefinition {
    const configured = config.resources[name];
    if (configured) return configured;
    const hint = this.db
      .prepare("SELECT capacity, memory_mb FROM resource_hints WHERE name = ?")
      .get(name) as { capacity: number; memory_mb: number } | undefined;
    return hint
      ? { capacity: hint.capacity, memoryMb: hint.memory_mb }
      : { capacity: 1, memoryMb: 0 };
  }

  enqueue(request: ResourceRequest): Ticket {
    const needs = new Map<string, number>();
    for (const item of request.resources) {
      const name = normalizeResource(item.name);
      needs.set(name, Math.max(needs.get(name) ?? 0, Math.max(item.units ?? 1, 1)));
    }
    const resources = [...needs.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, units]) => ({ name, units }));
    const id = `rt-${NodeCrypto.randomBytes(5).toString("hex")}`;
    const now = this.now();
    const pid = request.pid ?? null;
    const config = this.config();
    return this.tx(() => {
      for (const [name, hint] of Object.entries(request.hints ?? {})) {
        const key = normalizeResource(name);
        if (config.resources[key]) continue;
        this.db
          .prepare(
            `INSERT INTO resource_hints (name, capacity, memory_mb) VALUES (?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET capacity = excluded.capacity, memory_mb = excluded.memory_mb`,
          )
          .run(key, Math.max(hint.capacity ?? 1, 0), Math.max(hint.memoryMb ?? 0, 0));
      }
      const unavailable = resources.find(
        (item) => this.definitionOf(item.name, config).capacity < 1,
      );
      this.db
        .prepare(
          `INSERT INTO tickets (id, kind, state, resources_json, label, owner_ref, repo, pid, pid_start,
             enqueued_at, wait_deadline, run_ms, job_json, outcome, note, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          request.job ? "job" : "run",
          unavailable ? "done" : "waiting",
          JSON.stringify(resources),
          request.label ?? "",
          request.ownerRef ?? null,
          request.repo ?? null,
          pid,
          pid ? processStartTicks(pid) : null,
          now,
          now + (request.waitMs ?? DEFAULT_WAIT_MS),
          request.runMs ?? null,
          request.job ? JSON.stringify({ ...request.job, env: request.job.env ?? {} }) : null,
          unavailable ? "unavailable" : null,
          unavailable ? `This machine has no ${unavailable.name} (capacity 0).` : null,
          unavailable ? now : null,
        );
      return this.get(id)!;
    });
  }

  get(id: string): Ticket | null {
    const row = this.db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as
      | TicketRow
      | undefined;
    return row ? toTicket(row) : null;
  }

  /** Jobs and tickets of one owner (a task of one repository), oldest first. */
  forOwner(ownerRef: string, repo?: string): Ticket[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM tickets WHERE owner_ref = ? ${repo ? "AND repo = ?" : ""} ORDER BY seq`,
        )
        .all(...(repo ? [ownerRef, repo] : [ownerRef])) as unknown as TicketRow[]
    ).map(toTicket);
  }

  /** Stored jobs that finished and whose owner has not been told yet. */
  unreportedJobs(repo?: string): Ticket[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM tickets WHERE kind = 'job' AND state IN ('done','cancelled','expired')
             AND reported_at IS NULL ${repo ? "AND repo = ?" : ""} ORDER BY seq`,
        )
        .all(...(repo ? [repo] : [])) as unknown as TicketRow[]
    ).map(toTicket);
  }

  markReported(id: string): void {
    this.db.prepare("UPDATE tickets SET reported_at = ? WHERE id = ?").run(this.now(), id);
  }

  /** Waiting-or-running stored jobs of an owner, i.e. work the owner is still waiting for. */
  openJobsFor(ownerRef: string, repo?: string): Ticket[] {
    return this.forOwner(ownerRef, repo).filter(
      (ticket) =>
        ticket.kind === "job" &&
        (ticket.state === "waiting" || ticket.state === "granted" || ticket.state === "running"),
    );
  }

  heartbeat(id: string, extra?: { pid?: number; pgid?: number }): boolean {
    const now = this.now();
    const result = this.db
      .prepare(
        `UPDATE tickets SET heartbeat_at = ?, pgid = COALESCE(?, pgid)
         WHERE id = ? AND state IN ('waiting','granted','running')`,
      )
      .run(now, extra?.pgid ?? null, id);
    if (extra?.pid !== undefined) {
      this.db
        .prepare("UPDATE tickets SET pid = ?, pid_start = ? WHERE id = ?")
        .run(extra.pid, processStartTicks(extra.pid), id);
    }
    return Number(result.changes) > 0;
  }

  /** The holder is running its command now (records the process group to tear down if it hangs). */
  markRunning(id: string, pgid: number | null): void {
    this.db
      .prepare(
        "UPDATE tickets SET state = 'running', pgid = ?, heartbeat_at = ? WHERE id = ? AND state = 'granted'",
      )
      .run(pgid, this.now(), id);
  }

  finish(
    id: string,
    result: {
      outcome: TicketOutcome;
      exitCode?: number | null;
      note?: string | null;
      tail?: string | null;
      logPath?: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE tickets SET state = 'done', outcome = ?, exit_code = ?, note = COALESCE(?, note),
           tail = COALESCE(?, tail), log_path = COALESCE(?, log_path), finished_at = ?
         WHERE id = ? AND state IN ('waiting','granted','running')`,
      )
      .run(
        result.outcome,
        result.exitCode ?? null,
        result.note ?? null,
        result.tail ?? null,
        result.logPath ?? null,
        this.now(),
        id,
      );
  }

  cancel(id: string, note = "cancelled"): void {
    this.db
      .prepare(
        `UPDATE tickets SET state = 'cancelled', outcome = 'cancelled', note = ?, finished_at = ?
         WHERE id = ? AND state IN ('waiting','granted','running')`,
      )
      .run(note, this.now(), id);
  }

  /** Turn a waiting `run` ticket into a stored job the caller no longer waits for. */
  convertToJob(
    id: string,
    job: { command: string; cwd: string; env?: Record<string, string> },
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE tickets SET kind = 'job', pid = NULL, pid_start = NULL, job_json = ?
         WHERE id = ? AND state = 'waiting'`,
      )
      .run(JSON.stringify({ ...job, env: job.env ?? {} }), id);
    return Number(result.changes) > 0;
  }

  // ── runners ──────────────────────────────────────────────────────────────

  registerRunner(pid: number, repo: string | null): void {
    this.db
      .prepare(
        `INSERT INTO runners (pid, pid_start, repo, heartbeat_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(pid) DO UPDATE SET heartbeat_at = excluded.heartbeat_at, repo = excluded.repo, pid_start = excluded.pid_start`,
      )
      .run(pid, processStartTicks(pid), repo, this.now());
  }

  unregisterRunner(pid: number): void {
    this.db.prepare("DELETE FROM runners WHERE pid = ?").run(pid);
  }

  /** Granted jobs assigned to a runner process, oldest first. */
  grantedJobsFor(runnerPid: number): Ticket[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM tickets WHERE kind = 'job' AND state = 'granted' AND pid = ? ORDER BY seq",
        )
        .all(runnerPid) as unknown as TicketRow[]
    ).map(toTicket);
  }

  // ── the queue ────────────────────────────────────────────────────────────

  /**
   * Retire dead and stalled holders, give up waiters that ran out of patience, then grant
   * every ticket that fits, in order. Safe to call from any process at any time; the result is
   * the tickets granted by this call.
   */
  pump(): Ticket[] {
    const granted: string[] = [];
    const killList: number[] = [];
    this.tx(() => {
      const now = this.now();
      const config = this.config();
      const host = this.host();

      // 1. Holders that vanished or stopped heartbeating.
      const holding = this.db
        .prepare("SELECT * FROM tickets WHERE state IN ('granted','running') ORDER BY seq")
        .all() as unknown as TicketRow[];
      for (const row of holding) {
        const owned = row.pid !== null;
        const alive = owned ? processIsLive(row.pid!, row.pid_start) : false;
        const silent = now - (row.heartbeat_at ?? row.granted_at ?? now) > LEASE_MS;
        if (alive && !silent) continue;
        if (row.kind === "job") {
          // A job whose runner died goes back in line, unless it keeps dying.
          const attempts = row.attempts + 1;
          if (row.pgid !== null) killList.push(row.pgid);
          if (attempts >= MAX_JOB_ATTEMPTS) {
            this.db
              .prepare(
                `UPDATE tickets SET state = 'done', outcome = 'interrupted', attempts = ?, note = ?, finished_at = ?, pid = NULL WHERE id = ?`,
              )
              .run(
                attempts,
                `The runner disappeared ${attempts} times while running this job.`,
                now,
                row.id,
              );
          } else {
            this.db
              .prepare(
                `UPDATE tickets SET state = 'waiting', attempts = ?, pid = NULL, pid_start = NULL, pgid = NULL,
                   slots_json = '{}', granted_at = NULL, heartbeat_at = NULL, note = ? WHERE id = ?`,
              )
              .run(attempts, "Its runner disappeared; waiting again.", row.id);
          }
        } else {
          if (alive && row.pgid !== null) killList.push(row.pgid);
          else if (!alive && row.pgid !== null) killList.push(row.pgid);
          this.db
            .prepare(
              `UPDATE tickets SET state = 'expired', outcome = 'interrupted', note = ?, finished_at = ? WHERE id = ?`,
            )
            .run(
              alive
                ? "The holder stopped heartbeating and was torn down."
                : "The holder process vanished.",
              now,
              row.id,
            );
        }
      }

      // 2. Waiters whose process is gone, or who ran out of patience.
      const waitingRows = this.db
        .prepare("SELECT * FROM tickets WHERE state = 'waiting' ORDER BY seq")
        .all() as unknown as TicketRow[];
      const stillWaiting: TicketRow[] = [];
      for (const row of waitingRows) {
        if (row.kind === "run" && row.pid !== null && !processIsLive(row.pid, row.pid_start)) {
          this.db
            .prepare(
              `UPDATE tickets SET state = 'cancelled', outcome = 'cancelled', note = 'the waiting process vanished', finished_at = ? WHERE id = ?`,
            )
            .run(now, row.id);
          continue;
        }
        if (row.wait_deadline !== null && now > row.wait_deadline) {
          this.db
            .prepare(
              `UPDATE tickets SET state = 'done', outcome = 'exhausted', note = ?, finished_at = ? WHERE id = ?`,
            )
            .run(
              "Waited for the resource until the wait limit; it never became available.",
              now,
              row.id,
            );
          continue;
        }
        stillWaiting.push(row);
      }

      // 3. Grant in order.
      const active = this.db
        .prepare("SELECT * FROM tickets WHERE state IN ('granted','running')")
        .all() as unknown as TicketRow[];
      const used = new Map<string, Set<number>>();
      const useSlots = (slots: Record<string, number[]>) => {
        for (const [name, list] of Object.entries(slots)) {
          const set = used.get(name) ?? new Set<number>();
          for (const slot of list) set.add(slot);
          used.set(name, set);
        }
      };
      let rampingMb = 0;
      for (const row of active) {
        useSlots(parse(row.slots_json, {}));
        if (row.granted_at !== null && now - row.granted_at < RAMP_MS) {
          rampingMb += this.memoryOf(parse(row.resources_json, []), config);
        }
      }
      const runners = this.db
        .prepare("SELECT pid, pid_start, repo, heartbeat_at FROM runners")
        .all() as Array<{
        pid: number;
        pid_start: number | null;
        repo: string | null;
        heartbeat_at: number;
      }>;
      const liveRunners = runners.filter((runner) => {
        if (now - runner.heartbeat_at > 30_000 || !processIsLive(runner.pid, runner.pid_start)) {
          this.db.prepare("DELETE FROM runners WHERE pid = ?").run(runner.pid);
          return false;
        }
        return true;
      });
      let headBlocked = false;
      let freeMb = host.availableMb - config.reserveMb - rampingMb;
      for (const row of stillWaiting) {
        if (headBlocked) break;
        const needs = parse<Array<{ name: string; units: number }>>(row.resources_json, []);
        const aged = now - row.enqueued_at >= STARVATION_MS;
        let runner: (typeof liveRunners)[number] | undefined;
        if (row.kind === "job") {
          runner = liveRunners.find(
            (candidate) => candidate.repo === null || candidate.repo === row.repo,
          );
          if (!runner) continue; // no runner can run it yet; it keeps its place without blocking others
        }
        const slotsFor: Record<string, number[]> = {};
        let fits = true;
        for (const item of needs) {
          const definition = this.definitionOf(item.name, config);
          const taken = used.get(item.name) ?? new Set<number>();
          const free: number[] = [];
          for (let slot = 0; slot < definition.capacity; slot++)
            if (!taken.has(slot)) free.push(slot);
          if (free.length < item.units) {
            fits = false;
            break;
          }
          slotsFor[item.name] = free.slice(0, item.units);
        }
        const memoryMb = this.memoryOf(needs, config);
        // Nothing of ours is running, so the shortage is not ours to wait out forever.
        const idle =
          active.length === 0 &&
          granted.length === 0 &&
          now - row.enqueued_at >= IDLE_MEMORY_OVERRIDE_MS;
        const memoryFits = memoryMb === 0 || idle || freeMb >= memoryMb;
        if (fits && memoryFits) {
          this.db
            .prepare(
              `UPDATE tickets SET state = 'granted', slots_json = ?, granted_at = ?, heartbeat_at = ?, ${
                runner ? "pid = ?, pid_start = ?," : ""
              } note = NULL WHERE id = ?`,
            )
            .run(
              JSON.stringify(slotsFor),
              now,
              now,
              ...(runner ? [runner.pid, runner.pid_start] : []),
              row.id,
            );
          useSlots(slotsFor);
          freeMb -= memoryMb;
          granted.push(row.id);
          continue;
        }
        this.db
          .prepare("UPDATE tickets SET note = ? WHERE id = ?")
          .run(
            !fits
              ? "waiting for a free slot"
              : `waiting for memory (${Math.max(Math.round(freeMb), 0)} MB headroom, needs ${memoryMb} MB)`,
            row.id,
          );
        if (aged) headBlocked = true;
      }

      // 4. Forget old finished tickets.
      this.db
        .prepare(
          "DELETE FROM tickets WHERE state IN ('done','cancelled','expired') AND finished_at < ? AND (kind = 'run' OR reported_at IS NOT NULL)",
        )
        .run(now - KEEP_FINISHED_MS);
    });
    for (const pgid of killList) {
      try {
        this.killGroup(pgid);
      } catch {
        // already gone
      }
    }
    return granted.map((id) => this.get(id)!).filter(Boolean);
  }

  private memoryOf(
    needs: ReadonlyArray<{ name: string; units: number }>,
    config: ResourceConfig,
  ): number {
    return needs.reduce(
      (sum, item) => sum + item.units * this.definitionOf(item.name, config).memoryMb,
      0,
    );
  }

  /** Where a waiting ticket stands in line for each of its resources (1 = next). */
  position(id: string): number {
    const row = this.db.prepare("SELECT seq FROM tickets WHERE id = ?").get(id) as
      | { seq: number }
      | undefined;
    if (!row) return 0;
    const count = this.db
      .prepare("SELECT COUNT(*) AS n FROM tickets WHERE state = 'waiting' AND seq <= ?")
      .get(row.seq) as { n: number };
    return Number(count.n);
  }

  status(): { resources: ResourceStatus[]; host: HostSnapshot; reserveMb: number } {
    const config = this.config();
    const now = this.now();
    const rows = (
      this.db
        .prepare(
          "SELECT * FROM tickets WHERE state IN ('waiting','granted','running') ORDER BY seq",
        )
        .all() as unknown as TicketRow[]
    ).map(toTicket);
    const names = new Set<string>([...Object.keys(config.resources)]);
    for (const ticket of rows) for (const item of ticket.resources) names.add(item.name);
    const resources = [...names].sort().map((name): ResourceStatus => {
      const definition = this.definitionOf(name, config);
      const holders = rows.filter(
        (ticket) =>
          (ticket.state === "granted" || ticket.state === "running") &&
          ticket.resources.some((item) => item.name === name),
      );
      const queue = rows.filter(
        (ticket) =>
          ticket.state === "waiting" && ticket.resources.some((item) => item.name === name),
      );
      return {
        name,
        capacity: definition.capacity,
        active: holders.reduce(
          (sum, ticket) => sum + (ticket.resources.find((item) => item.name === name)?.units ?? 0),
          0,
        ),
        waiting: queue.length,
        holders: holders.map((ticket) => ({
          ticket: ticket.id,
          label: ticket.label,
          pid: ticket.pid,
          sinceMs: now - (ticket.grantedAt ?? now),
          slots: ticket.slots[name] ?? [],
        })),
        queue: queue.map((ticket, index) => ({
          ticket: ticket.id,
          label: ticket.label,
          waitingMs: now - ticket.enqueuedAt,
          position: index + 1,
        })),
      };
    });
    return { resources, host: this.host(), reserveMb: config.reserveMb };
  }
}

export function openBroker(options: BrokerOptions = {}): ResourceBroker {
  return new ResourceBroker(options);
}
