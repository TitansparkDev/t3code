// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Launches a packaged desktop app against a seeded T3 home, opens a thread, and checks its
// messages render. Release jobs run it so a build whose backend or bundle cannot start fails
// before it is published.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";
import * as NodeSqlite from "node:sqlite";
import { _electron, type ElectronApplication } from "playwright-core";

// A snapshot from an older build on purpose: the packaged server must migrate it forward, as it
// does for every upgrading user. It holds one project and two threads, nothing else.
const FIXTURE_DB = NodePath.join(import.meta.dirname, "fixtures/desktop-launch/statev2.sqlite");
const THREAD_TITLE = "Release launch check";
const THREAD_MESSAGE = "The release opens and shows this thread.";
const STEP_TIMEOUT_MS = 60_000;

const { values } = NodeUtil.parseArgs({
  options: {
    executable: { type: "string" },
    // An unpackaged app directory for a plain Electron executable, as PR CI runs it.
    app: { type: "string" },
    "artifacts-dir": { type: "string" },
  },
});
const executable = values.executable;
if (!executable)
  throw new Error(
    "Usage: smoke-desktop-app.ts --executable <app> [--app <dir>] [--artifacts-dir <dir>]",
  );
const artifactsDir = NodePath.resolve(values["artifacts-dir"] ?? "desktop-launch-check");

const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-desktop-launch-"));
const t3Home = NodePath.join(home, "t3");
const fixtureWorkspaceRoot = NodePath.join(home, "workspace");
NodeFS.mkdirSync(NodePath.join(t3Home, "userdata"), { recursive: true });
const fixtureDbPath = NodePath.join(t3Home, "userdata/statev2.sqlite");
NodeFS.copyFileSync(FIXTURE_DB, fixtureDbPath);
NodeFS.mkdirSync(fixtureWorkspaceRoot);
const fixtureDb = new NodeSqlite.DatabaseSync(fixtureDbPath);
fixtureDb
  .prepare("UPDATE projection_projects SET workspace_root = ? WHERE project_id = ?")
  .run(fixtureWorkspaceRoot, "launch-check-project");
fixtureDb.close();
const appEnvironment: NodeJS.ProcessEnv = {};
for (const name of [
  "HOME",
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "DISPLAY",
  "XAUTHORITY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "XDG_DATA_DIRS",
  "DBUS_SESSION_BUS_ADDRESS",
]) {
  if (process.env[name] !== undefined) appEnvironment[name] = process.env[name];
}
// A host's real session bus can hold the main process forever (a locked keyring waiting for an
// unlock prompt), so Linux gets a private bus with no secret service, like a bare CI runner.
let privateBus: NodeChildProcess.ChildProcess | undefined;
// oxlint-disable-next-line t3code/no-global-process-runtime -- Top-level release script, no Effect runtime.
if (NodeOS.platform() === "linux") {
  const bus = NodeChildProcess.spawn(
    "dbus-daemon",
    ["--session", "--nofork", "--nopidfile", "--print-address=1"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const printed = new Promise<string | undefined>((resolve) => {
    bus.on("error", () => resolve(undefined));
    bus.on("exit", () => resolve(undefined));
    bus.stdout.once("data", (chunk) => resolve(String(chunk).trim()));
  });
  const address = await Promise.race([
    printed,
    NodeTimersPromises.setTimeout(5_000, undefined, { ref: false }),
  ]);
  if (address) {
    privateBus = bus;
    appEnvironment.DBUS_SESSION_BUS_ADDRESS = address;
  } else {
    bus.kill();
  }
}
appEnvironment.CODEX_HOME = NodePath.join(home, "codex");
appEnvironment.CLAUDE_CONFIG_DIR = NodePath.join(home, "claude");
appEnvironment.GEMINI_HOME = NodePath.join(home, "gemini");
appEnvironment.GROK_HOME = NodePath.join(home, "grok");

let step = "launching the app";
let app: ElectronApplication | undefined;
try {
  app = await _electron.launch({
    executablePath: executable,
    // Linux CI runners do not allow the Chromium sandbox's user namespaces.
    args: [...(values.app ? [NodePath.resolve(values.app)] : []), "--no-sandbox"],
    // HOME stays real: on macOS a fake HOME has no login keychain, and safeStorage blocks the
    // main process on a keychain dialog. macOS keeps its Electron profile in the runner's HOME.
    env: {
      ...appEnvironment,
      XDG_CONFIG_HOME: NodePath.join(home, ".config"),
      XDG_DATA_HOME: NodePath.join(home, ".local/share"),
      T3CODE_HOME: t3Home,
      T3CODE_TELEMETRY_ENABLED: "false",
      T3CODE_DISABLE_AUTO_UPDATE: "true",
    },
    timeout: STEP_TIMEOUT_MS,
  });
  // A backend that never starts leaves no window, or only the "could not start" window, so the
  // thread wait below fails either way and its screenshot shows the startup error.
  step = "waiting for the first window";
  const page = await app.firstWindow({ timeout: STEP_TIMEOUT_MS });
  try {
    step = `finding "${THREAD_TITLE}" in the sidebar`;
    const thread = page.locator("li[data-thread-item]", { hasText: THREAD_TITLE });
    await thread.waitFor({ timeout: STEP_TIMEOUT_MS });
    step = "opening the thread";
    await thread.click();
    await page.getByText(THREAD_MESSAGE).waitFor({ timeout: STEP_TIMEOUT_MS });
  } catch (error) {
    NodeFS.mkdirSync(artifactsDir, { recursive: true });
    await page
      .screenshot({ path: NodePath.join(artifactsDir, "window.png"), timeout: 10_000 })
      .catch(() => {});
    throw error;
  }
  console.log("Desktop launch check passed: the app opened and showed the seeded thread.");
} catch (error) {
  console.error(`Desktop launch check failed while ${step}.`);
  NodeFS.mkdirSync(artifactsDir, { recursive: true });
  console.error(error instanceof Error ? error.message : error);
  const logs = NodePath.join(t3Home, "userdata/logs");
  if (NodeFS.existsSync(logs)) {
    NodeFS.cpSync(logs, NodePath.join(artifactsDir, "logs"), { recursive: true });
    const serverLog = NodePath.join(logs, "server-child.log");
    if (NodeFS.existsSync(serverLog)) {
      console.error("\nLast backend output (server-child.log):");
      console.error(NodeFS.readFileSync(serverLog, "utf8").split("\n").slice(-20).join("\n"));
    }
  }
  process.exitCode = 1;
} finally {
  if (app) {
    // A hung app never finishes closing; kill it so the job does not wait for its timeout.
    // Playwright drops the process handle once the app closes, so read it first.
    const child = app.process();
    const closed = app.close().catch(() => {});
    await Promise.race([closed, NodeTimersPromises.setTimeout(10_000, undefined, { ref: false })]);
    child.kill("SIGKILL");
  }
  privateBus?.kill();
  NodeFS.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
}
