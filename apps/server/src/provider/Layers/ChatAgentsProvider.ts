/**
 * ChatAgentsProvider — the status layer for the Chat Agents driver.
 *
 * Chat Agents has no CLI to probe. It is usable when W's desktop worker and its
 * Python exist and the ChatGPT desktop app answers on its debugger port, so
 * that is what the snapshot reports. There is one model: the ChatGPT chat the
 * worker drives.
 *
 * @module provider/Layers/ChatAgentsProvider
 */
import {
  CHAT_AGENTS_MODEL,
  type ChatAgentsSettings,
  type RuntimeMode,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient } from "effect/unstable/http";

import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";

/** Where the ChatGPT desktop app exposes its debugger. Mirrors the worker's own list. */
const CDP_ENDPOINTS = ["http://127.0.0.1:9222", "http://[::1]:9222"] as const;
const CDP_PROBE_TIMEOUT_MS = 2_500;

const CHAT_AGENTS_PRESENTATION = {
  displayName: "Chat Agents",
  badgeLabel: "Private",
  // The chat carries its own tools through W; T3's permission modes do not apply.
  requiresNewThreadForModelChange: false,
  supportsConversationRollback: false,
  // A title would cost a ChatGPT turn in the shared desktop app.
  supportsTextGeneration: false,
  showInteractionModeToggle: false,
  supportsImageAttachments: false,
  supportsFileAttachments: false,
  supportedRuntimeModes: ["full-access"] as ReadonlyArray<RuntimeMode>,
} as const;

export const CHAT_AGENTS_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: CHAT_AGENTS_MODEL,
    name: "ChatGPT desktop chat",
    isCustom: false,
    isDefault: true,
    capabilities: createModelCapabilities({ optionDescriptors: [] }),
  },
];

export function buildInitialChatAgentsProviderSnapshot(
  settings: ChatAgentsSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return buildServerProvider({
      presentation: CHAT_AGENTS_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: CHAT_AGENTS_MODELS,
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking W's ChatGPT desktop worker...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Chat Agents is off. Turn it on in Settings.",
          },
    });
  });
}

const answersAsDebugger = (httpClient: HttpClient.HttpClient, endpoint: string) =>
  httpClient.get(`${endpoint}/json/version`).pipe(
    Effect.map((response) => response.status === 200),
    Effect.timeout(CDP_PROBE_TIMEOUT_MS),
    Effect.orElseSucceed(() => false),
  );

export const checkChatAgentsProviderStatus = (
  settings: ChatAgentsSettings,
): Effect.Effect<ServerProviderDraft, never, FileSystem.FileSystem | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const httpClient = yield* HttpClient.HttpClient;
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const build = (probe: Parameters<typeof buildServerProvider>[0]["probe"]) =>
      buildServerProvider({
        presentation: CHAT_AGENTS_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: CHAT_AGENTS_MODELS,
        probe,
      });

    if (!settings.enabled) {
      return build({
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Chat Agents is off. Turn it on in Settings.",
      });
    }

    const missing: string[] = [];
    for (const [label, path] of [
      ["W desktop worker", settings.workerPath],
      ["Python for the worker", settings.pythonPath],
    ] as const) {
      const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false));
      if (!exists) missing.push(`${label} (${path})`);
    }
    if (missing.length > 0) {
      return build({
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `Not found: ${missing.join(", ")}. Set the right paths in Settings.`,
      });
    }

    const answers = yield* Effect.forEach(
      CDP_ENDPOINTS,
      (endpoint) => answersAsDebugger(httpClient, endpoint),
      {
        concurrency: "unbounded",
      },
    );
    if (!answers.some(Boolean)) {
      return build({
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message:
          "The ChatGPT desktop app is not answering. W keeps it running, so this usually clears on its own.",
      });
    }
    return build({
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated", label: "ChatGPT desktop (W)" },
    });
  });
