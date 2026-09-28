import {
  cliReleaseChannelOf,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
} from "@t3tools/shared/cliRelease";
import { useSyncExternalStore } from "react";

import { APP_VERSION } from "./branding";

// GitHub allows 60 unauthenticated API requests per hour per IP.
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

let latestReleaseVersion: string | null = null;
let polling = false;
const listeners = new Set<() => void>();

async function checkLatestRelease(): Promise<void> {
  try {
    const response = await fetch(cliReleaseIndexPageUrl(1));
    if (!response.ok) return;
    const releases: unknown = await response.json();
    if (!Array.isArray(releases)) return;
    const version = newestCliReleaseVersion(
      releases.filter(
        (release): release is { tag_name: string; draft?: boolean } =>
          typeof release?.tag_name === "string",
      ),
      cliReleaseChannelOf(APP_VERSION),
    );
    if (version === undefined || version === latestReleaseVersion) return;
    latestReleaseVersion = version;
    for (const listener of listeners) listener();
  } catch {
    // Offline or rate limited: keep the last known release.
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Development builds and tests never poll GitHub.
  if (!polling && import.meta.env.PROD) {
    polling = true;
    void checkLatestRelease();
    setInterval(() => void checkLatestRelease(), CHECK_INTERVAL_MS);
  }
  return () => {
    listeners.delete(listener);
  };
}

/** The newest published release on this build's channel, once known. */
export function useLatestReleaseVersion(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => latestReleaseVersion,
    () => null,
  );
}
