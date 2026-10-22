import { describe, expect, it } from "vite-plus/test";
import { chooseAvd, ensureEmulator } from "../src/emulatorProvision.ts";

describe("emulator provisioning", () => {
  it("picks the AVD named by the environment, then the repository, then the first by name", () => {
    const avds = ["medium_phone", "overseer_api36", "t3test"];
    expect(chooseAvd(avds, "/repos/Overseer", "t3test")).toBe("t3test");
    expect(chooseAvd(avds, "/repos/Overseer", undefined)).toBe("overseer_api36");
    expect(chooseAvd(avds, "/repos/t3code", undefined)).toBe("medium_phone");
    expect(chooseAvd([], "/repos/t3code", undefined)).toBeNull();
    expect(chooseAvd(["only"], null, undefined)).toBe("only");
  });

  it("leaves a command without an emulator slot alone", async () => {
    expect((await ensureEmulator({})).ready).toBe(true);
  });
});
