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

const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;

export interface AntigravityUsageWindow {
  readonly id?: string;
  readonly label: string;
  readonly usedPercent: number;
  readonly windowDurationMins: number;
  readonly resetsAt?: string;
}

export interface AntigravityUsageGroup {
  readonly key: "gemini" | "claude-gpt";
  readonly displayName: string;
  readonly windows: ReadonlyArray<AntigravityUsageWindow>;
}

export interface AntigravityUsagePayload {
  readonly groups: ReadonlyArray<AntigravityUsageGroup>;
}

interface QuotaBucket {
  readonly bucketId?: string;
  readonly modelId?: string;
  readonly displayName?: string;
  readonly window?: string;
  readonly remainingFraction?: number;
  readonly remaining_fraction?: number;
  readonly resetTime?: string;
  readonly reset_time?: string;
  readonly disabled?: boolean;
}

interface QuotaGroup {
  readonly displayName?: string;
  readonly modelId?: string;
  readonly buckets?: ReadonlyArray<QuotaBucket>;
  readonly quotaBuckets?: ReadonlyArray<QuotaBucket>;
}

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
  if (typeof value !== "object" || value === null) return undefined;
  const root = value as Record<string, unknown>;
  const rawGroups = root.groups ?? root.quotaGroups ?? root.modelGroups;
  if (!Array.isArray(rawGroups)) return undefined;
  const groups: AntigravityUsageGroup[] = [];
  for (const raw of rawGroups) {
    if (typeof raw !== "object" || raw === null) continue;
    const group = raw as QuotaGroup;
    const name = (group.displayName ?? group.modelId ?? "").trim();
    const buckets = group.buckets ?? group.quotaBuckets ?? [];
    if (!name || !Array.isArray(buckets)) continue;
    const isGemini = /gemini|google/iu.test(name);
    const family = isGemini ? "Gemini" : /claude|gpt/iu.test(name) ? "Claude & GPT" : name;
    const windows = buckets.flatMap((bucket, index): AntigravityUsageWindow[] => {
      if (bucket.disabled) return [];
      const descriptor = `${bucket.window ?? ""} ${bucket.displayName ?? ""}`;
      const duration = windowDurationMins(undefined, descriptor);
      if (!duration) return [];
      const remaining = bucket.remainingFraction ?? bucket.remaining_fraction;
      if (typeof remaining !== "number" || !Number.isFinite(remaining)) return [];
      const usedPercent = remainingToUsed(remaining);
      if (usedPercent === undefined) return [];
      const reset = parseReset(bucket.resetTime ?? bucket.reset_time);
      return [
        {
          id:
            bucket.bucketId ??
            `${isGemini ? "gemini" : "claude-gpt"}_${duration >= MONTH_MINS ? "monthly" : duration >= WEEK_MINS ? "weekly" : "5h"}_${index}`,
          label: duration >= MONTH_MINS ? "Monthly" : duration >= WEEK_MINS ? "Weekly" : "5-hour",
          usedPercent,
          windowDurationMins: duration,
          ...(reset ? { resetsAt: reset } : {}),
        },
      ];
    });
    if (windows.length > 0)
      groups.push({ key: isGemini ? "gemini" : "claude-gpt", displayName: family, windows });
  }
  return groups.length > 0 ? { groups } : undefined;
}

function creditsToUsage(value: unknown): AntigravityUsagePayload | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const state = (value as { readonly quotaManagerState?: unknown }).quotaManagerState;
  if (typeof state !== "object" || state === null) return undefined;
  const credits = state as Record<string, unknown>;
  const windows: AntigravityUsageWindow[] = [];
  for (const [id, totalKey, availableKey, label] of [
    ["prompt_credits", "monthlyPromptCredits", "availablePromptCredits", "Prompt credits"],
    ["flow_credits", "monthlyFlowCredits", "availableFlowCredits", "Flow credits"],
  ] as const) {
    const total = credits[totalKey];
    const available = credits[availableKey];
    if (
      typeof total !== "number" ||
      !Number.isFinite(total) ||
      total <= 0 ||
      typeof available !== "number" ||
      !Number.isFinite(available)
    ) {
      continue;
    }
    windows.push({
      id,
      label,
      usedPercent: remainingToUsed(available / total) ?? 0,
      windowDurationMins: 43_200,
    });
  }
  return windows.length > 0
    ? { groups: [{ key: "gemini", displayName: "Gemini", windows }] }
    : undefined;
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
  for (const endpoint of [
    "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
  ]) {
    const response = yield* client
      .execute(
        HttpClientRequest.post(endpoint).pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${accessToken}`),
          HttpClientRequest.setHeader("Content-Type", "application/json"),
          HttpClientRequest.setHeader("User-Agent", "antigravity/1.1.28"),
          HttpClientRequest.bodyJsonUnsafe({ project: "default-cli-project" }),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((result) => result.json),
        Effect.timeout("5 seconds"),
        Effect.option,
      );
    if (Option.isSome(response)) {
      const payload = directQuotaGroups(response.value);
      if (payload) return payload;
    }
  }
  const creditsResponse = yield* client
    .execute(
      HttpClientRequest.post("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist").pipe(
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
  if (Option.isSome(creditsResponse)) {
    const payload = creditsToUsage(creditsResponse.value);
    if (payload) return payload;
  }
  return undefined;
});

/** Direct Google quota probe with the installed CLI as a compatibility fallback. */
export const readAntigravityUsageLimits = Effect.fn("readAntigravityUsageLimits")(
  function* (input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly profileDirectory: string;
    readonly fallbackToCli?: boolean;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;
    const direct = yield* directQuotaProbe(input).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.option,
    );
    if (Option.isSome(direct) && direct.value) return direct.value;
    return input.fallbackToCli === false ? undefined : yield* readAntigravityUsage(input);
  },
);

export function antigravityUsageToProviderLimits(
  usage: AntigravityUsagePayload,
): ProviderUsageLimitsUpdate {
  return {
    windows: usage.groups
      .toSorted((left, right) => Number(right.key === "gemini") - Number(left.key === "gemini"))
      .flatMap((group) =>
        group.windows
          .toSorted((left, right) => left.windowDurationMins - right.windowDurationMins)
          .map((window, index) => ({
            id: window.id ?? `${group.key}-${window.windowDurationMins}-${index}`,
            kind:
              window.windowDurationMins >= MONTH_MINS
                ? "monthly"
                : window.windowDurationMins >= WEEK_MINS
                  ? "weekly"
                  : "session",
            label: `${group.displayName} ${window.label}`,
            usedPercent: window.usedPercent,
            ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
            windowDurationMins: window.windowDurationMins,
          })),
      ),
  };
}

function windowDurationMins(value: unknown, fallback?: string): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  const text = typeof value === "string" ? value : fallback;
  if (!text) return undefined;
  if (/(?:five.?hour|5.?hour|5h|session)/iu.test(text)) return 300;
  if (/(?:monthly|month|30d)/iu.test(text)) return MONTH_MINS;
  if (/(?:weekly|week|seven.?day|7d)/iu.test(text)) return WEEK_MINS;
  return undefined;
}

function remainingToUsed(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(numeric)) return undefined;
  const remainingPercent = numeric <= 1 ? numeric * 100 : numeric;
  return Math.min(100, Math.max(0, 100 - remainingPercent));
}

function parseReset(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value.trim();
}

function groupKey(displayName: string): "gemini" | "claude-gpt" {
  return /gemini|google/iu.test(displayName) ? "gemini" : "claude-gpt";
}

function parseJsonGroups(value: unknown): AntigravityUsagePayload | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const command = record.command;
  const commandData =
    typeof command === "object" && command !== null
      ? (command as Record<string, unknown>).data
      : undefined;
  const data =
    typeof commandData === "object" && commandData !== null
      ? (commandData as Record<string, unknown>)
      : record;
  const rawGroups = data.groups;
  if (!Array.isArray(rawGroups)) return undefined;

  const groups: AntigravityUsageGroup[] = [];
  for (const rawGroup of rawGroups) {
    if (typeof rawGroup !== "object" || rawGroup === null) continue;
    const group = rawGroup as Record<string, unknown>;
    const displayName = typeof group.name === "string" ? group.name.trim() : "";
    if (!displayName) continue;
    const rawBuckets = group.buckets;
    if (!Array.isArray(rawBuckets)) continue;
    const windows: AntigravityUsageWindow[] = [];
    for (const rawBucket of rawBuckets) {
      if (typeof rawBucket !== "object" || rawBucket === null) continue;
      const bucket = rawBucket as Record<string, unknown>;
      if (bucket.disabled === true) continue;
      const label = typeof bucket.name === "string" ? bucket.name.trim() : "";
      const duration = windowDurationMins(bucket.window, label);
      const usedPercent = remainingToUsed(
        bucket.remaining_fraction ?? bucket.remainingFraction ?? bucket.remaining_percent,
      );
      if (!label || duration === undefined || usedPercent === undefined) continue;
      const reset = parseReset(bucket.reset_time ?? bucket.resetTime ?? bucket.resetsAt);
      windows.push({
        label: label.replace(/\s+remaining$/iu, ""),
        usedPercent,
        windowDurationMins: duration,
        ...(reset ? { resetsAt: reset } : {}),
      });
    }
    if (windows.length > 0) {
      groups.push({ key: groupKey(displayName), displayName, windows });
    }
  }
  return groups.length > 0 ? { groups } : undefined;
}

function parseText(stdout: string): AntigravityUsagePayload | undefined {
  const groups = new Map<"gemini" | "claude-gpt", AntigravityUsageGroup>();
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.includes("\t")
      ? line.split(/\t+/u).map((field) => field.trim())
      : /^(.+?)\s{2,}(.+?)\s+(\d+(?:\.\d+)?)%\s*(.*)$/u.exec(line)?.slice(1);
    if (!fields || fields.length < 3) continue;
    const displayName = fields[0];
    const label = fields[1];
    const usedPercent = remainingToUsed(fields[2]);
    const duration = windowDurationMins(undefined, label);
    if (!displayName || !label || usedPercent === undefined || duration === undefined) continue;
    const key = groupKey(displayName);
    const existing = groups.get(key) ?? { key, displayName, windows: [] };
    const reset = parseReset(fields[3]);
    groups.set(key, {
      ...existing,
      windows: [
        ...existing.windows,
        {
          label: label.replace(/\s+remaining$/iu, ""),
          usedPercent,
          windowDurationMins: duration,
          ...(reset ? { resetsAt: reset } : {}),
        },
      ],
    });
  }
  const parsed = [...groups.values()];
  return parsed.length > 0 ? { groups: parsed } : undefined;
}

/** Parse both current JSON output and the older tabular `agy /usage` output. */
export function parseAntigravityUsage(stdout: string): AntigravityUsagePayload | undefined {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const jsonGroups = parseJsonGroups(parsed);
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
      ["-p", "/usage", "--output-format", "json"],
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
