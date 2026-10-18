// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import {
  makeChatAgentsAcpAgent,
  parseChatAgentsAcpArgs,
  parseWorkerOutput,
  type ChatAgentsAcpOptions,
  type WorkerResult,
} from "./chatAgentsAcp.ts";

const CONVERSATION = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";

const harness = (script: Array<Partial<WorkerResult> | "wait">) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "chat-agents-acp-test-"));
  const options: ChatAgentsAcpOptions = {
    ...parseChatAgentsAcpArgs([]),
    stateFile: NodePath.join(dir, "state.json"),
    capacityRetryMs: 1,
  };
  const sent: Array<Record<string, any>> = [];
  const calls: Array<{ prompt: string; conversationId: string | undefined }> = [];
  const agent = makeChatAgentsAcpAgent(
    options,
    (message) => sent.push(message),
    (_options, input, signal) => {
      calls.push(input);
      const next = script.shift();
      if (next === "wait") {
        const cancelled: WorkerResult = {
          status: "error",
          conversationId: undefined,
          responseText: undefined,
          failureCode: "CANCELLED",
          message: "Cancelled.",
        };
        return new Promise((resolve) => {
          if (signal.aborted) resolve(cancelled);
          else signal.addEventListener("abort", () => resolve(cancelled), { once: true });
        });
      }
      return Promise.resolve({
        status: "success",
        conversationId: CONVERSATION,
        responseText: "Done.",
        failureCode: undefined,
        message: undefined,
        ...next,
      });
    },
  );
  const start = async () => {
    await agent.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await agent.handle({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} });
    return sent.find((message) => message.id === 2)!.result.sessionId as string;
  };
  return { agent, sent, calls, start, options };
};

const ask = (sessionId: string, text: string, id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "session/prompt",
  params: { sessionId, prompt: [{ type: "text", text }] },
});

it("reads the worker's last line, and what a broken line says", () => {
  expect(
    parseWorkerOutput('noise\n{"status":"success","conversation_id":"x","response_text":"Hi"}'),
  ).toMatchObject({
    status: "success",
    responseText: "Hi",
  });
  expect(parseWorkerOutput("Traceback: boom")).toMatchObject({
    status: "error",
    message: "Traceback: boom",
  });
  expect(parseWorkerOutput("")).toBeUndefined();
});

it("answers a prompt with the reply, and continues the same chat afterwards", async () => {
  const { agent, sent, calls, start } = harness([{}, { responseText: "Again." }]);
  const sessionId = await start();
  await agent.handle(ask(sessionId, "Hello", 3));
  await agent.handle(ask(sessionId, "More", 4));

  expect(calls).toEqual([
    { prompt: "Hello", conversationId: undefined },
    { prompt: "More", conversationId: CONVERSATION },
  ]);
  const chunks = sent.filter((message) => message.method === "session/update");
  expect(chunks.map((message) => message.params.update.content.text)).toEqual(["Done.", "Again."]);
  expect(sent.find((message) => message.id === 3)?.result).toEqual({ stopReason: "end_turn" });
});

it("remembers the conversation for a restarted server that loads the session", async () => {
  const first = harness([{}]);
  const sessionId = await first.start();
  await first.agent.handle(ask(sessionId, "Hello", 3));

  const second = harness([{}]);
  NodeFS.writeFileSync(second.options.stateFile, NodeFS.readFileSync(first.options.stateFile));
  await second.agent.handle({
    jsonrpc: "2.0",
    id: 5,
    method: "session/load",
    params: { sessionId },
  });
  await second.agent.handle(ask(sessionId, "Back again", 6));
  expect(second.calls[0]).toEqual({ prompt: "Back again", conversationId: CONVERSATION });
});

it("starts a new chat with a note when the conversation was deleted", async () => {
  const { agent, sent, calls, start } = harness([
    {},
    { status: "error", failureCode: "CONVERSATION_NOT_FOUND", responseText: undefined },
    { responseText: "Fresh." },
  ]);
  const sessionId = await start();
  await agent.handle(ask(sessionId, "One", 3));
  await agent.handle(ask(sessionId, "Two", 4));

  expect(calls.map((call) => call.conversationId)).toEqual([undefined, CONVERSATION, undefined]);
  const text = sent
    .filter((message) => message.method === "session/update")
    .map((message) => message.params.update.content.text)
    .join("|");
  expect(text).toContain("could not be found");
  expect(text).toContain("Fresh.");
});

it("reports a failed worker as an error and a cancel as a cancelled stop", async () => {
  const failing = harness([
    { status: "error", failureCode: "LOGIN_REQUIRED", message: "Sign in", responseText: undefined },
  ]);
  const failingSession = await failing.start();
  await failing.agent.handle(ask(failingSession, "Hi", 3));
  expect(failing.sent.find((message) => message.id === 3)?.error.message).toBe(
    "Sign in (LOGIN_REQUIRED)",
  );

  const waiting = harness(["wait"]);
  const waitingSession = await waiting.start();
  const running = waiting.agent.handle(ask(waitingSession, "Hi", 3));
  await waiting.agent.handle({
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId: waitingSession },
  });
  await running;
  expect(waiting.sent.find((message) => message.id === 3)?.result).toEqual({
    stopReason: "cancelled",
  });
});
