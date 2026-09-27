/**
 * ClineProvider — the status/diagnostic layer for the Cline driver.
 *
 * Cline has no non-interactive "am I signed in" command: `cline auth` and
 * `cline config` both hard-fail without a TTY, and `cline doctor` only reports
 * process health. The only honest signal is the ACP session setup itself, so
 * `checkClineProviderStatus` runs a real, throwaway `cline --acp` session and
 * reads authentication and the model catalog out of its answer. That process is
 * scoped to the check, so a failed probe cannot leak a Cline child.
 *
 * @module provider/Layers/ClineProvider
 */
import {
  type ClineSettings,
  type ModelCapabilities,
  type RuntimeMode,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import * as Crypto from "effect/Crypto";

import {
  CLINE_SUPPORTED_RUNTIME_MODES,
  classifyClineAuthFailure,
  clineModelsFromSessionSetup,
  makeClineAcpRuntime,
} from "../acp/ClineAcpSupport.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { expandHomePath } from "../../pathExpansion.ts";

/**
 * Cline's model catalog is a few hundred entries, so a probe that has to build
 * a session and stream them back needs more headroom than a bare `--version`.
 */
const VERSION_PROBE_TIMEOUT_MS = 4_000;
const ACP_DISCOVERY_TIMEOUT_MS = 20_000;
/** How long a wedged probe child gets to exit on SIGTERM before SIGKILL. */
const PROBE_FORCE_KILL_AFTER = "1 second" as const;
/** Ceiling on the kill itself, so teardown is bounded even against a wedged peer. */
const PROBE_TERMINATE_TIMEOUT_MS = 2_000;
const CLINE_DEFAULT_COMMAND = "cline";

/**
 * Hints follow the command that is actually configured. A custom `binaryPath`
 * makes the stock install advice and the stock `cline auth` advice wrong, and
 * the user is the only one who knows what that path is.
 */
const configuredCommand = (clineSettings: ClineSettings) =>
  clineSettings.binaryPath?.trim() || CLINE_DEFAULT_COMMAND;

const notInstalledHint = (clineSettings: ClineSettings) => {
  const command = configuredCommand(clineSettings);
  return command === CLINE_DEFAULT_COMMAND
    ? "Install it with `npm install -g cline`."
    : "Set a binary path that exists in Settings.";
};

const unauthenticatedHint = (clineSettings: ClineSettings) =>
  `Cline CLI is installed but not signed in. Run \`${configuredCommand(clineSettings)} auth\`.`;

const EMPTY_CATALOG_HINT =
  "Cline is signed in but did not advertise any usable models. Configure a provider and model in Cline, then re-check.";

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const CLINE_PRESENTATION = {
  displayName: "Cline",
  badgeLabel: "Early Access",
  // Cline's ACP build hard-disables reasoning, so no thinking level is offered.
  requiresNewThreadForModelChange: false,
  supportsConversationRollback: false,
  // Background generation would boot a full interactive Cline session on the
  // user's account; T3 picks another provider for titles and commit messages.
  supportsTextGeneration: false,
  showInteractionModeToggle: false,
  // Cline's CLI advertises image prompts but discards every non-text block
  // before dispatch, so a sent image or file would vanish without a trace.
  // The two are declared apart because they are separate questions, even
  // though this build answers no to both.
  supportsImageAttachments: false,
  supportsFileAttachments: false,
  supportedRuntimeModes: CLINE_SUPPORTED_RUNTIME_MODES as ReadonlyArray<RuntimeMode>,
} as const;

export function buildInitialClineProviderSnapshot(
  clineSettings: ClineSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: clineSettings.enabled,
      checkedAt,
      models: [],
      probe: clineSettings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Cline CLI availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Cline is disabled in T3 Code settings.",
          },
    });
  });
}

/** Cline's advertised models, shaped for the T3 model picker. */
function clineModelsFromSetup(
  sessionSetupResult: AcpSessionSetupResponse,
): ReadonlyArray<ServerProviderModel> {
  return clineModelsFromSessionSetup(sessionSetupResult).map((model) => ({
    slug: model.slug,
    name: model.name,
    isCustom: false,
    ...(model.isDefault ? { isDefault: true } : {}),
    capabilities: EMPTY_CAPABILITIES,
  }));
}

type AcpSessionSetupResponse = Parameters<typeof clineModelsFromSessionSetup>[0];

type StartOutcome =
  | { readonly kind: "ok"; readonly sessionSetupResult: AcpSessionSetupResponse }
  | { readonly kind: "error"; readonly cause: Cause.Cause<EffectAcpErrors.AcpError> }
  | { readonly kind: "timeout" };

export type ClineAcpDiscovery =
  | { readonly kind: "ok"; readonly models: ReadonlyArray<ServerProviderModel> }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "failed"; readonly errorTag: string };

/**
 * Opens a throwaway Cline ACP session purely to read its auth state and model
 * catalog. The session lives in a scope that closes as soon as the answer is
 * extracted, so an abandoned or failed probe never leaves a Cline process
 * running and never registers a session.
 */
const discoverClineModelsViaAcp = Effect.fn("discoverClineModelsViaAcp")(function* (
  clineSettings: ClineSettings,
  environment: NodeJS.ProcessEnv | undefined,
  timeoutMs: number,
): Effect.fn.Return<
  ClineAcpDiscovery,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.gen(function* () {
    const acp = yield* makeClineAcpRuntime({
      clineSettings,
      childProcessSpawner: spawner,
      cwd: process.cwd(),
      ...(environment ? { environment } : {}),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    // An agent that never answers `initialize` keeps its JSON-RPC request open,
    // so scope close would wait on a peer that will never speak again. Observe
    // startup as data and kill the exact child this probe owns when the
    // deadline passes.
    //
    // Forked into this probe's scope rather than detached: the timeout path
    // terminates the child first, and the scope close that follows is what
    // releases the fiber. A detached fiber would outlive the probe, so a kill
    // that fails leaks a fiber and its runtime for the life of the server, once
    // per status refresh.
    const startFiber = yield* acp.start().pipe(Effect.forkScoped);
    // Race rather than time out: `Effect.timeoutOption` interrupts the awaited
    // fiber, and interrupting a startup that is parked on an unanswered
    // JSON-RPC request tears the runtime down against a peer that will never
    // answer. Racing leaves `start` alone so this scope can kill the child.
    const startOutcome = yield* Effect.raceFirst(
      Fiber.await(startFiber).pipe(
        Effect.map((exit): StartOutcome =>
          Exit.isSuccess(exit)
            ? { kind: "ok", sessionSetupResult: exit.value.sessionSetupResult }
            : { kind: "error", cause: exit.cause },
        ),
      ),
      Effect.sleep(timeoutMs).pipe(Effect.as<StartOutcome>({ kind: "timeout" })),
    );

    if (startOutcome.kind === "timeout") {
      // Bound the kill too: a peer that never answers must not turn teardown
      // into an unbounded wait.
      yield* acp
        .terminate(PROBE_FORCE_KILL_AFTER)
        .pipe(Effect.timeoutOption(PROBE_TERMINATE_TIMEOUT_MS), Effect.ignore);
      return { kind: "failed", errorTag: "Timeout" } satisfies ClineAcpDiscovery;
    }
    if (startOutcome.kind === "error") {
      return yield* Effect.failCause(startOutcome.cause);
    }
    return {
      kind: "ok",
      models: clineModelsFromSetup(startOutcome.sessionSetupResult),
    } satisfies ClineAcpDiscovery;
  }).pipe(
    Effect.catchCause((cause): Effect.Effect<ClineAcpDiscovery> => {
      const failure = classifyClineAuthFailure(cause);
      return failure.kind === "unauthenticated"
        ? Effect.succeed({ kind: "unauthenticated" })
        : Effect.succeed({ kind: "failed", errorTag: causeErrorTag(cause) });
    }),
    Effect.scoped,
  );
});

const runClineCliCommand = (
  clineSettings: ClineSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv | undefined,
) =>
  Effect.gen(function* () {
    const command = expandHomePath(configuredCommand(clineSettings));
    const spawnCommand = yield* resolveSpawnCommand(
      command,
      args,
      environment ? { env: environment, extendEnv: true } : {},
    );
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(environment ? { env: environment, extendEnv: true } : {}),
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkClineProviderStatus = Effect.fn("checkClineProviderStatus")(function* (
  clineSettings: ClineSettings,
  environment: NodeJS.ProcessEnv | undefined = process.env,
) {
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  if (!clineSettings.enabled) {
    return yield* buildInitialClineProviderSnapshot(clineSettings);
  }

  const versionResult = yield* runClineCliCommand(clineSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Cline CLI health check failed.", { errorTag: error._tag });
    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? `Cline CLI (\`${configuredCommand(clineSettings)}\`) is not installed or not on PATH. ${notInstalledHint(clineSettings)}`
          : "Failed to execute the Cline CLI health check.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Cline CLI is installed but timed out while running `cline --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Cline CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Cline CLI is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* discoverClineModelsViaAcp(
    clineSettings,
    environment,
    ACP_DISCOVERY_TIMEOUT_MS,
  ).pipe(Effect.exit);
  // `Effect.exit` also captures interruptions, and a probe cancelled because
  // its scope closed has not learned anything about Cline. Re-interrupt instead
  // of reporting a timeout Cline never caused; discovery reports its own
  // deadline as a `Timeout` result, so a plain failure here is a real error.
  if (Exit.isFailure(discoveryExit)) {
    // `Cause.hasInterrupts` rather than `Exit.hasInterrupts`: the latter is
    // typed as refining to the whole `Failure` variant, so its false branch
    // narrows to `never`.
    if (Cause.hasInterrupts(discoveryExit.cause)) {
      return yield* Effect.interrupt;
    }
    const errorTag = causeErrorTag(discoveryExit.cause);
    yield* Effect.logWarning("Cline ACP model discovery failed.", {
      timeoutMs: ACP_DISCOVERY_TIMEOUT_MS,
      errorTag,
    });
    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Cline CLI is installed but its ACP session could not be verified (${errorTag}). Check server logs for details.`,
      },
    });
  }
  const discovery = discoveryExit.value;

  if (discovery.kind === "unauthenticated") {
    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unauthenticated" } satisfies ServerProviderAuth,
        message: unauthenticatedHint(clineSettings),
      },
    });
  }

  if (discovery.kind === "failed") {
    yield* Effect.logWarning("Cline ACP model discovery failed.", { errorTag: discovery.errorTag });
    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Cline CLI is installed but ACP startup failed. Check server logs for details.",
      },
    });
  }

  if (discovery.models.length === 0) {
    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "authenticated" } satisfies ServerProviderAuth,
        message: EMPTY_CATALOG_HINT,
      },
    });
  }

  return buildServerProvider({
    presentation: CLINE_PRESENTATION,
    enabled: true,
    checkedAt,
    models: discovery.models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "authenticated" } satisfies ServerProviderAuth,
    },
  });
});
