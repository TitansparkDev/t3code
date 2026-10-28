// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, expect, it } from "@effect/vitest";
import { nativeCodexToolRequest, runNativeCodexTurn } from "./native-codex.ts";

it("accepts only dynamic calls in the supplied evaluator catalog", () => {
  assert.deepEqual(
    nativeCodexToolRequest(
      {
        id: 7,
        method: "item/tool/call",
        params: { callId: "call-1", tool: "mcp__t3_code__delegate_task", arguments: { task: "x" } },
      },
      ["mcp__t3_code__delegate_task"],
    ),
    { id: 7, name: "mcp__t3_code__delegate_task", arguments: { task: "x" }, allowed: true },
  );
  assert.isUndefined(nativeCodexToolRequest({ method: "turn/completed", params: {} }, []));
});

it("identifies native tools outside the fake evaluator catalog for denial", () => {
  assert.deepEqual(
    nativeCodexToolRequest(
      {
        id: 8,
        method: "item/tool/call",
        params: { tool: "exec_command", arguments: { cmd: "id" } },
      },
      ["exec"],
    ),
    { id: 8, name: "exec_command", arguments: { cmd: "id" }, allowed: false },
  );
});

const fakeServer = async (
  mode: "normal" | "protocol-error" | "stall" | "native-tool-attempt" | "bad-tool",
) => {
  const root = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-eval-native-test-"));
  await NodeFS.chmod(root, 0o700);
  const auth = NodePath.join(root, "codex-home");
  await NodeFS.mkdir(auth, { mode: 0o700 });
  await NodeFS.writeFile(NodePath.join(auth, "auth.json"), "{}", { mode: 0o600 });
  const script = NodePath.join(root, "fake-codex");
  const source = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
rl.on("line", line => {
  const req = JSON.parse(line);
  if (${JSON.stringify(mode)} === "stall") return;
  if (req.method === "initialize") {
    send(${JSON.stringify(mode)} === "protocol-error" ? { id: req.id, error: { code: -1, message: "private error" } } : { id: req.id, result: {} });
  } else if (req.method === "thread/start") {
    const p = req.params;
    const safe = p.environments?.length === 0 && p.config?.mcp_servers && Object.keys(p.config.mcp_servers).length === 0 && p.config?.web_search === "disabled" && p.config?.features?.shell_tool === false && p.cwd === process.cwd() && p.cwd.includes("t3-eval-codex-") && process.env.HOME === process.env.CODEX_HOME && process.argv.includes('web_search="disabled"') && process.argv.includes("shell_tool") && process.argv.includes("browser_use") && process.argv.includes("plugins");
    send({ id: req.id, result: { thread: { id: safe ? "thread-1" : "unsafe" } } });
  } else if (req.method === "turn/start") {
    send({ id: req.id, result: { turn: { id: "turn-1" } } });
    if (${JSON.stringify(mode)} === "native-tool-attempt") {
      send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [{ id: "comment-1", type: "agentMessage", phase: "commentary", text: "I will not use the shell." }, { id: "final-1", type: "agentMessage", phase: "final_answer", text: "Done safely." }, { id: "command-1", type: "commandExecution", command: "echo blocked", status: "failed" }] } } });
      return;
    }
    send({ id: "dynamic-1", method: "item/tool/call", params: { callId: "call-1", threadId: req.params.threadId, turnId: "turn-1", tool: ${JSON.stringify(mode === "bad-tool" ? "exec_command" : "mock")}, arguments: { value: 2 } } });
  } else if (req.id === "dynamic-1") {
    const result = req.result;
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [{ id: "msg-1", type: "agentMessage", phase: "final_answer", text: result?.contentItems?.[0]?.text === "fake-result" ? "safe and done" : "tool result missing" }] } } });
  }
});
`;
  await NodeFS.writeFile(script, source, { mode: 0o700 });
  await NodeFS.chmod(script, 0o700);
  return { root, auth, script };
};

it("uses only the supplied app-server tools and cleans its isolated home", async () => {
  const fixture = await fakeServer("normal");
  const tempDirsBefore = (await NodeFS.readdir(NodeOS.tmpdir())).filter((name) =>
    name.startsWith("t3-eval-codex-"),
  );
  try {
    const result = await runNativeCodexTurn({
      model: "gpt-6-luna",
      effort: "low",
      codexHome: fixture.auth,
      developerInstructions: "system instructions",
      input: "user prompt",
      tools: [{ name: "mock", description: "Fake", inputSchema: { type: "object" } }],
      command: fixture.script,
      onToolCall: async () => "fake-result",
    });
    assert.equal(result.text, "safe and done");
    assert.equal(result.finalText, "safe and done");
    assert.deepEqual(result.calls, [
      { id: "call-1", name: "mock", arguments: { value: 2 }, output: "fake-result" },
    ]);
    assert.deepEqual(await NodeFS.readFile(NodePath.join(fixture.auth, "auth.json"), "utf8"), "{}");
  } finally {
    await NodeFS.rm(fixture.root, { recursive: true, force: true });
  }
  const tempDirsAfter = (await NodeFS.readdir(NodeOS.tmpdir())).filter((name) =>
    name.startsWith("t3-eval-codex-"),
  );
  assert.deepEqual(tempDirsAfter, tempDirsBefore);
});

it("records blocked native actions and uses only the final-answer message", async () => {
  const fixture = await fakeServer("native-tool-attempt");
  try {
    const result = await runNativeCodexTurn({
      model: "gpt-6-luna",
      effort: "low",
      codexHome: fixture.auth,
      developerInstructions: "",
      input: "",
      tools: [],
      command: fixture.script,
      onToolCall: async () => "",
    });
    assert.equal(result.text, "I will not use the shell.\n\nDone safely.");
    assert.equal(result.finalText, "Done safely.");
    assert.deepEqual(result.unsupportedNativeTools, ["exec_command"]);
  } finally {
    await NodeFS.rm(fixture.root, { recursive: true, force: true });
  }
});

it("fails closed on app-server protocol errors and startup deadlines", async () => {
  for (const [mode, timeoutMs, expected] of [
    ["protocol-error", 1000, "request failed"],
    ["stall", 30, "exceeded 30 ms"],
  ] as const) {
    const fixture = await fakeServer(mode);
    const homes = (await NodeFS.readdir(NodeOS.tmpdir())).filter((name) =>
      name.startsWith("t3-eval-codex-"),
    );
    try {
      await expect(
        runNativeCodexTurn({
          model: "gpt-6-luna",
          effort: "low",
          codexHome: fixture.auth,
          developerInstructions: "",
          input: "",
          tools: [],
          command: fixture.script,
          timeoutMs,
          onToolCall: async () => "",
        }),
      ).rejects.toThrow(expected);
      assert.deepEqual(
        (await NodeFS.readdir(NodeOS.tmpdir())).filter((name) => name.startsWith("t3-eval-codex-")),
        homes,
      );
    } finally {
      await NodeFS.rm(fixture.root, { recursive: true, force: true });
    }
  }
});

it("denies an unadvertised dynamic tool without turning it into an infrastructure error", async () => {
  const fixture = await fakeServer("bad-tool");
  const homes = (await NodeFS.readdir(NodeOS.tmpdir())).filter((name) =>
    name.startsWith("t3-eval-codex-"),
  );
  try {
    const result = await runNativeCodexTurn({
      model: "gpt-6-luna",
      effort: "low",
      codexHome: fixture.auth,
      developerInstructions: "",
      input: "",
      tools: [{ name: "mock", description: "Fake", inputSchema: {} }],
      command: fixture.script,
      onToolCall: async () => "unused",
    });
    assert.deepEqual(result.unsupportedNativeTools, ["exec_command"]);
    assert.equal(result.calls[0]?.output, "Unsupported dynamic tool call was denied.");
  } finally {
    await NodeFS.rm(fixture.root, { recursive: true, force: true });
  }
  assert.deepEqual(
    (await NodeFS.readdir(NodeOS.tmpdir())).filter((name) => name.startsWith("t3-eval-codex-")),
    homes,
  );
});
