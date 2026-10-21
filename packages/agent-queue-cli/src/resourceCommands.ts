// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off globalConsole:off
/**
 * `agentq run -- <command>` and `agentq resource ...`: what a worker uses for anything that
 * contends for a shared machine resource (Gradle, an emulator, Docker, a database, a GPU).
 *
 * The worker does not choose which resource or who else is using it. It prefixes the command; the
 * resources are inferred from the command line and the repository's contract, the request waits in
 * the machine-wide fair queue, and the command runs only while it holds them. If the wait would be
 * long, the request becomes a stored job: the command exits immediately telling the worker to end its
 * turn, the server runs the job when the resource is free and sends the result back to the same
 * conversation. A busy resource is never a reason for a worker to give up or ask for help.
 */
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { resolveGitContext } from "./gitContext.ts";
import {
  createJobRunner,
  describeJob,
  inferResourceDemands,
  loadContract,
  loadResourceConfig,
  normalizeResource,
  openBroker,
  readHost,
  runUnderBroker,
  type ResourceBroker,
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

export interface ResourceCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const fmtMs = (ms: number) =>
  ms < 90_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;

function statusText(broker: ResourceBroker): string {
  const { resources, host, reserveMb } = broker.status();
  const lines = [
    `Host: ${host.availableMb} MB available of ${host.totalMb} MB (reserve ${reserveMb} MB), ${host.swapUsedMb} MB swapped, load ${host.load1.toFixed(1)} on ${host.cpus} CPUs`,
  ];
  for (const resource of resources) {
    if (resource.capacity === 0 && resource.active === 0 && resource.waiting === 0) {
      lines.push(`${resource.name}: not available on this machine`);
      continue;
    }
    lines.push(
      `${resource.name}: ${resource.active}/${resource.capacity} in use, ${resource.waiting} waiting`,
    );
    for (const holder of resource.holders)
      lines.push(
        `    holding ${holder.ticket} slot ${holder.slots.join(",")} for ${fmtMs(holder.sinceMs)}: ${holder.label}`,
      );
    for (const waiter of resource.queue)
      lines.push(
        `    #${waiter.position} ${waiter.ticket} waiting ${fmtMs(waiter.waitingMs)}: ${waiter.label}`,
      );
  }
  return lines.join("\n");
}

const jobLine = (ticket: Ticket) =>
  `${ticket.id} ${ticket.state}${ticket.outcome ? `/${ticket.outcome}` : ""} [${ticket.resources.map((r) => r.name).join(",")}] ${ticket.job?.command ?? ticket.label}`;

/**
 * Handles `run` and `resource <sub>`. Returns null when `argv` is not one of them, so the
 * synchronous CLI can take over.
 */
export async function runResourceCommand(
  argv: ReadonlyArray<string>,
  cwd: string = process.cwd(),
): Promise<ResourceCliResult | null> {
  const [first, second] = argv;
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
    if (command.length === 0) {
      return {
        exitCode: 2,
        stdout: "",
        stderr:
          "Usage: agentq run [--resource a,b] [--owner TASK] [--defer-after SECONDS] [--timeout SECONDS] [--wait SECONDS] -- <command> [args]",
      };
    }
    const { resources: repoResources, repo } = contractResources(cwd);
    const commandLine = command.join(" ");
    const named =
      typeof flags.resource === "string"
        ? flags.resource.split(",").map(normalizeResource).filter(Boolean)
        : [];
    const demands = [
      ...named.map((name) => ({ name })),
      ...inferResourceDemands(commandLine, repoResources),
    ];
    const resources = [...new Set(demands.map((demand) => demand.name))];
    if (resources.length === 0) {
      // Nothing shared is involved: run it straight away, as if the prefix were not there.
      const child = NodeChildProcess.spawnSync(command[0]!, command.slice(1), {
        cwd,
        stdio: "inherit",
      });
      return { exitCode: child.status ?? 1, stdout: "", stderr: "" };
    }
    const hints = Object.fromEntries(
      repoResources.map((resource) => [resource.name, { capacity: resource.limit }]),
    );
    const deferAfter =
      typeof flags["defer-after"] === "string"
        ? num(flags["defer-after"], 0)
        : num(process.env.AGENTQUEUE_DEFER_AFTER, 0);
    const owner = typeof flags.owner === "string" ? flags.owner : process.env.AGENTQUEUE_OWNER;
    const result = await runUnderBroker({
      resources: demands,
      argv: command,
      cwd,
      label: typeof flags.label === "string" ? flags.label : commandLine.slice(0, 100),
      ...(owner ? { ownerRef: owner } : {}),
      ...(repo ? { repo: repo.common } : {}),
      hints,
      waitMs: num(flags.wait, 3 * 3600) * 1000,
      ...(typeof flags.timeout === "string" ? { runMs: num(flags.timeout, 0) * 1000 } : {}),
      stdio: "inherit",
      ...(deferAfter > 0 && owner ? { deferAfterMs: deferAfter * 1000 } : {}),
      onWaiting: (ticket, position) =>
        process.stderr.write(
          `[agentq] waiting for ${ticket.resources.map((r) => r.name).join(", ")} (${position === 1 ? "next in line" : `#${position} in line`}; ${ticket.note ?? "queued"})\n`,
        ),
    });
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
      return { exitCode: result.result.exitCode, stdout: "", stderr: "" };
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
