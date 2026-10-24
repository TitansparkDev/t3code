// @vitest-environment jsdom
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  auth: {
    isLoaded: true,
    isSignedIn: true,
    userId: "account-1" as string | null,
    getToken: vi.fn(async () => "first-token"),
  },
  restore: vi.fn(async () => {}),
  remove: vi.fn(async () => ({ _tag: "Success" })),
}));

vi.mock("@clerk/expo", () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => mocks.auth,
}));
vi.mock("@clerk/expo/token-cache", () => ({ tokenCache: {} }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => mocks.remove,
}));
vi.mock("../../lib/runtime", () => ({
  runtime: { runPromiseExit: vi.fn() },
}));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerCloudAccountId: vi.fn(async () => null),
  restoreCloudComposerDrafts: () => mocks.restore(),
}));
vi.mock("../agent-awareness/remoteRegistration", () => ({
  setAgentAwarenessRelayTokenProvider: vi.fn(),
  releaseAgentAwarenessRelayTokenProvider: vi.fn(),
  unregisterAgentAwarenessDeviceForCurrentUser: vi.fn(),
}));
vi.mock("./publicConfig", () => ({
  resolveCloudPublicConfig: () => ({
    clerk: { publishableKey: "pk_test", jwtTemplate: "test" },
    relay: { url: "https://relay.example.test" },
  }),
  resolveRelayClerkTokenOptions: () => ({ template: "test" }),
}));
vi.mock("./cloud-drafts", () => ({ removeCloudEnvironments: {} }));

import { appAtomRegistry } from "../../state/atom-registry";
import { CloudAuthProvider, deactivateCloudRelayAccount } from "./CloudAuthProvider";

let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  mocks.auth.isLoaded = true;
  mocks.auth.isSignedIn = true;
  mocks.auth.userId = "account-1";
  mocks.auth.getToken = vi.fn(async () => "first-token");
  mocks.restore.mockReset().mockResolvedValue(undefined);
  mocks.remove.mockReset().mockResolvedValue({ _tag: "Success" });
});
afterEach(() => {
  act(() => root.unmount());
  deactivateCloudRelayAccount();
});

const render = () => createElement(CloudAuthProvider, null, createElement("div"));

describe("CloudAuthProvider sign-in activation", () => {
  it("finishes pending activation despite same-account Clerk getToken replacement", async () => {
    let releaseRestore!: () => void;
    const pendingRestore = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    mocks.restore.mockReturnValueOnce(pendingRestore);

    await act(async () => {
      root.render(render());
    });
    expect(mocks.restore).toHaveBeenCalledTimes(1);
    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();

    // A token reader refresh must not cancel activation or run draft restoration twice.
    mocks.auth.getToken = vi.fn(async () => "refreshed-token");
    await act(async () => {
      root.render(render());
    });
    expect(mocks.restore).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseRestore();
      await pendingRestore;
    });
    const session = appAtomRegistry.get(managedRelaySessionAtom);
    expect(session?.accountId).toBe("account-1");
    expect(await Effect.runPromise(session!.readClerkToken())).toBe("refreshed-token");
  });
});
