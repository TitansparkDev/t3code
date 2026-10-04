import { describe, expect, it } from "vite-plus/test";

import { goalPrompt, isGoalCommand, parseGoalCommand, replyReportsGoalComplete } from "./goals.ts";

describe("parseGoalCommand", () => {
  it("takes the first line as the goal and the rest as instructions", () => {
    expect(
      parseGoalCommand("!goal complete the plan.md\nWork the plan in the root.\nUse a worktree."),
    ).toEqual({
      lanes: undefined,
      description: "complete the plan.md",
      prompt: "complete the plan.md\n\nWork the plan in the root.\nUse a worktree.",
    });
  });

  it("uses a one-line goal as its own instructions", () => {
    expect(parseGoalCommand("  !goal  fix every failing test ")).toEqual({
      lanes: undefined,
      description: "fix every failing test",
      prompt: "fix every failing test",
    });
  });

  it("reads an optional lane count and keeps it between 1 and 8", () => {
    expect(parseGoalCommand("!goal x5 ship it")?.lanes).toBe(5);
    expect(parseGoalCommand("!goal x40 ship it")?.lanes).toBe(8);
    expect(parseGoalCommand("!goal x0 ship it")?.lanes).toBe(1);
  });

  it("ignores messages that merely mention the command", () => {
    expect(parseGoalCommand("please run !goal later")).toBeUndefined();
    expect(parseGoalCommand("!goals are nice")).toBeUndefined();
    expect(parseGoalCommand("!goal")).toBeUndefined();
    expect(parseGoalCommand("!goal   \n  ")).toBeUndefined();
  });

  it("recognizes an empty command so the sender can be told what is missing", () => {
    expect(isGoalCommand("!goal")).toBe(true);
    expect(isGoalCommand("!GOAL do it")).toBe(true);
    expect(isGoalCommand("hello !goal")).toBe(false);
    expect(isGoalCommand("!goals")).toBe(false);
  });
});

describe("goal completion", () => {
  it("counts only the marker on its own line", () => {
    expect(replyReportsGoalComplete("All merged.\n\nGOAL COMPLETE")).toBe(true);
    expect(replyReportsGoalComplete("  GOAL COMPLETE  ")).toBe(true);
    expect(replyReportsGoalComplete("I will say GOAL COMPLETE when done.")).toBe(false);
    expect(replyReportsGoalComplete(undefined)).toBe(false);
  });

  it("tells each chat how to work alone and how to report that nothing is left", () => {
    const prompt = goalPrompt({ prompt: "Finish PLAN.md.", lanes: 3 });
    expect(prompt.startsWith("Finish PLAN.md.")).toBe(true);
    expect(prompt).toContain("up to 3 agents");
    expect(prompt).toContain("own git worktree");
    expect(prompt).toContain("GOAL COMPLETE on a line by itself");
  });
});
