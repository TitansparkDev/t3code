// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * A granted `android` slot names an emulator serial (`emulator-5554`), but nothing used to start
 * it: `connectedAndroidTest` then failed with "Connected device 'emulator-5554' not found", a
 * failure no worker can repair. A command holding the slot now finds the emulator booted first.
 *
 * @module emulatorProvision
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const run = (file: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv, timeout = 15_000) =>
  NodeChildProcess.spawnSync(file, [...args], { env, encoding: "utf8", timeout });

function sdkTool(env: NodeJS.ProcessEnv, ...relative: string[]): string | null {
  const roots = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    NodePath.join(NodeOS.homedir(), "Android", "Sdk"),
  ].filter((root): root is string => Boolean(root));
  for (const root of roots) {
    const candidate = NodePath.join(root, ...relative);
    if (NodeFS.existsSync(candidate)) return candidate;
  }
  return null;
}

/** The AVD to boot: `AGENTQUEUE_AVD`, else the one named after the repository, else the only one. */
export function chooseAvd(
  avds: ReadonlyArray<string>,
  repo: string | null,
  preferred: string | undefined,
): string | null {
  if (preferred && avds.includes(preferred)) return preferred;
  const name = repo ? NodePath.basename(repo).toLowerCase() : "";
  const named = name ? avds.filter((avd) => avd.toLowerCase().includes(name)) : [];
  if (named.length > 0) return named[0]!;
  return avds.length === 1 ? avds[0]! : null;
}

const booted = (adb: string, serial: string, env: NodeJS.ProcessEnv) =>
  run(adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], env, 8_000).stdout?.trim() ===
  "1";

/**
 * Makes sure the emulator behind `env.ANDROID_SERIAL` is running and booted. Best effort: when
 * it cannot (no SDK, no suitable AVD, no boot in time) the command runs anyway and reports the
 * missing device itself.
 */
export async function ensureEmulator(
  env: Readonly<Record<string, string>>,
  options: { readonly repo?: string | null; readonly bootTimeoutMs?: number } = {},
): Promise<{ readonly ready: boolean; readonly note: string }> {
  const serial = env.ANDROID_SERIAL;
  const port = env.AGENTQUEUE_EMULATOR_PORT;
  if (!serial || !port) return { ready: true, note: "no emulator requested" };
  if (process.env.AGENTQUEUE_NO_EMULATOR_BOOT || process.env.VITEST !== undefined) {
    return { ready: true, note: "emulator provisioning is off" };
  }
  const full: NodeJS.ProcessEnv = { ...process.env, ...env };
  const adb = sdkTool(full, "platform-tools", "adb") ?? "adb";
  const deadline = Date.now() + (options.bootTimeoutMs ?? 300_000);
  const waitBooted = async () => {
    while (Date.now() < deadline) {
      if (booted(adb, serial, full)) return true;
      await sleep(3_000);
    }
    return false;
  };
  if (booted(adb, serial, full)) return { ready: true, note: `${serial} already running` };
  const emulator = sdkTool(full, "emulator", "emulator");
  if (!emulator) return { ready: false, note: "the Android emulator binary was not found" };
  const avds = (run(emulator, ["-list-avds"], full).stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const avd = chooseAvd(avds, options.repo ?? null, full.AGENTQUEUE_AVD);
  if (!avd) {
    return {
      ready: false,
      note: `no single AVD to boot among ${avds.join(", ") || "(none)"}; set AGENTQUEUE_AVD`,
    };
  }
  const child = NodeChildProcess.spawn(
    emulator,
    ["-avd", avd, "-port", port, "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot-save"],
    { env: full, detached: true, stdio: "ignore" },
  );
  child.unref();
  const ready = await waitBooted();
  return {
    ready,
    note: ready ? `booted ${avd} as ${serial}` : `${avd} did not finish booting as ${serial}`,
  };
}
