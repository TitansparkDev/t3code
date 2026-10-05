/**
 * ChatAgentsDriver — `ProviderDriver` for ordinary ChatGPT desktop chats that
 * W's desktop worker drives.
 *
 * Unlike the CLI drivers there is nothing to install or update here: the worker
 * and the ChatGPT desktop app belong to W and are already running on the same
 * machine, so the snapshot only checks that they are reachable.
 *
 * @module provider/Drivers/ChatAgentsDriver
 */
import { ChatAgentsSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeUnsupportedTextGeneration } from "../../textGeneration/unsupportedTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeChatAgentsAdapter } from "../Layers/ChatAgentsAdapter.ts";
import {
  buildInitialChatAgentsProviderSnapshot,
  checkChatAgentsProviderStatus,
} from "../Layers/ChatAgentsProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const decodeChatAgentsSettings = Schema.decodeSync(ChatAgentsSettings);

const DRIVER_KIND = ProviderDriverKind.make("chatAgents");

export type ChatAgentsDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ServerSettingsService;

export const ChatAgentsDriver: ProviderDriver<ChatAgentsSettings, ChatAgentsDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Chat Agents",
    // One shared ChatGPT desktop app and one owner slot behind it.
    supportsMultipleInstances: false,
  },
  configSchema: ChatAgentsSettings,
  defaultConfig: (): ChatAgentsSettings => decodeChatAgentsSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const httpClient = yield* HttpClient.HttpClient;
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettingsService;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies ChatAgentsSettings;

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<ChatAgentsSettings>
      >({
        // Nothing here is installed or updated by T3 Code.
        resolveMaintenance: () =>
          Effect.succeed({ provider: DRIVER_KIND, packageName: null, update: null }),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialChatAgentsProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider: checkChatAgentsProviderStatus(effectiveConfig).pipe(
          Effect.map(stampIdentity),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build the Chat Agents provider snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      const adapter = yield* makeChatAgentsAdapter(effectiveConfig, {
        environment: processEnv,
        instanceId,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration: makeUnsupportedTextGeneration(DRIVER_KIND),
      } satisfies ProviderInstance;
    }),
};
