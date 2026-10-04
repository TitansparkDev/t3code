import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  autoResumeStateFor,
  setInstanceAutoResume,
  setModelAutoResume,
} from "./usageLimitAutoResume.logic";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");

describe("usage-limit auto-resume rules", () => {
  it("adds and removes one model without touching other instances", () => {
    const on = setModelAutoResume([{ instanceId: claude, model: "opus" }], codex, "gpt-6", true);
    expect(on).toEqual([
      { instanceId: claude, model: "opus" },
      { instanceId: codex, model: "gpt-6" },
    ]);
    expect(setModelAutoResume(on, codex, "gpt-6", false)).toEqual([
      { instanceId: claude, model: "opus" },
    ]);
  });

  it("does not duplicate a model that is already on", () => {
    const rules = setModelAutoResume([{ instanceId: codex, model: "gpt-6" }], codex, "gpt-6", true);
    expect(rules).toHaveLength(1);
  });

  it("replaces per-model rules when the whole instance is turned on", () => {
    const rules = setInstanceAutoResume(
      [
        { instanceId: codex, model: "gpt-6" },
        { instanceId: claude, model: "opus" },
      ],
      codex,
      true,
    );
    expect(rules).toEqual([
      { instanceId: claude, model: "opus" },
      { instanceId: codex, model: "*" },
    ]);
    expect(autoResumeStateFor(rules, codex)).toBe("all");
    expect(autoResumeStateFor(rules, claude)).toBe("some");
    expect(autoResumeStateFor(setInstanceAutoResume(rules, codex, false), codex)).toBe("none");
  });
});
