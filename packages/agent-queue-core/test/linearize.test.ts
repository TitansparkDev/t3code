// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { linearizeBranch } from "../src/linearize.ts";
import { createTestGitRepo, execCommand } from "./harness/gitHarness.ts";

describe("linearizeBranch", () => {
  it("drops a merge of the base into the branch and keeps the real commits", async () => {
    const repo = await createTestGitRepo("aq-linear-");
    try {
      const git = (...args: string[]) => execCommand("git", args, repo.rootDir);
      const base = (await git("rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
      await git("checkout", "-q", "-b", "work");
      await NodeFSP.writeFile(NodePath.join(repo.rootDir, "a.txt"), "a\n");
      await git("add", "a.txt");
      await git("commit", "-qm", "work");
      await git("checkout", "-q", base);
      await NodeFSP.writeFile(NodePath.join(repo.rootDir, "b.txt"), "b\n");
      await git("add", "b.txt");
      await git("commit", "-qm", "base moves");
      await git("checkout", "-q", "work");
      await git("merge", "-q", "--no-edit", base);
      expect((await git("rev-list", "--merges", `${base}..HEAD`)).stdout.trim()).not.toBe("");

      expect(linearizeBranch(repo.rootDir, base).outcome).toBe("rebased");
      expect((await git("rev-list", "--merges", `${base}..HEAD`)).stdout.trim()).toBe("");
      expect((await git("rev-list", "--count", `${base}..HEAD`)).stdout.trim()).toBe("1");
      expect(linearizeBranch(repo.rootDir, base).outcome).toBe("linear");
    } finally {
      await repo.cleanup();
    }
  });
});
