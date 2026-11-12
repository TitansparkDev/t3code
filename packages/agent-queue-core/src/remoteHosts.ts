// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { accountHome, brokerHome } from "./resourceBroker.ts";

/**
 * Remote build machines (the Legion Go S and the laptop) that take queued work before this VM does.
 * Each remote is driven through a client executable (`legion`, `laptop`) that speaks the protocol in
 * `docs/agentqueue/remote-hosts.md`; the remote's own queue stays authoritative because CI shares it.
 */

/** The remote slot a request occupies. Only these classes are ever sent to another machine. */
export type RemoteClass = "heavy_build" | "android";

export interface RemoteHostConfig {
  readonly name: string;
  /** Absolute path of the client executable. */
  readonly client: string;
  readonly enabled: boolean;
  /** VM path prefix -> remote replacement, applied to argv words that start with the prefix. */
  readonly pathMap: Readonly<Record<string, string>>;
}

export interface RemoteHostStatus {
  readonly name: string;
  readonly reachable: boolean;
  readonly accepting: boolean;
  /** Not accepting now, but `<client> wake` may bring it up (idle and on power). */
  readonly wakeable: boolean;
  readonly free: Readonly<Record<RemoteClass, number>>;
  readonly checkedAt: number;
  /** Epoch ms until which this host is skipped after it refused or failed to start a job. */
  readonly coolingUntil?: number;
}

export interface RemotePlan {
  readonly class: RemoteClass;
  /** Top level of the worktree the command runs in; synced to the remote. */
  readonly dir: string;
  /** cwd relative to `dir` ("" at the top). */
  readonly cwdRel: string;
  /** Remote workspace key: stable per worktree. */
  readonly wsKey: string;
  /** Key under which an environment failure is remembered (repo + normalized command). */
  readonly avoidKey: string;
  /** The argv after the host's pathMap is applied. */
  argvFor(host: RemoteHostConfig): string[];
}

export interface RemoteRunResult {
  readonly host: string;
  /** False: the command never started there (refused, busy, unreachable); place it elsewhere. */
  readonly placed: boolean;
  /** It started, then the connection or the remote job was lost before an exit code came back. */
  readonly lost: boolean;
  /** The command's exit code (meaningful only when placed && !lost). */
  readonly code: number;
  /** It failed because the remote lacks something the VM has (tool, SDK, secret); rerun on the VM. */
  readonly envFailure: boolean;
  readonly tail: string;
  readonly runMs: number;
}

export interface RemoteRunOptions {
  readonly timeoutSec: number;
  readonly label: string;
  readonly stdio?: "inherit" | "pipe";
  readonly logFile?: string;
  readonly onStart?: () => void;
  readonly onBeat?: () => void;
}

/** Everything the broker side needs; injectable so tests never touch real machines. */
export interface RemoteDeps {
  hosts(): ReadonlyArray<RemoteHostConfig>;
  statuses(hosts: ReadonlyArray<RemoteHostConfig>): Promise<ReadonlyArray<RemoteHostStatus>>;
  plan(input: RemotePlanInput): RemotePlan | { readonly local: string };
  run(
    host: RemoteHostConfig,
    plan: RemotePlan,
    options: RemoteRunOptions,
  ): Promise<RemoteRunResult>;
  coolDown(host: string, ms: number): void;
  recordAvoid(avoidKey: string, reason: string): void;
}

export interface RemotePlanInput {
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  /** Broker resource names the request holds (after normalization). */
  readonly resources: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** First host in configured order that is accepting, has a free slot of `cls`, and is not cooling. */
export function pickHost(
  statuses: ReadonlyArray<RemoteHostStatus>,
  cls: RemoteClass,
  now: number = Date.now(),
): RemoteHostStatus | null {
  return (
    statuses.find(
      (status) =>
        status.reachable &&
        status.accepting &&
        status.free[cls] > 0 &&
        (status.coolingUntil === undefined || status.coolingUntil <= now),
    ) ?? null
  );
}

const REMOTE_RESOURCES: ReadonlySet<string> = new Set(["heavy_build", "typecheck", "android"]);
const STATUS_TTL_MS = 10_000;
const STATUS_TIMEOUT_MS = 8_000;
const WAKE_RETRY_MS = 10 * 60_000;
const AVOID_TTL_MS = 7 * 24 * 60 * 60_000;
const BEAT_MS = 10_000;
/** Grace after the job's own `--timeout` before the client's process group is killed. */
const RUN_GRACE_SEC = 180;
const KILL_AFTER_MS = 10_000;
const TAIL_CHARS = 64 * 1024;
/** Client exit codes that mean nothing ran (docs/agentqueue/remote-hosts.md). */
const NOT_PLACED_CODES: ReadonlySet<number> = new Set([75, 76, 77, 78, 255]);
/** Absolute paths every machine has; argv words naming them never keep a request on the VM. */
const PORTABLE_PREFIXES = ["/usr/", "/bin/", "/lib", "/dev/null", "/proc"];
const STARTED_LINE = /^\[remote\] STARTED /m;
const ENV_FAILURE_PATTERNS: ReadonlyArray<RegExp> = [
  /command not found/i,
  /No such file or directory.*\/home\/ajay/,
  /\/home\/ajay\/[^\s]*: not found/,
  /SDK location not found/i,
  /ANDROID_(SDK_ROOT|HOME).*not (set|found)/i,
  /JAVA_HOME is not set/i,
  /Keystore file .* not found/i,
  /keystore.*(not found|does not exist)/i,
  /signingConfig/i,
  /flutter: (command )?not found/i,
  /ENOENT.*\/home\/ajay/,
];

const underTest = () => process.env.VITEST !== undefined || process.env.NODE_ENV === "test";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const localOnly = (reason: string): { readonly local: string } => ({ local: reason });
const realpath = (path: string): string => {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return path;
  }
};

function resourceConfigFile(): string | null {
  if (process.env.AGENTQUEUE_RESOURCE_CONFIG !== undefined)
    return process.env.AGENTQUEUE_RESOURCE_CONFIG;
  if (underTest()) return null;
  return NodePath.join(accountHome(), ".config", "agentqueue", "resources.json");
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Written beside the target and renamed into place, so readers never see a partial file. */
function writeJson(file: string, value: unknown): boolean {
  const tmp = `${file}.${process.pid}.${NodeCrypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(tmp, JSON.stringify(value));
    NodeFS.renameSync(tmp, file);
    return true;
  } catch {
    try {
      NodeFS.rmSync(tmp, { force: true });
    } catch {
      // Nothing more to clean up.
    }
    return false;
  }
}

function stringMap(value: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  if (isRecord(value)) {
    for (const [prefix, target] of Object.entries(value)) {
      if (typeof target === "string") map[prefix] = target;
    }
  }
  return map;
}

/** Remotes from the resource config, in order. Disabled or client-less entries are skipped. */
export function loadRemoteHosts(): ReadonlyArray<RemoteHostConfig> {
  if (process.env.AGENTQUEUE_REMOTE === "off") return [];
  const file = resourceConfigFile();
  const raw = file === null ? undefined : readJson(file);
  const remotes = isRecord(raw) && Array.isArray(raw.remotes) ? (raw.remotes as unknown[]) : [];
  const hosts: RemoteHostConfig[] = [];
  for (const entry of remotes) {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name === "") continue;
    if (typeof entry.client !== "string" || entry.client === "" || entry.enabled === false)
      continue;
    hosts.push({
      name: entry.name,
      client: entry.client,
      enabled: true,
      pathMap: stringMap(entry.pathMap),
    });
  }
  return hosts;
}

interface CachedStatus extends RemoteHostStatus {
  readonly wakeRequestedAt?: number;
}

const blankStatus = (name: string): CachedStatus => ({
  name,
  reachable: false,
  accepting: false,
  wakeable: false,
  free: { heavy_build: 0, android: 0 },
  checkedAt: 0,
});

const statusFile = (): string => NodePath.join(brokerHome(), "remote-status.json");

function isCachedStatus(value: unknown): value is CachedStatus {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.checkedAt === "number" &&
    isRecord(value.free)
  );
}

function readStatusCache(): Record<string, CachedStatus> {
  const raw = readJson(statusFile());
  const cache: Record<string, CachedStatus> = {};
  if (isRecord(raw) && isRecord(raw.hosts)) {
    for (const [name, entry] of Object.entries(raw.hosts)) {
      if (isCachedStatus(entry)) cache[name] = entry;
    }
  }
  return cache;
}

const isFresh = (entry: CachedStatus | undefined, now: number): boolean =>
  entry !== undefined && now - entry.checkedAt >= 0 && now - entry.checkedAt < STATUS_TTL_MS;

function statusOf(name: string, entry: CachedStatus | undefined): RemoteHostStatus {
  const cached = entry ?? blankStatus(name);
  return {
    name,
    reachable: cached.reachable,
    accepting: cached.accepting,
    wakeable: cached.wakeable,
    free: cached.free,
    checkedAt: cached.checkedAt,
    ...(cached.coolingUntil !== undefined ? { coolingUntil: cached.coolingUntil } : {}),
  };
}

interface ProbedStatus {
  readonly accepting: boolean;
  readonly wakeable: boolean;
  readonly free: Readonly<Record<RemoteClass, number>>;
}

function freeSlots(slot: unknown): number {
  if (!isRecord(slot)) return 0;
  const free = Number(slot.total) - Number(slot.used ?? 0);
  return Number.isFinite(free) ? Math.max(0, free) : 0;
}

function parseStatus(text: string): ProbedStatus | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const slots: Record<string, unknown> = isRecord(raw.slots) ? raw.slots : {};
  return {
    accepting: raw.accepting === true,
    wakeable: raw.wakeable === true,
    free: { heavy_build: freeSlots(slots.heavy_build), android: freeSlots(slots.android) },
  };
}

/** `null` when the host cannot be reached or does not answer with a status object. */
function probeStatus(host: RemoteHostConfig): Promise<ProbedStatus | null> {
  return new Promise((resolve) => {
    try {
      NodeChildProcess.execFile(
        host.client,
        ["status", "--json"],
        { timeout: STATUS_TIMEOUT_MS, maxBuffer: 1 << 20 },
        (error, stdout) => resolve(error ? null : parseStatus(String(stdout))),
      );
    } catch {
      resolve(null);
    }
  });
}

function spawnWake(client: string): void {
  try {
    NodeChildProcess.spawn(client, ["wake"], { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
  } catch {
    // Waking is best effort; the next status check asks again.
  }
}

/**
 * Each host's status, reusing cache entries fresher than the TTL and probing the rest in parallel.
 * Never throws: an unreadable cache or a failed write only costs a probe next time.
 */
export async function remoteStatuses(
  hosts: ReadonlyArray<RemoteHostConfig>,
): Promise<ReadonlyArray<RemoteHostStatus>> {
  if (hosts.length === 0) return [];
  const cache = readStatusCache();
  const stale = hosts.filter((host) => !isFresh(cache[host.name], Date.now()));
  const probes = await Promise.all(
    stale.map(async (host) => ({ host, probe: await probeStatus(host) })),
  );
  const now = Date.now();
  // Re-read after the probes: coolDown and other processes may have written meanwhile.
  const latest = readStatusCache();
  for (const { host, probe } of probes) {
    const previous = latest[host.name];
    latest[host.name] = {
      name: host.name,
      reachable: probe !== null,
      accepting: probe?.accepting ?? false,
      wakeable: probe?.wakeable ?? false,
      free: probe?.free ?? { heavy_build: 0, android: 0 },
      checkedAt: now,
      ...(previous?.coolingUntil !== undefined ? { coolingUntil: previous.coolingUntil } : {}),
      ...(previous?.wakeRequestedAt !== undefined
        ? { wakeRequestedAt: previous.wakeRequestedAt }
        : {}),
    };
  }

  const anyAccepting = hosts.some((host) => {
    const entry = latest[host.name];
    return entry?.reachable === true && entry.accepting;
  });
  if (!anyAccepting) {
    const wake = hosts.find((host) => {
      const entry = latest[host.name];
      return (
        entry?.reachable === true &&
        entry.wakeable &&
        (entry.wakeRequestedAt === undefined || now - entry.wakeRequestedAt > WAKE_RETRY_MS)
      );
    });
    if (wake !== undefined) {
      spawnWake(wake.client);
      latest[wake.name] = { ...blankStatus(wake.name), ...latest[wake.name], wakeRequestedAt: now };
    }
  }

  writeJson(statusFile(), { hosts: latest });
  return hosts.map((host) => statusOf(host.name, latest[host.name]));
}

/** Skips `host` for `ms` milliseconds, e.g. after it refused or failed to start a job. */
export function coolDown(host: string, ms: number): void {
  const cache = readStatusCache();
  cache[host] = { ...(cache[host] ?? blankStatus(host)), coolingUntil: Date.now() + ms };
  writeJson(statusFile(), { hosts: cache });
}

interface AvoidEntry {
  readonly reason: string;
  readonly until: number;
}

const avoidFile = (): string => NodePath.join(brokerHome(), "remote-avoid.json");

function readAvoid(now: number): Record<string, AvoidEntry> {
  const raw = readJson(avoidFile());
  const live: Record<string, AvoidEntry> = {};
  if (!isRecord(raw)) return live;
  for (const [key, entry] of Object.entries(raw)) {
    if (
      isRecord(entry) &&
      typeof entry.reason === "string" &&
      typeof entry.until === "number" &&
      entry.until > now
    ) {
      live[key] = { reason: entry.reason, until: entry.until };
    }
  }
  return live;
}

/** Keeps a command on the VM for the repository for seven days (environment failures only). */
export function recordAvoid(avoidKey: string, reason: string): void {
  const now = Date.now();
  const entries = readAvoid(now);
  entries[avoidKey] = { reason, until: now + AVOID_TTL_MS };
  writeJson(avoidFile(), entries);
}

function gitOut(cwd: string, args: ReadonlyArray<string>): string | null {
  try {
    const out = NodeChildProcess.execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/** Index of the script string in `bash -c script` / `sh -c script`, or -1. */
function scriptIndex(argv: ReadonlyArray<string>): number {
  const shell = NodePath.basename(argv[0] ?? "");
  if (shell !== "bash" && shell !== "sh") return -1;
  const flag = argv.indexOf("-c");
  return flag >= 0 && flag + 1 < argv.length ? flag + 1 : -1;
}

const splitScript = (script: string): string[] =>
  script
    .split(/\s+/)
    .map((word) => word.replace(/^["']+|["']+$/g, ""))
    .filter((word) => word !== "");

/** Every word the request names: argv without the script string, plus the script's own words. */
function commandWords(argv: ReadonlyArray<string>): string[] {
  const at = scriptIndex(argv);
  const plain = argv.filter((_, index) => index !== at);
  return at < 0 ? plain : [...plain, ...splitScript(argv[at]!)];
}

function rewritePath(word: string, pathMap: Readonly<Record<string, string>>): string {
  let best: string | null = null;
  for (const prefix of Object.keys(pathMap)) {
    if (prefix !== "" && word.startsWith(prefix) && (best === null || prefix.length > best.length))
      best = prefix;
  }
  return best === null ? word : `${pathMap[best] ?? ""}${word.slice(best.length)}`;
}

/** Rewrites every absolute path token of a shell script, not just its first word. */
function rewriteScript(script: string, pathMap: Readonly<Record<string, string>>): string {
  return script.replace(
    /(^|[\s'"=(])(\/[^\s'"]*)/g,
    (_match, lead: string, path: string) => `${lead}${rewritePath(path, pathMap)}`,
  );
}

function remoteArgv(argv: ReadonlyArray<string>, pathMap: Readonly<Record<string, string>>) {
  const at = scriptIndex(argv);
  return argv.map((word, index) =>
    index === at ? rewriteScript(word, pathMap) : rewritePath(word, pathMap),
  );
}

const isUnder = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`);

function workspaceKey(dir: string): string {
  const hash = NodeCrypto.createHash("sha1").update(dir).digest("hex").slice(0, 8);
  return `${NodePath.basename(dir)}-${hash}`.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/**
 * Decides whether a request can run on a remote. Anything the remote cannot reproduce (git history,
 * VM devices, paths only this VM has, a remembered environment failure) stays local with its reason.
 */
export function planRemote(input: RemotePlanInput): RemotePlan | { readonly local: string } {
  const env = input.env ?? process.env;
  const resources = input.resources;
  const cls: RemoteClass | null = resources.includes("android")
    ? "android"
    : resources.includes("heavy_build") || resources.includes("typecheck")
      ? "heavy_build"
      : null;
  if (cls === null) return localOnly("no remotable resource");
  const stays = resources.find((name) => !REMOTE_RESOURCES.has(name));
  if (stays !== undefined) return localOnly(`resource ${stays} stays on the VM`);
  if (env.ANDROID_SERIAL) return localOnly("ANDROID_SERIAL pins an attached device");
  const hosts = loadRemoteHosts();
  if (hosts.length === 0) return localOnly("no remote hosts configured");
  const top = gitOut(input.cwd, ["rev-parse", "--show-toplevel"]);
  if (top === null) return localOnly("not a git worktree");
  const dir = realpath(top);
  const cwdRel = NodePath.relative(dir, realpath(input.cwd));
  const words = commandWords(input.argv);
  if (words.some((word) => word === "git" || word.includes("check:changed")))
    return localOnly("needs git history");
  for (const word of words) {
    if (!word.startsWith("/") || isUnder(word, dir)) continue;
    if (PORTABLE_PREFIXES.some((prefix) => word.startsWith(prefix))) continue;
    if (hosts.every((host) => Object.keys(host.pathMap).some((prefix) => word.startsWith(prefix))))
      continue;
    return localOnly(`path outside the worktree: ${word}`);
  }
  const common = gitOut(input.cwd, ["rev-parse", "--git-common-dir"]);
  const repo = common === null ? dir : NodePath.resolve(input.cwd, common);
  const avoidKey = `${repo}:${input.argv.join(" ").split(dir).join(".")}`.slice(0, 300);
  const remembered = readAvoid(Date.now())[avoidKey];
  if (remembered !== undefined) return localOnly(`remembered: ${remembered.reason}`);
  return {
    class: cls,
    dir,
    cwdRel,
    wsKey: workspaceKey(dir),
    avoidKey,
    argvFor: (host) => remoteArgv(input.argv, host.pathMap),
  };
}

function openLog(file: string | undefined): number | null {
  if (file === undefined) return null;
  try {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    return NodeFS.openSync(file, "a");
  } catch {
    return null;
  }
}

function closeLog(fd: number | null): void {
  if (fd === null) return;
  try {
    NodeFS.closeSync(fd);
  } catch {
    // Already closed.
  }
}

const unplaced = (host: string, tail: string, runMs: number): RemoteRunResult => ({
  host,
  placed: false,
  lost: false,
  code: 127,
  envFailure: false,
  tail,
  runMs,
});

/**
 * Runs the request through the host's client in its own process group. The job counts as started
 * on the client's STARTED line; a group that outlives the job's timeout plus a grace is killed.
 */
export async function runRemote(
  host: RemoteHostConfig,
  plan: RemotePlan,
  options: RemoteRunOptions,
): Promise<RemoteRunResult> {
  const spawnedAt = Date.now();
  const args = [
    "run",
    "--ws",
    plan.wsKey,
    "--dir",
    plan.dir,
    ...(plan.cwdRel === "" ? [] : ["--cwd", plan.cwdRel]),
    "--resource",
    plan.class,
    "--timeout",
    String(options.timeoutSec),
    "--wait",
    "30",
    "--label",
    options.label,
    "--",
    ...plan.argvFor(host),
  ];
  const logFd = openLog(options.logFile);
  let child: NodeChildProcess.ChildProcess;
  try {
    child = NodeChildProcess.spawn(host.client, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    closeLog(logFd);
    return unplaced(host.name, String(error), Date.now() - spawnedAt);
  }

  return new Promise<RemoteRunResult>((resolve) => {
    const pid = child.pid;
    let tail = "";
    let carry = "";
    let started = false;
    let startedAt = spawnedAt;
    let spawnError: string | null = null;
    let timedOut = false;
    let settled = false;
    let escalate: NodeJS.Timeout | null = null;

    const append = (text: string) => {
      tail = (tail + text).slice(-TAIL_CHARS);
      if (logFd === null) return;
      try {
        NodeFS.writeSync(logFd, text);
      } catch {
        // The log is best effort; the tail still reaches the caller.
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (options.stdio === "inherit") process.stdout.write(text);
      append(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (options.stdio === "inherit") process.stderr.write(text);
      append(text);
      if (started) return;
      carry = (carry + text).slice(-512);
      if (STARTED_LINE.test(carry)) {
        started = true;
        startedAt = Date.now();
        options.onStart?.();
      }
    });

    const beat = setInterval(() => options.onBeat?.(), BEAT_MS);
    const signalGroup = (signal: NodeJS.Signals) => {
      if (pid === undefined) return;
      try {
        process.kill(-pid, signal);
      } catch {
        // The group is already gone.
      }
    };
    const limit = setTimeout(
      () => {
        timedOut = true;
        signalGroup("SIGTERM");
        escalate = setTimeout(() => signalGroup("SIGKILL"), KILL_AFTER_MS);
      },
      (options.timeoutSec + RUN_GRACE_SEC) * 1000,
    );
    const onTerm = () => signalGroup("SIGTERM");
    const onInt = () => signalGroup("SIGINT");
    process.once("SIGTERM", onTerm);
    process.once("SIGINT", onInt);

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearInterval(beat);
      clearTimeout(limit);
      if (escalate !== null) clearTimeout(escalate);
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      closeLog(logFd);
      const runMs = Date.now() - startedAt;
      if (spawnError !== null) {
        resolve(unplaced(host.name, tail, runMs));
        return;
      }
      const code = timedOut ? 124 : exitCode;
      const placed = started || !NOT_PLACED_CODES.has(code);
      const lost = started && code === 255;
      const envFailure =
        placed &&
        !lost &&
        code !== 0 &&
        (code === 127 || ENV_FAILURE_PATTERNS.some((pattern) => pattern.test(tail)));
      resolve({ host: host.name, placed, lost, code, envFailure, tail, runMs });
    };
    child.on("error", (error) => {
      spawnError = error.message;
      append(`${error.message}\n`);
      finish(127);
    });
    child.on("close", (exit, signal) => finish(exit ?? (signal !== null ? 128 : 1)));
  });
}

export const REAL_REMOTE: RemoteDeps = {
  hosts: () => loadRemoteHosts(),
  statuses: (hosts) => remoteStatuses(hosts),
  plan: (input) => planRemote(input),
  run: (host, plan, options) => runRemote(host, plan, options),
  coolDown: (host, ms) => coolDown(host, ms),
  recordAvoid: (key, reason) => recordAvoid(key, reason),
};
