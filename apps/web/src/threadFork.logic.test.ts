import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
  type ThreadForkErrorReason,
  ThreadForkError,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  defaultForkTitle,
  formatForkErrorMessage,
  hasAvailableForkModel,
  isThreadForkBusy,
  isThreadForkSupported,
  resolveDefaultForkSelection,
  resolveForkModelOptions,
} from "./threadFork.logic";

function makeProvider(input: {
  instanceId: string;
  driver: string;
  enabled?: boolean;
  installed?: boolean;
  status?: "ready" | "error" | "warning";
  models?: Array<{ slug: string; name: string; isCustom?: boolean }>;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: input.enabled ?? true,
    installed: input.installed ?? true,
    version: "1.0.0",
    status: input.status ?? "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-01T00:00:00.000Z",
    models: (input.models ?? []).map((m) => ({
      slug: m.slug,
      name: m.name,
      isCustom: m.isCustom ?? false,
      capabilities: {},
    })),
    slashCommands: [],
    skills: [],
  };
}

describe("threadFork.logic", () => {
  describe("defaultForkTitle", () => {
    it("appends (fork) to title", () => {
      expect(defaultForkTitle("Investigate memory leak")).toBe("Investigate memory leak (fork)");
    });

    it("does not duplicate (fork) suffix", () => {
      expect(defaultForkTitle("Investigate memory leak (fork)")).toBe(
        "Investigate memory leak (fork)",
      );
    });

    it("handles whitespace correctly", () => {
      expect(defaultForkTitle("  Fix bug   ")).toBe("Fix bug (fork)");
    });
  });

  describe("isThreadForkSupported", () => {
    it("returns true only when threadForking capability is true", () => {
      expect(isThreadForkSupported({ threadForking: true })).toBe(true);
      expect(isThreadForkSupported({ threadForking: false })).toBe(false);
      expect(isThreadForkSupported({})).toBe(false);
      expect(isThreadForkSupported(null)).toBe(false);
      expect(isThreadForkSupported(undefined)).toBe(false);
    });
  });

  describe("isThreadForkBusy", () => {
    it("returns false for idle thread", () => {
      expect(
        isThreadForkBusy({
          session: { status: "stopped" },
          latestTurn: { state: "completed" },
          messages: [{ streaming: false }],
        }),
      ).toBe(false);
      expect(isThreadForkBusy(null)).toBe(false);
    });

    it("returns true when session is running or starting", () => {
      expect(isThreadForkBusy({ session: { status: "running" } })).toBe(true);
      expect(isThreadForkBusy({ session: { status: "starting" } })).toBe(true);
    });

    it("returns true when turn is running or pending", () => {
      expect(isThreadForkBusy({ latestTurn: { state: "running" } })).toBe(true);
      expect(isThreadForkBusy({ latestTurn: { state: "pending" } })).toBe(true);
    });

    it("returns true when message is streaming", () => {
      expect(isThreadForkBusy({ messages: [{ streaming: true }] })).toBe(true);
    });
  });

  describe("resolveForkModelOptions and hasAvailableForkModel", () => {
    const codexProvider = makeProvider({
      instanceId: "codex",
      driver: "codex",
      models: [
        { slug: "gpt-4o", name: "GPT-4o" },
        { slug: "o1", name: "o1" },
      ],
    });
    const claudeProvider = makeProvider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      models: [{ slug: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet" }],
    });
    const disabledProvider = makeProvider({
      instanceId: "cursor",
      driver: "cursor",
      enabled: false,
      models: [{ slug: "cursor-fast", name: "Cursor Fast" }],
    });

    it("resolves model options from ready providers only", () => {
      const options = resolveForkModelOptions({
        providers: [codexProvider, claudeProvider, disabledProvider],
        sourceModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-4o",
        },
      });

      expect(options).toHaveLength(3);
      expect(options.map((o) => `${o.instanceId}:${o.modelSlug}`)).toEqual([
        "codex:gpt-4o",
        "codex:o1",
        "claudeAgent:claude-3-7-sonnet",
      ]);

      const current = options.find((o) => o.isCurrent);
      expect(current?.modelSlug).toBe("gpt-4o");
    });

    it("identifies whether alternate models exist", () => {
      expect(
        hasAvailableForkModel({
          providers: [codexProvider, claudeProvider],
          currentSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-4o",
          },
        }),
      ).toBe(true);

      const singleModelProvider = makeProvider({
        instanceId: "codex",
        driver: "codex",
        models: [{ slug: "gpt-4o", name: "GPT-4o" }],
      });
      expect(
        hasAvailableForkModel({
          providers: [singleModelProvider],
          currentSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-4o",
          },
        }),
      ).toBe(true);
    });

    it("prefers first alternate model in resolveDefaultForkSelection", () => {
      const options = resolveForkModelOptions({
        providers: [codexProvider, claudeProvider],
        sourceModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-4o",
        },
      });

      const selected = resolveDefaultForkSelection(options, {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-4o",
      });

      expect(selected?.modelSlug).toBe("o1");
      expect(selected?.isCurrent).toBe(false);
    });
  });

  describe("formatForkErrorMessage", () => {
    it("formats known ThreadForkError reasons clearly", () => {
      const busyErr = new ThreadForkError({
        reason: "source_busy",
        message: "Source thread is busy",
        sourceThreadId: ThreadId.make("thread-1"),
      });
      expect(formatForkErrorMessage(busyErr)).toBe(
        "The source thread is currently busy. Please wait for the current turn to complete.",
      );

      const provErr = new ThreadForkError({
        reason: "provider_unavailable",
        message: "Provider unavailable",
      });
      expect(formatForkErrorMessage(provErr)).toBe(
        "The selected provider or model is unavailable or unauthenticated.",
      );

      const conflictErr = new ThreadForkError({
        reason: "target_conflict",
        message: "Target conflict",
      });
      expect(formatForkErrorMessage(conflictErr)).toBe(
        "A thread with this target ID already exists or conflicts with an existing thread.",
      );

      const customForkErr = {
        _tag: "ThreadForkError",
        reason: "transcript_too_large",
        message: "Transcript too large",
      };
      expect(formatForkErrorMessage(customForkErr)).toBe(
        "The conversation transcript exceeds the maximum size for forking.",
      );
    });

    it("formats text errors and Error instances", () => {
      expect(formatForkErrorMessage(new Error("Network connection dropped"))).toBe(
        "Network connection dropped",
      );
      expect(formatForkErrorMessage({ message: "Transcript is too large to process" })).toBe(
        "The conversation transcript exceeds the maximum size for forking.",
      );
    });
  });
});
