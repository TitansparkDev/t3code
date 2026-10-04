import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { defaultGoalSetup, goalSetupProblem, goalSetupToSettings } from "./goalSetup.ts";

const agent = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" };
const ready = {
  ...defaultGoalSetup({
    projectId: ProjectId.make("project-1"),
    agent,
    runtimeMode: "full-access",
  }),
  name: "  Finish PLAN.md  ",
};

describe("goal setup", () => {
  it("starts from three agents, a cap of fifty, auto resume and the working rules on", () => {
    expect(defaultGoalSetup({ projectId: null, agent, runtimeMode: "full-access" })).toMatchObject({
      concurrency: 3,
      maxChats: 50,
      autoResume: true,
      standardRules: true,
      agents: [{ model: "gpt-6", count: 3 }],
    });
  });

  it("turns a ready form into the server's input", () => {
    expect(goalSetupToSettings(ready)).toMatchObject({
      name: "Finish PLAN.md",
      projectId: "project-1",
      concurrency: 3,
      maxChats: 50,
      agents: [{ modelSelection: { model: "gpt-6" }, count: 3 }],
    });
  });

  it("allows running until complete", () => {
    expect(goalSetupToSettings({ ...ready, maxChats: null })?.maxChats).toBeNull();
  });

  it("explains what is missing and refuses to build settings", () => {
    expect(goalSetupProblem({ ...ready, projectId: null })).toContain("project");
    expect(goalSetupProblem({ ...ready, name: " " })).toContain("what the goal is");
    expect(goalSetupProblem({ ...ready, agents: [] })).toContain("at least one model");
    expect(goalSetupProblem({ ...ready, concurrency: 0 })).toContain("at once");
    expect(goalSetupProblem({ ...ready, concurrency: 5, maxChats: 3 })).toContain(
      "at least as many",
    );
    expect(goalSetupProblem({ ...ready, agents: [{ ...agent, count: 99 }] })).toContain(
      "Each model",
    );
    expect(goalSetupToSettings({ ...ready, name: "" })).toBeUndefined();
  });
});
