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

/**
 * The AVD to boot: an explicit `AGENTQUEUE_AVD`, else the one named after the repository, else
 * the first by name. An explicit profile is never replaced by a fallback.
 */
export function chooseAvd(
  avds: ReadonlyArray<string>,
  repo: string | null,
  preferred: string | undefined,
): string | null {
  const valid = avds.filter(validAvdName);
  if (preferred) return valid.includes(preferred) ? preferred : null;
  const name = repo ? NodePath.basename(repo).toLowerCase() : "";
  const named = name ? valid.filter((avd) => avd.toLowerCase().includes(name)) : [];
  if (named.length > 0) return named[0]!;
  return [...valid].sort()[0] ?? null;
}

function declaredApi(value: string): number | null {
  if (!/^\d{1,10}$/.test(value)) return null;
  const api = Number(value);
  return Number.isSafeInteger(api) && api > 0 ? api : null;
}

function validAvdName(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/^(?:\.{1,2})$|[/\\\0\r\n]/.test(value);
}

export interface EmulatorIdentity {
  readonly avd: string | null;
  readonly api: number | null;
}

/** Returns a reason when the connected device cannot satisfy an explicit environment request. */
export function avdIdentityMismatch(
  requested: { readonly avd?: string; readonly api?: string },
  actual: EmulatorIdentity,
): string | null {
  if (requested.avd && actual.avd !== requested.avd) {
    return "the connected emulator does not match the requested AVD";
  }
  if (requested.api !== undefined) {
    const expectedApi = declaredApi(requested.api);
    if (expectedApi === null) return "AGENTQUEUE_AVD_API must be a numeric Android API level";
    if (actual.api !== expectedApi) {
      return `the connected emulator does not match the requested Android API ${expectedApi}`;
    }
  }
  return null;
}

/** Reads the Android API level from an AVD's local config files, when they declare one. */
export function avdApiLevel(avdHome: string, name: string): number | null {
  if (!validAvdName(name)) return null;
  try {
    const iniPath = NodePath.join(avdHome, `${name}.ini`);
    const ini = NodeFS.readFileSync(iniPath, "utf8");
    const configuredPath = /^path=(.+)$/m.exec(ini)?.[1]?.trim();
    const avdPath = configuredPath
      ? NodePath.isAbsolute(configuredPath)
        ? configuredPath
        : NodePath.resolve(avdHome, configuredPath)
      : NodePath.join(avdHome, `${name}.avd`);
    const configPath = NodePath.join(avdPath, "config.ini");
    const config = NodeFS.readFileSync(configPath, "utf8");
    const image = /^image\.sysdir\.1=(.+)$/m.exec(config)?.[1]?.trim();
    const target = /^target=android-(\d+)$/m.exec(config)?.[1];
    const imageApi = image && /(?:^|\/)android-(\d+)(?:\/|$)/.exec(image)?.[1];
    const value = Number(imageApi ?? target);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export interface EmulatorProvisionResult {
  readonly ready: boolean;
  /** An explicit AVD/API request failed; the caller must hold the check instead of running it. */
  readonly blocking: boolean;
  readonly note: string;
}

const booted = (adb: string, serial: string, env: NodeJS.ProcessEnv) =>
  run(adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], env, 8_000).stdout?.trim() ===
  "1";

function actualAvd(adb: string, serial: string, env: NodeJS.ProcessEnv): string | null {
  const output = run(adb, ["-s", serial, "emu", "avd", "name"], env, 8_000).stdout ?? "";
  return (
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "" && line.toUpperCase() !== "OK") ?? null
  );
}

function actualApi(adb: string, serial: string, env: NodeJS.ProcessEnv): number | null {
  const value = run(
    adb,
    ["-s", serial, "shell", "getprop", "ro.build.version.sdk"],
    env,
    8_000,
  ).stdout?.trim();
  return value ? declaredApi(value) : null;
}

/**
 * Where the AVDs live. An agent on its own account home (`HOME=~/.ai-homes/claude-2`) has no
 * `~/.android/avd`, so `emulator -list-avds` found nothing and every device check ran without a
 * device; the login user's home is looked at as well.
 */
export function avdHome(
  env: NodeJS.ProcessEnv,
  homes: ReadonlyArray<string> = [NodeOS.homedir(), NodeOS.userInfo().homedir],
): string | undefined {
  if (env.ANDROID_AVD_HOME) return env.ANDROID_AVD_HOME;
  const roots = [env.ANDROID_USER_HOME, ...homes.map((home) => NodePath.join(home, ".android"))];
  for (const root of roots) {
    if (!root) continue;
    const dir = NodePath.join(root, "avd");
    if (NodeFS.existsSync(dir) && NodeFS.readdirSync(dir).some((name) => name.endsWith(".ini")))
      return dir;
  }
  return undefined;
}

/**
 * Makes sure the emulator behind `env.ANDROID_SERIAL` is running and booted. Undeclared emulator
 * setup remains best effort; a failed explicit AVD/API request is marked blocking for the caller.
 */
export async function ensureEmulator(
  env: Readonly<Record<string, string>>,
  options: { readonly repo?: string | null; readonly bootTimeoutMs?: number } = {},
): Promise<EmulatorProvisionResult> {
  const serial = env.ANDROID_SERIAL;
  const port = env.AGENTQUEUE_EMULATOR_PORT;
  if (!serial || !port) return { ready: true, blocking: false, note: "no emulator requested" };
  if (process.env.AGENTQUEUE_NO_EMULATOR_BOOT || process.env.VITEST !== undefined) {
    return { ready: true, blocking: false, note: "emulator provisioning is off" };
  }
  const full: NodeJS.ProcessEnv = { ...process.env, ...env };
  const requested = {
    ...(full.AGENTQUEUE_AVD ? { avd: full.AGENTQUEUE_AVD } : {}),
    ...(full.AGENTQUEUE_AVD_API !== undefined ? { api: full.AGENTQUEUE_AVD_API } : {}),
  };
  const declared = requested.avd !== undefined || requested.api !== undefined;
  const unavailable = (note: string): EmulatorProvisionResult => ({
    ready: false,
    blocking: declared,
    note,
  });
  const home = avdHome(full);
  if (home) full.ANDROID_AVD_HOME = home;
  const adb = sdkTool(full, "platform-tools", "adb") ?? "adb";
  const deadline = Date.now() + (options.bootTimeoutMs ?? 300_000);
  const waitBooted = async () => {
    while (Date.now() < deadline) {
      if (booted(adb, serial, full)) return true;
      await sleep(3_000);
    }
    return false;
  };
  if (booted(adb, serial, full)) {
    if (!declared) return { ready: true, blocking: false, note: `${serial} already running` };
    const mismatch = avdIdentityMismatch(requested, {
      avd: requested.avd ? actualAvd(adb, serial, full) : null,
      api: requested.api !== undefined ? actualApi(adb, serial, full) : null,
    });
    return mismatch
      ? { ready: false, blocking: true, note: mismatch }
      : { ready: true, blocking: false, note: `${serial} matches the requested emulator` };
  }
  const emulator = sdkTool(full, "emulator", "emulator");
  if (!emulator) return unavailable("the Android emulator binary was not found");
  const avds = (run(emulator, ["-list-avds"], full).stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const avd = chooseAvd(avds, options.repo ?? null, full.AGENTQUEUE_AVD);
  if (!avd) {
    return unavailable(
      requested.avd
        ? "the requested AVD is not in the provisioned inventory"
        : "no AVD exists to boot; create one or set AGENTQUEUE_AVD",
    );
  }
  if (requested.api !== undefined) {
    const expectedApi = declaredApi(requested.api);
    const foundApi = home ? avdApiLevel(home, avd) : null;
    if (expectedApi === null) {
      return unavailable("AGENTQUEUE_AVD_API must be a numeric Android API level");
    }
    if (foundApi !== expectedApi) {
      return unavailable(`AVD "${avd}" does not match the requested Android API ${expectedApi}`);
    }
  }
  const child = NodeChildProcess.spawn(
    emulator,
    ["-avd", avd, "-port", port, "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot-save"],
    { env: full, detached: true, stdio: "ignore" },
  );
  child.unref();
  const ready = await waitBooted();
  if (ready && declared) {
    const mismatch = avdIdentityMismatch(requested, {
      avd: requested.avd ? actualAvd(adb, serial, full) : null,
      api: requested.api !== undefined ? actualApi(adb, serial, full) : null,
    });
    if (mismatch) return { ready: false, blocking: true, note: mismatch };
  }
  return {
    ready,
    blocking: declared && !ready,
    note: ready ? `booted ${avd} as ${serial}` : `${avd} did not finish booting as ${serial}`,
  };
}
