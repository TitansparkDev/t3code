// @effect-diagnostics nodeBuiltinImport:off
/**
 * Repositories require a worker's branch to be linear on top of the integration branch
 * (NR8 was refused by `worker-finalizer` for one merge commit, a worker's own "merge the base
 * in" step). A merge of the base into the branch carries no work of its own, so replaying the
 * branch onto the base with a plain rebase drops it and keeps every real commit.
 *
 * @module linearize
 */
import * as NodeChildProcess from "node:child_process";

const git = (cwd: string, args: ReadonlyArray<string>) => {
  const out = NodeChildProcess.spawnSync("git", [...args], { cwd, encoding: "utf8" });
  return {
    code: out.status ?? 1,
    stdout: (out.stdout ?? "").trim(),
    stderr: (out.stderr ?? "").trim(),
  };
};

export type LinearizeOutcome = "linear" | "rebased" | "skipped" | "failed";

/**
 * Rebases the worktree's branch onto `base` when it contains merge commits. Never touches a
 * dirty worktree or a detached HEAD, and leaves the branch exactly as it was if the replay conflicts.
 */
export function linearizeBranch(
  worktree: string,
  base: string,
): { readonly outcome: LinearizeOutcome; readonly note: string } {
  const merges = git(worktree, ["rev-list", "--merges", `${base}..HEAD`]);
  if (merges.code !== 0) return { outcome: "skipped", note: merges.stderr.slice(0, 200) };
  if (merges.stdout === "") return { outcome: "linear", note: "no merge commits" };
  if (git(worktree, ["symbolic-ref", "-q", "HEAD"]).code !== 0) {
    return { outcome: "skipped", note: "HEAD is detached" };
  }
  if (git(worktree, ["status", "--porcelain"]).stdout !== "") {
    return { outcome: "skipped", note: "the worktree has uncommitted changes" };
  }
  const rebased = git(worktree, ["rebase", base]);
  if (rebased.code === 0) {
    return { outcome: "rebased", note: `replayed onto ${base}, dropping its merge commits` };
  }
  git(worktree, ["rebase", "--abort"]);
  return { outcome: "failed", note: rebased.stderr.slice(-300) };
}
