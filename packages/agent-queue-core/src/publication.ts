// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * Publishing a plan: moving the target branch (for example `main`) to the verified result
 * AgentQueue built on the plan's own integration branch.
 *
 * Tasks do not wait for this. They complete when they are integrated and verified on the
 * integration branch, which only AgentQueue touches. Publication happens when the plan is
 * integrated, under the landing lock, and never at the cost of someone's uncommitted work:
 *  - no checkout has the target open: the branch ref moves (compare-and-swap);
 *  - a checkout has it open and its edits do not overlap the change: plain fast-forward;
 *  - overlapping edits with an active owner, staged changes, an unfinished Git operation or
 *    recent writes: publication stays pending and says why;
 *  - overlapping edits that are provably idle and plain working-tree edits: copied to a
 *    durable snapshot first, then reconciled by a three-way merge so the edits stay on top
 *    of the new commit. A conflict leaves the checkout untouched and publication pending.
 *
 * @module publication
 */
import type * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  analyzeCheckout,
  planReconcile,
  restoreSnapshot,
  snapshotCheckout,
  type CheckoutAnalysis,
} from "./checkout.ts";
import { acquireLandingLock, prepareStagingWorktree } from "./integration.ts";
import { recordEvent } from "./eventStream.ts";
import { runVerification } from "./verifier.ts";

function git(cwd: string, args: ReadonlyArray<string>) {
  const result = NodeChildProcess.spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    code: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

const IDENTITY = ["-c", "user.name=AgentQueue", "-c", "user.email=agentqueue@localhost"] as const;

export type PublicationState = "pending" | "published" | "blocked";

export interface PublishPolicy {
  /** Whether provably abandoned uncommitted edits may be preserved and reconciled. */
  readonly reconcileAbandoned: boolean;
  /** Overlapping edits must have been idle at least this long before they count as abandoned. */
  readonly idleMinutes: number;
}

export const DEFAULT_PUBLISH_POLICY: PublishPolicy = {
  reconcileAbandoned: true,
  idleMinutes: Number(process.env.AGENTQUEUE_CHECKOUT_IDLE_MINUTES ?? 30),
};

export type PublishOutcome =
  | {
      readonly kind: "published";
      readonly commit: string;
      /** Set when abandoned edits were preserved and reconciled to publish. */
      readonly snapshotId?: string;
      /** Set when the target already contained the result (an earlier attempt finished). */
      readonly reconciled: boolean;
    }
  /** Waiting for the checkout, base branch or a check; the verified result is kept. */
  | {
      readonly kind: "pending";
      readonly reason: string;
      readonly cause:
        | "active-owner"
        | "staged-changes"
        | "unfinished-operation"
        | "recent-edits"
        | "conflicting-edits"
        | "policy"
        | "unknown-owner"
        | "base-moved";
      readonly files: ReadonlyArray<string>;
      readonly snapshotId?: string;
    }
  /** The target moved in a way that cannot be merged or verified automatically. */
  | { readonly kind: "blocked"; readonly reason: string; readonly files: ReadonlyArray<string> }
  | { readonly kind: "nothing-to-publish" };

export interface PublishInput {
  readonly repoRoot: string;
  readonly gitCommonDir: string;
  readonly baseBranch: string;
  readonly integrationBranch: string;
  readonly planId: string;
  readonly policy?: PublishPolicy;
}

function checkedOutAt(repoRoot: string, branch: string): string | null {
  const listing = git(repoRoot, ["worktree", "list", "--porcelain"]).stdout;
  let path: string | null = null;
  for (const line of listing.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}` && path) return path;
  }
  return null;
}

function setPublication(
  db: NodeSqlite.DatabaseSync,
  planId: string,
  state: PublicationState,
  note: string | null,
  commit?: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE plans SET publication_state = ?, publication_note = ?, published_commit = COALESCE(?, published_commit),
       publication_updated_at = ?, updated_at = ? WHERE id = ?`,
  ).run(state, note?.slice(0, 1000) ?? null, commit ?? null, now, now, planId);
}

function describeOwners(analysis: CheckoutAnalysis): string {
  if (analysis.activeProcesses === null)
    return "Another process may be using the checkout (it cannot be checked on this system).";
  const who = analysis.activeProcesses.map((p) => `${p.command || "process"} ${p.pid}`).join(", ");
  return `Active in the checkout: ${who}.`;
}

/** Everything the policy may do to a checkout that has the target branch open. */
function promoteIntoCheckout(
  input: PublishInput,
  policy: PublishPolicy,
  holder: string,
  baseOid: string,
  newOid: string,
): PublishOutcome {
  const head = git(holder, ["rev-parse", "HEAD"]).stdout;
  if (head !== baseOid) {
    return {
      kind: "pending",
      cause: "base-moved",
      reason: `${input.baseBranch} moved while publishing; trying again.`,
      files: [],
    };
  }
  const incoming = new Set(
    git(holder, ["diff", "--name-only", baseOid, newOid]).stdout.split("\n").filter(Boolean),
  );
  const analysis = analyzeCheckout(holder, incoming);
  if (analysis.unfinished) {
    return {
      kind: "pending",
      cause: "unfinished-operation",
      reason: `The checkout at ${holder} has an unfinished Git operation (${analysis.unfinished}).`,
      files: [],
    };
  }

  let snapshotId: string | undefined;
  if (analysis.overlap.length > 0) {
    const files = analysis.overlap.map((entry) => entry.path);
    if (analysis.overlap.some((entry) => entry.staged)) {
      return {
        kind: "pending",
        cause: "staged-changes",
        reason: `The checkout at ${holder} has staged changes to files this plan also changes (${files.slice(0, 5).join(", ")}). They are left alone.`,
        files,
      };
    }
    if (analysis.activeProcesses === null || analysis.activeProcesses.length > 0) {
      return {
        kind: "pending",
        cause: analysis.activeProcesses === null ? "unknown-owner" : "active-owner",
        reason: `The checkout at ${holder} has uncommitted edits to files this plan also changes (${files.slice(0, 5).join(", ")}). ${describeOwners(analysis)} Publication waits; the verified result is kept on ${input.integrationBranch}.`,
        files,
      };
    }
    if (!policy.reconcileAbandoned) {
      return {
        kind: "pending",
        cause: "policy",
        reason: `The checkout at ${holder} has uncommitted edits to files this plan also changes (${files.slice(0, 5).join(", ")}) and reconciling them is switched off.`,
        files,
      };
    }
    const idleMinutes = analysis.overlapIdleMs / 60_000;
    if (idleMinutes < policy.idleMinutes) {
      return {
        kind: "pending",
        cause: "recent-edits",
        reason: `The overlapping edits in ${holder} (${files.slice(0, 5).join(", ")}) were written ${Math.round(idleMinutes)} minute(s) ago; they count as abandoned after ${policy.idleMinutes}.`,
        files,
      };
    }
    // No owner, no staged work, idle long enough: preserve everything, then reconcile.
    const plan = planReconcile(holder, baseOid, newOid, analysis.overlap);
    if (!plan.ok) {
      return {
        kind: "pending",
        cause: "conflicting-edits",
        reason: `${plan.reason} The checkout was not changed.`,
        files,
      };
    }
    const snapshot = snapshotCheckout(holder, input.gitCommonDir);
    snapshotId = snapshot.id;
    // Only the overlapping files are moved out of the way, and only after the snapshot verified.
    for (const entry of analysis.overlap) {
      const abs = NodePath.join(holder, entry.path);
      if (entry.untracked) NodeFS.unlinkSync(abs);
      else git(holder, ["restore", "--worktree", "--", entry.path]);
    }
    const merged = git(holder, ["merge", "--ff-only", newOid]);
    if (merged.code !== 0) {
      restoreSnapshot(input.gitCommonDir, snapshot.id, holder);
      return {
        kind: "pending",
        cause: "conflicting-edits",
        reason: `Fast-forwarding ${input.baseBranch} was refused (${merged.stderr.slice(0, 200)}); the checkout was restored from snapshot ${snapshot.id}.`,
        files,
        snapshotId: snapshot.id,
      };
    }
    for (const edit of plan.reapply) {
      const next = git(holder, ["cat-file", "blob", `${newOid}:${edit.path}`]);
      // Their edit stays on top of the new commit unless it already equals it.
      if (next.stdout !== edit.merged.toString("utf8").trim()) {
        NodeFS.writeFileSync(NodePath.join(holder, edit.path), edit.merged);
      }
    }
    return { kind: "published", commit: newOid, snapshotId, reconciled: false };
  }

  const merged = git(holder, ["merge", "--ff-only", newOid]);
  if (merged.code !== 0) {
    return {
      kind: "pending",
      cause: "base-moved",
      reason: `Fast-forwarding ${input.baseBranch} at ${holder} was refused: ${merged.stderr.slice(0, 300)}`,
      files: [],
    };
  }
  return { kind: "published", commit: newOid, reconciled: false };
}

/**
 * Publish the plan's integration branch to the target branch. Safe to call repeatedly and
 * after a crash: a result the target already contains is recognised and recorded.
 */
export async function publishPlan(
  db: NodeSqlite.DatabaseSync,
  input: PublishInput,
): Promise<PublishOutcome> {
  const policy = input.policy ?? DEFAULT_PUBLISH_POLICY;
  const release = await acquireLandingLock(input.gitCommonDir);
  try {
    const goalRef = `refs/heads/${input.integrationBranch}`;
    const baseRef = `refs/heads/${input.baseBranch}`;
    let goalOid = git(input.repoRoot, ["rev-parse", goalRef]).stdout;
    const baseOid = git(input.repoRoot, ["rev-parse", baseRef]).stdout;
    if (!goalOid || !baseOid) {
      return {
        kind: "blocked",
        reason: `Branch ${!goalOid ? input.integrationBranch : input.baseBranch} is missing.`,
        files: [],
      };
    }

    // The target already has everything: an earlier attempt finished, or there is nothing new.
    if (git(input.repoRoot, ["merge-base", "--is-ancestor", goalOid, baseOid]).code === 0) {
      const changed = git(input.repoRoot, [
        "rev-list",
        "--count",
        `${input.integrationBranch}...${input.baseBranch}`,
      ]);
      setPublication(db, input.planId, "published", null, baseOid);
      recordEvent(db, input.planId, "plan_published", { commit: baseOid, reconciled: true });
      return changed.stdout === "0" && goalOid === baseOid
        ? { kind: "published", commit: baseOid, reconciled: true }
        : { kind: "published", commit: baseOid, reconciled: true };
    }

    // The target moved on its own: bring those commits into the integration branch first,
    // in the integration worktree, and verify the plan's final check on the result.
    if (git(input.repoRoot, ["merge-base", "--is-ancestor", baseOid, goalOid]).code !== 0) {
      const staging = prepareStagingWorktree(input.repoRoot, goalOid);
      const merge = git(staging, [
        ...IDENTITY,
        "merge",
        "--no-edit",
        "-m",
        `AgentQueue: bring ${input.baseBranch} into ${input.integrationBranch}`,
        baseOid,
      ]);
      if (merge.code !== 0) {
        const files = git(staging, ["diff", "--name-only", "--diff-filter=U"])
          .stdout.split("\n")
          .filter(Boolean);
        git(staging, ["merge", "--abort"]);
        const reason = `${input.baseBranch} changed independently and conflicts with the plan's result in: ${files.join(", ") || merge.stderr.slice(0, 200)}.`;
        setPublication(db, input.planId, "blocked", reason);
        return { kind: "blocked", reason, files };
      }
      const merged = git(staging, ["rev-parse", "HEAD"]).stdout;
      const finalCommand = (
        db.prepare("SELECT final_verification FROM plans WHERE id = ?").get(input.planId) as
          | { final_verification: string | null }
          | undefined
      )?.final_verification;
      if (finalCommand?.trim()) {
        const receipt = await runVerification("plan", staging, finalCommand, 900_000);
        if (!receipt.passed) {
          const reason = `After combining with ${input.baseBranch}, the plan's final check failed (exit ${receipt.exitCode}).`;
          setPublication(db, input.planId, "blocked", reason);
          return { kind: "blocked", reason, files: [] };
        }
      }
      const moved = git(input.repoRoot, [
        "update-ref",
        "-m",
        "AgentQueue: combine with target",
        goalRef,
        merged,
        goalOid,
      ]);
      if (moved.code !== 0) {
        return {
          kind: "pending",
          cause: "base-moved",
          reason: "The integration branch changed while combining; trying again.",
          files: [],
        };
      }
      goalOid = merged;
    }

    const holder = checkedOutAt(input.repoRoot, input.baseBranch);
    let outcome: PublishOutcome;
    if (!holder) {
      const update = git(input.repoRoot, [
        "update-ref",
        "-m",
        "AgentQueue: publish plan",
        baseRef,
        goalOid,
        baseOid,
      ]);
      outcome =
        update.code === 0
          ? { kind: "published", commit: goalOid, reconciled: false }
          : {
              kind: "pending",
              cause: "base-moved",
              reason: `${input.baseBranch} moved while publishing; trying again.`,
              files: [],
            };
    } else {
      outcome = promoteIntoCheckout(input, policy, holder, baseOid, goalOid);
    }

    if (outcome.kind === "published") {
      setPublication(
        db,
        input.planId,
        "published",
        outcome.snapshotId
          ? `Published after preserving abandoned edits in snapshot ${outcome.snapshotId}.`
          : null,
        goalOid,
      );
      recordEvent(db, input.planId, "plan_published", {
        commit: goalOid,
        snapshotId: outcome.snapshotId ?? null,
      });
    } else if (outcome.kind === "pending") {
      setPublication(db, input.planId, "pending", outcome.reason);
    }
    return outcome;
  } finally {
    release();
  }
}
