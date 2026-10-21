// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off globalConsole:off
/**
 * `node scripts/reliability-check.ts typecheck [--fresh] [--timeout SECONDS] -- <command>`: the entry
 * point the root and server `typecheck` scripts run through.
 *
 * - Admission: the check takes the machine's `heavy_build` lock with a memory demand that covers a
 *   compiler's measured peak (see TYPECHECK_DEMAND_MB), through the same broker as `agentq run`.
 * - Coalescing: identical checks (same source, lock file, checker versions, environment and command)
 *   share one process. A finished identical check answers from its receipt unless `--fresh` is given.
 * - Nesting: when a granted command runs this script again (the root script runs the server's), the
 *   inner check runs under the grant it inherited instead of queueing for the same unit.
 * - Timeouts stop the whole process tree and release the lock; the exit status is the command's own.
 *
 * @module reliability-check
 */
import {
  brokerHome,
  checkIdentity,
  claimCheck,
  readReceipt,
  releaseCheck,
  runningCheck,
  runUnderBroker,
  TYPECHECK_DEMAND_MB,
  writeReceipt,
  type CheckReceipt,
  type RunUnderBrokerResult,
} from "../packages/agent-queue-core/src/index.ts";

const USAGE =
  "Usage: node scripts/reliability-check.ts typecheck [--fresh] [--timeout SECONDS] [--wait SECONDS] -- <command> [args]";
const DEFAULT_TIMEOUT_SECONDS = 1800;

export interface ReliableCheckOptions {
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly runMs: number;
  readonly waitMs?: number;
  /** Run even when an identical check already has a receipt. */
  readonly fresh?: boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function exitCodeOf(result: RunUnderBrokerResult): number {
  if (result.kind === "ran") return result.result.exitCode;
  if (result.kind === "not-granted") {
    process.stderr.write(`[reliability-check] ${result.message}\n`);
    return result.outcome === "unavailable" ? 77 : 76;
  }
  return 75;
}

function replay(receipt: CheckReceipt): number {
  process.stderr.write(
    `[reliability-check] identical inputs were already checked (${receipt.key.slice(0, 12)}: ${receipt.outcome}, exit ${receipt.exitCode}); no compiler was launched.\n`,
  );
  process.stdout.write(receipt.tail);
  return receipt.exitCode;
}

/** Runs the check and returns the exit status it should end with. */
export async function runReliableCheck(options: ReliableCheckOptions): Promise<number> {
  const home = brokerHome();
  const chain = (process.env.AGENTQUEUE_CHECK_CHAIN ?? "").split(",").filter(Boolean);
  const identity = checkIdentity({ argv: options.argv, cwd: options.cwd });
  const request = {
    resources: [{ name: "typecheck", memoryMb: TYPECHECK_DEMAND_MB }],
    argv: options.argv,
    cwd: options.cwd,
    label: `typecheck: ${options.argv.join(" ")}`.slice(0, 100),
    runMs: options.runMs,
    ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
    stdio: "inherit" as const,
    onWaiting: (_ticket: unknown, position: number) =>
      process.stderr.write(`[reliability-check] waiting for typecheck (#${position} in line)\n`),
  };

  // Not a repository, or an identical check is an ancestor of this process: waiting for the same
  // check would wait on ourselves, so run under the grant this process inherited (or queue alone).
  if (!identity || chain.includes(identity.key)) {
    const result = await runUnderBroker({
      ...request,
      env: { AGENTQUEUE_CHECK_CHAIN: chain.join(",") },
    });
    return exitCodeOf(result);
  }

  const { key } = identity;
  while (true) {
    if (!options.fresh) {
      const receipt = readReceipt(key, home);
      if (receipt) return replay(receipt);
    }
    // Claims are taken only after admission, so a process that holds a grant never waits on a
    // claim whose owner is still queued; the owner of a claim is already running.
    if (runningCheck(key, home)) {
      await sleep(500);
      continue;
    }

    let startedAt = 0;
    const result = await runUnderBroker({
      ...request,
      env: { AGENTQUEUE_CHECK_CHAIN: [...chain, key].join(",") },
      shouldStop: () =>
        runningCheck(key, home) !== null || (!options.fresh && readReceipt(key, home) !== null),
      beforeRun: () => {
        if (!options.fresh && readReceipt(key, home) !== null) return false;
        if (!claimCheck(key, home)) return false;
        startedAt = Date.now();
        return true;
      },
      beforeFinish: (ended) => {
        // Written before the lock is released, so no waiter can be granted between the two.
        try {
          if (ended.outcome === "ok" || ended.outcome === "failed") {
            writeReceipt(
              {
                key,
                command: options.argv.join(" "),
                outcome: ended.outcome,
                exitCode: ended.exitCode,
                tail: ended.tail,
                elapsedMs: Date.now() - startedAt,
                peakRssKb: ended.peakRssKb,
                checkers: identity.checkers,
                finishedAt: Date.now(),
              },
              home,
            );
          }
        } finally {
          releaseCheck(key, home);
        }
      },
    });
    if (result.kind === "superseded") continue;
    releaseCheck(key, home);
    return exitCodeOf(result);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const separator = argv.indexOf("--");
  const head = separator === -1 ? argv : argv.slice(0, separator);
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  const valueOf = (flag: string) => {
    const at = head.indexOf(flag);
    return at === -1 ? undefined : head[at + 1];
  };
  const timeout = Number(valueOf("--timeout") ?? DEFAULT_TIMEOUT_SECONDS);
  const wait = valueOf("--wait");
  if (head[0] !== "typecheck" || command.length === 0 || !(timeout > 0)) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
  } else {
    process.exitCode = await runReliableCheck({
      argv: command,
      cwd: process.cwd(),
      runMs: timeout * 1000,
      fresh: head.includes("--fresh"),
      ...(wait !== undefined ? { waitMs: Number(wait) * 1000 } : {}),
    });
  }
}
