import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { avdHome, chooseAvd, ensureEmulator } from "../src/emulatorProvision.ts";

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

  it("finds the AVDs in the login home when the agent runs on its own account home", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "avd-home-"));
    try {
      const agentHome = NodePath.join(root, "agent");
      const loginHome = NodePath.join(root, "login");
      NodeFS.mkdirSync(NodePath.join(agentHome, ".android"), { recursive: true });
      NodeFS.mkdirSync(NodePath.join(loginHome, ".android", "avd"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(loginHome, ".android", "avd", "pixel.ini"), "");
      expect(avdHome({}, [agentHome, loginHome])).toBe(NodePath.join(loginHome, ".android", "avd"));
      expect(avdHome({ ANDROID_AVD_HOME: "/set" }, [agentHome, loginHome])).toBe("/set");
      expect(avdHome({}, [agentHome])).toBeUndefined();
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
