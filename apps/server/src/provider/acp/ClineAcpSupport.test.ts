import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import * as EffectAcpSchema from "effect-acp/schema";
import { ProviderDriverKind } from "@t3tools/contracts";

import { ProviderAdapterRequestError } from "../Errors.ts";

import {
  applyClineAcpModelSelection,
  buildClineAcpSpawnInput,
  classifyClineAuthFailure,
  clineAcpSpawnArgs,
  clineInitializeResultForSnapshot,
  clineModelsFromSessionSetup,
  clineSupportsRuntimeMode,
  currentClineModelIdFromSessionSetup,
  findClineModelConfigOption,
  resolveClineActModeId,
} from "./ClineAcpSupport.ts";

const decodeResponse = Schema.decodeUnknownSync(EffectAcpSchema.NewSessionResponse);
const decodeInitialize = Schema.decodeUnknownSync(EffectAcpSchema.InitializeResponse);

const CLINE_PROVIDER_OPTION = {
  id: "provider",
  name: "Provider",
  category: "model",
  type: "select",
  currentValue: "cline",
  options: [
    { value: "cline", name: "Cline Usage-Billing" },
    { value: "cline-pass", name: "ClinePass" },
  ],
} as const;

const CLINE_MODEL_OPTION = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "anthropic/claude-sonnet-5",
  options: [
    { value: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
    { value: "qwen/qwen3.8-max-prime", name: "Qwen 3.8 Max Prime" },
  ],
} as const;

const clineSessionSetup = (overrides?: {
  readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null;
  readonly models?: EffectAcpSchema.SessionModelState | null;
}) =>
  decodeResponse({
    sessionId: "cline-session-1",
    modes: { currentModeId: "act", availableModes: [{ id: "act", name: "Act" }] },
    ...(overrides?.configOptions === undefined
      ? { configOptions: [CLINE_PROVIDER_OPTION, CLINE_MODEL_OPTION] }
      : { configOptions: overrides.configOptions }),
    ...(overrides?.models === undefined ? {} : { models: overrides.models }),
  });

describe("buildClineAcpSpawnInput", () => {
  it("spawns `cline --acp` with no other run flags", () => {
    const spawn = buildClineAcpSpawnInput({ binaryPath: "", dataDir: "" }, "/tmp/work");
    assert.strictEqual(spawn.command, "cline");
    assert.deepStrictEqual(spawn.args, ["--acp"]);
    assert.strictEqual(spawn.cwd, "/tmp/work");
    assert.deepStrictEqual(clineAcpSpawnArgs(), ["--acp"]);
  });

  it("honors a custom binary path", () => {
    const spawn = buildClineAcpSpawnInput(
      { binaryPath: "/opt/bin/cline", dataDir: "" },
      "/tmp/work",
    );
    assert.strictEqual(spawn.command, "/opt/bin/cline");
    assert.deepStrictEqual(spawn.args, ["--acp"]);
  });

  it("extends the inherited environment with the instance environment", () => {
    const spawn = buildClineAcpSpawnInput({ binaryPath: "cline", dataDir: "" }, "/tmp/work", {
      CLINE_API_KEY: "secret",
      PATH: "/usr/bin",
    });
    assert.strictEqual(spawn.extendEnv, true);
    assert.strictEqual(spawn.env?.CLINE_API_KEY, "secret");
    assert.strictEqual(spawn.env?.PATH, "/usr/bin");
  });

  it("relocates Cline state through CLINE_DIR, since --data-dir is ignored in ACP mode", () => {
    const spawn = buildClineAcpSpawnInput(
      { binaryPath: "cline", dataDir: "/srv/cline-two" },
      "/tmp/work",
      { PATH: "/usr/bin" },
    );
    assert.strictEqual(spawn.env?.CLINE_DIR, "/srv/cline-two");
    assert.strictEqual(spawn.env?.CLINE_DATA_DIR, "/srv/cline-two");
  });

  it("leaves Cline's own profile alone when no data directory is configured", () => {
    const spawn = buildClineAcpSpawnInput({ binaryPath: "cline", dataDir: "  " }, "/tmp/work", {
      PATH: "/usr/bin",
    });
    assert.isUndefined(spawn.env?.CLINE_DIR);
    assert.isUndefined(spawn.env?.CLINE_DATA_DIR);
  });
});

describe("findClineModelConfigOption", () => {
  it("prefers the literal model id over the provider picker", () => {
    // Cline tags its provider picker with `category: "model"` and lists it
    // first, so a category-only lookup would change accounts.
    assert.strictEqual(
      findClineModelConfigOption([CLINE_PROVIDER_OPTION, CLINE_MODEL_OPTION])?.id,
      "model",
    );
  });

  it("falls back to a model-category option that is not the provider picker", () => {
    const renamed = { ...CLINE_MODEL_OPTION, id: "claude-model" } as const;
    assert.strictEqual(
      findClineModelConfigOption([CLINE_PROVIDER_OPTION, renamed])?.id,
      "claude-model",
    );
  });

  it("returns undefined when only the provider picker is advertised", () => {
    assert.isUndefined(findClineModelConfigOption([CLINE_PROVIDER_OPTION]));
    assert.isUndefined(findClineModelConfigOption([]));
    assert.isUndefined(findClineModelConfigOption(null));
  });

  it("ignores a boolean option named model", () => {
    const booleanModel = {
      id: "model",
      name: "Model",
      type: "boolean",
      currentValue: false,
    } as const;
    assert.isUndefined(findClineModelConfigOption([booleanModel]));
  });
});

describe("clineModelsFromSessionSetup", () => {
  it("reads the advertised catalog and marks the current model default", () => {
    const models = clineModelsFromSessionSetup(
      clineSessionSetup({
        configOptions: [CLINE_PROVIDER_OPTION, CLINE_MODEL_OPTION],
        models: {
          currentModelId: "qwen/qwen3.8-max-prime",
          availableModels: [
            { modelId: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
            { modelId: "qwen/qwen3.8-max-prime", name: "Qwen 3.8 Max Prime" },
          ],
        },
      }),
    );
    assert.deepStrictEqual(models, [
      { slug: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", isDefault: false },
      { slug: "qwen/qwen3.8-max-prime", name: "Qwen 3.8 Max Prime", isDefault: true },
    ]);
  });

  it("falls back to the model select when the models object is absent", () => {
    const models = clineModelsFromSessionSetup(clineSessionSetup());
    assert.deepStrictEqual(
      models.map((model) => model.slug),
      ["anthropic/claude-sonnet-5", "qwen/qwen3.8-max-prime"],
    );
  });

  it("does not read provider ids as models", () => {
    const models = clineModelsFromSessionSetup(
      clineSessionSetup({ configOptions: [CLINE_PROVIDER_OPTION] }),
    );
    assert.deepStrictEqual(models, []);
  });

  it("flattens grouped select options", () => {
    const grouped = {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "b/model",
      options: [
        { group: "anthropic", name: "Anthropic", options: [{ value: "a/model", name: "A" }] },
        { group: "other", name: "Other", options: [{ value: "b/model", name: "B" }] },
      ],
    } as const;
    const models = clineModelsFromSessionSetup(clineSessionSetup({ configOptions: [grouped] }));
    assert.deepStrictEqual(models, [
      { slug: "a/model", name: "A", isDefault: false },
      { slug: "b/model", name: "B", isDefault: true },
    ]);
  });

  it("drops blank names, blank slugs and duplicates, and falls back to the slug", () => {
    const messy = {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "dup",
      options: [
        { value: " dup ", name: "  " },
        { value: "   ", name: "Blank" },
        { value: "dup", name: "Duplicate" },
      ],
    } as const;
    const models = clineModelsFromSessionSetup(clineSessionSetup({ configOptions: [messy] }));
    assert.deepStrictEqual(models, [{ slug: "dup", name: "dup", isDefault: true }]);
  });

  it("returns nothing for a malformed or empty model configuration", () => {
    assert.deepStrictEqual(
      clineModelsFromSessionSetup(clineSessionSetup({ configOptions: [], models: null })),
      [],
    );
    assert.deepStrictEqual(
      clineModelsFromSessionSetup(
        clineSessionSetup({
          configOptions: [CLINE_PROVIDER_OPTION],
          models: { currentModelId: "", availableModels: [] },
        }),
      ),
      [],
    );
  });
});

describe("currentClineModelIdFromSessionSetup", () => {
  it("prefers the models object, then the model select", () => {
    assert.strictEqual(
      currentClineModelIdFromSessionSetup(
        clineSessionSetup({
          models: { currentModelId: "from-models", availableModels: [] },
        }),
      ),
      "from-models",
    );
    assert.strictEqual(
      currentClineModelIdFromSessionSetup(clineSessionSetup()),
      CLINE_MODEL_OPTION.currentValue,
    );
  });

  it("is undefined when neither advertises a selection", () => {
    assert.isUndefined(
      currentClineModelIdFromSessionSetup(
        clineSessionSetup({
          configOptions: [CLINE_PROVIDER_OPTION],
          models: { currentModelId: "   ", availableModels: [] },
        }),
      ),
    );
  });
});

describe("applyClineAcpModelSelection", () => {
  const mapAcpError = (cause: EffectAcpErrors.AcpError) =>
    new ProviderAdapterRequestError({
      provider: ProviderDriverKind.make("cline"),
      method: "session/set_config_option",
      detail: cause.message,
    });
  const makeRuntime = (configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>) => {
    const calls: Array<{ configId: string; value: string | boolean }> = [];
    return {
      calls,
      runtime: {
        getConfigOptions: Effect.succeed(configOptions),
        setConfigOption: (configId: string, value: string | boolean) => {
          calls.push({ configId, value });
          return Effect.succeed({} as EffectAcpSchema.SetSessionConfigOptionResponse);
        },
      },
    };
  };
  const select = (
    runtime: ReturnType<typeof makeRuntime>,
    requestedModelId: string | null | undefined,
  ) =>
    applyClineAcpModelSelection({
      runtime: runtime.runtime,
      requestedModelId,
      mapError: mapAcpError,
    });

  it.effect("writes the selection through the model option, never the provider one", () =>
    Effect.gen(function* () {
      const runtime = makeRuntime([CLINE_PROVIDER_OPTION, CLINE_MODEL_OPTION]);
      yield* select(runtime, "qwen/qwen3.8-max-prime");
      assert.deepStrictEqual(runtime.calls, [
        { configId: "model", value: "qwen/qwen3.8-max-prime" },
      ]);
    }),
  );

  it.effect("is a no-op for a blank, unchanged or unresolvable selection", () =>
    Effect.gen(function* () {
      for (const requested of [undefined, null, "", "  "]) {
        const runtime = makeRuntime([CLINE_PROVIDER_OPTION, CLINE_MODEL_OPTION]);
        yield* select(runtime, requested);
        assert.deepStrictEqual(runtime.calls, []);
      }
      const unchanged = makeRuntime([CLINE_PROVIDER_OPTION, CLINE_MODEL_OPTION]);
      yield* select(unchanged, "anthropic/claude-sonnet-5");
      assert.deepStrictEqual(unchanged.calls, []);

      const noOption = makeRuntime([CLINE_PROVIDER_OPTION]);
      yield* select(noOption, "qwen/qwen3.8-max-prime");
      assert.deepStrictEqual(noOption.calls, []);

      const emptySelect = makeRuntime([
        { id: "model", name: "Model", type: "select", currentValue: "", options: [] },
      ]);
      yield* select(emptySelect, "qwen/qwen3.8-max-prime");
      assert.deepStrictEqual(emptySelect.calls, []);
    }),
  );

  it.effect("rejects a model Cline never advertised instead of forwarding it", () =>
    // `session/set_model` accepts any string on this build, so an unchecked
    // slug would silently pin the session to a model Cline does not offer.
    Effect.gen(function* () {
      const runtime = makeRuntime([CLINE_PROVIDER_OPTION, CLINE_MODEL_OPTION]);
      const error = yield* select(runtime, "retired/model").pipe(Effect.flip);
      assert.strictEqual(error._tag, "ClineModelSelectionError");
      assert.deepStrictEqual(runtime.calls, []);
    }),
  );
});

describe("resolveClineActModeId", () => {
  it("prefers Cline's own act alias", () => {
    assert.strictEqual(
      resolveClineActModeId({
        currentModeId: "plan",
        availableModes: [{ id: "plan" }, { id: "act" }],
      }),
      "act",
    );
  });

  it("accepts a generic implement alias when Cline does not advertise act", () => {
    assert.strictEqual(
      resolveClineActModeId({
        currentModeId: "plan",
        availableModes: [{ id: "plan" }, { id: "code" }],
      }),
      "code",
    );
  });

  it("falls back to the first non-plan mode, then the current mode", () => {
    assert.strictEqual(
      resolveClineActModeId({ currentModeId: "plan", availableModes: [{ id: "plan" }] }),
      "plan",
    );
    assert.strictEqual(
      resolveClineActModeId({ currentModeId: "build", availableModes: [] }),
      "build",
    );
    assert.isUndefined(resolveClineActModeId(undefined));
  });
});

describe("clineSupportsRuntimeMode", () => {
  it("supports the two modes its single approval switch can express", () => {
    assert.isTrue(clineSupportsRuntimeMode("approval-required"));
    assert.isTrue(clineSupportsRuntimeMode("full-access"));
  });

  it("rejects the modes that promise a per-tool policy Cline cannot enforce", () => {
    // Cline has one `auto_approve` boolean. Offering these would silently
    // grant more than the user chose.
    assert.isFalse(clineSupportsRuntimeMode("auto-accept-edits"));
    assert.isFalse(clineSupportsRuntimeMode("auto"));
  });
});

describe("classifyClineAuthFailure", () => {
  const authCause = (overrides?: {
    readonly method?: string;
    readonly code?: number;
    readonly message?: string;
  }) =>
    Cause.fail(
      new EffectAcpErrors.AcpRequestError({
        code: (overrides?.code ?? -32000) as never,
        errorMessage:
          overrides?.message ??
          "Authentication required: Call authenticate before starting a session",
        method: overrides?.method ?? "session/new",
      }),
    );

  it("reads an unauthenticated CLI out of the session-setup auth guard", () => {
    for (const method of ["session/new", "session/load", "session/resume"]) {
      assert.deepStrictEqual(classifyClineAuthFailure(authCause({ method })), {
        kind: "unauthenticated",
      });
    }
  });

  it("does not read an unrelated -32000 on another method as a sign-in problem", () => {
    // `-32000` is a generic ACP code, so the method and the wording both have
    // to line up before Settings tells the user to run `cline auth`.
    assert.deepStrictEqual(classifyClineAuthFailure(authCause({ method: "session/prompt" })), {
      kind: "failed",
    });
    assert.deepStrictEqual(
      classifyClineAuthFailure(authCause({ method: "session/new", code: -32603 })),
      { kind: "failed" },
    );
    assert.deepStrictEqual(
      classifyClineAuthFailure(authCause({ method: "session/new", message: "spawn ENOENT" })),
      { kind: "failed" },
    );
  });

  it("treats an unrelated defect as a failure rather than an auth verdict", () => {
    assert.deepStrictEqual(classifyClineAuthFailure(Cause.die("boom")), { kind: "failed" });
    assert.deepStrictEqual(classifyClineAuthFailure(Cause.die(new Error("spawn cline ENOENT"))), {
      kind: "failed",
    });
  });

  it("reads the verified typed -32000 guard as unauthenticated", () => {
    // The shape Cline 3.0.65 actually sends: a well-formed session/new error.
    const thrown = Cause.fail(
      new EffectAcpErrors.AcpRequestError({
        code: -32000,
        method: "session/new",
        errorMessage: "Authentication required: Call authenticate before starting a session",
      }),
    );
    assert.deepStrictEqual(classifyClineAuthFailure(thrown), { kind: "unauthenticated" });
  });

  it("reads an auth guard printed to stderr by an exiting process", () => {
    // A build that gives up before answering produces no request error, so the
    // captured stderr is the only text available. Without this branch Settings
    // would report a broken CLI instead of `cline auth`.
    const thrown = Cause.fail(
      new EffectAcpErrors.AcpProcessExitedError({
        code: 1,
        stderr: "Authentication required: Call authenticate before starting a session",
      }),
    );
    assert.deepStrictEqual(classifyClineAuthFailure(thrown), { kind: "unauthenticated" });
  });

  it("does not read a process exit with no auth text as unauthenticated", () => {
    const thrown = Cause.fail(new EffectAcpErrors.AcpProcessExitedError({ code: 1 }));
    assert.deepStrictEqual(classifyClineAuthFailure(thrown), { kind: "failed" });
  });

  it("falls back to a thrown guard's message when no typed error survives", () => {
    // Defensive: a build whose failure never becomes a typed error leaves only
    // the text, with no method to check.
    const thrown = Cause.die(
      new Error("Authentication required: Call authenticate before starting a session"),
    );
    assert.deepStrictEqual(classifyClineAuthFailure(thrown), { kind: "unauthenticated" });
  });

  it("still refuses to read a startup failure as a sign-in problem", () => {
    // A broken PATH can mention the API key in its error text; telling the user
    // to sign in would send them after the wrong problem.
    for (const message of [
      "spawn cline ENOENT: api key not configured",
      "cline binary not found on PATH",
      "ACP startup timed out waiting for credentials",
    ]) {
      assert.deepStrictEqual(classifyClineAuthFailure(Cause.die(new Error(message))), {
        kind: "failed",
      });
    }
  });
});

describe("clineInitializeResultForSnapshot", () => {
  it("reports image prompts as unsupported, because Cline drops them", () => {
    const initialize = decodeInitialize({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false } },
    });
    const snapshot = clineInitializeResultForSnapshot(initialize);
    assert.strictEqual(snapshot.agentCapabilities?.promptCapabilities?.image, false);
    // Everything else is preserved: T3 must not hide what the agent can do.
    assert.strictEqual(snapshot.agentCapabilities?.promptCapabilities?.audio, false);
    assert.strictEqual(snapshot.agentCapabilities?.loadSession, true);
  });
});
