// @effect-diagnostics nodeBuiltinImport:off
/** Cold-start quota recovery from Codex-owned session transcripts. */
import * as NodeFSP from "node:fs/promises";

import {
  CodexSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type { AccountQuotaSnapshot } from "@t3tools/contracts/quota";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { listTranscriptFiles } from "../usage/usageTranscriptReader.ts";
import type { ServerSettingsService } from "../serverSettings.ts";
import { normalizeCodexRateLimits } from "./normalizeRateLimits.ts";
import type { QuotaService } from "./QuotaService.ts";

const TAIL_BYTES = 256 * 1024;
const SCAN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_FILES = 32;
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

interface TranscriptSnapshot {
  readonly snapshot: AccountQuotaSnapshot;
  readonly asOfMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrimaryLimit(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const limitId = value["limitId"] ?? value["limit_id"];
  return limitId === undefined || limitId === null || limitId === "codex";
}

async function readTailSnapshot(
  filePath: string,
  mtimeMs: number,
  providerInstanceId: ProviderInstanceId,
  source: "state-file" | "codex-transcript" = "state-file",
): Promise<TranscriptSnapshot | null> {
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const length = stat.size - start;
    if (length <= 0) return null;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);

    const lines = buffer.toString("utf8").split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line?.includes('"rate_limits"')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(parsed)) continue;
      const payload = isRecord(parsed["payload"]) ? parsed["payload"] : null;
      const rateLimits = payload?.["rate_limits"];
      if (!isPrimaryLimit(rateLimits)) continue;
      const timestamp =
        typeof parsed["timestamp"] === "string" ? Date.parse(parsed["timestamp"]) : NaN;
      const asOfMs = Number.isFinite(timestamp) ? timestamp : mtimeMs;
      const observedAt = DateTime.formatIso(DateTime.makeUnsafe(asOfMs));
      const normalized = normalizeCodexRateLimits({
        providerInstanceId,
        payload: rateLimits,
        observedAt,
      });
      if (!normalized || normalized.groups.every((group) => group.windows.length === 0)) continue;
      return { snapshot: { ...normalized, source }, asOfMs };
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readLatestCodexTranscriptQuota(input: {
  readonly sessionsDir: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly nowMs: number;
  readonly source?: "state-file" | "codex-transcript";
}): Promise<AccountQuotaSnapshot | null> {
  let files;
  try {
    files = await listTranscriptFiles(input.sessionsDir, input.nowMs - SCAN_WINDOW_MS);
  } catch {
    return null;
  }
  const newestFirst = [...files]
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, MAX_FILES);
  let best: TranscriptSnapshot | null = null;
  for (const file of newestFirst) {
    if (best && file.mtimeMs <= best.asOfMs) break;
    const found = await readTailSnapshot(
      file.path,
      file.mtimeMs,
      input.providerInstanceId,
      input.source ?? "state-file",
    );
    if (found && (!best || found.asOfMs > best.asOfMs)) best = found;
  }
  return best?.snapshot ?? null;
}

export const seedCodexQuotaFromTranscripts = Effect.fn("quota.seedCodexFromTranscripts")(function* (
  settingsService: ServerSettingsService["Service"],
  quota: QuotaService["Service"],
) {
  const settings = yield* settingsService.getSettings;
  const path = yield* Path.Path;
  const configs = new Map<ProviderInstanceId, CodexSettings>();
  configs.set(defaultInstanceIdForDriver(CODEX_DRIVER), settings.providers.codex);
  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    if (instance.driver !== CODEX_DRIVER || instance.enabled === false) continue;
    const decoded = decodeCodexSettings(instance.config);
    if (Option.isSome(decoded)) configs.set(instanceId as ProviderInstanceId, decoded.value);
  }

  const targets = new Map<string, Array<ProviderInstanceId>>();
  for (const [instanceId, config] of configs) {
    if (!config.enabled) continue;
    const layout = yield* resolveCodexHomeLayout(config);
    const sessionsDir = path.join(layout.sharedHomePath, "sessions");
    const ids = targets.get(sessionsDir) ?? [];
    ids.push(instanceId);
    targets.set(sessionsDir, ids);
  }

  const nowMs = yield* Clock.currentTimeMillis;
  for (const [sessionsDir, instanceIds] of targets) {
    // A shared transcript directory can contain several accounts. Without
    // an account id on the rate-limit line, assigning its latest value to
    // every instance would violate the instance-keyed honesty guarantee.
    if (instanceIds.length !== 1) continue;
    const instanceId = instanceIds[0]!;
    const latest = yield* Effect.promise(() =>
      readLatestCodexTranscriptQuota({ sessionsDir, providerInstanceId: instanceId, nowMs }),
    );
    if (!latest) continue;
    yield* quota.seedSnapshot(latest);
  }
});
