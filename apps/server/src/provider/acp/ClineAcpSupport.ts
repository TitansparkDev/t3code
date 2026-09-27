/**
 * ClineAcpSupport — everything provider-specific about driving Cline over ACP.
 *
 * Cline speaks ACP through `cline --acp`, a newline-delimited JSON-RPC 2.0
 * stdio server. Three traits of that build shape this module:
 *
 * 1. **Authentication is never requested.** Cline's ACP `authenticate` starts a
 *    device-code OAuth flow: it prints a URL to stderr, tries to open a browser,
 *    and then blocks forever waiting for the user. On a T3 server that browser
 *    opens on the wrong machine, so `makeClineAcpRuntime` deliberately omits
 *    `authMethodId` and lets session setup reveal an unauthenticated CLI through
 *    its `-32000` error instead. See `classifyClineAuthFailure`.
 *
 * 2. **The model catalog arrives in session setup, not `initialize`.**
 *    `session/new` returns both an unstable `models` object and a `model` select
 *    inside `configOptions`. `AcpRuntimeModel.extractModelConfigId` picks the
 *    first option with `category: "model"`, which for Cline is the *provider*
 *    picker — so Cline resolves its own option id rather than trusting that
 *    helper. See `findClineModelConfigOption`.
 *
 * 3. **Tool approval has exactly one knob.** Cline exposes a single
 *    `auto_approve` boolean; it has no per-tool policies and no middle ground
 *    between "ask about everything" and "approve everything". T3's
 *    `approval-required` and `full-access` modes map onto those two states and
 *    the two in-between modes are declared unsupported, so T3 never promises a
 *    narrower grant than Cline will enforce.
 *
 * @module provider/acp/ClineAcpSupport
 */
import { type ClineSettings, type RuntimeMode } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { findSessionConfigOption } from "./AcpRuntimeModel.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const CLINE_BINARY = "cline";

/** `~/.cline/data` by default; `cline --help` documents the flag Cline reads it from. */
const CLINE_DATA_DIR_ENV = "CLINE_DATA_DIR";
const CLINE_DIR_ENV = "CLINE_DIR";

export type ClineAcpRuntimeClineSettings = Pick<ClineSettings, "binaryPath" | "dataDir">;

export interface ClineAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "resumeMethod" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly clineSettings: ClineAcpRuntimeClineSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * `--auto-approve` is honored in ACP mode; every other run flag is parsed after
 * the ACP branch has already taken over, so passing one would be a silent no-op.
 * Approval is driven through the ACP permission handler instead, which keeps
 * the CLI's own default (ask about every tool) and lets T3 decide.
 */
export function clineAcpSpawnArgs(): ReadonlyArray<string> {
  return ["--acp"];
}

/**
 * Relocating Cline's state is environment-only: `--config` / `--data-dir` are
 * ignored once `--acp` takes over, so a second instance points at its own
 * profile by exporting `CLINE_DIR` / `CLINE_DATA_DIR` for that process.
 */
function clineDataDirEnv(clineSettings: ClineAcpRuntimeClineSettings | null | undefined) {
  const dataDir = clineSettings?.dataDir?.trim();
  if (!dataDir) {
    return {};
  }
  // Expanded like every other provider's path setting: the child process does
  // not run a shell, so a literal `~/...` would be passed through as a
  // directory named "~" instead of the user's home.
  const resolved = expandHomePath(dataDir);
  return {
    [CLINE_DIR_ENV]: resolved,
    [CLINE_DATA_DIR_ENV]: resolved,
  };
}

export function buildClineAcpSpawnInput(
  clineSettings: ClineAcpRuntimeClineSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    // Expanded for the same reason as the data dir: a spawn has no shell to
    // resolve `~`, and a path the user typed in Settings should work the way it
    // does for the other providers.
    command: expandHomePath(clineSettings?.binaryPath?.trim() || CLINE_BINARY),
    args: clineAcpSpawnArgs(),
    cwd,
    ...(environment
      ? {
          env: { ...environment, ...clineDataDirEnv(clineSettings) },
          extendEnv: true,
        }
      : clineDataDirEnv(clineSettings)),
  };
}

export const makeClineAcpRuntime = Effect.fn("makeClineAcpRuntime")(function* (
  input: ClineAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> {
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...input,
      spawn: buildClineAcpSpawnInput(input.clineSettings, input.cwd, input.environment),
      // Cline implements `session/load` and returns its model catalog in the
      // authoritative response. `session/resume` is `-32601` on this build.
      resumeMethod: "load",
      // Cline never calls `fs/*` or `terminal/*`; it does all file and shell
      // work in-process, so advertising client filesystem access would only
      // invite traffic T3 cannot meaningfully gate.
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    }).pipe(
      Layer.provide(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
      ),
    ),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});

/* -------------------------------------------------------------------------- */
/* Model catalog                                                              */
/* -------------------------------------------------------------------------- */

type ClineSessionSetupResult =
  | EffectAcpSchema.LoadSessionResponse
  | EffectAcpSchema.NewSessionResponse
  | EffectAcpSchema.ResumeSessionResponse;

type ClineModelSelectOption = Extract<
  EffectAcpSchema.SessionConfigOption,
  { readonly type: "select" }
>;

/**
 * Cline advertises the model picker twice: as the unstable `models` object and
 * as the `model` select in `configOptions`. Reads prefer the `models` object and
 * fall back to the select, so a build that drops the extension still yields a
 * catalog and a build that drops `configOptions` still yields a switchable one.
 */
function clineModelSelectValues(
  option: ClineModelSelectOption | undefined,
): ReadonlyArray<{ value: string; name: string }> {
  if (!option) {
    return [];
  }
  return option.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
}

/**
 * Resolves the config option that selects a Cline model.
 *
 * Cline tags its *provider* picker with `category: "model"` too and lists it
 * first, so the shared `extractModelConfigId` resolves to `"provider"` and
 * `session/set_config_option` would change accounts instead of models. Prefer
 * the literal `model` id and never fall back to the provider picker.
 */
export function findClineModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ClineModelSelectOption | undefined {
  const byId = findSessionConfigOption(configOptions, "model");
  if (byId?.type === "select") {
    return byId;
  }
  const byCategory = configOptions?.find(
    (option) =>
      option.type === "select" && option.category === "model" && option.id.trim() !== "provider",
  );
  return byCategory?.type === "select" ? byCategory : undefined;
}

export interface ClineDiscoveredModel {
  readonly slug: string;
  readonly name: string;
  readonly isDefault: boolean;
}

export function currentClineModelIdFromSessionSetup(
  sessionSetupResult: ClineSessionSetupResult,
): string | undefined {
  const fromModelState = sessionSetupResult.models?.currentModelId?.trim();
  if (fromModelState) {
    return fromModelState;
  }
  const currentValue = findClineModelConfigOption(
    sessionSetupResult.configOptions,
  )?.currentValue.trim();
  return currentValue ? currentValue : undefined;
}

/**
 * Flattens Cline's advertised catalog into T3 models. Grouped and flat selects
 * are both handled, and blanks and duplicates are dropped.
 *
 * At most one entry is marked default, and only when the session's current
 * selection is actually in the catalog. A current model that is not advertised
 * leaves every entry unmarked rather than promoting an arbitrary one: the
 * session's own choice is not ours to second-guess, and a wrong default would
 * silently pin the thread to a model the user did not pick.
 */
export function clineModelsFromSessionSetup(
  sessionSetupResult: ClineSessionSetupResult,
): ReadonlyArray<ClineDiscoveredModel> {
  const modelState = sessionSetupResult.models;
  const currentModelId = currentClineModelIdFromSessionSetup(sessionSetupResult);
  const advertised: ReadonlyArray<{ slug: string; name: string }> =
    modelState && modelState.availableModels.length > 0
      ? modelState.availableModels.map((model) => ({ slug: model.modelId, name: model.name }))
      : clineModelSelectValues(findClineModelConfigOption(sessionSetupResult.configOptions)).map(
          (entry) => ({ slug: entry.value, name: entry.name }),
        );

  const seen = new Set<string>();
  const models: Array<ClineDiscoveredModel> = [];
  for (const entry of advertised) {
    const slug = entry.slug.trim();
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    const name = entry.name.trim();
    models.push({
      slug,
      name: name || slug,
      isDefault: slug === currentModelId,
    });
  }
  return models;
}

export class ClineModelSelectionError extends Schema.TaggedError<ClineModelSelectionError>()(
  "ClineModelSelectionError",
  { requestedModelId: Schema.String },
) {
  override get message(): string {
    return `Cline did not advertise model '${this.requestedModelId}'.`;
  }
}

/**
 * Applies a requested model through the option Cline actually advertised.
 *
 * A selection outside the advertised catalog is rejected instead of forwarded:
 * `session/set_model` accepts any string on this build, so an unchecked slug
 * would silently pin the session to a model Cline never offered.
 *
 * The value written back is the advertised entry verbatim, not the trimmed
 * request, because the runtime validates it against the advertised set.
 */
export const applyClineAcpModelSelection = Effect.fn("applyClineAcpModelSelection")(
  function* (input: {
    readonly runtime: Pick<
      AcpSessionRuntime.AcpSessionRuntime["Service"],
      "getConfigOptions" | "setConfigOption"
    >;
    readonly requestedModelId: string | null | undefined;
    readonly mapError: (cause: EffectAcpErrors.AcpError) => ProviderAdapterError;
  }): Effect.fn.Return<void, ProviderAdapterError | ClineModelSelectionError> {
    const requested = input.requestedModelId?.trim();
    if (!requested) {
      return;
    }
    const option = findClineModelConfigOption(yield* input.runtime.getConfigOptions);
    if (!option) {
      return;
    }
    const advertised = clineModelSelectValues(option);
    if (advertised.length === 0) {
      return;
    }
    const match = advertised.find((entry) => entry.value.trim() === requested);
    if (!match) {
      return yield* new ClineModelSelectionError({ requestedModelId: requested });
    }
    if (option.currentValue.trim() === requested) {
      return;
    }
    yield* input.runtime
      .setConfigOption(option.id, match.value)
      .pipe(Effect.mapError(input.mapError));
  },
);

/* -------------------------------------------------------------------------- */
/* Session modes                                                              */
/* -------------------------------------------------------------------------- */

const CLINE_PLAN_MODE_ALIASES: ReadonlySet<string> = new Set(["plan", "architect"]);
const CLINE_ACT_MODE_ALIASES: ReadonlyArray<string> = [
  "act",
  "code",
  "agent",
  "default",
  "chat",
  "implement",
];

/**
 * Cline's Act mode id when the session advertises one.
 *
 * Aliases and the Plan exclusion are matched against a normalized copy, but
 * the id returned is the one exactly as advertised, because the runtime
 * validates `session/set_mode` against the advertised set.
 */
export function resolveClineActModeId(
  modeState:
    | {
        readonly currentModeId: string;
        readonly availableModes: ReadonlyArray<{ readonly id: string }>;
      }
    | undefined,
): string | undefined {
  if (!modeState) {
    return undefined;
  }
  // First advertised occurrence wins, so a duplicated alias cannot reorder the
  // match away from the id the session actually offered first.
  const advertisedByNormalizedId = new Map<string, string>();
  for (const mode of modeState.availableModes) {
    const normalized = mode.id.trim().toLowerCase();
    if (!advertisedByNormalizedId.has(normalized)) {
      advertisedByNormalizedId.set(normalized, mode.id);
    }
  }
  const aliasMatch = CLINE_ACT_MODE_ALIASES.map((alias) =>
    advertisedByNormalizedId.get(alias),
  ).find((id) => id !== undefined);
  if (aliasMatch !== undefined) {
    return aliasMatch;
  }
  const nonPlanId = [...advertisedByNormalizedId.keys()].find(
    (normalized) => !CLINE_PLAN_MODE_ALIASES.has(normalized),
  );
  if (nonPlanId !== undefined) {
    return advertisedByNormalizedId.get(nonPlanId) ?? undefined;
  }
  return modeState.currentModeId;
}

/* -------------------------------------------------------------------------- */
/* Permissions                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Access modes Cline can actually enforce. `auto-accept-edits` and `auto` both
 * promise a middle ground — approve some tool classes, ask about others — and
 * Cline's single `auto_approve` boolean cannot express either, so advertising
 * them would grant more than the user chose.
 */
export const CLINE_SUPPORTED_RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "full-access",
];

export function clineSupportsRuntimeMode(runtimeMode: RuntimeMode): boolean {
  return CLINE_SUPPORTED_RUNTIME_MODES.includes(runtimeMode);
}

/* -------------------------------------------------------------------------- */
/* Authentication state                                                        */
/* -------------------------------------------------------------------------- */

const CLINE_SESSION_SETUP_METHODS: ReadonlySet<string> = new Set([
  "session/new",
  "session/load",
  "session/resume",
]);
/**
 * Cline's session-setup auth guard, e.g.
 * `Authentication required: Call authenticate before starting a session`.
 * T3 never issues that call, so the wording alone is a reliable signal.
 */
const CLINE_AUTH_REQUIRED_MESSAGE = /authenticat|sign(?:ed)?[ -]?in|credential|api[ _-]?key/i;
/**
 * Messages that mean the CLI never ran. They must not be read as a sign-in
 * problem even though a broken `PATH` can also mention the API key.
 */
const CLINE_STARTUP_FAILURE_MESSAGE = /spawn|enoent|not found|no such file|executable|timed? ?out/i;

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);
const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);

export type ClineDiscoveryFailure =
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "failed" };

/**
 * Messages carried by defects only. A typed failure has already had its chance
 * above, where the method and code could be checked; re-reading its message
 * here would undo that check.
 */
function defectMessages(cause: Cause.Cause<unknown>): ReadonlyArray<string> {
  return cause.reasons.flatMap((reason) => {
    if (reason._tag !== "Die") {
      return [];
    }
    const defect: unknown = reason.defect;
    return [
      typeof defect === "string"
        ? defect
        : String((defect as Error | undefined)?.message ?? defect),
    ];
  });
}

/**
 * Every message that could be Cline's auth guard, with the shape-specific
 * precision already applied.
 *
 * The verified shape is a typed `AcpRequestError`: against Cline 3.0.65 an
 * unauthenticated CLI answers `session/new` with a well-formed
 * `-32000 {"message":"Authentication required: Call authenticate before starting
 * a session"}`. The method and the `-32000` code both have to line up, because
 * `-32000` is generic and an unrelated one must not read as a sign-in problem.
 *
 * The other two are defensive, for builds that give up earlier and never
 * produce that response at all:
 *
 * - A typed `AcpProcessExitedError`. A CLI that prints the guard to stderr and
 *   exits without answering yields no request error, so only the captured stderr
 *   counts — the wrapper's own "ACP process exited" text says nothing about why.
 * - A thrown defect, whose message is the last text left when a failure never
 *   becomes a typed error.
 */
function clineAuthCandidateMessages(
  cause: Cause.Cause<EffectAcpErrors.AcpError>,
): ReadonlyArray<string> {
  const messages: Array<string> = [...defectMessages(cause)];
  const error = Cause.findErrorOption(cause);
  if (Option.isSome(error)) {
    if (
      isAcpRequestError(error.value) &&
      error.value.code === -32000 &&
      error.value.method !== undefined &&
      CLINE_SESSION_SETUP_METHODS.has(error.value.method)
    ) {
      messages.push(error.value.errorMessage);
    }
    if (isAcpProcessExitedError(error.value)) {
      const stderr = error.value.stderr?.trim();
      if (stderr) {
        messages.push(stderr);
      }
    }
  }
  return messages;
}

/**
 * Splits "Cline is not signed in" from "Cline is broken" so Settings can offer
 * `cline auth` instead of a support ticket. See
 * {@link clineAuthCandidateMessages} for the shapes this recognizes.
 *
 * The startup guard is applied to every shape, not just the ones that carry
 * only a message: a broken `PATH` can also mention the API key, and that CLI
 * still needs installing rather than signing in.
 */
export function classifyClineAuthFailure(
  cause: Cause.Cause<EffectAcpErrors.AcpError>,
): ClineDiscoveryFailure {
  if (
    clineAuthCandidateMessages(cause).some(
      (message) =>
        CLINE_AUTH_REQUIRED_MESSAGE.test(message) && !CLINE_STARTUP_FAILURE_MESSAGE.test(message),
    )
  ) {
    return { kind: "unauthenticated" };
  }
  return { kind: "failed" };
}

/**
 * Cline advertises `promptCapabilities.image: true` but drops every non-text
 * block before dispatch, so the initialize result republished on the session
 * event has to say what the CLI will actually do.
 */
export function clineInitializeResultForSnapshot(
  initializeResult: EffectAcpSchema.InitializeResponse,
): EffectAcpSchema.InitializeResponse {
  return {
    ...initializeResult,
    agentCapabilities: {
      ...initializeResult.agentCapabilities,
      promptCapabilities: {
        ...initializeResult.agentCapabilities?.promptCapabilities,
        image: false,
      },
    },
  };
}
