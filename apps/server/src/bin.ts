// @effect-diagnostics nodeBuiltinImport:off -- The service launcher starts before the CLI runtime.
import * as NodeModule from "node:module";
import * as NodeSea from "node:sea";
import * as NodeURL from "node:url";

import { isEntrypoint } from "./entrypoint.ts";

// Loads the CLI outside the launcher's module graph. Packaged builds embed it as a raw asset.
async function loadCliMain(): Promise<typeof import("./binMain.ts")> {
  if (!NodeSea.isSea()) return import("./binMain.ts");

  // Keep the executable's module URL so the CLI finds the web client and native packages beside it.
  const require = NodeModule.createRequire(import.meta.url);
  // require() resolves links in the executable path, such as a Windows junction.
  const cliUrl = NodeURL.pathToFileURL(require.resolve(process.execPath)).href;
  const hook = NodeModule.registerHooks({
    load(url, context, next) {
      if (url !== cliUrl) return next(url, context);
      return {
        format: "module",
        source: new Uint8Array(NodeSea.getRawAsset("binMain.mjs")),
        shortCircuit: true,
      };
    },
  });
  try {
    return require(process.execPath) as typeof import("./binMain.ts");
  } finally {
    hook.deregister();
  }
}

function ignoreOutputError(): void {}

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  // Logs go to stdout and stderr, which may be a closed desktop launcher pipe or a log file on
  // a full disk. Node emits a failed write as an unhandled stream error that crashes the process
  // and skips shutdown, so drop the line instead.
  process.stdout.on("error", ignoreOutputError);
  process.stderr.on("error", ignoreOutputError);

  const command = process.argv[2];
  // Guard sockets before either dispatch path can load outbound-capable modules.
  const { ignoreMacosTypeOfServiceEinval } = await import("./outboundHttp.ts");
  ignoreMacosTypeOfServiceEinval();
  // The launcher owns shutdown until its child exits, so it bypasses the Effect CLI runtime.
  // A service unit passes nothing, or on Windows the launcher's own flags; help and anything
  // else go through the full CLI.
  const launcher =
    command === "__service-launcher" ? await import("./cli/serviceLauncher.ts") : undefined;
  const launcherOptions = launcher?.parseServiceLauncherArgs(process.argv.slice(3));
  if (command === "chat-agents-acp") {
    // An ACP agent the server runs as a local command: stdout carries only protocol messages.
    const { runChatAgentsAcp } = await import("./provider/chatAgentsAcp.ts");
    await runChatAgentsAcp(process.argv.slice(3));
  } else if (command === "__document-text") {
    const { extractDocumentText } = await import("./provider/documentTextWorker.ts");
    try {
      process.stdout.write(await extractDocumentText(process.argv[3]!, process.argv[4]!));
    } catch (error) {
      if (error instanceof Error && "code" in error && /^E[A-Z0-9]+$/.test(String(error.code))) {
        throw error;
      }
      // Exit 2 identifies document rejections; OS and process failures remain retryable.
      process.exitCode = 2;
    }
  } else if (command === "__managed-chatgpt-token") {
    const { runManagedChatGptTokenCli } = await import("./cli/managedChatGptToken.ts");
    await runManagedChatGptTokenCli(process.argv.slice(3));
  } else if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
    const { runAcpMcpCliFastPath } = await import("./mcp/AcpMcpStdioBridge.ts");
    await runAcpMcpCliFastPath(command, process.argv.slice(3));
  } else if (launcher !== undefined && launcherOptions !== undefined) {
    await launcher.runServiceLauncherCli(launcherOptions);
  } else {
    const { runCliCommand } = await loadCliMain();
    await runCliCommand();
  }
}
