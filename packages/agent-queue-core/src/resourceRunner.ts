// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/** Resource-aware process execution. @module resourceRunner */
import { ensureEmulator } from "./emulatorProvision.ts";
import { cgroupOomKills, cgroupUsedKb } from "./hostCapacity.ts";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  brokerHome,
  legacyAndroidLock,
  lockRoot,
  normalizeResource,
  openBroker,
  TYPECHECK_DEMAND_MB,
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

const COMPILERS = new Set(["tsc", "tsgo", "tsc-rs", "effect-tsgo"]);
const CHECK_SCRIPTS = new Set(["typecheck", "tc"]);
const SCRIPT_RUNNERS = new Set(["pnpm", "npm", "yarn", "bun", "vp"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** Commands that run their arguments as another command. */
const LAUNCHERS = new Set(["env", "exec", "nice", "nohup", "time", "timeout", "npx"]);
/** `timeout` takes a duration before the command; `nice` takes its value as a flag (`-n`). */
const LAUNCHERS_WITH_VALUE = new Set(["timeout"]);
/** Launcher options that take the next word as their value (`time -f FORMAT`, `env -u NAME`). */
const LAUNCHER_FLAGS_WITH_VALUE = new Set([
  "-f",
  "--format",
  "-o",
  "--output",
  "-n",
  "-s",
  "-k",
  "-u",
  "-C",
  "-S",
  "--signal",
  "--kill-after",
]);
const SCRIPT_FLAGS_WITH_VALUE = new Set(["-F", "--filter", "-C", "--dir", "--concurrency-limit"]);

/** Index of the `)` closing a `$(` that starts just before `start`, or the end of the line. */
function closingParen(line: string, start: number): number {
  let depth = 1;
  for (let i = start; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === "(") depth++;
    else if (line[i] === ")" && --depth === 0) return i;
  }
  return line.length;
}

/**
 * Splits a shell command line into simple commands, each a list of words with quotes and
 * escapes removed. Operators (`;`, `&&`, `|`, newline) start a new command, and so do
 * substitutions (`$(...)`, backticks), which are read as commands of their own. Quoted text stays
 * one word, which is how `echo "run tsc later"` is told apart from `tsc --noEmit`.
 */
function shellCommands(line: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word: string | null = null;
  let quoted = false;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === "\\") {
      const next = line[i + 1];
      if (next === undefined) break;
      const literal = quoted && !/["\\$`\n]/.test(next);
      word = (word ?? "") + (literal ? char : next);
      i++;
    } else if (char === "'" && !quoted) {
      const close = line.indexOf("'", i + 1);
      const end = close === -1 ? line.length : close;
      word = (word ?? "") + line.slice(i + 1, end);
      i = end;
    } else if (char === '"') {
      quoted = !quoted;
      word ??= "";
    } else if (char === "$" && line[i + 1] === "(") {
      const end = closingParen(line, i + 2);
      commands.push(...shellCommands(line.slice(i + 2, end)));
      word ??= "";
      i = end;
    } else if (char === "`") {
      const close = line.indexOf("`", i + 1);
      const end = close === -1 ? line.length : close;
      commands.push(...shellCommands(line.slice(i + 1, end)));
      word ??= "";
      i = end;
    } else if (!quoted && (char === " " || char === "\t" || char === "\r")) {
      endWord();
    } else if (!quoted && /[;&|()\n]/.test(char)) {
      endCommand();
    } else {
      word = (word ?? "") + char;
    }
  }
  endCommand();
  return commands;
}

const baseProgram = (word: string): string =>
  word
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(exe|cmd|bat|ps1)$/i, "");

const isAssignment = (word: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

/** True when a simple command launches a type checker, directly or through a launcher or shell. */
function launchesCompiler(words: ReadonlyArray<string>, depth: number): boolean {
  let index = 0;
  while (index < words.length && isAssignment(words[index]!)) index++;
  while (index < words.length && LAUNCHERS.has(baseProgram(words[index]!))) {
    const launcher = baseProgram(words[index]!);
    index++;
    while (index < words.length && (isAssignment(words[index]!) || words[index]!.startsWith("-"))) {
      if (LAUNCHER_FLAGS_WITH_VALUE.has(words[index]!)) index++;
      index++;
    }
    if (LAUNCHERS_WITH_VALUE.has(launcher)) index++;
  }
  const program = words[index];
  if (program === undefined) return false;
  const name = baseProgram(program);
  if (COMPILERS.has(name)) return true;
  if (name === "node") {
    const script = words[index + 1];
    return script !== undefined && COMPILERS.has(baseProgram(script).replace(/\.[cm]?js$/, ""));
  }
  if (SHELLS.has(name)) {
    const flag = words.findIndex((word, at) => at > index && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word));
    const script = flag === -1 ? undefined : words[flag + 1];
    return script !== undefined && depth < 4 && isCompilerCommand(script, depth + 1);
  }
  if (SCRIPT_RUNNERS.has(name)) {
    const rest = words.slice(index + 1);
    for (let at = 0; at < rest.length; at++) {
      const word = rest[at]!;
      if (word.startsWith("-")) {
        if (SCRIPT_FLAGS_WITH_VALUE.has(word)) at++;
        continue;
      }
      if (word === "run") continue;
      if (word === "exec") return launchesCompiler(rest.slice(at + 1), depth + 1);
      return CHECK_SCRIPTS.has(word);
    }
  }
  return false;
}

/**
 * Whether a command line runs a TypeScript checker (tsc, tsgo, tsc-rs, effect-tsgo) or the
 * repository's typecheck script. Matches the program in command position, so an argument, an
 * echoed string or a commit message that merely mentions a checker is never a launch.
 */
export function isCompilerCommand(command: string, depth = 0): boolean {
  return shellCommands(command).some((words) => launchesCompiler(words, depth));
}

export interface ResourceDemand {
  readonly name: string;
  readonly memoryMb?: number;
}

/** Resources a command line needs, with the memory a compiler run declares for admission. */
export function inferResourceDemands(
  command: string,
  repoResources: ReadonlyArray<{
    readonly name: string;
    readonly commands: ReadonlyArray<string>;
  }> = [],
): ResourceDemand[] {
  const found = new Map<string, number | undefined>();
  const add = (name: string, memoryMb?: number) => {
    const key = normalizeResource(name);
    const previous = found.get(key);
    found.set(key, memoryMb === undefined ? previous : Math.max(memoryMb, previous ?? 0));
  };
  for (const [pattern, names] of COMMAND_RULES) {
    if (pattern.test(command)) for (const name of names) add(name);
  }
  if (isCompilerCommand(command)) add("typecheck", TYPECHECK_DEMAND_MB);
  for (const resource of repoResources) {
    for (const expression of resource.commands) {
      try {
        if (new RegExp(expression).test(command)) add(resource.name);
      } catch {
        if (command.includes(expression)) add(resource.name);
      }
    }
  }
  return [...found]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, memoryMb]) => ({
      name,
      ...(memoryMb === undefined ? {} : { memoryMb }),
    }));
}

export function inferResources(
  command: string,
  repoResources: ReadonlyArray<{
    readonly name: string;
    readonly commands: ReadonlyArray<string>;
  }> = [],
): string[] {
  return inferResourceDemands(command, repoResources).map((demand) => demand.name);
}

const LEGACY_CLASSES = new Set(["android", "browser", "heavy_build", "package_install", "codegen"]);

/** The flock files that physically guard one slot of a resource. Empty for broker-only resources. */
export function lockFilesFor(name: string, slot: number): string[] {
  const files: string[] = [];
  if (name === "android" || name.startsWith("device_")) {
    const dir = NodePath.join(lockRoot(), "devices");
    NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const device = name === "android" ? `emulator-${5554 + 2 * slot}` : name.slice("device_".length);
    const file = NodePath.join(dir, `${device}.lock`);
    if (!NodeFS.existsSync(file)) NodeFS.closeSync(NodeFS.openSync(file, "a", 0o600));
    files.push(file);
  }
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

/** Finds an explicit Android target in argv before falling back to the caller's environment. */
export function requestedAndroidSerial(argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv): string | null {
  const assignment = (token: string) => token.startsWith("ANDROID_SERIAL=") ? token.slice("ANDROID_SERIAL=".length) : null;
  if (argv[0] === "env") {
    for (const token of argv.slice(1)) {
      if (!token.includes("=")) break;
      const value = assignment(token);
      if (value !== null) return value || null;
    }
  } else {
    const value = assignment(argv[0] ?? "");
    if (value !== null) return value || null;
  }
  if ((argv[0] === "bash" || argv[0] === "sh") && argv[1] === "-c") {
    const match = argv[2]?.match(/ANDROID_SERIAL=([^\s;&|]+)/);
    if (match) return match[1] || null;
  }
  return env.ANDROID_SERIAL || null;
}

let flockProbe: boolean | undefined;
export function flockAvailable(): boolean {
  if (flockProbe === undefined) {
    flockProbe =
      NodeChildProcess.spawnSync("flock", ["--version"], { stdio: "ignore" }).status === 0;
  }
  return flockProbe;
}

/** Locks to take for a granted ticket, in a fixed order so two tickets cannot deadlock. */
export function ticketLockFiles(ticket: Ticket): string[] {
  // Without util-linux `flock` (Windows, a minimal image) the broker's own queue still keeps
  // AgentQueue's users apart; only the interlock with older lock-file scripts is not available.
  if (!flockAvailable()) return [];
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
  readonly ticket?: Ticket;
  constructor(
    outcome: "exhausted" | "unavailable" | "cancelled",
    message: string,
    ticket?: Ticket,
  ) {
    super(message);
    this.name = "ResourceWaitError";
    this.outcome = outcome;
    if (ticket) this.ticket = ticket;
  }
}

export class EmulatorPrerequisiteError extends Error {
  constructor(note: string) {
    super(note);
    this.name = "EmulatorPrerequisiteError";
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
    /** Polled while waiting: true withdraws the ticket and resolves `"superseded"` (the same work finished meanwhile). */
    readonly shouldStop?: () => boolean;
  } = {},
): Promise<Ticket | "defer" | "superseded"> {
  const started = Date.now();
  let lastReport = 0;
  let delay = 150;
  while (true) {
    if (options.shouldStop && broker.get(ticketId)?.state === "waiting" && options.shouldStop()) {
      broker.cancel(ticketId, "superseded by an identical check");
      return "superseded";
    }
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
  /** Most memory the command held, in KiB: its process tree, or what its cgroup grew by (0 when unreadable). */
  readonly peakRssKb: number;
  /** The kernel killed something in the caller's cgroup for memory while the command ran. */
  readonly oomKilled: boolean;
}

/** Where memory is read from; tests replace it. */
export interface MemoryProbes {
  readonly usedKb: () => number | undefined;
  readonly oomKills: () => number | undefined;
}
const SYSTEM_PROBES: MemoryProbes = { usedKb: cgroupUsedKb, oomKills: cgroupOomKills };

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

/** Resident memory, in KiB, of every process in a process group (Linux `/proc`; 0 elsewhere). */
function treeResidentKb(pgid: number): number {
  let entries: string[];
  try {
    entries = NodeFS.readdirSync("/proc");
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = NodeFS.readFileSync(`/proc/${entry}/stat`, "utf8")
        .split(")")[1]!
        .trim()
        .split(/\s+/);
      if (Number(stat[2]) !== pgid) continue;
      const rss = /^VmRSS:\s+(\d+) kB/m.exec(NodeFS.readFileSync(`/proc/${entry}/status`, "utf8"));
      if (rss) total += Number(rss[1]);
    } catch {
      // It exited while it was being read.
    }
  }
  return total;
}

interface TreeRun {
  readonly code: number;
  readonly timedOut: boolean;
  readonly tail: string;
  readonly peakRssKb: number;
  readonly oomKilled: boolean;
}

/**
 * Run `argv` in its own process group and wait for it. The group is killed at `runMs`, so the
 * command's children cannot outlive its time limit. Output goes to the log file and to the tail.
 */
async function runTree(
  argv: ReadonlyArray<string>,
  command: {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly stdio?: "inherit" | "pipe";
    readonly logFile?: string;
  },
  runMs: number | null,
  hooks: {
    readonly onStart?: (pgid: number | null) => void;
    readonly onBeat?: () => void;
    readonly probes?: MemoryProbes;
  } = {},
): Promise<TreeRun> {
  const probes = hooks.probes ?? SYSTEM_PROBES;
  const oomBefore = probes.oomKills();
  const usedBefore = probes.usedKb();
  let logFd: number | null = null;
  if (command.logFile) {
    NodeFS.mkdirSync(NodePath.dirname(command.logFile), { recursive: true });
    logFd = NodeFS.openSync(command.logFile, "a");
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
  const child = NodeChildProcess.spawn(argv[0]!, argv.slice(1), {
    cwd: command.cwd,
    env: command.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pgid = child.pid ?? null;
  hooks.onStart?.(pgid);
  child.stdout!.on("data", (chunk: Buffer) => {
    if (command.stdio === "inherit") process.stdout.write(chunk);
    keep(chunk);
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    if (command.stdio === "inherit") process.stderr.write(chunk);
    keep(chunk);
  });
  const beat = setInterval(() => hooks.onBeat?.(), 10_000);
  let peakRssKb = 0;
  const sample =
    pgid === null
      ? null
      : setInterval(() => {
          peakRssKb = Math.max(peakRssKb, treeResidentKb(pgid));
          // Detached daemons (Gradle, Metro workers) leave the process group; the cgroup still sees them.
          const used = probes.usedKb();
          if (used !== undefined && usedBefore !== undefined)
            peakRssKb = Math.max(peakRssKb, used - usedBefore);
        }, 1000);
  let timedOut = false;
  const limit =
    runMs !== null
      ? setTimeout(() => {
          timedOut = true;
          if (pgid !== null) killTree(pgid);
        }, runMs)
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
  if (sample) clearInterval(sample);
  if (limit) clearTimeout(limit);
  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onInt);
  if (logFd !== null) NodeFS.closeSync(logFd);
  const oomAfter = probes.oomKills();
  const oomKilled = oomBefore !== undefined && oomAfter !== undefined && oomAfter > oomBefore;
  return { code, timedOut, tail: tail.join("").slice(-TAIL_BYTES), peakRssKb, oomKilled };
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
    /** Runs after the command ended and before its ticket is released, so what it records is visible to the next waiter. */
    beforeFinish?: (result: CommandResult) => void;
    /** A stored job killed for memory goes back in line instead of failing. */
    requeueOnOom?: boolean;
    probes?: MemoryProbes;
  },
): Promise<CommandResult> {
  const files = ticketLockFiles(ticket);
  const lockWait = 1800;
  const full = [...flockPrefix(files, lockWait), ...command.argv];
  const emulator = await ensureEmulator(ticketEnv(ticket), { repo: ticket.repo ?? null });
  if (!emulator.ready && emulator.blocking) {
    const tail = `[agentq] required Android emulator unavailable: ${emulator.note}\n`;
    const result: CommandResult = {
      outcome: "unavailable",
      exitCode: 77,
      tail,
      logPath: command.logFile ?? null,
      peakRssKb: 0,
      oomKilled: false,
    };
    try {
      command.beforeFinish?.(result);
    } finally {
      broker.finish(ticket.id, {
        outcome: "unavailable",
        exitCode: 77,
        tail,
        logPath: command.logFile ?? null,
        note: `Blocking Android emulator prerequisite: ${emulator.note}`,
      });
    }
    return result;
  }
  const run = await runTree(
    full,
    {
      cwd: command.cwd,
      env: { ...process.env, ...command.env, ...ticketEnv(ticket) } as Record<string, string>,
      ...(command.stdio ? { stdio: command.stdio } : {}),
      ...(command.logFile ? { logFile: command.logFile } : {}),
    },
    ticket.runMs,
    {
      onStart: (pgid) => {
        broker.markRunning(ticket.id, pgid);
        if (pgid !== null) broker.heartbeat(ticket.id, { pgid });
      },
      onBeat: () => broker.heartbeat(ticket.id),
      ...(command.probes ? { probes: command.probes } : {}),
    },
  );
  const logPath = command.logFile ?? null;
  const names = ticket.resources.map((item) => item.name);
  const measuredMb = run.peakRssKb / 1024;
  if (measuredMb > 0 && !run.timedOut) {
    // A kill hides the real need; ask for half as much again next time.
    broker.recordPeak(names, run.oomKilled ? Math.max(measuredMb * 1.5, 4096) : measuredMb * 1.1);
  }
  const lockTimedOut = run.code === 111 && files.length > 0;
  const outcome: TicketOutcome = run.timedOut
    ? "timed-out"
    : lockTimedOut
      ? "exhausted"
      : run.code === 0
        ? "ok"
        : "failed";
  const exitCode = run.timedOut ? 124 : lockTimedOut ? 76 : run.code;
  const result: CommandResult = {
    outcome,
    exitCode,
    tail: run.tail,
    logPath,
    peakRssKb: run.peakRssKb,
    oomKilled: run.oomKilled,
  };
  if (
    run.oomKilled &&
    command.requeueOnOom === true &&
    broker.requeueJob(ticket.id, "Killed for memory; waiting for more headroom.")
  ) {
    return result;
  }
  try {
    command.beforeFinish?.(result);
  } finally {
    broker.finish(ticket.id, {
      outcome,
      exitCode,
      tail: run.tail,
      logPath,
      note: lockTimedOut
        ? "A script outside AgentQueue held the same lock file for the whole wait."
        : run.timedOut
          ? `Killed at its time limit (${ticket.runMs} ms).`
          : null,
    });
  }
  return result;
}

/**
 * The ticket this process was started under, when it holds every resource asked for. A command
 * that a granted command runs (a script calling the compiler, a wrapper calling a wrapper) must not
 * queue for the units its own ancestor holds: it would wait on itself.
 */
function enclosingTicket(broker: ResourceBroker, names: ReadonlyArray<string>): Ticket | null {
  const id = process.env.AGENTQUEUE_RESOURCE_TICKET;
  if (!id) return null;
  const ticket = broker.get(id);
  if (!ticket || (ticket.state !== "granted" && ticket.state !== "running")) return null;
  const held = new Set(ticket.resources.map((item) => item.name));
  return names.every((name) => held.has(normalizeResource(name))) ? ticket : null;
}

/** A command inside a grant its caller already holds: it runs under that grant, with no ticket of its own. */
async function runNested(options: RunUnderBrokerOptions): Promise<CommandResult> {
  const run = await runTree(
    options.argv,
    {
      cwd: options.cwd,
      env: { ...process.env, ...options.env } as Record<string, string>,
      ...(options.stdio ? { stdio: options.stdio } : {}),
      ...(options.logFile ? { logFile: options.logFile } : {}),
    },
    options.runMs ?? null,
  );
  const outcome: TicketOutcome = run.timedOut ? "timed-out" : run.code === 0 ? "ok" : "failed";
  const result: CommandResult = {
    outcome,
    exitCode: run.timedOut ? 124 : run.code,
    tail: run.tail,
    logPath: options.logFile ?? null,
    peakRssKb: run.peakRssKb,
    oomKilled: false,
  };
  options.beforeFinish?.(result);
  return result;
}

/**
 * Longest a command may run once it holds its resources when the caller gives no deadline.
 * A hung build otherwise holds a single-slot resource for every other worker.
 */
export const DEFAULT_RUN_MS = 3_600_000;

export interface RunUnderBrokerOptions extends Omit<ResourceRequest, "job"> {
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly stdio?: "inherit" | "pipe";
  readonly logFile?: string;
  readonly onWaiting?: (ticket: Ticket, position: number) => void;
  /** When set the request becomes a stored job after waiting this long (the caller then ends its turn). */
  readonly deferAfterMs?: number;
  /** Polled while waiting. True withdraws the request: the same work has finished or is running elsewhere. */
  readonly shouldStop?: () => boolean;
  /** Asked once the resources are held, before the command starts. False withdraws the request. */
  readonly beforeRun?: () => boolean;
  /** Told how the command ended, before its resources are released. */
  readonly beforeFinish?: (result: CommandResult) => void;
  /** Told when a command killed for memory goes back in line (attempt 1 of `MAX_MEMORY_RETRIES`). */
  readonly onMemoryRetry?: (attempt: number) => void;
  readonly probes?: MemoryProbes;
  readonly broker?: ResourceBroker;
  readonly brokerOptions?: BrokerOptions;
}

export type RunUnderBrokerResult =
  | { readonly kind: "ran"; readonly result: CommandResult; readonly ticket: Ticket }
  | { readonly kind: "deferred"; readonly ticket: Ticket }
  | { readonly kind: "superseded"; readonly ticket: Ticket }
  | {
      readonly kind: "not-granted";
      readonly outcome: "exhausted" | "unavailable" | "cancelled";
      readonly message: string;
      readonly ticket: Ticket;
    };

/** How many times a command the kernel killed for memory is queued again before the kill is reported. */
export const MAX_MEMORY_RETRIES = 2;

/**
 * The one door a command goes through: wait for its resources, run, report how it ended. A command
 * killed for memory is not a failure of the work: its measured peak raises the next admission, so it
 * waits in line until the host has that much room and runs again.
 */
export async function runUnderBroker(
  options: RunUnderBrokerOptions,
): Promise<RunUnderBrokerResult> {
  for (let attempt = 1; ; attempt++) {
    const outcome = await runUnderBrokerOnce(options);
    if (outcome.kind !== "ran" || !outcome.result.oomKilled || attempt > MAX_MEMORY_RETRIES) {
      if (
        outcome.kind !== "deferred" &&
        outcome.ticket.id !== process.env.AGENTQUEUE_RESOURCE_TICKET
      ) {
        const broker = options.broker ?? openBroker(options.brokerOptions);
        try {
          broker.markReported(outcome.ticket.id, outcome.ticket.repo);
        } finally {
          if (options.broker === undefined) broker.close();
        }
      }
      return outcome;
    }
    options.onMemoryRetry?.(attempt);
  }
}

async function runUnderBrokerOnce(options: RunUnderBrokerOptions): Promise<RunUnderBrokerResult> {
  const broker = options.broker ?? openBroker(options.brokerOptions);
  const owned = options.broker === undefined;
  try {
    const enclosing = enclosingTicket(
      broker,
      options.resources.map((item) => item.name),
    );
    if (enclosing) {
      if (options.beforeRun && !options.beforeRun())
        return { kind: "superseded", ticket: enclosing };
      const result = await runNested(options);
      return { kind: "ran", result, ticket: enclosing };
    }
    const ticket = broker.enqueue({
      resources: options.resources,
      pid: process.pid,
      ...(options.label ? { label: options.label } : {}),
      ...(options.ownerRef ? { ownerRef: options.ownerRef } : {}),
      ...(options.checkId !== undefined ? { checkId: options.checkId } : {}),
      ...(options.repo ? { repo: options.repo } : {}),
      ...(options.hints ? { hints: options.hints } : {}),
      ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
      runMs: options.runMs ?? DEFAULT_RUN_MS,
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
        ...(options.shouldStop ? { shouldStop: options.shouldStop } : {}),
      });
      if (granted === "superseded") return { kind: "superseded", ticket: broker.get(ticket.id)! };
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
      if (options.beforeRun && !options.beforeRun()) {
        broker.cancel(ticket.id, "superseded by an identical check");
        return { kind: "superseded", ticket: broker.get(ticket.id)! };
      }
      const result = await runGranted(broker, granted, options);
      return { kind: "ran", result, ticket: broker.get(ticket.id)! };
    } catch (error) {
      if (error instanceof ResourceWaitError) {
        if (!error.ticket) throw error;
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

export interface WithBrokerOptions<A = unknown> {
  readonly label?: string;
  readonly ownerRef?: string;
  readonly checkId?: string;
  readonly repo?: string;
  readonly hints?: ResourceRequest["hints"];
  readonly waitMs?: number;
  readonly broker?: ResourceBroker;
  readonly brokerOptions?: BrokerOptions;
  /** Classify a returned result when completion does not imply success. */
  readonly outcomeOf?: (result: A) => TicketOutcome;
}

/**
 * Run `body` while holding the named resources (the server's own checks use this). The same
 * queue, memory admission and lock files as a worker's `agentq run`, so neither can bypass the other.
 * `body` receives the environment the grant implies (emulator serial, slots).
 */
export async function withBrokerResources<A>(
  names: ReadonlyArray<string>,
  body: (env: Record<string, string>) => Promise<A>,
  options: WithBrokerOptions<A> = {},
): Promise<A> {
  const unique = [...new Set(names.map(normalizeResource))];
  if (unique.length === 0) return body({});
  const broker = options.broker ?? openBroker(options.brokerOptions);
  const owned = options.broker === undefined;
  const enclosing = enclosingTicket(broker, unique);
  if (enclosing) {
    try {
      return await body(ticketEnv(enclosing));
    } finally {
      if (owned) broker.close();
    }
  }
  const ticket = broker.enqueue({
    resources: unique.map((name) => ({ name })),
    pid: process.pid,
    label: options.label ?? "server check",
    ...(options.ownerRef ? { ownerRef: options.ownerRef } : {}),
    ...(options.checkId !== undefined ? { checkId: options.checkId } : {}),
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
    const grantedEnv = ticketEnv(granted);
    const emulator = await ensureEmulator(grantedEnv, { repo: granted.repo ?? null });
    if (!emulator.ready && emulator.blocking) throw new EmulatorPrerequisiteError(emulator.note);
    const result = await body(grantedEnv);
    const outcome = options.outcomeOf?.(result) ?? "ok";
    broker.finish(ticket.id, { outcome });
    return result;
  } catch (error) {
    const final = broker.get(ticket.id);
    if (
      final &&
      (final.state === "waiting" || final.state === "granted" || final.state === "running")
    ) {
      broker.finish(ticket.id, {
        outcome:
          error instanceof ResourceWaitError
            ? error.outcome
            : error instanceof EmulatorPrerequisiteError
              ? "unavailable"
              : "failed",
        note:
          error instanceof ResourceWaitError
            ? `Resource wait ${error.outcome}`
            : error instanceof EmulatorPrerequisiteError
              ? `Blocking Android emulator prerequisite: ${error.message}`
              : "Resource callback failed",
      });
    }
    throw error;
  } finally {
    if (beat) clearInterval(beat);
    release();
    const final = broker.get(ticket.id);
    if (
      final &&
      (final.state === "waiting" || final.state === "granted" || final.state === "running")
    ) {
      broker.finish(ticket.id, { outcome: "failed" });
    }
    broker.pump();
    const completed = broker.get(ticket.id);
    if (completed) broker.markReported(completed.id, completed.repo);
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
          requeueOnOom: true,
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
