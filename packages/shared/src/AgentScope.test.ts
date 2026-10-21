// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import { describe, expect, it } from "@effect/vitest";

import { AGENT_OOM_SCORE_ADJ, agentScopeCommand } from "./AgentScope.ts";
import * as HostProcess from "./HostProcess.ts";

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("agentScopeCommand", () => {
  it("raises the OOM score and execs the command with its arguments in the same process", () => {
    const launch = agentScopeCommand({
      command: "/bin/sh",
      args: [
        "-c",
        'printf "%s\\n" "$$" "$(cat /proc/self/oom_score_adj)" "$@"',
        "agent",
        "a b",
        "$HOME",
      ],
    });
    const child = NodeChildProcess.spawnSync(launch.command, [...launch.args], {
      encoding: "utf8",
    });
    const [pid, score, ...args] = child.stdout.trimEnd().split("\n");
    expect(Number(pid)).toBe(child.pid);
    expect(Number(score)).toBe(AGENT_OOM_SCORE_ADJ);
    expect(args).toEqual(["a b", "$HOME"]);
  });

  it("applies the private runtime memory ceiling to the owning scope", () => {
    const launch = agentScopeCommand({
      command: "agent",
      args: [],
      scope: {
        systemdRun: "/usr/bin/systemd-run",
        slice: "app-t3code-agents-private.slice",
        unit: "t3code-agent-test.scope",
        runtimeDir: "/run/user/1",
        options: [],
        memoryLimitMb: 10240,
      },
    });
    expect(launch.args).toContain(`--property=MemoryMax=${10240 * 1024 * 1024}`);
  });
});
