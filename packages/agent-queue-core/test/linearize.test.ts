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

  it("squashes a branch whose merge resolved a conflict instead of failing the replay", async () => {
    const repo = await createTestGitRepo("aq-linear-conflict-");
    try {
      const git = (...args: string[]) => execCommand("git", args, repo.rootDir);
      const write = (file: string, text: string) =>
        NodeFSP.writeFile(NodePath.join(repo.rootDir, file), text);
      const base = (await git("rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
      await write("shared.txt", "one\n");
      await git("add", "shared.txt");
      await git("commit", "-qm", "shared");
      await git("checkout", "-q", "-b", "work");
      await write("shared.txt", "work\n");
      await git("commit", "-qam", "work");
      await git("checkout", "-q", base);
      await write("shared.txt", "base\n");
      await git("commit", "-qam", "base moves");
      await git("checkout", "-q", "work");
      await git("merge", "-q", "--no-edit", base); // conflicts
      await write("shared.txt", "resolved\n");
      await git("commit", "-qam", "merge base, resolved");

      const result = linearizeBranch(repo.rootDir, base);
      expect(result.outcome).toBe("squashed");
      expect((await git("rev-list", "--merges", `${base}..HEAD`)).stdout.trim()).toBe("");
      expect((await git("rev-list", "--count", `${base}..HEAD`)).stdout.trim()).toBe("1");
      expect((await git("show", "HEAD:shared.txt")).stdout).toBe("resolved\n");
      expect((await git("status", "--porcelain")).stdout.trim()).toBe("");
    } finally {
      await repo.cleanup();
    }
  });

  it("leaves the branch untouched when the replay conflicts and the base was not merged in", async () => {
    const repo = await createTestGitRepo("aq-linear-stale-");
    try {
      const git = (...args: string[]) => execCommand("git", args, repo.rootDir);
      const write = (file: string, text: string) =>
        NodeFSP.writeFile(NodePath.join(repo.rootDir, file), text);
      const base = (await git("rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
      await write("shared.txt", "one\n");
      await git("add", "shared.txt");
      await git("commit", "-qm", "shared");
      await git("checkout", "-q", "-b", "side");
      await write("side.txt", "side\n");
      await git("add", "side.txt");
      await git("commit", "-qm", "side");
      await git("checkout", "-q", "-b", "work", base);
      await write("shared.txt", "work\n");
      await git("commit", "-qam", "work");
      await git("merge", "-q", "--no-edit", "side");
      await git("checkout", "-q", base);
      await write("shared.txt", "base\n");
      await git("commit", "-qam", "base moves");
      await git("checkout", "-q", "work");
      const before = (await git("rev-parse", "HEAD")).stdout.trim();

      expect(linearizeBranch(repo.rootDir, base).outcome).toBe("failed");
      expect((await git("rev-parse", "HEAD")).stdout.trim()).toBe(before);
      expect((await git("status", "--porcelain")).stdout.trim()).toBe("");
    } finally {
      await repo.cleanup();
    }
  });
});
