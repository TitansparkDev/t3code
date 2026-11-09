import {
  ProviderReplayEntry,
  ProviderReplayNdjsonRecord,
  ProviderReplayTranscript,
  type ProviderReplayTranscriptHeader,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class ProviderReplayNdjsonLineParseError extends Schema.TaggedError<ProviderReplayNdjsonLineParseError>()(
  "ProviderReplayNdjsonLineParseError",
  {
    lineNumber: Schema.Number,
    line: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to parse provider replay NDJSON line ${this.lineNumber}.`;
  }
}

export class ProviderReplayNdjsonMissingHeaderError extends Schema.TaggedError<ProviderReplayNdjsonMissingHeaderError>()(
  "ProviderReplayNdjsonMissingHeaderError",
  {},
) {
  override get message(): string {
    return "Provider replay NDJSON requires a transcript_start header or fallback transcript metadata.";
  }
}

export class ProviderReplayNdjsonEmptyError extends Schema.TaggedError<ProviderReplayNdjsonEmptyError>()(
  "ProviderReplayNdjsonEmptyError",
  {},
) {
  override get message(): string {
    return "Provider replay NDJSON did not contain any records.";
  }
}

export const ProviderReplayNdjsonParseError = Schema.Union([
  ProviderReplayNdjsonLineParseError,
  ProviderReplayNdjsonMissingHeaderError,
  ProviderReplayNdjsonEmptyError,
]);
export type ProviderReplayNdjsonParseError = typeof ProviderReplayNdjsonParseError.Type;

export type ProviderReplayTranscriptMetadata = Omit<ProviderReplayTranscript, "entries">;

const REPLAY_TRANSCRIPT_WORKSPACE_PLACEHOLDER = "<workspace>";

function materializeWorkspacePlaceholder(value: unknown, workspace: string): unknown {
  if (value === REPLAY_TRANSCRIPT_WORKSPACE_PLACEHOLDER) {
    return workspace;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => materializeWorkspacePlaceholder(entry, workspace));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      materializeWorkspacePlaceholder(entry, workspace),
    ]),
  );
}

export function materializeReplayTranscriptWorkspace(
  transcript: ProviderReplayTranscript,
  workspace: string,
): ProviderReplayTranscript {
  return {
    ...transcript,
    entries: transcript.entries.map((entry) =>
      entry.type === "expect_outbound"
        ? {
            ...entry,
            frame: materializeWorkspacePlaceholder(entry.frame, workspace),
          }
        : entry,
    ),
  };
}

const decodeReplayRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderReplayNdjsonRecord),
);
const decodeTranscript = Schema.decodeUnknownSync(ProviderReplayTranscript);

function parseReplayRecord(
  line: string,
  lineNumber: number,
): Effect.Effect<ProviderReplayNdjsonRecord, ProviderReplayNdjsonLineParseError> {
  return Effect.try({
    try: () => decodeReplayRecord(line),
    catch: (cause) =>
      new ProviderReplayNdjsonLineParseError({
        lineNumber,
        line,
        cause,
      }),
  });
}

function metadataFromHeader(
  header: ProviderReplayTranscriptHeader,
): ProviderReplayTranscriptMetadata {
  const { type: _type, ...metadata } = header;
  return metadata;
}

export function decodeProviderReplayNdjson(
  input: string,
  fallbackMetadata?: ProviderReplayTranscriptMetadata,
): Effect.Effect<ProviderReplayTranscript, ProviderReplayNdjsonParseError> {
  return Effect.gen(function* () {
    const lines = input
      .split(/\r?\n/u)
      .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
      .filter(({ line }) => line.length > 0);

    if (lines.length === 0) {
      return yield* new ProviderReplayNdjsonEmptyError();
    }

    const firstRecord = yield* parseReplayRecord(lines[0]!.line, lines[0]!.lineNumber);
    const metadata =
      firstRecord.type === "transcript_start" ? metadataFromHeader(firstRecord) : fallbackMetadata;

    if (!metadata) {
      return yield* new ProviderReplayNdjsonMissingHeaderError();
    }

    const entries: Array<ProviderReplayEntry> = [];
    if (firstRecord.type !== "transcript_start") {
      entries.push(firstRecord);
    }

    for (const { line, lineNumber } of lines.slice(1)) {
      const record = yield* parseReplayRecord(line, lineNumber);
      if (record.type === "transcript_start") {
        return yield* new ProviderReplayNdjsonLineParseError({
          lineNumber,
          line,
          cause: "transcript_start is only valid as the first replay record",
        });
      }
      entries.push(record);
    }

    return decodeTranscript({
      ...metadata,
      entries,
    });
  });
}

/** Use Path to resolve Windows drive/UNC fixture URLs into native paths. */
export const readProviderReplayTranscript = Effect.fn("readProviderReplayTranscript")(function* (
  file: URL,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFileString(yield* path.fromFileUrl(file));
  return yield* decodeProviderReplayNdjson(text);
});

export interface ProtocolCaptureRecord {
  readonly direction: "incoming" | "outgoing";
  readonly payload: string;
}

export interface ReplaySanitizerOptions {
  /** Replaced with the `<workspace>` placeholder that replay agents expand. */
  readonly workspace?: string;
  /** Exact credential or account values that must never reach a fixture. */
  readonly secrets?: ReadonlyArray<string>;
}

const REDACTED_SECRET_KEYS =
  /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|authorization|cookie|set-cookie|password|passwd|secret|client[_-]?secret|token|credentials?)$/iu;
const REDACTED_ACCOUNT_KEYS =
  /^(?:email|account[_-]?id|user[_-]?id|user[_-]?email|subject|login[_-]?hint|organization[_-]?id|project[_-]?id)$/iu;
const ATTACHMENT_TYPES = new Set(["image", "audio", "resource", "blob"]);

const REPLAY_REDACTION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer <redacted-token>"],
  [/\b(?:sk-|gho_|ghp_|xai-|ya29\.|AIza|vercel_)[A-Za-z0-9._-]{8,}/gu, "<redacted-token>"],
  [
    /https?:\/\/\S*(?:accounts\.google\.com|\/oauth2?\/|client_id=|redirect_uri=|code_challenge=)\S*/giu,
    "<redacted-login-url>",
  ],
  [/data:[a-z]+\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*;base64,[A-Za-z0-9+/=]+/giu, "<redacted-data-uri>"],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "<redacted-email>"],
];

function redactReplayText(text: string, options: ReplaySanitizerOptions): string {
  let result = text;
  if (options.workspace) {
    result = result.split(options.workspace).join(REPLAY_TRANSCRIPT_WORKSPACE_PLACEHOLDER);
  }
  for (const secret of options.secrets ?? []) {
    if (secret.length > 0) result = result.split(secret).join("<redacted>");
  }
  for (const [pattern, replacement] of REPLAY_REDACTION_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** Redacts credentials, login URLs, account identifiers and attachment bytes before a value is written. */
export function sanitizeReplayValue(value: unknown, options: ReplaySanitizerOptions = {}): unknown {
  if (typeof value === "string") {
    return redactReplayText(value, options);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeReplayValue(entry, options));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const attachment = typeof record.type === "string" && ATTACHMENT_TYPES.has(record.type);
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => {
      if (REDACTED_SECRET_KEYS.test(key)) return [key, "<redacted>"];
      if (REDACTED_ACCOUNT_KEYS.test(key)) return [key, "<redacted-account>"];
      if (attachment && (key === "data" || key === "blob" || key === "uri")) {
        return [key, "<redacted-attachment>"];
      }
      return [key, sanitizeReplayValue(entry, options)];
    }),
  );
}

/**
 * Converts raw ACP stdio chunks (as the protocol logger reports them) into replay
 * entries. T3-owned outbound params are replaced with `<any>` because prompts,
 * MCP server lists and client metadata vary per run.
 */
export function replayEntriesFromProtocolCapture(
  records: ReadonlyArray<ProtocolCaptureRecord>,
  options: ReplaySanitizerOptions = {},
): { readonly entries: Array<ProviderReplayEntry>; readonly unparsedLines: number } {
  const lines: Array<{ readonly direction: "incoming" | "outgoing"; readonly line: string }> = [];
  let incomingBuffer = "";
  for (const record of records) {
    if (record.direction === "outgoing") {
      for (const line of record.payload.split("\n")) {
        if (line.trim().length > 0) lines.push({ direction: "outgoing", line });
      }
      continue;
    }
    incomingBuffer += record.payload;
    const parts = incomingBuffer.split("\n");
    incomingBuffer = parts.pop() ?? "";
    for (const line of parts) {
      if (line.trim().length > 0) lines.push({ direction: "incoming", line });
    }
  }
  if (incomingBuffer.trim().length > 0) lines.push({ direction: "incoming", line: incomingBuffer });

  const requestMethods = {
    outgoing: new Map<string, string>(),
    incoming: new Map<string, string>(),
  };
  const entries: Array<ProviderReplayEntry> = [];
  let unparsedLines = 0;
  for (const { direction, line } of lines) {
    let message: {
      readonly id?: string | number | null;
      readonly method?: string;
      readonly params?: unknown;
      readonly result?: unknown;
      readonly error?: unknown;
    };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      unparsedLines += 1;
      continue;
    }
    const hasId = message.id !== undefined && message.id !== null;
    const id = hasId ? String(message.id) : undefined;
    // Outbound requests from T3 are matched by the replay agent only through their method and params.
    const outbound = direction === "outgoing";
    if (typeof message.method === "string") {
      const update =
        message.method === "session/update" && isReplayRecord(message.params)
          ? message.params.update
          : undefined;
      const sessionUpdate =
        isReplayRecord(update) && typeof update.sessionUpdate === "string"
          ? `:${update.sessionUpdate}`
          : "";
      const kind = hasId ? "request" : "notification";
      if (hasId && id !== undefined) requestMethods[direction].set(id, message.method);
      const frame = {
        kind,
        method: message.method,
        params: outbound ? REPLAY_ANY : message.params,
      };
      const sanitized = sanitizeReplayValue(frame, options);
      entries.push(
        outbound
          ? { type: "expect_outbound", label: `${kind}:${message.method}`, frame: sanitized }
          : {
              type: "emit_inbound",
              label: `${kind}:${message.method}${sessionUpdate}`,
              frame: sanitized,
            },
      );
      continue;
    }
    if (id === undefined) continue;
    // A response answers a request sent in the opposite direction.
    const method = requestMethods[outbound ? "incoming" : "outgoing"].get(id);
    if (method === undefined) continue;
    requestMethods[outbound ? "incoming" : "outgoing"].delete(id);
    const frame = {
      kind: "response",
      method,
      ...(message.result === undefined ? {} : { result: message.result }),
      ...(message.error === undefined ? {} : { error: message.error }),
    };
    entries.push(
      outbound
        ? {
            type: "expect_outbound",
            label: `response:${method}`,
            frame: sanitizeReplayValue(frame, options),
          }
        : {
            type: "emit_inbound",
            label: `response:${method}`,
            frame: sanitizeReplayValue(frame, options),
          },
    );
  }
  return { entries, unparsedLines };
}

const REPLAY_ANY = "<any>";

function isReplayRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
