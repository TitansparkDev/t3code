import { describe, expect, it } from "vite-plus/test";

import {
  goalPrompt,
  goalSettingsProblem,
  goalTitle,
  replyNeedsAttention,
  replyReportsGoalComplete,
} from "./goals.ts";

describe("goal completion", () => {
  it("counts only the marker on its own line", () => {
    expect(replyReportsGoalComplete("All merged.\n\nGOAL COMPLETE")).toBe(true);
    expect(replyReportsGoalComplete("  GOAL COMPLETE  ")).toBe(true);
    expect(replyReportsGoalComplete("I will say GOAL COMPLETE when done.")).toBe(false);
    expect(replyReportsGoalComplete(undefined)).toBe(false);
  });
});

describe("needs attention", () => {
  it("counts only the marker on its own line", () => {
    expect(replyNeedsAttention("Blocked on a login.\nNEEDS ATTENTION")).toBe(true);
    expect(replyNeedsAttention("This needs attention soon.")).toBe(false);
    expect(replyNeedsAttention(undefined)).toBe(false);
  });
});

describe("goalPrompt", () => {
  it("always tells the agent how to work alone and how to say nothing is left", () => {
    const prompt = goalPrompt({ name: "Finish PLAN.md.", concurrency: 3, standardRules: false });
    expect(prompt.startsWith("Finish PLAN.md.")).toBe(true);
    expect(prompt).toContain("up to 3 agents");
    expect(prompt).toContain("GOAL COMPLETE on a line by itself");
    expect(prompt).toContain("NEEDS ATTENTION on a line by itself");
    expect(prompt).not.toContain("git worktree");
  });

  it("adds the working rules only when asked", () => {
    const prompt = goalPrompt({ name: "Finish PLAN.md.", concurrency: 2, standardRules: true });
    expect(prompt).toContain("own git worktree");
    expect(prompt).toContain("claim one unfinished chunk");
  });
});

describe("goalTitle", () => {
  it("uses the first line and shortens a long one", () => {
    expect(goalTitle({ name: "Ship it\nand more detail" })).toBe("Ship it");
    expect(goalTitle({ name: "x".repeat(200) })).toHaveLength(80);
  });
});

describe("goalSettingsProblem", () => {
  const agent = { modelSelection: {} as never, count: 1 };
  it("accepts a ready setup, including one with no cap", () => {
    expect(
      goalSettingsProblem({ name: "Do it", agents: [agent], concurrency: 3, maxChats: 50 }),
    ).toBeUndefined();
    expect(
      goalSettingsProblem({ name: "Do it", agents: [agent], concurrency: 3, maxChats: null }),
    ).toBeUndefined();
  });

  it("explains what is missing", () => {
    expect(
      goalSettingsProblem({ name: "  ", agents: [agent], concurrency: 3, maxChats: null }),
    ).toContain("what the goal is");
    expect(
      goalSettingsProblem({ name: "Do it", agents: [], concurrency: 3, maxChats: null }),
    ).toContain("at least one model");
    expect(
      goalSettingsProblem({ name: "Do it", agents: [agent], concurrency: 5, maxChats: 3 }),
    ).toContain("at least as many");
  });
});
