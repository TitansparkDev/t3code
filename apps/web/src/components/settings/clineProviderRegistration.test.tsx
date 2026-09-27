import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { DRIVER_OPTION_BY_VALUE, DRIVER_OPTIONS, getDriverOption } from "./providerDriverMeta.ts";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils.ts";
import { ClineIcon } from "../Icons.tsx";

const CLINE = ProviderDriverKind.make("cline");

describe("Cline provider registration", () => {
  it("appears in the settings driver list as a first-class provider", () => {
    const definition = DRIVER_OPTION_BY_VALUE[CLINE];
    expect(definition).toBeDefined();
    expect(definition?.label).toBe("Cline");
    expect(definition?.icon).toBe(ClineIcon);
    // The ACP binding is still early access, and the CLI is not wired through
    // the cloud execution transport, so the card must not offer it.
    expect(definition?.badgeLabel).toBe("Early Access");
    expect(definition?.supportsCloudExecution).toBe(false);
    expect(DRIVER_OPTIONS.map((option) => option.value)).toContain(CLINE);
  });

  it("exposes the Cline settings schema so Settings renders its fields", () => {
    const fields = getDriverOption(CLINE)?.settingsSchema.fields;
    expect(Object.keys(fields ?? {}).toSorted()).toEqual([
      "binaryPath",
      "customModels",
      "dataDir",
      "enabled",
    ]);
  });

  it("resolves the provider icon for the chat surfaces", () => {
    expect(PROVIDER_ICON_BY_PROVIDER[CLINE]).toBe(ClineIcon);
  });
});
