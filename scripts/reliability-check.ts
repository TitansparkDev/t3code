// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off globalConsole:off
/** Brokered typecheck execution. @module reliability-check */
import * as NodeCrypto from "node:crypto";
import {
  brokerHome,
  claimCheck,
  defaultReuseEnv,
  declaredCheckIdentity,
  matchingReceipt,
  releaseCheck,
  runningCheck,
  runUnderBroker,
  TYPECHECK_DEMAND_MB,
  waitForCheck,
  writeReceipt,
  type CheckReceipt,
  type RunUnderBrokerResult,
} from "../packages/agent-queue-core/src/index.ts";

const USAGE =
  "Usage: node scripts/reliability-check.ts typecheck [--fresh] [--timeout SECONDS] [--wait SECONDS] -- <command> [args]";
const DEFAULT_TIMEOUT_SECONDS = 1800;
const TYPECHECK_INPUTS = ["**/*", "**/.*"] as const;

export interface ReliableCheckOptions {
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly runMs: number;
  readonly waitMs?: number;
  /** Run even when an identical check already has a receipt. */
  readonly fresh?: boolean;
}

function identity(options: ReliableCheckOptions) {
  return declaredCheckIdentity({
    argv: options.argv,
    cwd: options.cwd,
    reuseInputs: TYPECHECK_INPUTS,
    reuseEnv: defaultReuseEnv(process.env),
  });
}

function reusableReceipt(
  currentIdentity: NonNullable<ReturnType<typeof identity>>,
  runMs: number,
): CheckReceipt | null {
  const receipt = matchingReceipt(currentIdentity, {});
  return receipt && receipt.elapsedMs < runMs ? receipt : null;
}

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
    `[reliability-check] identical inputs already passed (${receipt.key.slice(0, 12)}); no compiler was launched.\n`,
  );
  return 0;
}

/** Runs the check and returns the exit status it should end with. */
export async function runReliableCheck(options: ReliableCheckOptions): Promise<number> {
  const home = brokerHome();
  const chain = (process.env.AGENTQUEUE_CHECK_CHAIN ?? "").split(",").filter(Boolean);
  const initialIdentity = identity(options);
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
  if (!initialIdentity || chain.includes(initialIdentity.key)) {
    const result = await runUnderBroker({
      ...request,
      env: { AGENTQUEUE_CHECK_CHAIN: chain.join(",") },
    });
    return exitCodeOf(result);
  }

  while (true) {
    const currentIdentity = identity(options);
    if (!currentIdentity) return exitCodeOf(await runUnderBroker(request));
    const { key } = currentIdentity;
    if (!options.fresh) {
      const receipt = reusableReceipt(currentIdentity, options.runMs);
      if (receipt) return replay(receipt);
    }
    if (runningCheck(key, home)) {
      if (!(await waitForCheck(key, home, options.runMs))) {
        process.stderr.write(
          "[reliability-check] an identical typecheck remained in progress for this timeout; no compiler was launched.\n",
        );
        return 76;
      }
      continue;
    }

    let claimOwner: string | null = null;
    let startedAt = 0;
    let invalidated = false;
    let result: RunUnderBrokerResult;
    try {
      result = await runUnderBroker({
        ...request,
        env: { AGENTQUEUE_CHECK_CHAIN: [...chain, key].join(",") },
        shouldStop: () =>
          runningCheck(key, home) !== null ||
          (!options.fresh && reusableReceipt(currentIdentity, options.runMs) !== null),
        beforeRun: () => {
          const current = identity(options);
          if (!current || current.key !== key) return false;
          if (!options.fresh && reusableReceipt(currentIdentity, options.runMs)) return false;
          try {
            claimOwner = claimCheck(key, home);
          } catch {
            claimOwner = null;
          }
          if (!claimOwner && runningCheck(key, home)) return false;
          startedAt = Date.now();
          return true;
        },
        beforeFinish: (ended) => {
          try {
            if (ended.outcome === "ok" && ended.exitCode === 0 && !ended.oomKilled) {
              const after = identity(options);
              if (!after || after.key !== key) {
                invalidated = true;
                return;
              }
              if (!claimOwner) return;
              try {
                writeReceipt(
                  {
                    schemaVersion: 2,
                    key,
                    commandHash: NodeCrypto.createHash("sha256")
                      .update(JSON.stringify(options.argv))
                      .digest("hex"),
                    outcome: "ok",
                    exitCode: 0,
                    elapsedMs: Date.now() - startedAt,
                    peakRssKb: ended.peakRssKb,
                    checkers: currentIdentity.checkers,
                    outputs: {},
                    finishedAt: Date.now(),
                  },
                  home,
                );
              } catch {
                // An unwritable cache only causes a later rerun.
              }
            }
          } finally {
            if (claimOwner) releaseCheck(key, claimOwner, home);
            claimOwner = null;
          }
        },
      });
    } finally {
      if (claimOwner) releaseCheck(key, claimOwner, home);
      claimOwner = null;
    }
    if (invalidated) {
      process.stderr.write(
        "[reliability-check] inputs changed while typecheck was running; rerun it.\n",
      );
      return 1;
    }
    if (result.kind === "superseded") continue;
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
