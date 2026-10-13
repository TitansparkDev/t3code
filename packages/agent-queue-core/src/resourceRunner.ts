// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * Running things under the broker (resourceBroker.ts): wait in the fair queue, take the physical
 * lock files, heartbeat while the work runs, tear it down at its time limit, record how it ended.
 *
 * The physical lock files are the same ones `agent-resources` uses (flock slot files in the
 * account's lock directory, plus `/tmp/android-heavy.lock` for the first emulator slot), so older
 * scripts that still call `agent-resources run --class android` or `flock /tmp/android-heavy.lock`
 * exclude AgentQueue work and the other way round. A lock held by `flock` dies with the process
 * tree that holds it, so a crashed holder never leaves a stale lock.
 *
 * @module resourceRunner
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  brokerHome,
  legacyAndroidLock,
  lockRoot,
  normalizeResource,
  openBroker,
  type BrokerOptions,
  type ResourceBroker,
  type ResourceRequest,
  type Ticket,
  type TicketOutcome,
} from "./resourceBroker.ts";

/** Resources a command needs, inferred from the command line. Repository rules add to these. */
const COMMAND_RULES: ReadonlyArray<readonly [RegExp, ReadonlyArray<string>]> = [
  [/(^|[\s/;&|])(\.\/)?gradlew?(\.bat)?(\s|$)/, ["heavy_build"]],
  [
    /connected\w*(Android)?Test|connectedCheck|\bmaestro\b|\bemulator\b|avdmanager|(^|\s)adb\s+(install|shell|-s|logcat|emu)/i,
    ["android"],
  ],
  [/(^|[\s/;&|])(docker(-|\s+)compose|docker\s+(run|build|compose|buildx)|podman)\b/, ["docker"]],
  [/(^|[\s/;&|])(pg_ctl|initdb|postgres)\b/, ["postgres"]],
  [/\b(playwright|cypress|chromium|puppeteer)\b/i, ["browser"]],
  [
    /(^|[\s/;&|])(pnpm|npm|yarn|bun|vp)\s+(i|install|add|ci)(\s|$)|(^|[\s/;&|])(pip3?|uv)\s+(install|sync|pip install)|(^|[\s/;&|])cargo\s+fetch/,
    ["package_install"],
  ],
  [
    /\b(nvidia-smi|cuda|torch\.cuda)\b|(^|\s)-m\s+["']?gpu\b|--gpu\b|pytest[^|]*(?<!not )\bgpu\b/i,
    ["gpu"],
  ],
];

export function inferResources(
  command: string,
  repoResources: ReadonlyArray<{
    readonly name: string;
    readonly commands: ReadonlyArray<string>;
  }> = [],
): string[] {
  const found = new Set<string>();
  for (const [pattern, names] of COMMAND_RULES) {
    if (pattern.test(command)) for (const name of names) found.add(name);
  }
  for (const resource of repoResources) {
    for (const expression of resource.commands) {
      try {
        if (new RegExp(expression).test(command)) found.add(normalizeResource(resource.name));
      } catch {
        if (command.includes(expression)) found.add(normalizeResource(resource.name));
      }
    }
  }
  return [...found].sort();
}

const LEGACY_CLASSES = new Set(["android", "browser", "heavy_build", "package_install", "codegen"]);

/** The flock files that physically guard one slot of a resource. Empty for broker-only resources. */
export function lockFilesFor(name: string, slot: number): string[] {
  const files: string[] = [];
  if (LEGACY_CLASSES.has(name)) {
    const dir = NodePath.join(lockRoot(), name);
    NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = NodePath.join(dir, `slot-${slot}.lock`);
    if (!NodeFS.existsSync(file)) NodeFS.closeSync(NodeFS.openSync(file, "a", 0o600));
    files.push(file);
  }
  const legacy = legacyAndroidLock();
  if (name === "android" && slot === 0 && legacy) {
    if (!NodeFS.existsSync(legacy)) {
      try {
        NodeFS.closeSync(NodeFS.openSync(legacy, "a", 0o666));
      } catch {
        return files;
      }
    }
    files.push(legacy);
  }
  return files;
}

/** Locks to take for a granted ticket, in a fixed order so two tickets cannot deadlock. */
export function ticketLockFiles(ticket: Ticket): string[] {
  const files: string[] = [];
  for (const item of ticket.resources) {
    for (const slot of ticket.slots[item.name] ?? []) files.push(...lockFilesFor(item.name, slot));
  }
  return [...new Set(files)].sort();
}

/** Environment a granted ticket gives its command: which slot it owns, which emulator to use. */
export function ticketEnv(ticket: Ticket): Record<string, string> {
  const env: Record<string, string> = {
    AGENTQUEUE_RESOURCE_TICKET: ticket.id,
    AGENTQUEUE_RESOURCES: ticket.resources.map((item) => item.name).join(","),
  };
  for (const item of ticket.resources) {
    const slots = ticket.slots[item.name] ?? [];
    env[`AGENTQUEUE_SLOT_${item.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] = slots.join(",");
  }
  const emulatorSlot = ticket.slots.android?.[0];
  if (emulatorSlot !== undefined) {
    const port = 5554 + emulatorSlot * 2;
    env.AGENTQUEUE_EMULATOR_PORT = String(port);
    env.ANDROID_SERIAL = `emulator-${port}`;
  }
  return env;
}

/** The environment a stored job keeps: what a build needs, never credentials. */
export function jobEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const allowed =
    /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z]+|TMPDIR|TZ|CI|JAVA_HOME|ANDROID_[A-Z_]+|GRADLE_[A-Z_]+|ORG_GRADLE_[A-Z_]+|KOTLIN_[A-Z_]+|DOCKER_[A-Z_]+|COMPOSE_[A-Z_]+|UV_[A-Z_]+|PYTHON[A-Z_]*|VIRTUAL_ENV|NODE_[A-Z_]+|NPM_[A-Z_]+|PNPM_[A-Z_]+|BUN_[A-Z_]+|CARGO_[A-Z_]+|RUST[A-Z_]*|GOPATH|GOFLAGS|XDG_[A-Z_]+|AGENTQUEUE_[A-Z0-9_]+|OVERSEER_[A-Z0-9_]+|PGPORT|PGDATABASE)$/;
  const secret = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|COOKIE|BEARER/i;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || !allowed.test(name) || secret.test(name)) continue;
    env[name] = value;
  }
  return env;
}

export class ResourceWaitError extends Error {
  readonly outcome: "exhausted" | "unavailable" | "cancelled";
  readonly ticket: Ticket;
  constructor(outcome: "exhausted" | "unavailable" | "cancelled", message: string, ticket: Ticket) {
    super(message);
    this.name = "ResourceWaitError";
    this.outcome = outcome;
    this.ticket = ticket;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wait in line until the ticket is granted. Any waiter pumps the queue, so no daemon has to be
 * running. Resolves with the granted ticket, or throws `ResourceWaitError` saying exactly why not.
 */
export async function waitForGrant(
  broker: ResourceBroker,
  ticketId: string,
  options: {
    readonly onWaiting?: (ticket: Ticket, position: number) => void;
    readonly reportEveryMs?: number;
    /** Resolve `"defer"` instead of waiting once this much time passed (the caller turns the ticket into a stored job). */
    readonly deferAfterMs?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<Ticket | "defer"> {
  const started = Date.now();
  let lastReport = 0;
  let delay = 150;
  while (true) {
    broker.pump();
    const ticket = broker.get(ticketId);
    if (!ticket) throw new Error(`Resource ticket ${ticketId} disappeared.`);
    if (ticket.state === "granted" || ticket.state === "running") return ticket;
    if (ticket.state !== "waiting") {
      const outcome =
        ticket.outcome === "exhausted" || ticket.outcome === "unavailable"
          ? ticket.outcome
          : "cancelled";
      throw new ResourceWaitError(
        outcome,
        ticket.note ?? `The resource request ended: ${ticket.outcome}.`,
        ticket,
      );
    }
    if (options.signal?.aborted) {
      broker.cancel(ticketId, "the caller stopped waiting");
      throw new ResourceWaitError("cancelled", "Stopped waiting.", ticket);
    }
    const waited = Date.now() - started;
    if (options.deferAfterMs !== undefined && waited >= options.deferAfterMs) return "defer";
    if (options.onWaiting && Date.now() - lastReport >= (options.reportEveryMs ?? 30_000)) {
      lastReport = Date.now();
      options.onWaiting(ticket, broker.position(ticketId));
    }
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.4), 1000);
  }
}

function flockPrefix(files: ReadonlyArray<string>, waitSeconds: number): string[] {
  const prefix: string[] = [];
  for (const file of files)
    prefix.push("flock", "-w", String(Math.max(waitSeconds, 1)), "-E", "111", file);
  return prefix;
}

export interface CommandResult {
  readonly outcome: TicketOutcome;
  readonly exitCode: number;
  readonly tail: string;
  readonly logPath: string | null;
}

const TAIL_BYTES = 6000;

function killTree(pgid: number): void {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-pgid, signal);
    } catch {
      return;
    }
    if (signal === "SIGTERM") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
}

/**
 * Run `argv` while the ticket's resources are held. The command runs in its own process group,
 * wrapped in `flock` for every physical lock, so an orphaned command keeps its locks until it
 * ends. Heartbeats keep the lease; the group is killed at `runMs`.
 */
export async function runGranted(
  broker: ResourceBroker,
  ticket: Ticket,
  command: {
    argv: ReadonlyArray<string>;
    cwd: string;
    env?: Record<string, string>;
    stdio?: "inherit" | "pipe";
    logFile?: string;
  },
): Promise<CommandResult> {
  const files = ticketLockFiles(ticket);
  const lockWait = 1800;
  const full = [...flockPrefix(files, lockWait), ...command.argv];
  const logPath = command.logFile ?? null;
  let logFd: number | null = null;
  if (logPath) {
    NodeFS.mkdirSync(NodePath.dirname(logPath), { recursive: true });
    logFd = NodeFS.openSync(logPath, "a");
  }
  const tail: string[] = [];
  let tailBytes = 0;
  const keep = (chunk: Buffer) => {
    if (logFd !== null) NodeFS.writeSync(logFd, chunk);
    tail.push(chunk.toString("utf8"));
    tailBytes += chunk.length;
    while (tailBytes > TAIL_BYTES * 2 && tail.length > 1)
      tailBytes -= Buffer.byteLength(tail.shift()!);
  };
  const child = NodeChildProcess.spawn(full[0]!, full.slice(1), {
    cwd: command.cwd,
    env: { ...process.env, ...command.env, ...ticketEnv(ticket) },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pgid = child.pid ?? null;
  broker.markRunning(ticket.id, pgid);
  if (pgid !== null) broker.heartbeat(ticket.id, { pgid });
  child.stdout!.on("data", (chunk: Buffer) => {
    if (command.stdio === "inherit") process.stdout.write(chunk);
    keep(chunk);
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    if (command.stdio === "inherit") process.stderr.write(chunk);
    keep(chunk);
  });
  const beat = setInterval(() => broker.heartbeat(ticket.id), 10_000);
  let timedOut = false;
  const limit =
    ticket.runMs !== null
      ? setTimeout(() => {
          timedOut = true;
          if (pgid !== null) killTree(pgid);
        }, ticket.runMs)
      : null;
  const forward = (signal: NodeJS.Signals) => {
    if (pgid !== null) {
      try {
        process.kill(-pgid, signal);
      } catch {
        // gone
      }
    }
  };
  const onTerm = () => forward("SIGTERM");
  const onInt = () => forward("SIGINT");
  process.once("SIGTERM", onTerm);
  process.once("SIGINT", onInt);
  const code = await new Promise<number>((resolve) => {
    child.on("error", (error) => {
      keep(Buffer.from(`${error.message}\n`));
      resolve(127);
    });
    child.on("close", (exit, signal) => resolve(exit ?? (signal ? 128 : 1)));
  });
  clearInterval(beat);
  if (limit) clearTimeout(limit);
  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onInt);
  if (logFd !== null) NodeFS.closeSync(logFd);
  const text = tail.join("").slice(-TAIL_BYTES);
  const lockTimedOut = code === 111 && files.length > 0;
  const outcome: TicketOutcome = timedOut
    ? "timed-out"
    : lockTimedOut
      ? "exhausted"
      : code === 0
        ? "ok"
        : "failed";
  const exitCode = timedOut ? 124 : lockTimedOut ? 76 : code;
  broker.finish(ticket.id, {
    outcome,
    exitCode,
    tail: text,
    logPath,
    note: lockTimedOut
      ? "A script outside AgentQueue held the same lock file for the whole wait."
      : timedOut
        ? `Killed at its time limit (${ticket.runMs} ms).`
        : null,
  });
  return { outcome, exitCode, tail: text, logPath };
}

export interface RunUnderBrokerOptions extends Omit<ResourceRequest, "job"> {
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly stdio?: "inherit" | "pipe";
  readonly logFile?: string;
  readonly onWaiting?: (ticket: Ticket, position: number) => void;
  /** When set the request becomes a stored job after waiting this long (the caller then ends its turn). */
  readonly deferAfterMs?: number;
  readonly broker?: ResourceBroker;
  readonly brokerOptions?: BrokerOptions;
}

export type RunUnderBrokerResult =
  | { readonly kind: "ran"; readonly result: CommandResult; readonly ticket: Ticket }
  | { readonly kind: "deferred"; readonly ticket: Ticket }
  | {
      readonly kind: "not-granted";
      readonly outcome: "exhausted" | "unavailable" | "cancelled";
      readonly message: string;
      readonly ticket: Ticket;
    };

/** The one door a command goes through: wait for its resources, run, report how it ended. */
export async function runUnderBroker(
  options: RunUnderBrokerOptions,
): Promise<RunUnderBrokerResult> {
  const broker = options.broker ?? openBroker(options.brokerOptions);
  const owned = options.broker === undefined;
  try {
    const ticket = broker.enqueue({
      resources: options.resources,
      pid: process.pid,
      ...(options.label ? { label: options.label } : {}),
      ...(options.ownerRef ? { ownerRef: options.ownerRef } : {}),
      ...(options.repo ? { repo: options.repo } : {}),
      ...(options.hints ? { hints: options.hints } : {}),
      ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
      ...(options.runMs !== undefined ? { runMs: options.runMs } : {}),
    });
    if (ticket.state === "done") {
      return {
        kind: "not-granted",
        outcome: "unavailable",
        message: ticket.note ?? "unavailable",
        ticket,
      };
    }
    try {
      const granted = await waitForGrant(broker, ticket.id, {
        ...(options.onWaiting ? { onWaiting: options.onWaiting } : {}),
        ...(options.deferAfterMs !== undefined ? { deferAfterMs: options.deferAfterMs } : {}),
      });
      if (granted === "defer") {
        const converted = broker.convertToJob(ticket.id, {
          command: options.argv.map(shQuote).join(" "),
          cwd: options.cwd,
          env: jobEnvironment({ ...process.env, ...options.env }),
        });
        if (!converted) {
          // Granted at the last moment: run it after all.
          const now = broker.get(ticket.id)!;
          if (now.state === "granted") {
            const result = await runGranted(broker, now, options);
            return { kind: "ran", result, ticket: broker.get(ticket.id)! };
          }
        }
        return { kind: "deferred", ticket: broker.get(ticket.id)! };
      }
      const result = await runGranted(broker, granted, options);
      return { kind: "ran", result, ticket: broker.get(ticket.id)! };
    } catch (error) {
      if (error instanceof ResourceWaitError) {
        return {
          kind: "not-granted",
          outcome: error.outcome,
          message: error.message,
          ticket: error.ticket,
        };
      }
      throw error;
    }
  } finally {
    if (owned) broker.close();
  }
}

const shQuote = (value: string): string =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Hold a granted ticket's physical locks for the lifetime of `body`, in this process. Used by the
 * server's own checks, which run many commands inside one operation. Helpers die with this process,
 * so a crashed server frees the locks.
 */
async function holdLocks(files: ReadonlyArray<string>, waitSeconds: number): Promise<() => void> {
  const holders: NodeChildProcess.ChildProcess[] = [];
  const release = () => {
    for (const holder of holders.toReversed()) {
      try {
        holder.stdin?.end();
        holder.kill("SIGKILL");
      } catch {
        // gone
      }
    }
  };
  try {
    for (const file of files) {
      const holder = NodeChildProcess.spawn(
        "flock",
        [
          "-w",
          String(Math.max(waitSeconds, 1)),
          "-E",
          "111",
          file,
          "sh",
          "-c",
          "echo held; exec cat >/dev/null",
        ],
        { stdio: ["pipe", "pipe", "ignore"] },
      );
      holders.push(holder);
      await new Promise<void>((resolve, reject) => {
        let seen = "";
        holder.stdout!.on("data", (chunk: Buffer) => {
          seen += chunk.toString();
          if (seen.includes("held")) resolve();
        });
        holder.on("close", (code) =>
          reject(
            new Error(
              code === 111
                ? `Timed out waiting for the lock ${file}.`
                : `lock helper ended (${code})`,
            ),
          ),
        );
        holder.on("error", reject);
      });
    }
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

export interface WithBrokerOptions {
  readonly label?: string;
  readonly ownerRef?: string;
  readonly repo?: string;
  readonly hints?: ResourceRequest["hints"];
  readonly waitMs?: number;
  readonly broker?: ResourceBroker;
  readonly brokerOptions?: BrokerOptions;
}

/**
 * Run `body` while holding the named resources (the server's own checks use this). The same
 * queue, memory admission and lock files as a worker's `agentq run`, so neither can bypass the other.
 * `body` receives the environment the grant implies (emulator serial, slots).
 */
export async function withBrokerResources<A>(
  names: ReadonlyArray<string>,
  body: (env: Record<string, string>) => Promise<A>,
  options: WithBrokerOptions = {},
): Promise<A> {
  const unique = [...new Set(names.map(normalizeResource))];
  if (unique.length === 0) return body({});
  const broker = options.broker ?? openBroker(options.brokerOptions);
  const owned = options.broker === undefined;
  const ticket = broker.enqueue({
    resources: unique.map((name) => ({ name })),
    pid: process.pid,
    label: options.label ?? "server check",
    ...(options.ownerRef ? { ownerRef: options.ownerRef } : {}),
    ...(options.repo ? { repo: options.repo } : {}),
    ...(options.hints ? { hints: options.hints } : {}),
    ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
  });
  let release = () => {};
  let beat: ReturnType<typeof setInterval> | null = null;
  try {
    if (ticket.state === "done") {
      throw new ResourceWaitError("unavailable", ticket.note ?? "unavailable", ticket);
    }
    const granted = (await waitForGrant(broker, ticket.id)) as Ticket;
    release = await holdLocks(ticketLockFiles(granted), 1800);
    broker.markRunning(ticket.id, null);
    beat = setInterval(() => broker.heartbeat(ticket.id), 10_000);
    return await body(ticketEnv(granted));
  } finally {
    if (beat) clearInterval(beat);
    release();
    const final = broker.get(ticket.id);
    if (
      final &&
      (final.state === "waiting" || final.state === "granted" || final.state === "running")
    ) {
      broker.finish(ticket.id, { outcome: "ok" });
    }
    broker.pump();
    if (owned) broker.close();
  }
}

// ── stored jobs ────────────────────────────────────────────────────────────

/** Turn a finished stored job into the short text its owner is shown. */
export function describeJob(ticket: Ticket): string {
  const how =
    ticket.outcome === "ok"
      ? "passed (exit 0)"
      : ticket.outcome === "timed-out"
        ? `was killed at its time limit`
        : ticket.outcome === "exhausted"
          ? `never got ${ticket.resources.map((r) => r.name).join(", ")} before the wait limit; nothing ran`
          : ticket.outcome === "unavailable"
            ? `cannot run: ${ticket.note ?? "this machine lacks the resource"}`
            : ticket.outcome === "interrupted"
              ? `was interrupted ${ticket.attempts} times; nothing reliable ran`
              : ticket.outcome === "cancelled"
                ? "was cancelled"
                : `failed (exit ${ticket.exitCode})`;
  return [
    `Resource job ${ticket.id} \`${ticket.job?.command ?? ticket.label}\` ${how}.`,
    ...(ticket.tail ? ["Last output:", "```", ticket.tail.slice(-2500), "```"] : []),
    ...(ticket.logPath ? [`Full log: ${ticket.logPath}`] : []),
  ].join("\n");
}

export interface JobRunner {
  /** Pump once: register, grant, start what was granted. Returns the jobs started. */
  tick(): Promise<string[]>;
  /** Stop starting jobs. Jobs already running keep running (they finish on their own). */
  stop(): void;
  readonly running: ReadonlySet<string>;
}

/**
 * The part of the system that executes stored jobs: one per server (or `agentq resource daemon`).
 * It owns no state of its own: what to run is in the broker, so a restart loses nothing; a job whose
 * runner died is queued again by the broker.
 */
export function createJobRunner(options: {
  readonly repo: string | null;
  readonly broker?: ResourceBroker;
  readonly brokerOptions?: BrokerOptions;
  readonly onFinished?: (ticket: Ticket) => void;
}): JobRunner {
  const broker = options.broker ?? openBroker(options.brokerOptions);
  const running = new Set<string>();
  let stopped = false;
  return {
    running,
    stop: () => {
      stopped = true;
      broker.unregisterRunner(process.pid);
    },
    async tick() {
      if (stopped) return [];
      broker.registerRunner(process.pid, options.repo);
      broker.pump();
      const started: string[] = [];
      for (const ticket of broker.grantedJobsFor(process.pid)) {
        if (running.has(ticket.id) || !ticket.job) continue;
        running.add(ticket.id);
        started.push(ticket.id);
        const logFile = NodePath.join(brokerHome(), "logs", `${ticket.id}.log`);
        void runGranted(broker, ticket, {
          argv: ["bash", "-c", ticket.job.command],
          cwd: ticket.job.cwd,
          env: ticket.job.env,
          logFile,
        })
          .catch((error) => {
            broker.finish(ticket.id, {
              outcome: "failed",
              exitCode: 127,
              note: String(error),
              logPath: logFile,
            });
          })
          .finally(() => {
            running.delete(ticket.id);
            const done = broker.get(ticket.id);
            if (done) options.onFinished?.(done);
          });
      }
      return started;
    },
  };
}
