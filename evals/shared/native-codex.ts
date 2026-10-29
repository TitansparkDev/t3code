// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

export type NativeCodexTool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
};

export type NativeCodexCall = {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly output: string;
};

export type NativeCodexTurn = {
  readonly text: string;
  readonly finalText: string;
  readonly calls: ReadonlyArray<NativeCodexCall>;
  readonly unsupportedNativeTools: ReadonlyArray<string>;
  readonly status: string;
};

export type NativeCodexOptions = {
  readonly model: string;
  readonly effort: string;
  readonly baseInstructions?: string;
  readonly developerInstructions: string;
  readonly input: string;
  readonly tools: ReadonlyArray<NativeCodexTool>;
  readonly codexHome?: string;
  readonly command?: string;
  readonly timeoutMs?: number;
  readonly maxToolCalls?: number;
  readonly signal?: AbortSignal;
  readonly onToolCall: (name: string, args: unknown, signal: AbortSignal) => Promise<string>;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;

const cleanEnv = () => {
  const allowed = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR"];
  return Object.fromEntries(
    allowed.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
  );
};

const featureOff = [
  "shell_tool",
  "view_image",
  "sleep_tool",
  "web_search_request",
  "web_search_cached",
  "standalone_web_search",
  "computer_use",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "in_app_browser",
  "in_app_local_automation",
  "apps",
  "plugins",
  "multi_agent",
  "image_generation",
];

export const nativeCodexToolRequest = (
  value: unknown,
  allowed: ReadonlyArray<string>,
):
  | {
      readonly id: unknown;
      readonly name: string;
      readonly arguments: unknown;
      readonly allowed: boolean;
    }
  | undefined => {
  const message = asRecord(value);
  if (message?.method !== "item/tool/call") return undefined;
  const params = asRecord(message.params);
  const name = typeof params?.tool === "string" ? params.tool : "";
  if (message.id === undefined || !name)
    throw new Error("Codex app-server sent a malformed dynamic tool request.");
  return { id: message.id, name, arguments: params?.arguments, allowed: allowed.includes(name) };
};

/** One isolated native Codex turn; only supplied dynamic tools can reach the evaluator. */
export const runNativeCodexTurn = async (options: NativeCodexOptions): Promise<NativeCodexTurn> => {
  const sourceHome =
    options.codexHome ?? process.env.CODEX_HOME ?? NodePath.join(NodeOS.homedir(), ".codex");
  const authPath = NodePath.join(sourceHome, "auth.json");
  const tempHome = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-eval-codex-"));
  const workspace = NodePath.join(tempHome, "workspace");
  let child: NodeChildProcess.ChildProcessWithoutNullStreams | undefined;
  let childClosed: Promise<void> | undefined;
  let deadline: NodeJS.Timeout | undefined;
  const abortController = new AbortController();
  let rejectAbort!: (error: Error) => void;
  const abortFailure = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  void abortFailure.catch(() => {});
  const onExternalAbort = () => {
    abortController.abort();
    rejectAbort(new Error("Codex app-server turn was aborted."));
  };
  const calls: Array<NativeCodexCall> = [];
  const maxToolCalls = options.maxToolCalls ?? 128;
  let requestId = 0;
  const pending = new Map<
    string,
    { method: string; resolve(value: unknown): void; reject(reason: Error): void }
  >();
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  try {
    if (options.signal?.aborted) throw new Error("Codex app-server turn was aborted.");
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    await NodeFSP.chmod(tempHome, 0o700);
    await NodeFSP.mkdir(workspace, { mode: 0o700 });
    await NodeFSP.copyFile(authPath, NodePath.join(tempHome, "auth.json"));
    await NodeFSP.chmod(NodePath.join(tempHome, "auth.json"), 0o600);
    child = NodeChildProcess.spawn(
      options.command ?? "codex",
      [
        "app-server",
        "--config",
        'web_search="disabled"',
        "--listen",
        "stdio://",
        ...featureOff.flatMap((feature) => ["--disable", feature]),
      ],
      {
        cwd: workspace,
        env: { ...cleanEnv(), HOME: tempHome, CODEX_HOME: tempHome },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    childClosed = new Promise<void>((resolve) => child!.once("close", () => resolve()));
    const lines = NodeReadline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const done = (() => {
      let resolve!: (value: NativeCodexTurn) => void;
      let reject!: (reason: Error) => void;
      const promise = new Promise<NativeCodexTurn>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    })();
    void done.promise.catch(() => {});
    let deadlineFailure: Promise<never> = new Promise(() => {});
    const exited = new Promise<never>((_, reject) => {
      child!.once("error", reject);
      child!.once("close", (code, signal) =>
        reject(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"}).`)),
      );
    });
    const fail = (error: Error) => {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      done.reject(error);
    };
    const turnTexts = new Map<string, string>();
    const turnPhases = new Map<string, string>();
    const unsupportedNativeTools: Array<string> = [];
    const itemToolNames: Readonly<Record<string, string>> = {
      commandExecution: "exec_command",
      fileChange: "apply_patch",
      mcpToolCall: "mcp_tool_call",
      collabAgentToolCall: "collaboration.spawn_agent",
      webSearch: "web_search",
      imageView: "view_image",
      sleep: "sleep",
      imageGeneration: "image_generation",
    };
    const passiveItemTypes = new Set([
      "userMessage",
      "agentMessage",
      "reasoning",
      "plan",
      "contextCompaction",
      "dynamicToolCall",
    ]);
    const nativeToolName = (type: string) =>
      itemToolNames[type] ?? (passiveItemTypes.has(type) ? undefined : `native:${type}`);
    let attemptedToolCalls = 0;
    child.stderr.on("data", () => {});
    lines.on("line", (line) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        fail(new Error("Codex app-server sent invalid JSON."));
        child?.kill("SIGTERM");
        return;
      }
      if (message.id !== undefined && typeof message.method !== "string") {
        const request = pending.get(String(message.id));
        if (request) {
          pending.delete(String(message.id));
          if (message.error) {
            const error = asRecord(message.error);
            const code = typeof error?.code === "number" ? ` (${error.code})` : "";
            request.reject(new Error(`Codex app-server ${request.method} failed${code}.`));
          } else request.resolve(message.result);
        }
        return;
      }
      if (message.method === "item/tool/call") {
        const limitExceeded = attemptedToolCalls >= maxToolCalls;
        attemptedToolCalls += 1;
        let call: ReturnType<typeof nativeCodexToolRequest>;
        try {
          call = nativeCodexToolRequest(
            message,
            options.tools.map((tool) => tool.name),
          );
        } catch (error) {
          done.reject(error as Error);
          child?.kill("SIGTERM");
          return;
        }
        if (!call) return;
        const { id } = message;
        const { name, arguments: args, allowed } = call;
        if (!allowed) {
          unsupportedNativeTools.push(name);
          calls.push({
            id: String(asRecord(message.params)?.callId ?? id),
            name,
            arguments: args,
            output: "Unsupported dynamic tool call was denied.",
          });
        }
        if (limitExceeded) {
          unsupportedNativeTools.push("tool_call_limit");
          done.resolve({
            text: [...turnTexts.values()].join("\n\n"),
            finalText: "",
            calls,
            unsupportedNativeTools,
            status: "tool_call_limit",
          });
          child?.kill("SIGTERM");
          return;
        }
        if (!allowed) {
          child?.stdin.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                success: false,
                contentItems: [
                  { type: "inputText", text: "Unsupported dynamic tool call was denied." },
                ],
              },
            })}\n`,
          );
          return;
        }
        void (async () => {
          let success = false;
          let text = "Unsupported dynamic tool.";
          try {
            text = await options.onToolCall(name, args, abortController.signal);
            success = true;
            calls.push({
              id: String(asRecord(message.params)?.callId ?? id),
              name,
              arguments: args,
              output: text,
            });
          } catch {
            done.reject(new Error("The evaluator's fake tool handler failed."));
            child?.kill("SIGTERM");
            return;
          }
          child?.stdin.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { success, contentItems: [{ type: "inputText", text }] },
            })}\n`,
          );
        })();
        return;
      }
      if (message.method && message.id !== undefined) {
        done.reject(new Error(`Codex app-server requested unsupported method ${message.method}.`));
        child?.kill("SIGTERM");
        return;
      }
      if (message.method === "item/agentMessage/delta") {
        const params = asRecord(message.params);
        if (typeof params?.itemId === "string" && typeof params.delta === "string")
          turnTexts.set(params.itemId, `${turnTexts.get(params.itemId) ?? ""}${params.delta}`);
        return;
      }
      if (message.method === "item/completed") {
        const item = asRecord(asRecord(message.params)?.item);
        if (item?.type === "agentMessage" && typeof item.id === "string") {
          if (typeof item.text === "string") turnTexts.set(item.id, item.text);
          if (typeof item.phase === "string") turnPhases.set(item.id, item.phase);
        } else if (typeof item?.type === "string" && nativeToolName(item.type)) {
          const name = nativeToolName(item.type)!;
          unsupportedNativeTools.push(name);
          calls.push({
            id: String(item.id ?? `blocked-${calls.length + 1}`),
            name,
            arguments: item,
            output: "Native Codex tool is disabled in this eval transport.",
          });
        }
        return;
      }
      if (message.method === "turn/completed") {
        const params = asRecord(message.params);
        const turn = asRecord(params?.turn);
        if (!turn) return;
        clearTimeout(deadline);
        const items = Array.isArray(turn.items) ? turn.items : [];
        for (const value of items) {
          const item = asRecord(value);
          const name = typeof item?.type === "string" ? nativeToolName(item.type) : undefined;
          if (name && !calls.some((call) => call.id === String(item?.id))) {
            unsupportedNativeTools.push(name);
            calls.push({
              id: String(item?.id ?? `blocked-${calls.length + 1}`),
              name,
              arguments: item,
              output: "Native Codex tool is disabled in this eval transport.",
            });
          }
        }
        const finalText = items
          .flatMap((item) => {
            const record = asRecord(item);
            return record?.type === "agentMessage" &&
              record.phase === "final_answer" &&
              typeof record.text === "string"
              ? [record.text]
              : [];
          })
          .join("\n\n");
        const itemTexts = items.flatMap((item) => {
          const record = asRecord(item);
          return record?.type === "agentMessage" && typeof record.text === "string"
            ? [record.text]
            : [];
        });
        const text = itemTexts.join("\n\n") || [...turnTexts.values()].join("\n\n");
        const completedFinalText =
          [...turnPhases.entries()]
            .filter(([, phase]) => phase === "final_answer")
            .map(([id]) => turnTexts.get(id) ?? "")
            .filter(Boolean)
            .at(-1) ?? "";
        if (turn.status !== "completed") {
          done.reject(
            new Error(
              `Codex app-server turn ended with status ${String(turn.status ?? "unknown")}.`,
            ),
          );
          lines.close();
          return;
        }
        done.resolve({
          text,
          finalText: finalText || completedFinalText,
          calls,
          unsupportedNativeTools,
          status: String(turn.status ?? "unknown"),
        });
        lines.close();
      }
    });
    const request = (method: string, params: unknown) => {
      const id = String(++requestId);
      const promise = new Promise<unknown>((resolve, reject) =>
        pending.set(id, { method, resolve, reject }),
      );
      child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return Promise.race([promise, exited, deadlineFailure, abortFailure, done.promise]);
    };
    const notify = (method: string, params?: unknown) =>
      child!.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`,
      );
    deadlineFailure = new Promise<never>((_, reject) => {
      deadline = setTimeout(
        () => reject(new Error(`Codex app-server exceeded ${timeoutMs} ms.`)),
        timeoutMs,
      );
      deadline.unref();
    });
    await request("initialize", {
      clientInfo: { name: "t3-mcp-tool-use-eval", title: "T3 eval", version: "1" },
      capabilities: { experimentalApi: true },
    });
    notify("initialized");
    const started = asRecord(
      await request("thread/start", {
        model: options.model,
        baseInstructions: options.baseInstructions,
        developerInstructions: options.developerInstructions,
        cwd: workspace,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        dynamicTools: options.tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
        environments: [],
        config: {
          mcp_servers: {},
          web_search: "disabled",
          features: { shell_tool: false, plugins: false, apps: false },
        },
      }),
    );
    const thread = asRecord(started?.thread);
    if (typeof thread?.id !== "string") throw new Error("Codex app-server did not start a thread.");
    await request("turn/start", {
      threadId: thread.id,
      model: options.model,
      effort: options.effort,
      input: [{ type: "text", text: options.input }],
      environments: [],
    });
    return await Promise.race([done.promise, exited, deadlineFailure, abortFailure]);
  } catch (error) {
    abortController.abort();
    for (const request of pending.values()) request.reject(new Error("Codex app-server stopped."));
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onExternalAbort);
    abortController.abort();
    if (deadline) clearTimeout(deadline);
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = childClosed ?? Promise.resolve();
      child.kill("SIGTERM");
      let grace: NodeJS.Timeout | undefined;
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          grace = setTimeout(resolve, 1500);
        }),
      ]);
      if (grace) clearTimeout(grace);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await closed;
      }
    }
    await NodeFSP.rm(tempHome, { recursive: true, force: true });
  }
};
