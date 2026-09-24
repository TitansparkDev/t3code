// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { readLatestCodexTranscriptQuota } from "./CodexTranscriptQuota.ts";

describe("CodexTranscriptQuota", () => {
  it("recovers the latest primary snapshot and ignores a newer side meter", async () => {
    const sessionsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-quota-transcript-"));
    try {
      const transcript = NodePath.join(sessionsDir, "rollout.jsonl");
      NodeFS.writeFileSync(
        transcript,
        [
          JSON.stringify({
            timestamp: "2026-08-23T10:00:00.000Z",
            payload: {
              rate_limits: {
                limit_id: "codex",
                plan_type: "pro",
                primary: { used_percent: 27, window_minutes: 300 },
                secondary: { used_percent: 61, window_minutes: 10080 },
              },
            },
          }),
          JSON.stringify({
            timestamp: "2026-08-23T10:01:00.000Z",
            payload: {
              rate_limits: {
                limit_id: "codex_bengalfox",
                primary: { used_percent: 99, window_minutes: 300 },
              },
            },
          }),
        ].join("\n"),
      );

      const snapshot = await readLatestCodexTranscriptQuota({
        sessionsDir,
        providerInstanceId: ProviderInstanceId.make("codex_personal"),
        nowMs: Date.parse("2026-08-23T11:00:00.000Z"),
      });

      expect(snapshot?.providerInstanceId).toBe("codex_personal");
      expect(snapshot?.source).toBe("state-file");
      expect(snapshot?.planType).toBe("pro");
      expect(snapshot?.groups[0]?.windows.map((window) => window.usedPercent)).toEqual([27, 61]);
    } finally {
      NodeFS.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it("supports explicit codex-transcript source attribution", async () => {
    const sessionsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-quota-transcript-"));
    try {
      const transcript = NodePath.join(sessionsDir, "session.jsonl");
      NodeFS.writeFileSync(
        transcript,
        JSON.stringify({
          timestamp: "2026-08-23T10:00:00.000Z",
          payload: {
            rate_limits: {
              limit_id: "codex",
              plan_type: "team",
              primary: { used_percent: 50, window_minutes: 300 },
            },
          },
        }),
      );

      const snapshot = await readLatestCodexTranscriptQuota({
        sessionsDir,
        providerInstanceId: ProviderInstanceId.make("codex_team"),
        nowMs: Date.parse("2026-08-23T10:30:00.000Z"),
        source: "codex-transcript",
      });

      expect(snapshot?.source).toBe("codex-transcript");
      expect(snapshot?.planType).toBe("team");
      expect(snapshot?.groups[0]?.windows[0]?.usedPercent).toBe(50);
    } finally {
      NodeFS.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });
});
