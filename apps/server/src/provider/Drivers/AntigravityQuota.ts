import type { ProviderUsageLimitsUpdate } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { spawnAndCollect } from "../providerSnapshot.ts";
import {
  antigravityPayloadToUsageLimits,
  classifyAntigravityIdentity,
  parseAntigravityQuotaPayload,
  parseResetTimestamp,
  parseWindowDurationMins,
  type AntigravityUsageGroup,
  type AntigravityUsagePayload,
  type AntigravityUsageWindow,
} from "../../quota/antigravityQuotaParser.ts";

export type { AntigravityUsageGroup, AntigravityUsagePayload, AntigravityUsageWindow };

const AntigravityTokenFile = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.String,
  refresh_token: Schema.String,
  token_uri: Schema.String,
});

const decodeAntigravityToken = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AntigravityTokenFile),
);

export function directQuotaGroups(value: unknown): AntigravityUsagePayload | undefined {
  return parseAntigravityQuotaPayload(value, { generateWindowIds: true });
}

export function projectIdFromLoadCodeAssist(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const root = value as Record<string, unknown>;
  // Only accept Google's explicitly provisioned companion project. Generic
  // project fields can refer to a different GCP project and produce a
  // successful but unrelated quota response.
  const candidate = root.cloudaicompanionProject;
  if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  if (typeof candidate === "object" && candidate !== null) {
    const project = candidate as Record<string, unknown>;
    for (const key of ["projectId", "project_id", "id", "name"] as const) {
      const value = project[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return undefined;
}

function safeGoogleTokenUri(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const uri = new URL(value);
    return (
      uri.protocol === "https:" &&
      (uri.hostname === "oauth2.googleapis.com" ||
        uri.hostname === "accounts.google.com" ||
        uri.hostname.endsWith(".googleapis.com"))
    );
  } catch {
    return false;
  }
}

/**
 * Discovers local Antigravity desktop or language-server endpoint.
 * Only probes loopback (127.0.0.1) and same-user processes.
 */
export function discoverLocalAntigravityEndpoint(
  environment: NodeJS.ProcessEnv,
): { readonly port: number; readonly csrfToken?: string } | undefined {
  const envPort = environment.ANTIGRAVITY_PORT ?? environment.AGY_PORT ?? environment.GEMINI_PORT;
  if (envPort) {
    const port = parseInt(envPort, 10);
    if (port >= 1 && port <= 65535) {
      const csrfToken = environment.ANTIGRAVITY_CSRF_TOKEN ?? environment.AGY_CSRF_TOKEN;
      return { port, ...(csrfToken ? { csrfToken } : {}) };
    }
  }

  if (process.platform === "linux") {
    try {
      const fs = require("node:fs");
      const entries: string[] = fs.readdirSync("/proc");
      const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          if (currentUid !== undefined) {
            const stat = fs.statSync(`/proc/${entry}`);
            if (stat.uid !== currentUid) continue;
          }
          const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf-8").replace(/\0/g, " ");
          if (!/antigravity|language_server|agy_acp/i.test(cmdline)) continue;
          const portMatch = /--port(?:=|\s+)(\d+)/.exec(cmdline);
          if (!portMatch || !portMatch[1]) continue;
          const port = parseInt(portMatch[1], 10);
          if (port < 1 || port > 65535) continue;
          const csrfMatch = /--(?:csrf_token|csrf-token|csrf)(?:=|\s+)([^\s]+)/.exec(cmdline);
          const csrfToken = csrfMatch?.[1];
          return { port, ...(csrfToken ? { csrfToken } : {}) };
        } catch {
          // Skip unreadable process entries
        }
      }
    } catch {
      // Ignore procfs read errors
    }
  }

  return undefined;
}

/**
 * Probe local running Antigravity endpoint.
 * Connects exclusively to 127.0.0.1. Never sends CSRF token to a remote host.
 */
export const probeLocalAntigravityUsage = Effect.fn("probeLocalAntigravityUsage")(
  function* (input: { readonly port: number; readonly csrfToken?: string }) {
    const client = yield* HttpClient.HttpClient;
    const endpoints = [
      "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
      "/exa.language_server_pb.LanguageServerService/GetUserStatus",
      "/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs",
    ];

    for (const endpoint of endpoints) {
      const url = `http://127.0.0.1:${input.port}${endpoint}`;
      let req = HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeader("Content-Type", "application/json"),
        HttpClientRequest.bodyJsonUnsafe({}),
      );
      if (input.csrfToken) {
        req = req.pipe(
          HttpClientRequest.setHeader("X-Csrf-Token", input.csrfToken),
          HttpClientRequest.setHeader("x-code-assist-csrf-token", input.csrfToken),
        );
      }

      const response = yield* client.execute(req).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((res) => res.json),
        Effect.timeout("3 seconds"),
        Effect.option,
      );

      if (Option.isSome(response)) {
        const payload = parseAntigravityQuotaPayload(response.value);
        if (payload && payload.groups.length > 0) {
          return payload;
        }
      }
    }
    return undefined;
  },
);

const directQuotaProbe = Effect.fn("readAntigravityDirectUsage")(function* (input: {
  readonly profileDirectory: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* HttpClient.HttpClient;
  const tokenText = yield* fs
    .readFileString(path.join(input.profileDirectory, "antigravity-acp", "acp_token.json"))
    .pipe(Effect.option);
  if (Option.isNone(tokenText)) return undefined;
  const token = yield* decodeAntigravityToken(tokenText.value).pipe(Effect.option);
  if (Option.isNone(token) || !safeGoogleTokenUri(token.value.token_uri)) return undefined;
  const tokenResponse = yield* client
    .execute(
      HttpClientRequest.post(token.value.token_uri).pipe(
        HttpClientRequest.bodyUrlParams({
          client_id: token.value.client_id,
          client_secret: token.value.client_secret,
          refresh_token: token.value.refresh_token,
          grant_type: "refresh_token",
        }),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout("10 seconds"),
      Effect.option,
    );
  if (Option.isNone(tokenResponse)) return undefined;
  const accessToken = (tokenResponse.value as { readonly access_token?: unknown }).access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) return undefined;
  const loadAssistResponse = yield* client
    .execute(
      HttpClientRequest.post(
        "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      ).pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${accessToken}`),
        HttpClientRequest.setHeader("Content-Type", "application/json"),
        HttpClientRequest.setHeader("User-Agent", "antigravity/1.1.28"),
        HttpClientRequest.bodyJsonUnsafe({
          metadata: { ideType: "ANTIGRAVITY", ideVersion: "1.0.0" },
        }),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((result) => result.json),
      Effect.timeout("10 seconds"),
      Effect.option,
    );
  const project = Option.isSome(loadAssistResponse)
    ? projectIdFromLoadCodeAssist(loadAssistResponse.value)
    : undefined;

  const response = yield* client
    .execute(
      HttpClientRequest.post(
        "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      ).pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${accessToken}`),
        HttpClientRequest.setHeader("Content-Type", "application/json"),
        HttpClientRequest.setHeader("User-Agent", "antigravity/1.1.28"),
        // The daily service accepts an empty body for accounts without a
        // provisioned companion project. Never send the made-up CLI project:
        // it returns a successful but incorrect Gemini quota.
        HttpClientRequest.bodyJsonUnsafe(project ? { project } : {}),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((result) => result.json),
      Effect.timeout("8 seconds"),
      Effect.option,
    );
  if (Option.isSome(response)) {
    const payload = parseAntigravityQuotaPayload(response.value);
    if (payload && payload.groups.length > 0) return payload;
  }
  return undefined;
});

/** Direct Google quota probe with local endpoint and CLI compatibility fallbacks. */
export const readAntigravityUsageLimits = Effect.fn("readAntigravityUsageLimits")(
  function* (input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly profileDirectory: string;
    readonly fallbackToCli?: boolean;
    readonly disableLocalDiscovery?: boolean;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;

    // 1. Try local loopback endpoint probe if discovered
    if (!input.disableLocalDiscovery) {
      const localEndpoint = discoverLocalAntigravityEndpoint(input.environment);
      if (localEndpoint) {
        const localUsage = yield* probeLocalAntigravityUsage(localEndpoint).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.option,
        );
        if (Option.isSome(localUsage) && localUsage.value) {
          return localUsage.value;
        }
      }
    }

    // 2. Try remote Google OAuth probe
    const direct = yield* directQuotaProbe(input).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.option,
    );
    if (Option.isSome(direct) && direct.value) return direct.value;

    // 3. Fall back to CLI
    return input.fallbackToCli === false ? undefined : yield* readAntigravityUsage(input);
  },
);

export function antigravityUsageToProviderLimits(
  usage: AntigravityUsagePayload,
): ProviderUsageLimitsUpdate {
  return antigravityPayloadToUsageLimits(usage);
}

function parseText(stdout: string): AntigravityUsagePayload | undefined {
  const groups = new Map<string, AntigravityUsageGroup>();
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("─") || line.startsWith("#")) continue;
    const fields = line.includes("\t")
      ? line.split(/\t+/u).map((field) => field.trim())
      : line.includes("│")
        ? line.split(/│+/u).map((field) => field.trim())
        : /^(.+?)\s{2,}(.+?)\s+(\d+(?:\.\d+)?)%\s*(.*)$/u.exec(line)?.slice(1);
    if (!fields || fields.length < 3) continue;
    const displayName = fields[0];
    const label = fields[1];
    const rawRemaining = fields[2];
    if (!displayName || !label || !rawRemaining) continue;
    const remainingMatch = /(\d+(?:\.\d+)?)%/u.exec(rawRemaining);
    if (!remainingMatch || !remainingMatch[1]) continue;
    const remainingNum = Number.parseFloat(remainingMatch[1]);
    if (!Number.isFinite(remainingNum) || remainingNum < 0 || remainingNum > 100) continue;
    const usedPercent = Math.round((100 - remainingNum) * 100) / 100;
    const duration = parseWindowDurationMins(undefined, label);
    if (!displayName || !label || duration === undefined) continue;
    const identity = classifyAntigravityIdentity(displayName, displayName);
    const key =
      identity.poolKey === "gemini"
        ? "gemini"
        : identity.poolKey === "claude-gpt"
          ? "claude-gpt"
          : displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const existing = groups.get(key) ?? {
      key,
      displayName: identity.defaultDisplayName,
      windows: [],
    };
    const reset = parseResetTimestamp(fields[3]);
    const window: AntigravityUsageWindow = {
      label: label.replace(/\s+remaining$/iu, ""),
      usedPercent,
      windowDurationMins: duration,
      ...(reset ? { resetsAt: reset } : {}),
    };
    groups.set(key, {
      ...existing,
      windows: [...existing.windows, window],
    });
  }
  const parsed = [...groups.values()];
  return parsed.length > 0 ? { groups: parsed } : undefined;
}

/** Parse both current JSON output and the older tabular `agy /quota` output. */
export function parseAntigravityUsage(stdout: string): AntigravityUsagePayload | undefined {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const jsonGroups = parseAntigravityQuotaPayload(parsed, { generateWindowIds: false });
    if (jsonGroups) return jsonGroups;
    if (typeof parsed === "object" && parsed !== null) {
      const response = (parsed as Record<string, unknown>).response;
      if (typeof response === "string") return parseText(response);
    }
  } catch {
    // The CLI's text mode is intentionally supported as a fallback.
  }
  return parseText(stdout);
}

export const readAntigravityUsage = Effect.fn("readAntigravityUsage")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly profileDirectory: string;
}) {
  const environment = {
    ...input.environment,
    GEMINI_HOME: input.profileDirectory,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
  };
  const result = yield* Effect.gen(function* () {
    const resolved = yield* resolveSpawnCommand(
      "agy",
      ["-p", "/quota", "--output-format", "json"],
      {
        env: environment,
        extendEnv: false,
      },
    );
    return yield* spawnAndCollect(
      "agy",
      ChildProcess.make(resolved.command, resolved.args, {
        env: environment,
        extendEnv: false,
        shell: resolved.shell,
      }),
    );
  }).pipe(
    Effect.timeoutOption("20 seconds"),
    Effect.orElseSucceed(() => Option.none()),
  );
  if (Option.isNone(result) || result.value.code !== 0) return undefined;
  return parseAntigravityUsage(result.value.stdout);
});
