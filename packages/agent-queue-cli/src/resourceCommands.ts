// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off globalConsole:off
/**
 * `agentq run -- <command>` and `agentq resource ...` queue shared machine resources.
 * Resources come from the command and repository contract; jobs wait fairly until available.
 * Long waits become stored jobs that resume the same conversation when resources free up.
 */
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import { resolveGitContext } from "./gitContext.ts";
import {
  brokerHome,
  claimCheck,
  createJobRunner,
  declaredCheckIdentity,
  DEFAULT_RUN_MS,
  describeJob,
  inferResourceDemands,
  jobEnvironment,
  requestedAndroidSerial,
  isReusableCommand,
  loadContract,
  loadResourceConfig,
  matchingReceipt,
  MAX_MEMORY_RETRIES,
  normalizeResource,
  openQueueDatabase,
  openBroker,
  outputSnapshot,
  parseStoredSpec,
  readHost,
  releaseCheck,
  ResourceBroker,
  runningCheck,
  waitForCheck,
  writeReceipt,
  runUnderBroker,
  type CheckIdentity,
  type CheckReceipt,
  type VerificationCheck,
  type RunUnderBrokerOptions,
  type Ticket,
} from "../../agent-queue-core/src/index.ts";

export interface ParsedFlags {
  readonly flags: Record<string, string | boolean>;
  readonly positional: string[];
  readonly after: string[];
}

/** Splits `args` at `--`: everything after it is the command, untouched. */
export function splitCommand(args: ReadonlyArray<string>): { head: string[]; command: string[] } {
  const index = args.indexOf("--");
  return index === -1
    ? { head: [...args], command: [] }
    : { head: args.slice(0, index), command: args.slice(index + 1) };
}

function parseHead(head: ReadonlyArray<string>): {
  flags: Record<string, string | boolean>;
  positional: string[];
} {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < head.length; i++) {
    const arg = head[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      else {
        const next = head[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[arg.slice(2)] = next;
          i++;
        } else flags[arg.slice(2)] = true;
      }
    } else positional.push(arg);
  }
  return { flags, positional };
}

const num = (value: string | boolean | undefined, fallback: number): number => {
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

function repoOf(cwd: string): { root: string; common: string } | null {
  try {
    const git = resolveGitContext(cwd);
    return { root: git.rootDir, common: git.gitCommonDir };
  } catch {
    return null;
  }
}

function contractResources(cwd: string) {
  const repo = repoOf(cwd);
  if (!repo)
    return {
      resources: [] as ReadonlyArray<{
        name: string;
        limit: number;
        commands: ReadonlyArray<string>;
        scope: ReadonlyArray<string>;
      }>,
      repo: null,
    };
  const refs = [process.env.AGENTQUEUE_BASE_BRANCH, "main", "master"].filter(
    (ref): ref is string => !!ref,
  );
  const loaded = loadContract({ repoRoot: repo.root, gitCommonDir: repo.common, refs });
  return { resources: loaded.contract.resources, repo };
}

function declaredReusableCheck(
  owner: string | undefined,
  checkId: string | undefined,
  repo: { readonly root: string; readonly common: string } | null,
  cwd: string,
  argv: ReadonlyArray<string>,
): VerificationCheck | null {
  if (!owner || !repo || !isReusableCommand(argv)) return null;
  const databasePath = NodePath.join(repo.common, "agentqueue", "queue.sqlite");
  if (!NodeFS.existsSync(databasePath)) return null;
  try {
    const db = openQueueDatabase({ gitCommonDir: repo.common, readonly: true });
    try {
      const task = db
        .prepare("SELECT verification_spec, verification_command FROM tasks WHERE id = ?")
        .get(owner) as
        | { verification_spec: string | null; verification_command: string | null }
        | undefined;
      const spec = parseStoredSpec(task?.verification_spec, task?.verification_command);
      if (spec.source !== "declared") return null;
      let actualCwd: string;
      try {
        actualCwd = NodeFS.realpathSync(cwd);
      } catch {
        return null;
      }
      const matches = spec.checks.filter((check) => {
        if (
          check.run !== argv.join(" ") ||
          check.expectExitCode !== 0 ||
          check.reuseInputs === undefined ||
          check.reuseInputs.length === 0 ||
          check.reuseEnv === undefined ||
          check.produces === undefined ||
          check.junit !== undefined ||
          (checkId !== undefined && check.id !== checkId) ||
          check.requires.some((name) => !["heavy_build", "typecheck"].includes(name))
        )
          return false;
        try {
          return NodeFS.realpathSync(NodePath.resolve(repo.root, check.cwd ?? ".")) === actualCwd;
        } catch {
          return false;
        }
      });
      return matches.length === 1 ? matches[0]! : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function revalidatedReceipt(
  identity: CheckIdentity,
  repoRoot: string,
  check: VerificationCheck,
  cwd: string,
  argv: ReadonlyArray<string>,
  reuseInputs: ReadonlyArray<string>,
  timeoutMs: number,
): CheckIdentity | null {
  const firstReceipt = matchingReceipt(identity, outputSnapshot(repoRoot, check.produces));
  if (!firstReceipt || firstReceipt.elapsedMs >= timeoutMs) return null;
  const current = declaredCheckIdentity({
    argv,
    cwd,
    reuseInputs,
    reuseEnv: check.reuseEnv!,
  });
  if (current?.key !== identity.key) return null;
  const currentReceipt = matchingReceipt(current, outputSnapshot(repoRoot, check.produces));
  return currentReceipt && currentReceipt.elapsedMs < timeoutMs ? current : null;
}

export interface ResourceCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Foreground window for a thread job before the caller is told to wait for it in the background. */
const THREAD_FOREGROUND_DEFAULT_S = 100;

const RUN_USAGE = `Usage: agentq run [--resource a,b] [--owner TASK [--check ID]] [--defer-after SECONDS] [--timeout SECONDS] [--wait SECONDS] -- <command> [args]
  --timeout   kill the command after SECONDS once it holds the resource (default ${DEFAULT_RUN_MS / 1000})
  --defer-after  with --owner: store the command as a job after waiting this long (exit 75)
  --wait      give up waiting for the resource after SECONDS (default 10800)
  In a T3 thread (T3CODE_THREAD_ID set) a command that needs a shared resource is run by the server:
  its output is shown for up to AGENTQUEUE_FOREGROUND_SECONDS (default ${THREAD_FOREGROUND_DEFAULT_S}), then exit 75 "STILL RUNNING";
  the result is posted into the thread when it finishes. \`agentq wait <id>\` blocks on it instead.
`;

const fmtMs = (ms: number) =>
  ms < 90_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;

function statusText(broker: ResourceBroker): string {
  const { resources, host, reserveMb } = broker.status();
  const lines = [
    `Host: ${host.availableMb} MB available of ${host.totalMb} MB (reserve ${reserveMb} MB), ${host.swapUsedMb} MB swapped, load ${host.load1.toFixed(1)} on ${host.cpus} CPUs${host.diskFreeMb === undefined ? "" : `, ${Math.round(host.diskFreeMb / 1024)} GB disk free`}`,
  ];
  for (const resource of resources) {
    if (resource.capacity === 0 && resource.active === 0 && resource.waiting === 0) {
      lines.push(`${resource.name}: not available on this machine`);
      continue;
    }
    lines.push(
      `${resource.name}: ${resource.active}/${resource.capacity} in use, ${resource.waiting} waiting`,
    );
    const who = (entry: { owner: string | null; pid: number | null }) =>
      `${entry.owner ?? "no owner"}, pid ${entry.pid ?? "?"}`;
    for (const holder of resource.holders)
      lines.push(
        `    holding ${holder.ticket} slot ${holder.slots.join(",")} for ${fmtMs(holder.sinceMs)} (${who(holder)}): ${holder.label}`,
      );
    for (const waiter of resource.queue)
      lines.push(
        `    #${waiter.position} ${waiter.ticket} waiting ${fmtMs(waiter.waitingMs)} (${who(waiter)}${waiter.note ? `; ${waiter.note}` : ""}): ${waiter.label}`,
      );
  }
  return lines.join("\n");
}

const jobLine = (ticket: Ticket) =>
  `${ticket.id} ${ticket.state}${ticket.outcome ? `/${ticket.outcome}` : ""} [${ticket.resources.map((r) => r.name).join(",")}] ${ticket.job?.command ?? ticket.label}`;

const WAIT_USAGE = `Usage: agentq wait <job-id> [--timeout SECONDS]
  --timeout  give up after SECONDS and exit 75 while the job is still running (default 14400)
`;

const threadOwnerRef = (threadId: string) => `thread:${threadId}`;

/** The job's command runs as `bash -c`, so each argument is quoted the way a shell reads it. */
const shellWord = (value: string): string =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

/** The exit status a finished job reports to whoever is waiting on it. */
function exitCodeOfJob(ticket: Ticket): number {
  if (ticket.state === "cancelled" || ticket.state === "expired") return 76;
  if (ticket.outcome === "ok") return 0;
  if (ticket.outcome === "timed-out") return 124;
  if (ticket.outcome === "unavailable") return 77;
  if (ticket.outcome === "exhausted" || ticket.outcome === "cancelled") return 76;
  return ticket.exitCode !== null && ticket.exitCode > 0 ? ticket.exitCode : 1;
}

const isFinishedJob = (ticket: Ticket) =>
  ticket.state === "done" || ticket.state === "cancelled" || ticket.state === "expired";

interface FollowDeps {
  readonly broker: ResourceBroker;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly write?: (text: string) => void;
}

/** Write whatever the job's log gained since `offset`; returns the new offset. */
function streamAppended(file: string, offset: number, write: (text: string) => void): number {
  let size: number;
  try {
    size = NodeFS.statSync(file).size;
  } catch {
    return offset;
  }
  if (size <= offset) return offset;
  const fd = NodeFS.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(size - offset);
    const read = NodeFS.readSync(fd, buffer, 0, buffer.length, offset);
    write(buffer.subarray(0, read).toString("utf8"));
    return offset + read;
  } finally {
    NodeFS.closeSync(fd);
  }
}

/**
 * Stream a stored job's output to `write` until it finishes (returns its ticket) or `deadlineMs`
 * passes (returns null). Any waiter pumps the broker, so a dead runner's job is noticed here too.
 */
async function followJob(id: string, deps: FollowDeps & { readonly deadlineMs: number }) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const write = deps.write ?? ((text: string) => void process.stdout.write(text));
  const logFile = NodePath.join(brokerHome(), "logs", `${id}.log`);
  let offset = 0;
  while (true) {
    offset = streamAppended(logFile, offset, write);
    deps.broker.pump();
    const ticket = deps.broker.get(id);
    if (!ticket) throw new Error(`Job ${id} disappeared.`);
    if (isFinishedJob(ticket)) {
      offset = streamAppended(logFile, offset, write);
      if (offset === 0 && ticket.tail)
        write(ticket.tail.endsWith("\n") ? ticket.tail : `${ticket.tail}\n`);
      return ticket;
    }
    if (now() >= deps.deadlineMs) return null;
    await sleep(1000);
  }
}

export interface ThreadJobRequest {
  readonly threadId: string;
  readonly demands: ReadonlyArray<{ readonly name: string }>;
  readonly hints: Readonly<Record<string, { readonly capacity: number }>>;
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
  readonly label: string;
  readonly env: Record<string, string>;
  readonly waitMs: number;
  readonly runMs: number;
  readonly foregroundMs: number;
}

/**
 * A command an agent runs from a T3 thread is stored as a job for the server's thread-job runner,
 * which posts the result back into that thread. The agent waits here only for the foreground window.
 */
export async function runThreadJob(
  request: ThreadJobRequest,
  deps: Partial<FollowDeps> = {},
): Promise<ResourceCliResult> {
  const broker = deps.broker ?? openBroker();
  const owned = deps.broker === undefined;
  try {
    const ticket = broker.enqueue({
      resources: request.demands,
      label: request.label,
      ownerRef: threadOwnerRef(request.threadId),
      repo: ResourceBroker.THREAD_JOBS_REPO,
      hints: request.hints,
      waitMs: request.waitMs,
      runMs: request.runMs,
      job: {
        command: request.command.map(shellWord).join(" "),
        cwd: request.cwd,
        env: jobEnvironment({ ...process.env, ...request.env }),
      },
    });
    if (ticket.state === "done") {
      broker.markReported(ticket.id);
      return {
        exitCode: 77,
        stdout: "",
        stderr: `[agentq] ${ticket.note ?? "required prerequisite unavailable"} Nothing ran.`,
      };
    }
    const now = deps.now ?? Date.now;
    const finished = await followJob(ticket.id, {
      ...deps,
      broker,
      deadlineMs: now() + request.foregroundMs,
    });
    if (finished) {
      broker.markReported(ticket.id);
      const code = exitCodeOfJob(finished);
      return {
        exitCode: code,
        stdout: "",
        stderr: code === 0 ? "" : `[agentq] ${ticket.id} ended with exit ${code}.`,
      };
    }
    const resources = request.demands.map((demand) => demand.name).join(", ");
    return {
      exitCode: 75,
      stdout: "",
      stderr: `[agentq] STILL RUNNING as ${ticket.id} (${resources}). Do not rerun or poll it. Keep working on something that does not need the result, or end your turn: the result is posted into this conversation when it finishes and you continue from there. To block on it instead, run \`agentq wait ${ticket.id}\` (Claude Code: as a background command).`,
    };
  } finally {
    if (owned) broker.close();
  }
}

/** `agentq wait <id>`: block on a stored job, streaming its output, and exit with its status. */
async function waitForJob(args: ReadonlyArray<string>): Promise<ResourceCliResult> {
  const { flags, positional } = parseHead(args);
  const id = positional[0];
  if (!id) return { exitCode: 2, stdout: "", stderr: WAIT_USAGE };
  const broker = openBroker();
  try {
    const job = broker.get(id);
    if (!job || job.kind !== "job")
      return { exitCode: 2, stdout: "", stderr: `Unknown job ${id}.` };
    const finished = await followJob(id, {
      broker,
      deadlineMs: Date.now() + num(flags.timeout, 4 * 3600) * 1000,
    });
    if (!finished) {
      const current = broker.get(id);
      return {
        exitCode: 75,
        stdout: "",
        stderr: `[agentq] still ${current?.state ?? "unknown"}; run agentq wait ${id} again to keep waiting.`,
      };
    }
    broker.markReported(id);
    return { exitCode: exitCodeOfJob(finished), stdout: `${describeJob(finished)}\n`, stderr: "" };
  } finally {
    broker.close();
  }
}

/** Whether a runner that takes thread jobs is alive on this machine. */
function threadRunnerLive(): boolean {
  const broker = openBroker();
  try {
    return broker.hasLiveRunner(ResourceBroker.THREAD_JOBS_REPO);
  } finally {
    broker.close();
  }
}

/**
 * Handles `run` and `resource <sub>`. Returns null when `argv` is not one of them, so the
 * synchronous CLI can take over.
 */
export async function runResourceCommand(
  argv: ReadonlyArray<string>,
  cwd: string = process.cwd(),
): Promise<ResourceCliResult | null> {
  const [first, second] = argv;
  if (first === "wait") return waitForJob(argv.slice(1));
  if (first !== "run" && first !== "resource") return null;
  const sub = first === "run" ? "run" : second;
  const rest = argv.slice(first === "run" ? 1 : 2);
  const { head, command } = splitCommand(rest);
  const { flags, positional } = parseHead(head);
  const json = flags.json === true;
  const out = (value: unknown, text: string): ResourceCliResult => ({
    exitCode: 0,
    stdout: json ? JSON.stringify(value, null, 2) : text,
    stderr: "",
  });

  if (sub === "run") {
    if (flags.help === true || flags.h === true) {
      return { exitCode: 0, stdout: RUN_USAGE, stderr: "" };
    }
    if (command.length === 0) {
      return { exitCode: 2, stdout: "", stderr: RUN_USAGE };
    }
    const { resources: repoResources, repo } = contractResources(cwd);
    const commandLine = command.join(" ");
    const deferAfter =
      typeof flags["defer-after"] === "string"
        ? num(flags["defer-after"], 0)
        : num(process.env.AGENTQUEUE_DEFER_AFTER, 0);
    const owner = typeof flags.owner === "string" ? flags.owner : process.env.AGENTQUEUE_OWNER;
    if (flags.check === true || (flags.check !== undefined && typeof flags.check !== "string")) {
      return { exitCode: 2, stdout: "", stderr: "--check requires a check id." };
    }
    const checkId = typeof flags.check === "string" ? flags.check : undefined;
    const runMs = typeof flags.timeout === "string" ? num(flags.timeout, 0) * 1000 : DEFAULT_RUN_MS;
    if (checkId && !owner) {
      return { exitCode: 2, stdout: "", stderr: "--check requires --owner TASK." };
    }
    const declared =
      deferAfter === 0 && !process.env.AGENTQUEUE_RESOURCE_TICKET
        ? declaredReusableCheck(owner, checkId, repo, cwd, command)
        : null;
    const named =
      typeof flags.resource === "string"
        ? flags.resource.split(",").map(normalizeResource).filter(Boolean)
        : [];
    const demands = [
      ...named.map((name) => ({ name })),
      ...inferResourceDemands(commandLine, repoResources),
      ...(declared?.requires.map((name) => ({ name })) ?? []),
    ];
    const androidSerial = demands.some((demand) => demand.name === "android")
      ? requestedAndroidSerial(command, process.env)
      : null;
    if (androidSerial !== null) {
      for (let index = demands.length - 1; index >= 0; index--) {
        if (demands[index]!.name === "android") demands.splice(index, 1);
      }
      demands.push({ name: `device_${androidSerial.replace(/[^A-Za-z0-9_.-]/g, "_")}` });
      process.stderr.write(`[agentq] using ANDROID_SERIAL=${androidSerial}\n`);
    }
    const resources = [...new Set(demands.map((demand) => demand.name))];
    const reusableInputs = declared
      ? [...declared.reuseInputs!, ...(declared.consumes ?? [])]
      : null;
    const reusable =
      declared !== null &&
      resources.length > 0 &&
      resources.every((name) => ["heavy_build", "typecheck"].includes(name));
    if (reusable && declared && repo) {
      const identity = declaredCheckIdentity({
        argv: command,
        cwd,
        reuseInputs: reusableInputs!,
        reuseEnv: declared.reuseEnv!,
      });
      if (
        identity &&
        revalidatedReceipt(identity, repo.root, declared, cwd, command, reusableInputs!, runMs)
      ) {
        return {
          exitCode: 0,
          stdout: "",
          stderr: "[agentq] reusing the successful declared check; its inputs and outputs match.",
        };
      }
    }
    if (resources.length === 0 && !reusable) {
      // Nothing shared is involved: run it straight away, as if the prefix were not there,
      // but still under the deadline the caller asked for.
      const child = NodeChildProcess.spawnSync(command[0]!, command.slice(1), {
        cwd,
        stdio: "inherit",
        ...(typeof flags.timeout === "string" && runMs > 0 ? { timeout: runMs } : {}),
      });
      if (child.error && (child.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
        return { exitCode: 124, stdout: "", stderr: "[agentq] killed at its time limit." };
      }
      return { exitCode: child.status ?? 1, stdout: "", stderr: "" };
    }
    const hints = Object.fromEntries(
      repoResources.map((resource) => [resource.name, { capacity: resource.limit }]),
    );
    const threadId = process.env.T3CODE_THREAD_ID;
    if (
      threadId &&
      !owner &&
      !process.env.AGENTQUEUE_RESOURCE_TICKET &&
      resources.length > 0 &&
      threadRunnerLive()
    ) {
      return runThreadJob({
        threadId,
        demands,
        hints,
        command,
        cwd,
        label: typeof flags.label === "string" ? flags.label : commandLine.slice(0, 100),
        env: androidSerial === null ? {} : { ANDROID_SERIAL: androidSerial },
        waitMs: num(flags.wait, 3 * 3600) * 1000,
        runMs,
        foregroundMs:
          num(process.env.AGENTQUEUE_FOREGROUND_SECONDS, THREAD_FOREGROUND_DEFAULT_S) * 1000,
      });
    }
    const request: RunUnderBrokerOptions = {
      resources: demands,
      argv: command,
      ...(androidSerial === null ? {} : { env: { ANDROID_SERIAL: androidSerial } }),
      cwd,
      label: typeof flags.label === "string" ? flags.label : commandLine.slice(0, 100),
      ...(owner ? { ownerRef: owner } : {}),
      ...(repo ? { repo: repo.common } : {}),
      hints,
      waitMs: num(flags.wait, 3 * 3600) * 1000,
      ...(typeof flags.timeout === "string" ? { runMs } : {}),
      stdio: "inherit",
      ...(deferAfter > 0 && owner ? { deferAfterMs: deferAfter * 1000 } : {}),
      onMemoryRetry: (attempt) =>
        process.stderr.write(
          `[agentq] the command was killed for memory; waiting for more headroom, then running it again (retry ${attempt} of ${MAX_MEMORY_RETRIES})\n`,
        ),
      onWaiting: (ticket, position) =>
        process.stderr.write(
          `[agentq] waiting for ${ticket.resources.map((r) => r.name).join(", ")} (${position === 1 ? "next in line" : `#${position} in line`}; ${ticket.note ?? "queued"})\n`,
        ),
    };
    let cached = false;
    let waitingKey: string | null = null;
    let claimKey: string | null = null;
    let claimOwner: string | null = null;
    let claimIdentity: CheckIdentity | null = null;
    let runIdentity: CheckIdentity | null = null;
    let startedAt = 0;
    let cacheFailure: string | null = null;
    let checkWaitExpired = false;
    let result: Awaited<ReturnType<typeof runUnderBroker>>;
    while (true) {
      result = await runUnderBroker({
        ...request,
        ...(reusable && declared && repo
          ? {
              beforeRun: () => {
                let identity = declaredCheckIdentity({
                  argv: command,
                  cwd,
                  reuseInputs: reusableInputs!,
                  reuseEnv: declared.reuseEnv!,
                });
                runIdentity = identity;
                if (!identity) return true;
                const receiptIdentity = revalidatedReceipt(
                  identity,
                  repo.root,
                  declared,
                  cwd,
                  command,
                  reusableInputs!,
                  runMs,
                );
                if (receiptIdentity) {
                  runIdentity = receiptIdentity;
                  cached = true;
                  return false;
                }
                if (claimOwner && claimKey !== identity.key) {
                  releaseCheck(claimKey!, claimOwner);
                  claimKey = null;
                  claimOwner = null;
                  claimIdentity = null;
                }
                if (claimOwner && claimKey === identity.key) return true;
                const ownerToken = claimCheck(identity.key);
                if (ownerToken) {
                  claimKey = identity.key;
                  claimOwner = ownerToken;
                  claimIdentity = identity;
                  startedAt = Date.now();
                  return true;
                }
                if (runningCheck(identity.key)) {
                  waitingKey = identity.key;
                  return false;
                }
                return true;
              },
              beforeFinish: (ended) => {
                try {
                  if (ended.outcome !== "ok" || ended.exitCode !== 0 || ended.oomKilled) return;
                  if (!runIdentity) return;
                  const after = declaredCheckIdentity({
                    argv: command,
                    cwd,
                    reuseInputs: reusableInputs!,
                    reuseEnv: declared.reuseEnv!,
                  });
                  const outputs = outputSnapshot(repo.root, declared.produces);
                  if (!after || after.key !== runIdentity.key) {
                    cacheFailure = "The check inputs changed while it was running; rerun it.";
                    return;
                  }
                  if (outputs === null) {
                    cacheFailure = "A declared check output is missing or unsafe; rerun the check.";
                    return;
                  }
                  if (!claimIdentity || !claimKey || !claimOwner) return;
                  const receipt: CheckReceipt = {
                    schemaVersion: 2,
                    key: claimIdentity.key,
                    commandHash: NodeCrypto.createHash("sha256")
                      .update(JSON.stringify(command))
                      .digest("hex"),
                    outcome: "ok",
                    exitCode: 0,
                    elapsedMs: Date.now() - startedAt,
                    peakRssKb: ended.peakRssKb,
                    checkers: claimIdentity.checkers,
                    outputs,
                    finishedAt: Date.now(),
                  };
                  try {
                    writeReceipt(receipt);
                  } catch {
                    // An unwritable cache only causes the check to run again next time.
                  }
                } finally {
                  if (claimKey && claimOwner) releaseCheck(claimKey, claimOwner);
                  claimKey = null;
                  claimOwner = null;
                  claimIdentity = null;
                }
              },
            }
          : {}),
      });
      if (waitingKey) {
        if (!(await waitForCheck(waitingKey, brokerHome(), runMs))) {
          checkWaitExpired = true;
          break;
        }
        waitingKey = null;
        continue;
      }
      break;
    }
    if (claimKey && claimOwner) releaseCheck(claimKey, claimOwner);
    if (checkWaitExpired) {
      return {
        exitCode: 76,
        stdout: "",
        stderr:
          "[agentq] an identical check remained in progress for this command's timeout; nothing ran.",
      };
    }
    if (cached) {
      return {
        exitCode: 0,
        stdout: "",
        stderr: "[agentq] reusing the successful declared check; its inputs and outputs match.",
      };
    }
    if (cacheFailure) return { exitCode: 1, stdout: "", stderr: `[agentq] ${cacheFailure}` };
    if (result.kind === "ran") {
      if (result.result.outcome === "timed-out") {
        return {
          exitCode: 124,
          stdout: "",
          stderr: `[agentq] killed at its time limit; resources were released.`,
        };
      }
      if (result.result.outcome === "exhausted") {
        return {
          exitCode: 76,
          stdout: "",
          stderr: `[agentq] could not take the lock file for the resource: ${result.ticket.note ?? ""}`,
        };
      }
      if (result.result.outcome === "unavailable") {
        return {
          exitCode: 77,
          stdout: "",
          stderr:
            result.result.tail ||
            `[agentq] ${result.ticket.note ?? "required prerequisite unavailable"}`,
        };
      }
      return {
        exitCode: result.result.exitCode,
        stdout: "",
        stderr: result.result.oomKilled
          ? `[agentq] the command was killed for memory ${MAX_MEMORY_RETRIES + 1} times (peak ${Math.round(result.result.peakRssKb / 1024)} MB); it needs more room than the agent's memory ceiling.`
          : "",
      };
    }
    if (result.kind === "deferred") {
      return {
        exitCode: 75,
        stdout: "",
        stderr: [
          `[agentq] QUEUED as ${result.ticket.id}: ${resources.join(", ")} is busy and this command was stored to run when it is free.`,
          `Do not wait or poll. Finish what you can without its result, commit, and end your turn with the single line:`,
          `WAITING FOR ${result.ticket.id}`,
          `The server runs the command and sends its result into this same conversation, then you continue from there.`,
        ].join("\n"),
      };
    }
    if (result.kind === "superseded") {
      return {
        exitCode: 75,
        stdout: "",
        stderr: `[agentq] ${result.ticket.label} was withdrawn: an identical check already finished or is running.`,
      };
    }
    return {
      exitCode: result.outcome === "unavailable" ? 77 : 76,
      stdout: "",
      stderr:
        result.outcome === "unavailable"
          ? `[agentq] ${result.message} Nothing ran. Do not retry; state in your final message that this check could not run on this machine.`
          : `[agentq] ${result.outcome === "exhausted" ? "The resource did not become available within the wait limit; nothing ran" : "Stopped waiting"}: ${result.message}`,
    };
  }

  const broker = openBroker();
  try {
    switch (sub) {
      case "status": {
        broker.pump();
        return out(broker.status(), statusText(broker));
      }
      case "config": {
        const config = loadResourceConfig();
        return out(config, JSON.stringify(config, null, 2));
      }
      case "host": {
        const host = readHost();
        return out(
          host,
          `${host.availableMb} MB available of ${host.totalMb} MB; load ${host.load1.toFixed(2)}; swap ${host.swapUsedMb}/${host.swapTotalMb} MB`,
        );
      }
      case "jobs": {
        const owner = typeof flags.owner === "string" ? flags.owner : positional[0];
        const jobs = owner
          ? broker.forOwner(owner).filter((t) => t.kind === "job")
          : broker.unreportedJobs();
        return out(jobs, jobs.length === 0 ? "No jobs." : jobs.map(jobLine).join("\n"));
      }
      case "job": {
        const id = positional[0];
        const ticket = id ? broker.get(id) : null;
        if (!ticket) return { exitCode: 1, stdout: "", stderr: `Unknown job ${id ?? ""}` };
        return out(
          ticket,
          ticket.state === "done" || ticket.state === "cancelled" || ticket.state === "expired"
            ? describeJob(ticket)
            : jobLine(ticket),
        );
      }
      case "wait": {
        const id = positional[0];
        const deadline = Date.now() + num(flags.timeout, 3600) * 1000;
        while (id) {
          broker.pump();
          const ticket = broker.get(id);
          if (!ticket) return { exitCode: 1, stdout: "", stderr: `Unknown job ${id}` };
          if (
            ticket.state === "done" ||
            ticket.state === "cancelled" ||
            ticket.state === "expired"
          ) {
            return {
              exitCode: ticket.outcome === "ok" ? 0 : 1,
              stdout: describeJob(ticket),
              stderr: "",
            };
          }
          if (Date.now() > deadline)
            return { exitCode: 75, stdout: "", stderr: `Still ${ticket.state}.` };
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return { exitCode: 2, stdout: "", stderr: "Usage: agentq resource wait <job-id>" };
      }
      case "cancel": {
        const id = positional[0];
        if (!id)
          return { exitCode: 2, stdout: "", stderr: "Usage: agentq resource cancel <ticket>" };
        broker.cancel(id, "cancelled by operator");
        return out({ cancelled: id }, `Cancelled ${id}.`);
      }
      case "daemon": {
        const repo =
          typeof flags.repo === "string"
            ? (repoOf(NodePath.resolve(flags.repo))?.common ?? null)
            : (repoOf(cwd)?.common ?? null);
        const runner = createJobRunner({ repo, broker });
        const stop = () => {
          runner.stop();
          process.exit(0);
        };
        process.on("SIGTERM", stop);
        process.on("SIGINT", stop);
        process.stderr.write(
          `[agentq] running stored resource jobs${repo ? ` for ${repo}` : ""}\n`,
        );
        for (;;) {
          await runner.tick();
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      default:
        return {
          exitCode: 2,
          stdout: "",
          stderr: "Usage: agentq resource <run|status|jobs|job|wait|cancel|config|host|daemon>",
        };
    }
  } finally {
    broker.close();
  }
}
