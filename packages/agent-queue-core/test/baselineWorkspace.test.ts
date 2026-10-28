import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { baselineResult, checkKey, prepareVerificationDependencies } from "../src/baseline.ts";
import { openQueueDatabase } from "../src/db.ts";
import { createTestGitRepo, createTestWorktree, execCommand } from "./harness/gitHarness.ts";

it.each([false, true])(
  "checks baseline workspace source with installed dependencies (obsolete cache: %s)",
  async (obsoleteCache) => {
    const repo = await createTestGitRepo("aq-baseline-workspace-");
    const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
    try {
      const app = NodePath.join(repo.rootDir, "apps/app");
      const shared = NodePath.join(repo.rootDir, "packages/shared");
      const external = NodePath.join(repo.rootDir, ".fixture-store/external-value");
      const reference = NodePath.join(repo.rootDir, ".repos/reference");
      await NodeFSP.mkdir(NodePath.join(app, "node_modules/@fixture"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(shared, "node_modules"), { recursive: true });
      await NodeFSP.mkdir(external, { recursive: true });
      await NodeFSP.mkdir(reference, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(repo.rootDir, ".gitignore"),
        "node_modules/\n.fixture-store/\n.worktrees/\n",
      );
      await NodeFSP.writeFile(NodePath.join(app, "package.json"), '{"name":"@fixture/app"}');
      await NodeFSP.writeFile(
        NodePath.join(shared, "package.json"),
        '{"name":"@fixture/shared","exports":"./index.mjs"}',
      );
      await NodeFSP.writeFile(
        NodePath.join(external, "package.json"),
        '{"name":"external-value","exports":"./index.mjs"}',
      );
      await NodeFSP.writeFile(
        NodePath.join(reference, "package.json"),
        '{"name":"external-value","exports":"./index.mjs"}',
      );
      await NodeFSP.writeFile(NodePath.join(reference, "index.mjs"), 'export default "vendored";');
      await NodeFSP.writeFile(NodePath.join(external, "index.mjs"), 'export default "installed";');
      const baselineSource =
        'export {default as external} from "external-value"; export const value = "baseline";';
      await NodeFSP.writeFile(NodePath.join(shared, "index.mjs"), baselineSource);
      await NodeFSP.writeFile(
        NodePath.join(app, "check.mjs"),
        'import {strict as assert} from "node:assert"; ' +
          'import {value, external} from "@fixture/shared"; ' +
          'assert.equal(value, "baseline"); assert.equal(external, "installed");',
      );
      await NodeFSP.symlink(shared, NodePath.join(app, "node_modules/@fixture/shared"), "dir");
      await NodeFSP.symlink(external, NodePath.join(shared, "node_modules/external-value"), "dir");
      await execCommand("git", ["add", "."], repo.rootDir);
      await execCommand("git", ["commit", "-m", "workspace fixture"], repo.rootDir);
      const tip = await execCommand("git", ["rev-parse", "HEAD"], repo.rootDir);
      const changedSource = baselineSource.replace('"baseline"', '"candidate"');
      await NodeFSP.writeFile(NodePath.join(shared, "index.mjs"), changedSource);
      const check = {
        run: "node check.mjs",
        cwd: "apps/app",
        timeoutSeconds: 30,
        requires: [],
        expectExitCode: 0,
      };
      if (obsoleteCache) {
        db.prepare(
          `INSERT INTO check_baselines
           (check_key, ref_commit, state, failing_json, summary, run_at)
           VALUES (?, ?, 'failed', '[]', 'Dependencies were missing', ?)`,
        ).run(checkKey(check), tip.stdout.trim(), "2000-01-01T00:00:00.000Z");
      }
      const input = {
        planId: null,
        taskId: "baseline-workspace",
        repoRoot: repo.rootDir,
        commit: tip.stdout.trim(),
        check,
        dependencySource: repo.rootDir,
      };
      const result = await baselineResult(db, input);
      expect(result, result.stderr + result.stdout).toMatchObject({
        state: "passed",
        cached: false,
      });
      expect(await baselineResult(db, input)).toMatchObject({
        state: "passed",
        cached: true,
        exitCode: 0,
      });
      expect(await NodeFSP.readFile(NodePath.join(shared, "index.mjs"), "utf8")).toBe(
        changedSource,
      );
    } finally {
      db.close();
      await repo.cleanup();
    }
  },
);

it("invalidates baseline evidence when a check's prerequisites change", async () => {
  const repo = await createTestGitRepo("aq-baseline-prerequisites-");
  const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
  try {
    const commit = await execCommand("git", ["rev-parse", "HEAD"], repo.rootDir);
    const check = {
      id: "middle",
      run: 'node -e "process.exit(1)"',
      cwd: ".",
      timeoutSeconds: 30,
      requires: [],
      expectExitCode: 0,
      dependsOn: ["producer"],
    };
    const input = {
      planId: null,
      taskId: "baseline-prerequisites",
      repoRoot: repo.rootDir,
      commit: commit.stdout.trim(),
      check,
      dependencySource: repo.rootDir,
    };
    const passingPrerequisite = {
      id: "producer",
      run: 'node -e "process.exit(0)"',
      cwd: ".",
      timeoutSeconds: 30,
      requires: [],
      expectExitCode: 0,
    };
    expect(
      await baselineResult(db, { ...input, checks: [passingPrerequisite, check] }),
    ).toMatchObject({ state: "failed", cached: false });

    const failingPrerequisite = { ...passingPrerequisite, run: 'node -e "process.exit(1)"' };
    expect(
      await baselineResult(db, { ...input, checks: [failingPrerequisite, check] }),
    ).toMatchObject({ state: "unknown", cached: false });
  } finally {
    db.close();
    await repo.cleanup();
  }
});

it("prepares a candidate despite missing dependencies in a vendored workspace", async () => {
  const repo = await createTestGitRepo("aq-baseline-vendored-workspace-");
  let probeRoot: string | undefined;
  try {
    const app = NodePath.join(repo.rootDir, "apps/app");
    const shared = NodePath.join(repo.rootDir, "packages/shared");
    const vendored = NodePath.join(repo.rootDir, ".repos/alchemy-effect/benchmarks/containers");
    await NodeFSP.mkdir(NodePath.join(app, "node_modules/@fixture"), { recursive: true });
    await NodeFSP.mkdir(shared, { recursive: true });
    await NodeFSP.mkdir(vendored, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(repo.rootDir, ".gitignore"), "node_modules/\n");
    await NodeFSP.writeFile(
      NodePath.join(app, "package.json"),
      '{"name":"@fixture/app","dependencies":{"@fixture/shared":"workspace:*"}}',
    );
    await NodeFSP.writeFile(
      NodePath.join(shared, "package.json"),
      '{"name":"@fixture/shared","exports":"./index.mjs"}',
    );
    await NodeFSP.writeFile(
      NodePath.join(vendored, "package.json"),
      '{"name":"@fixture/containers","dependencies":{"@distilled.cloud/aws":"workspace:*"}}',
    );
    await execCommand("git", ["add", "."], repo.rootDir);
    await execCommand("git", ["commit", "-m", "vendored workspace fixture"], repo.rootDir);
    await NodeFSP.symlink(shared, NodePath.join(app, "node_modules/@fixture/shared"), "dir");
    const probe = await createTestWorktree(repo, "probe", "probe-vendored-workspace");
    probeRoot = probe.worktreePath;

    const preparation = prepareVerificationDependencies({
      stage: "candidate",
      sourceRoot: repo.rootDir,
      probeRoot,
    });

    expect(preparation).toBeNull();
    expect(
      await NodeFSP.realpath(NodePath.join(probeRoot, "apps/app/node_modules/@fixture/shared")),
    ).toBe(NodePath.join(probeRoot, "packages/shared"));
  } finally {
    if (probeRoot)
      await execCommand("git", ["worktree", "remove", "--force", probeRoot], repo.rootDir);
    await repo.cleanup();
  }
});

it("reports a declared dependency that is not installed as a preparation failure, not a failing check", async () => {
  const repo = await createTestGitRepo("aq-baseline-missing-");
  const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
  try {
    const app = NodePath.join(repo.rootDir, "apps/app");
    await NodeFSP.mkdir(app, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(repo.rootDir, ".gitignore"),
      "node_modules/\n.worktrees/\n",
    );
    await NodeFSP.writeFile(
      NodePath.join(app, "package.json"),
      '{"name":"@fixture/app","dependencies":{"external-value":"1.0.0"}}',
    );
    await NodeFSP.writeFile(NodePath.join(app, "check.mjs"), "process.exit(1);");
    await execCommand("git", ["add", "."], repo.rootDir);
    await execCommand("git", ["commit", "-m", "missing install fixture"], repo.rootDir);
    const tip = (await execCommand("git", ["rev-parse", "HEAD"], repo.rootDir)).stdout.trim();
    const input = {
      planId: null,
      taskId: "baseline-missing",
      repoRoot: repo.rootDir,
      commit: tip,
      check: {
        run: "node check.mjs",
        cwd: "apps/app",
        timeoutSeconds: 30,
        requires: [],
        expectExitCode: 0,
      },
      dependencySource: repo.rootDir,
    };
    const result = await baselineResult(db, input);
    expect(result.state).toBe("unknown");
    expect(result.stderr).toContain("Dependency preparation failed at baseline");
    expect(result.stderr).toContain("external-value");
    expect((await baselineResult(db, input)).cached).toBe(false);
  } finally {
    db.close();
    await repo.cleanup();
  }
});
