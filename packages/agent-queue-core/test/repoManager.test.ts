// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  initRepo,
  doctorRepo,
  assessRepoOnboarding,
  generateOnboardingManifest,
  cutoverRepo,
} from "../src/repoManager.ts";
import { createTestGitRepo } from "./harness/gitHarness.ts";

describe("Phase 7: Repository Onboarding & Integration (AQ-051 - AQ-057, Gate G7)", () => {
  it("initializes and diagnoses a git repository idempotently (AQ-051)", async () => {
    const repo = await createTestGitRepo("repo-init-test-");
    try {
      // 1. Initial init
      const init1 = initRepo(repo.rootDir);
      expect(init1.gitCommonDir).toBe(repo.gitCommonDir);
      expect(NodeFS.existsSync(init1.dbPath)).toBe(true);

      // 2. Doctor reports healthy
      const doc1 = doctorRepo(repo.rootDir);
      expect(doc1.healthy).toBe(true);
      expect(doc1.checks.isGitRepo.ok).toBe(true);
      expect(doc1.checks.dbIntegrity.ok).toBe(true);
      expect(doc1.checks.legacyLockClear.ok).toBe(true);

      // 3. Repeated init is a safe no-op
      const init2 = initRepo(repo.rootDir);
      expect(init2.dbPath).toBe(init1.dbPath);

      // 4. If legacy lock file exists, doctor reports failure
      const legacyLock = NodePath.join(repo.gitCommonDir, "plan-work-landing.lock");
      NodeFS.writeFileSync(legacyLock, "active-lock");
      const doc2 = doctorRepo(repo.rootDir);
      expect(doc2.healthy).toBe(false);
      expect(doc2.checks.legacyLockClear.ok).toBe(false);
      NodeFS.unlinkSync(legacyLock);
    } finally {
      await repo.cleanup();
    }
  });

  it("assesses repositories and generates accurate onboarding manifests (AQ-052, AQ-053)", async () => {
    const repo = await createTestGitRepo("repo-manifest-test-");
    try {
      // Clean repo -> safe_to_register
      const a1 = assessRepoOnboarding(repo.rootDir);
      expect(a1.classification).toBe("safe_to_register");
      expect(a1.activePlanWorkClaims).toBe(0);

      // Add PLAN.md and dirty uncommitted file -> safe_to_import_only
      NodeFS.writeFileSync(NodePath.join(repo.rootDir, "PLAN.md"), "# Project Plan\n");
      NodeFS.writeFileSync(NodePath.join(repo.rootDir, "dirty.txt"), "uncommitted");
      const a2 = assessRepoOnboarding(repo.rootDir);
      expect(a2.classification).toBe("safe_to_import_only");
      expect(a2.hasPlanFile).toBe(true);
      expect(a2.hasDirtyWorkingTree).toBe(true);

      // Add legacy lock -> defer_active_plan
      const legacyLock = NodePath.join(repo.gitCommonDir, "plan-work-landing.lock");
      NodeFS.writeFileSync(legacyLock, "active-claim");
      const a3 = assessRepoOnboarding(repo.rootDir);
      expect(a3.classification).toBe("defer_active_plan");
      NodeFS.unlinkSync(legacyLock);

      // Manifest generation over multiple targets
      const manifest = generateOnboardingManifest([repo.rootDir, "/tmp/non-existent-repo-path"]);
      expect(manifest.length).toBe(2);
      expect(manifest[0].repoPath).toBe(repo.rootDir);
      expect(manifest[1].classification).toBe("incompatible");
    } finally {
      await repo.cleanup();
    }
  });

  it("guards cutover against active plan-work claims and allows eligible repos (AQ-057)", async () => {
    const repo = await createTestGitRepo("repo-cutover-test-");
    try {
      // Simulate active claim via legacy lock
      const legacyLock = NodePath.join(repo.gitCommonDir, "plan-work-landing.lock");
      NodeFS.writeFileSync(legacyLock, "active-lock");

      // Cutover must be rejected
      const res1 = cutoverRepo(repo.rootDir);
      expect(res1.success).toBe(false);
      expect(res1.message).toContain("Cutover rejected");

      // Remove lock: now cutover succeeds
      NodeFS.unlinkSync(legacyLock);
      const res2 = cutoverRepo(repo.rootDir);
      expect(res2.success).toBe(true);
      expect(res2.message).toContain("Successfully initialized");
    } finally {
      await repo.cleanup();
    }
  });
});
