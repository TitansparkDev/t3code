import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadForkError,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ModelOption } from "../../lib/modelOptions";
import {
  defaultForkTitle,
  formatForkErrorMessage,
  isThreadForkBusy,
  isThreadForkEligible,
  isThreadForkSupported,
  resolveDefaultForkOption,
} from "./thread-fork";

function makeOption(input: {
  instanceId: string;
  driver: string;
  model: string;
  label?: string;
  isUnavailable?: boolean;
}): ModelOption {
  return {
    key: `${input.instanceId}:${input.model}`,
    label: input.label ?? input.model,
    subtitle: "",
    providerKey: input.instanceId,
    providerLabel: input.instanceId,
    providerDriver: input.driver,
    isDefault: false,
    isLegacy: false,
    isUnavailable: input.isUnavailable,
    capabilities: null,
    selection: {
      instanceId: ProviderInstanceId.make(input.instanceId),
      model: input.model,
    },
  };
}

describe("thread-fork logic", () => {
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
      expect(defaultForkTitle("   ")).toBe("(fork)");
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
    it("returns false for idle or null thread", () => {
      expect(
        isThreadForkBusy({
          session: { status: "stopped" },
          latestTurn: { state: "completed" },
          messages: [{ streaming: false }],
        }),
      ).toBe(false);
      expect(isThreadForkBusy(null)).toBe(false);
      expect(isThreadForkBusy(undefined)).toBe(false);
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

  describe("isThreadForkEligible", () => {
    it("returns true when supported and not busy", () => {
      expect(
        isThreadForkEligible({
          capabilities: { threadForking: true },
          thread: { session: { status: "stopped" }, latestTurn: { state: "completed" } },
        }),
      ).toBe(true);
    });

    it("returns false when unsupported even if not busy", () => {
      expect(
        isThreadForkEligible({
          capabilities: { threadForking: false },
          thread: { session: { status: "stopped" } },
        }),
      ).toBe(false);
      expect(
        isThreadForkEligible({
          capabilities: null,
          thread: { session: { status: "stopped" } },
        }),
      ).toBe(false);
    });

    it("returns false when busy even if supported", () => {
      expect(
        isThreadForkEligible({
          capabilities: { threadForking: true },
          thread: { session: { status: "running" } },
        }),
      ).toBe(false);
      expect(
        isThreadForkEligible({
          capabilities: { threadForking: true },
          thread: { latestTurn: { state: "pending" } },
        }),
      ).toBe(false);
    });
  });

  describe("resolveDefaultForkOption", () => {
    const codexGpt4o = makeOption({
      instanceId: "codex",
      driver: "codex",
      model: "gpt-4o",
      label: "GPT-4o",
    });
    const codexO1 = makeOption({
      instanceId: "codex",
      driver: "codex",
      model: "o1",
      label: "o1",
    });
    const claudeSonnet = makeOption({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      model: "claude-3-7-sonnet",
      label: "Claude 3.7 Sonnet",
    });
    const unavailableOption = makeOption({
      instanceId: "cursor",
      driver: "cursor",
      model: "cursor-fast",
      isUnavailable: true,
    });

    it("prefers alternate model when sourceModelSelection is provided", () => {
      const selected = resolveDefaultForkOption([codexGpt4o, codexO1, claudeSonnet], {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-4o",
      });
      expect(selected?.selection.model).toBe("o1");
    });

    it("falls back to same model if it is the only option", () => {
      const selected = resolveDefaultForkOption([codexGpt4o, unavailableOption], {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-4o",
      });
      expect(selected?.selection.model).toBe("gpt-4o");
    });

    it("returns first option if no sourceModelSelection provided", () => {
      const selected = resolveDefaultForkOption([codexGpt4o, codexO1]);
      expect(selected?.selection.model).toBe("gpt-4o");
    });

    it("returns null when options list is empty or all unavailable", () => {
      expect(resolveDefaultForkOption([])).toBe(null);
      expect(resolveDefaultForkOption([unavailableOption])).toBe(null);
    });
  });

  describe("formatForkErrorMessage", () => {
    it("formats known ThreadForkError reasons", () => {
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

      const largeErr = {
        _tag: "ThreadForkError",
        reason: "transcript_too_large",
      };
      expect(formatForkErrorMessage(largeErr)).toBe(
        "The conversation transcript exceeds the maximum size for forking.",
      );
    });

    it("handles Error instances and string messages", () => {
      expect(formatForkErrorMessage(new Error("Network failed"))).toBe("Network failed");
      expect(formatForkErrorMessage({ message: "The thread is busy with another task" })).toBe(
        "The source thread is currently busy. Please wait for the current turn to complete.",
      );
      expect(formatForkErrorMessage(null)).toBe("Failed to fork conversation.");
    });
  });
});
