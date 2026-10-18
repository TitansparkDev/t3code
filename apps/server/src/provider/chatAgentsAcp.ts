// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off globalConsole:off cryptoRandomUUID:off
/**
 * Chat Agents as an ACP agent. Each prompt is one run of W's ChatGPT desktop worker
 * (`chatgpt_worker_w.py --role owner`, the same transport W's Telegram service uses). The
 * worker returns when ChatGPT has finished, so a reply arrives whole, as one message chunk.
 * The ChatGPT conversation id the worker reports is kept per session in a small state file,
 * so a later prompt (or a restarted server loading the session) continues the same chat.
 *
 * Why ACP and not a native adapter: the generic ACP integration already provides threads,
 * checkpoints, history and approvals, and this agent has no tools or approvals to expose.
 *
 *  - One turn at a time. The worker's owner slot is single and refuses a second caller, so
 *    prompts queue here across sessions, and a refused run is asked again.
 *  - Cancelling a prompt terminates the worker process, which closes its window.
 *  - A conversation deleted in ChatGPT starts a new chat with a note in the reply.
 *
 * @module chatAgentsAcp
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

export const CHAT_AGENTS_MODEL = "chatgpt-desktop";

const DEFAULT_WORKER_PATH = "/srv/chatagents-w/deploy/current/desktop/chatgpt_worker_w.py";
const DEFAULT_PYTHON_PATH = "/srv/chatagents-w/desktop-venv/bin/python";
const DEFAULT_RUNTIME_ROOT = "/srv/chatagents-w";
/** How long a refused run waits before asking for the owner slot again. */
const CAPACITY_RETRY_MS = 20_000;
const CAPACITY_RETRIES = 30;
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;

export interface ChatAgentsAcpOptions {
  readonly workerPath: string;
  readonly pythonPath: string;
  readonly runtimeRoot: string;
  readonly turnTimeoutMinutes: number;
  readonly stateFile: string;
  readonly capacityRetryMs?: number;
}

export function parseChatAgentsAcpArgs(argv: ReadonlyArray<string>): ChatAgentsAcpOptions {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name?.startsWith("--") && value !== undefined) flags.set(name.slice(2), value);
  }
  const minutes = Number(flags.get("timeout-minutes") ?? "90");
  return {
    workerPath: flags.get("worker-path") || DEFAULT_WORKER_PATH,
    pythonPath: flags.get("python-path") || DEFAULT_PYTHON_PATH,
    runtimeRoot: flags.get("runtime-root") || DEFAULT_RUNTIME_ROOT,
    turnTimeoutMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 90,
    stateFile:
      flags.get("state-file") || NodePath.join(NodeOS.homedir(), ".t3", "chat-agents-acp.json"),
  };
}

/** What one worker run reported. The worker prints one JSON object; the last line is it. */
export interface WorkerResult {
  readonly status: string;
  readonly conversationId: string | undefined;
  readonly responseText: string | undefined;
  readonly failureCode: string | undefined;
  readonly message: string | undefined;
}

const EMPTY_RESULT: WorkerResult = {
  status: "error",
  conversationId: undefined,
  responseText: undefined,
  failureCode: undefined,
  message: undefined,
};

export function parseWorkerOutput(stdout: string): WorkerResult | undefined {
  const last = stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .at(-1);
  if (last === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(last);
  } catch {
    return { ...EMPTY_RESULT, message: last.slice(-300) };
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const text = (key: string) => {
    const field = record[key];
    return typeof field === "string" && field.trim() !== "" ? field : undefined;
  };
  return {
    status: typeof record.status === "string" ? record.status : "error",
    conversationId: text("conversation_id"),
    responseText: text("response_text"),
    failureCode: text("failure_code"),
    message: text("message"),
  };
}

/** Runs the worker for one prompt. `signal` aborting terminates the process. */
export function runWorker(
  options: ChatAgentsAcpOptions,
  input: { readonly prompt: string; readonly conversationId: string | undefined },
  signal: AbortSignal,
): Promise<WorkerResult> {
  return new Promise((resolve) => {
    const requestId = `T3-${NodeCrypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const requestFile = NodePath.join(NodeOS.tmpdir(), `chat-agents-${requestId}.json`);
    NodeFS.writeFileSync(
      requestFile,
      JSON.stringify({
        request_id: requestId,
        role: "owner",
        prompt: input.prompt,
        conversation_id: input.conversationId ?? null,
      }),
      { mode: 0o600 },
    );
    let finished = false;
    const finish = (result: WorkerResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      NodeFS.rmSync(requestFile, { force: true });
      resolve(result);
    };
    let stdout = "";
    const child = NodeChildProcess.spawn(
      options.workerPath,
      ["--role", "owner", "--task-id", requestId, "--request-file", requestFile],
      {
        env: {
          ...process.env,
          CHATGPT_WORKER_PYTHON: options.pythonPath,
          CHATGPT_WORKER_DIAG_DIR: NodePath.join(
            options.runtimeRoot,
            "logs",
            "desktop-diagnostics",
          ),
          CHATGPT_WORKER_CAPABILITY_PATH: NodePath.join(
            options.runtimeRoot,
            "telegram",
            "t3code-capability.json",
          ),
        },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", (error) =>
      finish({
        ...EMPTY_RESULT,
        message: `Could not run W's desktop worker: ${String(error).slice(0, 200)}`,
      }),
    );
    child.on("close", () =>
      finish(parseWorkerOutput(stdout) ?? { ...EMPTY_RESULT, message: "The worker said nothing." }),
    );
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        ...EMPTY_RESULT,
        failureCode: "TURN_TIMEOUT",
        message: `ChatGPT did not finish within ${options.turnTimeoutMinutes} minutes.`,
      });
    }, options.turnTimeoutMinutes * 60_000);
    const onAbort = () => {
      child.kill("SIGTERM");
      finish({ ...EMPTY_RESULT, failureCode: "CANCELLED", message: "Cancelled." });
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

type Json = Record<string, unknown>;

interface Session {
  conversationId: string | undefined;
  running: AbortController | undefined;
}

const textOf = (prompt: unknown): string =>
  (Array.isArray(prompt) ? prompt : [])
    .flatMap((block: unknown) => {
      const record = block as { type?: unknown; text?: unknown; resource?: { text?: unknown } };
      if (record?.type === "text" && typeof record.text === "string") return [record.text];
      if (record?.type === "resource" && typeof record.resource?.text === "string") {
        return [record.resource.text];
      }
      return [];
    })
    .join("\n\n")
    .trim();

/** The ACP agent. `write` receives each JSON-RPC message to send; `handle` takes one received. */
export function makeChatAgentsAcpAgent(
  options: ChatAgentsAcpOptions,
  write: (message: Json) => void,
  run: typeof runWorker = runWorker,
) {
  const sessions = new Map<string, Session>();
  const saved = (): Record<string, string> => {
    try {
      return JSON.parse(NodeFS.readFileSync(options.stateFile, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  };
  const remember = (sessionId: string, conversationId: string) => {
    try {
      NodeFS.mkdirSync(NodePath.dirname(options.stateFile), { recursive: true });
      NodeFS.writeFileSync(
        options.stateFile,
        JSON.stringify({ ...saved(), [sessionId]: conversationId }),
      );
    } catch {
      // The chat still works; it just cannot be continued after a restart.
    }
  };
  /** The worker's owner slot is single: prompts across all sessions go through here one by one. */
  let slot: Promise<unknown> = Promise.resolve();
  const exclusive = <A>(task: () => Promise<A>): Promise<A> => {
    const next = slot.then(task, task);
    slot = next.catch(() => undefined);
    return next;
  };

  const models = {
    currentModelId: CHAT_AGENTS_MODEL,
    availableModels: [{ modelId: CHAT_AGENTS_MODEL, name: "ChatGPT desktop" }],
  };

  const runWhenFree = (prompt: string, conversationId: string | undefined, signal: AbortSignal) =>
    exclusive(async () => {
      for (let attempt = 0; attempt < CAPACITY_RETRIES; attempt += 1) {
        const result = await run(options, { prompt, conversationId }, signal);
        if (result.failureCode !== "GENERATION_CAPACITY" || signal.aborted) return result;
        await new Promise((resolve) =>
          setTimeout(resolve, options.capacityRetryMs ?? CAPACITY_RETRY_MS),
        );
      }
      return {
        ...EMPTY_RESULT,
        failureCode: "GENERATION_CAPACITY",
        message: "ChatGPT's desktop worker stayed busy. Try again in a few minutes.",
      } satisfies WorkerResult;
    });

  const prompt = async (sessionId: string, blocks: unknown): Promise<{ stopReason: string }> => {
    const session = sessions.get(sessionId);
    if (!session) throw Object.assign(new Error(`Unknown session ${sessionId}`), { code: -32602 });
    if (session.running) {
      throw new Error("ChatGPT is still working on the last message in this session.");
    }
    const text = textOf(blocks);
    if (!text) throw new Error("Chat Agents needs a message to send.");
    const controller = new AbortController();
    session.running = controller;
    try {
      const speak = (message: string) =>
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: message },
            },
          },
        });

      let result = await runWhenFree(text, session.conversationId, controller.signal);
      if (controller.signal.aborted) return { stopReason: "cancelled" };
      if (result.failureCode === "CONVERSATION_NOT_FOUND" && session.conversationId) {
        session.conversationId = undefined;
        speak(
          "_The earlier ChatGPT conversation could not be found, so this message started a new one._\n\n",
        );
        result = await runWhenFree(text, undefined, controller.signal);
        if (controller.signal.aborted) return { stopReason: "cancelled" };
      }
      if (result.status !== "success" || result.responseText === undefined) {
        const detail =
          result.message ??
          (result.status === "success"
            ? "ChatGPT finished but its reply could not be read."
            : "The ChatGPT desktop worker failed.");
        throw new Error(result.failureCode ? `${detail} (${result.failureCode})` : detail);
      }
      if (result.conversationId && CONVERSATION_ID.test(result.conversationId)) {
        session.conversationId = result.conversationId;
        remember(sessionId, result.conversationId);
      }
      speak(result.responseText);
      return { stopReason: "end_turn" };
    } finally {
      session.running = undefined;
    }
  };

  const handle = async (message: Json): Promise<void> => {
    const id = message.id as number | string | undefined;
    const method = message.method as string | undefined;
    const params = (message.params ?? {}) as Json;
    const reply = (result: unknown) => {
      if (id !== undefined) write({ jsonrpc: "2.0", id, result });
    };
    const fail = (error: unknown) => {
      if (id === undefined) return;
      const code = (error as { code?: number }).code ?? -32000;
      write({
        jsonrpc: "2.0",
        id,
        error: { code, message: error instanceof Error ? error.message : String(error) },
      });
    };
    try {
      switch (method) {
        case "initialize":
          reply({
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: { image: false, audio: false, embeddedContext: true },
            },
            agentInfo: { name: "chat-agents", title: "Chat Agents", version: "1.0.0" },
            authMethods: [],
          });
          return;
        case "session/new": {
          const sessionId = NodeCrypto.randomUUID();
          sessions.set(sessionId, { conversationId: undefined, running: undefined });
          reply({ sessionId, models });
          return;
        }
        case "session/load": {
          const sessionId = String(params.sessionId ?? "");
          sessions.set(sessionId, { conversationId: saved()[sessionId], running: undefined });
          reply({ models });
          return;
        }
        case "session/prompt":
          reply(await prompt(String(params.sessionId ?? ""), params.prompt));
          return;
        case "session/cancel":
          sessions.get(String(params.sessionId ?? ""))?.running?.abort();
          return;
        case "session/set_model":
        case "session/set_mode":
        case "session/set_config_option":
          reply({});
          return;
        default:
          if (id !== undefined) {
            write({
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: `Unknown method ${method}` },
            });
          }
      }
    } catch (error) {
      fail(error);
    }
  };

  return { handle };
}

/** Speaks ACP on stdin/stdout until stdin closes. */
export async function runChatAgentsAcp(argv: ReadonlyArray<string>): Promise<void> {
  const options = parseChatAgentsAcpArgs(argv);
  const agent = makeChatAgentsAcpAgent(options, (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  });
  const lines = NodeReadline.createInterface({ input: process.stdin });
  const pending = new Set<Promise<void>>();
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      return;
    }
    // Prompts run for minutes; everything else, cancel included, must keep being heard.
    const task = agent.handle(message).finally(() => pending.delete(task));
    pending.add(task);
  });
  await new Promise<void>((resolve) => lines.once("close", resolve));
  await Promise.allSettled([...pending]);
}
