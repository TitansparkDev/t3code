import type { DiscoveredLocalServer } from "@t3tools/contracts";
import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";
import { isLocalLoopbackHost, isPrivateNetworkHost } from "@t3tools/shared/hostClassification";

export interface ResolvedDevServer {
  readonly server: DiscoveredLocalServer;
  readonly url: string;
  readonly reachable: boolean;
}

/**
 * Resolve a discovered server for the device displaying it.
 *
 * Port discovery runs on the environment machine, so a loopback URL from
 * that machine must use the environment's private connection host on mobile.
 * Public relay and tunnel hosts are deliberately not guessed to be reachable:
 * they do not forward arbitrary development ports.
 */
export function resolveDevServerUrl(
  httpBaseUrl: string | null,
  server: DiscoveredLocalServer,
): ResolvedDevServer {
  try {
    const parsed = new URL(normalizePreviewUrl(server.url));
    if (!isLoopbackHost(parsed.hostname)) {
      return { server, url: parsed.href, reachable: true };
    }

    if (httpBaseUrl === null) {
      return { server, url: parsed.href, reachable: false };
    }

    const environmentUrl = new URL(httpBaseUrl);
    if (isLocalLoopbackHost(environmentUrl.hostname)) {
      return { server, url: parsed.href, reachable: true };
    }
    if (!isPrivateNetworkHost(environmentUrl.hostname)) {
      return { server, url: parsed.href, reachable: false };
    }

    const environmentHost = environmentUrl.hostname.replace(/^\[|\]$/g, "");
    const rewritten = new URL(parsed.href);
    // WHATWG URL requires brackets when assigning an IPv6 hostname.
    rewritten.hostname = environmentHost.includes(":") ? `[${environmentHost}]` : environmentHost;
    rewritten.port = String(server.port);
    return { server, url: rewritten.href, reachable: true };
  } catch {
    return { server, url: server.url, reachable: false };
  }
}

export function devServerLabel(server: DiscoveredLocalServer): string {
  return `localhost:${server.port}`;
}

export function devServerDescription(resolved: ResolvedDevServer): string {
  if (!resolved.reachable) {
    return "Not reachable over this connection";
  }
  return resolved.server.processName ?? "Linked dev server";
}
