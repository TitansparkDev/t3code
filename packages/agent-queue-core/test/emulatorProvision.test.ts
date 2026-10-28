import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  avdApiLevel,
  avdHome,
  avdIdentityMismatch,
  chooseAvd,
  ensureEmulator,
} from "../src/emulatorProvision.ts";

describe("emulator provisioning", () => {
  it("picks the AVD named by the environment, then the repository, then the first by name", () => {
    const avds = ["medium_phone", "overseer_api36", "t3test"];
    expect(chooseAvd(avds, "/repos/Overseer", "t3test")).toBe("t3test");
    expect(chooseAvd(avds, "/repos/Overseer", "missing_profile")).toBeNull();
    expect(chooseAvd(avds, "/repos/Overseer", undefined)).toBe("overseer_api36");
    expect(chooseAvd(avds, "/repos/t3code", undefined)).toBe("medium_phone");
    expect(chooseAvd([], "/repos/t3code", undefined)).toBeNull();
    expect(chooseAvd(["only"], null, undefined)).toBe("only");
  });

  it("leaves a command without an emulator slot alone", async () => {
    expect(await ensureEmulator({})).toEqual({
      ready: true,
      blocking: false,
      note: "no emulator requested",
    });
  });

  it("rejects a booted device that does not match an explicit AVD or API request", () => {
    expect(
      avdIdentityMismatch({ avd: "t3test", api: "35" }, { avd: "t3test", api: 35 }),
    ).toBeNull();
    expect(avdIdentityMismatch({ avd: "t3test" }, { avd: "medium_phone", api: 35 })).toContain(
      "does not match the requested AVD",
    );
    expect(avdIdentityMismatch({ api: "35" }, { avd: null, api: 34 })).toContain(
      "does not match the requested Android API",
    );
    expect(avdIdentityMismatch({ api: "35x" }, { avd: null, api: 35 })).toContain(
      "must be a numeric Android API",
    );
  });

  it("reads declared Android API from AVD inventory without starting an emulator", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "avd-api-"));
    try {
      const home = NodePath.join(root, "avd");
      const profile = NodePath.join(home, "pixel_api35.avd");
      NodeFS.mkdirSync(profile, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(home, "pixel_api35.ini"), `path=${profile}\n`);
      NodeFS.writeFileSync(
        NodePath.join(profile, "config.ini"),
        "image.sysdir.1=system-images/android-35/google_apis/x86_64/\n",
      );
      expect(avdApiLevel(home, "pixel_api35")).toBe(35);
      expect(avdApiLevel(home, "missing")).toBeNull();
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
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
