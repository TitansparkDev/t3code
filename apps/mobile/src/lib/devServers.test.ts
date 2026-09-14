import type { DiscoveredLocalServer } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { devServerDescription, resolveDevServerUrl } from "./devServers";

const server = (
  url: string,
  overrides: Partial<DiscoveredLocalServer> = {},
): DiscoveredLocalServer => ({
  host: "127.0.0.1",
  port: 5173,
  url,
  processName: "vite",
  pid: 123,
  terminal: {
    threadId: ThreadId.make("thread-1"),
    terminalId: "terminal-1",
  },
  ...overrides,
});

describe("resolveDevServerUrl", () => {
  it("rewrites loopback URLs to a private IPv4 host and preserves URL details", () => {
    const resolved = resolveDevServerUrl(
      "http://192.168.1.25:3773",
      server("https://user:p%40ss@localhost:5173/dashboard?mode=test#results"),
    );

    expect(resolved.server.url).toBe(
      "https://user:p%40ss@localhost:5173/dashboard?mode=test#results",
    );
    expect(resolved.url).toBe("https://user:p%40ss@192.168.1.25:5173/dashboard?mode=test#results");
    expect(resolved.reachable).toBe(true);
  });

  it("supports tailnet and IPv6 environment hosts", () => {
    expect(
      resolveDevServerUrl(
        "http://100.65.180.100:3773",
        server("http://127.0.0.1:3000/app", { port: 3000 }),
      ).url,
    ).toBe("http://100.65.180.100:3000/app");
    expect(
      resolveDevServerUrl(
        "http://[fd7a:115c:a1e0::53]:3773",
        server("http://localhost:3000/app", { port: 3000 }),
      ).url,
    ).toBe("http://[fd7a:115c:a1e0::53]:3000/app");
  });

  it("keeps local loopback URLs local", () => {
    const resolved = resolveDevServerUrl("http://127.0.0.1:3773", server("http://localhost:5173/"));
    expect(resolved.url).toBe("http://localhost:5173/");
    expect(resolved.reachable).toBe(true);
  });

  it("marks relay, tunnel, and offline loopback servers unreachable", () => {
    const discovered = server("http://localhost:5173/");
    expect(resolveDevServerUrl("https://relay.t3.codes", discovered).reachable).toBe(false);
    expect(resolveDevServerUrl(null, discovered).reachable).toBe(false);
    expect(devServerDescription(resolveDevServerUrl("https://relay.t3.codes", discovered))).toBe(
      "Not reachable over this connection",
    );
  });

  it("preserves non-loopback server URLs", () => {
    const resolved = resolveDevServerUrl(
      "https://relay.t3.codes",
      server("https://preview.example.test/workspace?tab=1#top", { host: "preview.example.test" }),
    );
    expect(resolved.url).toBe("https://preview.example.test/workspace?tab=1#top");
    expect(resolved.reachable).toBe(true);
  });
});
