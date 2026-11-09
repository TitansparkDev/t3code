import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  decodeProviderReplayNdjson,
  replayEntriesFromProtocolCapture,
  sanitizeReplayValue,
} from "./replayTranscript.ts";

// Every credential here is synthetic. The sanitizer must remove each one from output.
const SYNTHETIC_SECRETS = [
  "sk-synthetic-replay-key-0001",
  "synthetic-bearer-value-0002",
  "person.synthetic@example.test",
  "synthetic-refresh-value-0003",
  "aW1hZ2UtYnl0ZXMtc3ludGhldGlj",
  "acct-synthetic-0004",
];

const header = {
  type: "transcript_start",
  provider: "antigravity",
  protocol: "acp.ndjson-jsonrpc",
  version: "1",
  scenario: "synthetic_replay",
};

describe("provider replay NDJSON", () => {
  it.effect("decodes a header and records in order", () =>
    Effect.gen(function* () {
      const text = [
        JSON.stringify(header),
        JSON.stringify({ type: "expect_outbound", label: "request:initialize", frame: "<any>" }),
        JSON.stringify({ type: "runtime_exit", status: "success" }),
      ].join("\n");
      const transcript = yield* decodeProviderReplayNdjson(text);
      expect(transcript.scenario).toBe("synthetic_replay");
      expect(transcript.entries.map((entry) => entry.type)).toEqual([
        "expect_outbound",
        "runtime_exit",
      ]);
    }),
  );

  it.effect("fails without a header when no fallback metadata is supplied", () =>
    Effect.gen(function* () {
      const text = JSON.stringify({ type: "runtime_exit", status: "success" });
      const result = yield* Effect.exit(decodeProviderReplayNdjson(text));
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("uses fallback metadata for headerless fixtures", () =>
    Effect.gen(function* () {
      const text = JSON.stringify({ type: "runtime_exit", status: "success" });
      const transcript = yield* decodeProviderReplayNdjson(text, {
        provider: "antigravity",
        protocol: "acp.ndjson-jsonrpc",
        version: "1",
        scenario: "headerless",
      });
      expect(transcript.entries).toHaveLength(1);
    }),
  );
});

describe("sanitizeReplayValue", () => {
  it("removes synthetic credentials, login URLs, account identifiers and attachment bytes", () => {
    const input = {
      sessionId: "agy-session-01",
      token: `Bearer ${SYNTHETIC_SECRETS[1]}`,
      note: `key ${SYNTHETIC_SECRETS[0]} for ${SYNTHETIC_SECRETS[2]}`,
      refresh_token: SYNTHETIC_SECRETS[3],
      accountId: SYNTHETIC_SECRETS[5],
      login: `open https://accounts.google.com/o/oauth2/auth?client_id=abc&redirect_uri=http://localhost:1`,
      image: { type: "image", mimeType: "image/png", data: SYNTHETIC_SECRETS[4] },
      uri: `data:image/png;base64,${SYNTHETIC_SECRETS[4]}`,
      path: "/work/synthetic-root/probe.txt",
    };
    const sanitized = sanitizeReplayValue(input, {
      workspace: "/work/synthetic-root",
      secrets: [SYNTHETIC_SECRETS[5]!],
    });
    const serialized = JSON.stringify(sanitized);
    for (const secret of SYNTHETIC_SECRETS) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain("accounts.google.com");
    expect(sanitized).toMatchObject({
      sessionId: "agy-session-01",
      token: "<redacted>",
      refresh_token: "<redacted>",
      accountId: "<redacted-account>",
      image: { type: "image", mimeType: "image/png", data: "<redacted-attachment>" },
      path: "<workspace>/probe.txt",
    });
  });

  it("keeps ordinary progress text and command output untouched", () => {
    const input = {
      combinedOutput: "compile 1/4\ncompile 2/4\n",
      sessionUpdate: "tool_call_update",
    };
    expect(sanitizeReplayValue(input)).toEqual(input);
  });
});

describe("replayEntriesFromProtocolCapture", () => {
  const capture = [
    {
      direction: "outgoing" as const,
      payload: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { token: SYNTHETIC_SECRETS[0] } })}\n`,
    },
    {
      direction: "incoming" as const,
      payload: `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })}\n`,
    },
    {
      direction: "outgoing" as const,
      payload: `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "hi" }] } })}\n`,
    },
    {
      // Chunked stdin: one JSON line split across two incoming payloads.
      direction: "incoming" as const,
      payload: `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","messageId":"m1","content":{"type":"text","text":"ok"}}}}`,
    },
    {
      direction: "incoming" as const,
      payload: `\n${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: { sessionId: "s" } })}\n`,
    },
    {
      direction: "outgoing" as const,
      payload: `${JSON.stringify({ jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "selected", optionId: "deny" } } })}\n`,
    },
    {
      direction: "incoming" as const,
      payload: `${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } })}\n`,
    },
    { direction: "incoming" as const, payload: "not json\n" },
  ];

  it("maps captured wire frames onto ordered replay entries with T3-owned params abstracted", () => {
    const { entries, unparsedLines } = replayEntriesFromProtocolCapture(capture, {
      secrets: [SYNTHETIC_SECRETS[0]!],
    });
    expect(unparsedLines).toBe(1);
    expect(
      entries.map((entry) => [entry.type, "label" in entry ? entry.label : undefined]),
    ).toEqual([
      ["expect_outbound", "request:initialize"],
      ["emit_inbound", "response:initialize"],
      ["expect_outbound", "request:session/prompt"],
      ["emit_inbound", "notification:session/update:agent_message_chunk"],
      ["emit_inbound", "request:session/request_permission"],
      ["expect_outbound", "response:session/request_permission"],
      ["emit_inbound", "response:session/prompt"],
    ]);
    expect(JSON.stringify(entries)).not.toContain(SYNTHETIC_SECRETS[0]!);
    expect(entries[0]).toMatchObject({
      frame: { kind: "request", method: "initialize", params: "<any>" },
    });
    expect(entries[3]).toMatchObject({
      frame: { params: { update: { messageId: "m1", content: { text: "ok" } } } },
    });
  });

  it.effect("round-trips through the NDJSON decoder", () =>
    Effect.gen(function* () {
      const { entries } = replayEntriesFromProtocolCapture(capture);
      const text = [header, ...entries].map((record) => JSON.stringify(record)).join("\n");
      const transcript = yield* decodeProviderReplayNdjson(text);
      expect(transcript.entries).toHaveLength(entries.length);
    }),
  );
});
