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

export type LinearizeOutcome = "linear" | "rebased" | "squashed" | "skipped" | "failed";

/**
 * Rebases the worktree's branch onto `base` when it contains merge commits; if that conflicts and
 * the branch already contains `base`, squashes it into one commit on `base` instead. Never touches
 * a dirty worktree or a detached HEAD, and otherwise leaves the branch exactly as it was.
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
  // Replaying drops the conflict resolutions the merges made. When the branch already contains
  // the whole base, its tree is exactly base plus the task's work: one commit of that tree on
  // top of the base is linear and needs no resolution.
  if (git(worktree, ["merge-base", "--is-ancestor", base, "HEAD"]).code === 0) {
    const subjects = git(worktree, ["log", "--no-merges", "--format=%s", `${base}..HEAD`]).stdout;
    const message = `${subjects.split("\n")[0] || "Task work"}\n\nSquashed onto ${base}; the branch merged it in with resolved conflicts.\n\n${subjects}`;
    const commit = git(worktree, ["commit-tree", "HEAD^{tree}", "-p", base, "-m", message]);
    if (commit.code === 0 && commit.stdout !== "") {
      const moved = git(worktree, ["reset", "-q", "--keep", commit.stdout]);
      if (moved.code === 0) {
        return {
          outcome: "squashed",
          note: `replaying conflicted, so the branch became one commit on ${base} with the same content`,
        };
      }
    }
  }
  const conflicted = /CONFLICT[^\n]*/.exec(rebased.stdout + "\n" + rebased.stderr)?.[0];
  return { outcome: "failed", note: (conflicted ?? rebased.stderr).slice(-300) };
}
