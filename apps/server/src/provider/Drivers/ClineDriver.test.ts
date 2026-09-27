import { ClineSettings, ProviderDriverKind, type TextGenerationError } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { assert, describe, expect } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import { ClineDriver } from "./ClineDriver.ts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { makeUnsupportedTextGeneration } from "../../textGeneration/unsupportedTextGeneration.ts";

const decodeClineSettings = Schema.decodeSync(ClineSettings);

describe("ClineDriver", () => {
  it("registers as a first-class built-in driver", () => {
    expect(BUILT_IN_DRIVERS).toContain(ClineDriver);
    expect(ClineDriver.driverKind).toBe(ProviderDriverKind.make("cline"));
    expect(ClineDriver.metadata.displayName).toBe("Cline");
  });

  it("supports multiple instances and keeps execution local", () => {
    // Each instance spawns its own `cline --acp`; nothing global is shared.
    expect(ClineDriver.metadata.supportsMultipleInstances).toBe(true);
  });

  it("defaults to disabled with the CLI resolved from PATH", () => {
    const config = ClineDriver.defaultConfig();
    expect(config.enabled).toBe(false);
    expect(config.binaryPath).toBe("cline");
    expect(config.dataDir).toBe("");
  });

  it("decodes a custom binary path and an isolated data directory", () => {
    const config = decodeClineSettings({
      enabled: true,
      binaryPath: "/opt/bin/cline",
      dataDir: "/srv/cline-two",
    });
    expect(config.binaryPath).toBe("/opt/bin/cline");
    expect(config.dataDir).toBe("/srv/cline-two");
  });

  it("renders the binary path and data directory in the settings form, in that order", () => {
    // The browser renders provider settings from these annotations, so the order
    // decides what a user sees first.
    expect(Schema.resolveAnnotations(ClineSettings)?.providerSettingsFormSchema).toMatchObject({
      order: ["binaryPath", "dataDir"],
    });
  });
});

describe("makeUnsupportedTextGeneration", () => {
  const driverKind = ProviderDriverKind.make("cline");
  const service = makeUnsupportedTextGeneration(driverKind);
  const operations = [
    "generateCommitMessage",
    "generatePrContent",
    "generateBranchName",
    "generateThreadTitle",
  ] as const;

  it.effect("fails every background generation with an actionable reason", () =>
    Effect.gen(function* () {
      // Each call must refuse before it looks at the input at all, so the
      // stub inputs are deliberately incomplete.
      const stub = {} as never;
      // Collapse the success types: every one of these must fail, and the
      // diagnostic is the reason these are not compared as a union.
      const refuse = <A>(attempt: Effect.Effect<A, TextGenerationError>) => Effect.asVoid(attempt);
      const refusals: Readonly<
        Record<(typeof operations)[number], Effect.Effect<void, TextGenerationError>>
      > = {
        generateCommitMessage: refuse(service.generateCommitMessage(stub)),
        generatePrContent: refuse(service.generatePrContent(stub)),
        generateBranchName: refuse(service.generateBranchName(stub)),
        generateThreadTitle: refuse(service.generateThreadTitle(stub)),
      };
      assert.deepStrictEqual(Object.keys(refusals).toSorted(), [...operations].toSorted());
      for (const attempt of Object.values(refusals)) {
        const error = yield* Effect.flip(attempt);
        assert.strictEqual(error._tag, "TextGenerationError");
        assert.match(error.detail, /does not support background text generation/);
        assert.match(error.detail, /Pick another provider/);
      }
    }),
  );
});
