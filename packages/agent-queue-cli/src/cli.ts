// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import {
  importPlanCommand,
  listTasksCommand,
  claimTaskCommand,
  heartbeatCommand,
  releaseCommand,
  statusCommand,
  eventsCommand,
  abortTaskCommand,
  retryTaskCommand,
  blockTaskCommand,
  unblockTaskCommand,
  noteTaskCommand,
  repoInitCommand,
  repoDoctorCommand,
} from "./commands.ts";

export interface ParsedArgs {
  readonly command: string;
  readonly subcommand?: string;
  readonly positional: string[];
  readonly flags: Record<string, string | boolean>;
}

export function parseArgs(rawArgs: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (!arg) continue;
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const next = rawArgs[i + 1];
        if (next && !next.startsWith("-")) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = true;
        }
      }
    } else if (arg.startsWith("-")) {
      flags[arg.slice(1)] = true;
    } else {
      positional.push(arg);
    }
  }

  const [command, subcommand, ...rest] = positional;
  return {
    command: command ?? "status",
    ...(subcommand !== undefined ? { subcommand } : {}),
    positional: rest,
    flags,
  };
}

export function runCli(
  rawArgs: string[],
  cwd: string = process.cwd(),
): { exitCode: number; output: string } {
  const args = parseArgs(rawArgs);
  const jsonMode = Boolean(args.flags.json);

  try {
    let result: Record<string, unknown>;

    switch (args.command) {
      case "repo":
        if (args.subcommand === "init") {
          result = repoInitCommand({ cwd, json: jsonMode });
        } else if (args.subcommand === "doctor") {
          result = repoDoctorCommand({ cwd, json: jsonMode });
        } else {
          throw new Error(`Unknown repo subcommand: ${args.subcommand}`);
        }
        break;

      case "plan":
        if (args.subcommand === "import") {
          const filePath = args.positional[0] || (args.flags.file as string);
          if (!filePath) throw new Error("Usage: agentqueue plan import <plan-file>");
          result = importPlanCommand(filePath, { cwd, json: jsonMode });
        } else {
          throw new Error(`Unknown plan subcommand: ${args.subcommand}`);
        }
        break;

      case "task":
        switch (args.subcommand) {
          case "list": {
            const listFilters: { status?: string; planId?: string } = {};
            if (typeof args.flags.status === "string") listFilters.status = args.flags.status;
            if (typeof args.flags.plan === "string") listFilters.planId = args.flags.plan;
            result = listTasksCommand(listFilters, { cwd, json: jsonMode });
            break;
          }

          case "claim": {
            const claimOpts: { taskId?: string; leaseSeconds?: number } = {};
            const taskId = (args.flags.id as string) || args.positional[0];
            if (taskId) claimOpts.taskId = taskId;
            if (args.flags.lease) {
              const lease = parseInt(args.flags.lease as string, 10);
              if (!isNaN(lease)) claimOpts.leaseSeconds = lease;
            }
            result = claimTaskCommand(claimOpts, { cwd, json: jsonMode });
            break;
          }

          case "heartbeat": {
            const token = (args.flags.token as string) || args.positional[0];
            if (!token) throw new Error("Usage: agentqueue task heartbeat --token <token>");
            result = heartbeatCommand(token, 120, { cwd, json: jsonMode });
            break;
          }

          case "release": {
            const token = (args.flags.token as string) || args.positional[0];
            const status = (args.flags.status as "completed" | "failed" | "pending") || "completed";
            const reason = (args.flags.reason as string) || undefined;
            if (!token)
              throw new Error(
                "Usage: agentqueue task release --token <token> [--status completed|failed]",
              );
            result = releaseCommand(token, status, reason, { cwd, json: jsonMode });
            break;
          }

          case "abort": {
            const taskId = args.positional[0] || (args.flags.id as string);
            const reason = (args.flags.reason as string) || "Aborted by operator";
            if (!taskId) throw new Error("Usage: agentqueue task abort <task-id>");
            result = abortTaskCommand(taskId, reason, { cwd, json: jsonMode });
            break;
          }

          case "retry": {
            const taskId = args.positional[0] || (args.flags.id as string);
            if (!taskId) throw new Error("Usage: agentqueue task retry <task-id>");
            result = retryTaskCommand(taskId, { cwd, json: jsonMode });
            break;
          }

          case "block": {
            const taskId = args.positional[0] || (args.flags.id as string);
            const reason = (args.flags.reason as string) || "Blocked by operator";
            if (!taskId)
              throw new Error("Usage: agentqueue task block <task-id> --reason <reason>");
            result = blockTaskCommand(taskId, reason, { cwd, json: jsonMode });
            break;
          }

          case "unblock": {
            const taskId = args.positional[0] || (args.flags.id as string);
            if (!taskId) throw new Error("Usage: agentqueue task unblock <task-id>");
            result = unblockTaskCommand(taskId, { cwd, json: jsonMode });
            break;
          }

          case "note": {
            const taskId = args.positional[0] || (args.flags.id as string);
            const noteText = args.positional.slice(1).join(" ") || (args.flags.text as string);
            if (!taskId || !noteText)
              throw new Error("Usage: agentqueue task note <task-id> <note text>");
            result = noteTaskCommand(taskId, noteText, { cwd, json: jsonMode });
            break;
          }

          default:
            throw new Error(`Unknown task subcommand: ${args.subcommand}`);
        }
        break;

      case "status":
        result = statusCommand({ cwd, json: jsonMode });
        break;

      case "events": {
        const since = args.flags.since ? parseInt(args.flags.since as string, 10) : 0;
        result = eventsCommand(since, 100, { cwd, json: jsonMode });
        break;
      }

      default:
        throw new Error(`Unknown agentqueue command: ${args.command}`);
    }

    if (jsonMode) {
      return { exitCode: 0, output: JSON.stringify(result, null, 2) };
    }

    return { exitCode: 0, output: formatHumanOutput(args.command, args.subcommand, result) };
  } catch (err: any) {
    if (jsonMode) {
      return {
        exitCode: 1,
        output: JSON.stringify({ error: err.message, stack: err.stack }, null, 2),
      };
    }
    return { exitCode: 1, output: `Error: ${err.message}` };
  }
}

function formatHumanOutput(
  command: string,
  subcommand: string | undefined,
  data: Record<string, any>,
): string {
  if (command === "status") {
    const snap = data.snapshot;
    const dl = data.deadlock;
    return [
      `=== AgentQueue Status ===`,
      `Tasks: ${snap.counts.total} (Pending: ${snap.counts.pending}, Claimed: ${snap.counts.claimed}, Running: ${snap.counts.running}, Completed: ${snap.counts.completed}, Failed: ${snap.counts.failed}, Blocked: ${snap.counts.blocked})`,
      `Active Leases: ${snap.activeLeases.length}`,
      dl.isDeadlocked ? `DEADLOCK DETECTED: ${dl.reason}` : `Queue Healthy (no deadlock)`,
    ].join("\n");
  }

  if (command === "plan" && subcommand === "import") {
    return `Imported plan '${data.title}' (${data.planId}) with ${data.taskCount} tasks.`;
  }

  if (command === "task" && subcommand === "list") {
    if (data.count === 0) return "No tasks found.";
    return data.tasks
      .map((t: any) => `[${t.status.toUpperCase()}] ${t.id} (Prio ${t.priority}) - ${t.title}`)
      .join("\n");
  }

  return JSON.stringify(data, null, 2);
}
