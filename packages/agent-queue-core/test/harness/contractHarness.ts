// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/** Real git repositories with real guard scripts, plans and queue, for the execution-contract tests. */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { openQueueDatabase } from "../../src/db.ts";
import {
  ensureIntegrationBranch,
  integrateCandidate,
  integrationBranchFor,
  submitCandidate,
} from "../../src/integration.ts";
import { importPlanFile } from "../../src/planImport.ts";
import { reserveNextTask } from "../../src/reservation.ts";
import { createTestGitRepo, execCommand } from "./gitHarness.ts";

export const guardScript = (
  prefixes: string[],
  extra = "",
) => `import { execFileSync } from "node:child_process";
const branch = execFileSync("git", ["branch", "--show-current"]).toString().trim();
if (${prefixes.map((p) => `!branch.startsWith("${p}")`).join(" && ")}) {
  console.error("ERROR: refusing to work outside an isolated agent branch; current branch is " + branch);
  process.exit(1);
}
${extra}
`;

export interface RepoOptions {
  readonly plan: string;
  readonly prefixes?: string[];
  readonly contract?: object | null;
  readonly agents?: string;
  readonly files?: Record<string, string>;
}

export async function makeRepo(options: RepoOptions) {
  const repo = await createTestGitRepo("aq-contract-");
  const write = async (file: string, content: string) => {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(repo.rootDir, file)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(repo.rootDir, file), content);
  };
  await write("PLAN.md", options.plan);
  await write("tools/guard.mjs", guardScript(options.prefixes ?? ["agent/"]));
  await write(
    "AGENTS.md",
    options.agents ??
      "# Rules\n\nEvery automated worker must run `node tools/guard.mjs` (the checkout guard) before its first repository write.\n",
  );
  if (options.contract) await write(".agentqueue/contract.json", JSON.stringify(options.contract));
  for (const [file, content] of Object.entries(options.files ?? {})) await write(file, content);
  await execCommand("git", ["add", "-A"], repo.rootDir);
  await execCommand("git", ["commit", "-m", "init"], repo.rootDir);
  const { planId } = importPlanFile(repo.rootDir, "PLAN.md");
  const goal = integrationBranchFor(planId);
  ensureIntegrationBranch(repo.rootDir, "main", goal);
  const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
  db.prepare("UPDATE plans SET integration_branch = ?, base_branch = 'main' WHERE id = ?").run(
    goal,
    planId,
  );
  const reserve = (worker = "w") =>
    reserveNextTask(db, {
      repoRoot: repo.rootDir,
      baseBranch: goal,
      targetBranch: "main",
      gitCommonDir: repo.gitCommonDir,
      planId,
      workerSessionId: worker,
      isOwnerAlive: () => false,
    });
  const commitFile = async (cwd: string, file: string, content: string) => {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(cwd, file)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(cwd, file), content);
    await execCommand("git", ["add", "-A"], cwd);
    await execCommand("git", ["commit", "-m", `work ${file}`], cwd);
  };
  const task = (id: string) =>
    db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, any>;
  const submit = (
    t: { taskId: string; claimToken: string; worktreePath: string; branch: string },
    scopeRequests?: Array<{ paths: string[]; reason: string }>,
  ) =>
    submitCandidate(db, {
      repoRoot: repo.rootDir,
      gitCommonDir: repo.gitCommonDir,
      baseBranch: goal,
      targetBranch: "main",
      taskId: t.taskId,
      claimToken: t.claimToken,
      worktreePath: t.worktreePath,
      branch: t.branch,
      verificationCommand: "",
      ...(scopeRequests ? { scopeRequests } : {}),
    });
  const integrate = (taskId: string) =>
    integrateCandidate(db, {
      repoRoot: repo.rootDir,
      gitCommonDir: repo.gitCommonDir,
      baseBranch: "main",
      integrationBranch: goal,
      taskId,
    });
  const commitOnMain = async (file: string, content: string) => {
    await write(file, content);
    await execCommand("git", ["add", "-A"], repo.rootDir);
    await execCommand("git", ["commit", "-m", `main: ${file}`], repo.rootDir);
  };
  return {
    repo,
    db,
    planId,
    goal,
    reserve,
    commitFile,
    task,
    submit,
    integrate,
    write,
    commitOnMain,
  };
}

export const PASS = 'node -e "process.exit(0)"';
export const plan = (
  tasks: Array<{ id: string; title?: string; deps?: string[]; scope?: string; verify?: string }>,
) =>
  [
    "# Plan",
    "",
    ...tasks.flatMap((t) => [
      `- [ ] **${t.id} — ${t.title ?? `Task ${t.id}`}.**`,
      `  - Depends on: ${t.deps?.length ? t.deps.join(", ") : "none"}.`,
      ...(t.scope ? [`  - Scope: ${t.scope}.`] : []),
      `  - Verify: \`${t.verify ?? PASS}\``,
      "",
    ]),
  ].join("\n");

export const tmpDir = (prefix: string) => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
