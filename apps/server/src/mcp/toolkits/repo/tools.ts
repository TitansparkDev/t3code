import {
  OrchestratorMcpFailure,
  PositiveInt,
  ProjectId,
  REPO_CONTEXT_MAX_OUTPUT_CHARS,
  REPO_CONTEXT_MAX_SEARCH_RESULTS,
  RepoContextGitResult,
  RepoContextGitView,
  RepoContextListDirResult,
  RepoContextReadFileResult,
  RepoContextSearchResult,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as RepoContext from "../../../workspace/RepoContext.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    RepoContext.RepoContext,
  ],
};

/** A project's workspace, or one of its git worktrees (goal worker checkouts included). */
const repoTargetFields = {
  projectId: ProjectId,
  worktreePath: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Absolute path of a git worktree of this project, from t3_worktree_list. Omit for the project's workspace root.",
    }),
  ),
};

const ListDirTool = Tool.make("t3_repo_list_dir", {
  ...shared,
  success: RepoContextListDirResult,
  description:
    "List one directory of a project or its worktree, read-only. Secret paths (.env, keys, .git, secrets/, .t3/) are hidden. Works for unpushed local work in a worktree.",
  parameters: Schema.Struct({
    ...repoTargetFields,
    path: Schema.optional(Schema.String.annotate({ description: "Relative directory path." })),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ReadFileTool = Tool.make("t3_repo_read_file", {
  ...shared,
  success: RepoContextReadFileResult,
  description:
    "Read a text file from a project or its worktree, read-only, by line range. Output is capped (about 200 KB); check truncated and use startLine to continue. Secret files are refused.",
  parameters: Schema.Struct({
    ...repoTargetFields,
    path: TrimmedNonEmptyString,
    startLine: Schema.optional(PositiveInt),
    maxLines: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2000 }))),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const SearchTool = Tool.make("t3_repo_search", {
  ...shared,
  success: RepoContextSearchResult,
  description:
    "Search file contents in a project or its worktree with git grep (tracked and untracked, not ignored files). Fixed-string by default; set regex for extended regular expressions. Secret files are excluded.",
  parameters: Schema.Struct({
    ...repoTargetFields,
    query: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
    glob: Schema.optional(
      Schema.String.check(Schema.isMaxLength(256)).annotate({
        description: "Optional pathspec glob, e.g. apps/server/**/*.ts.",
      }),
    ),
    regex: Schema.optional(Schema.Boolean),
    maxResults: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: REPO_CONTEXT_MAX_SEARCH_RESULTS })),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const GitTool = Tool.make("t3_repo_git", {
  ...shared,
  success: RepoContextGitResult,
  description:
    "Read git state of a project or its worktree: status, log (HEAD or ref), diff (uncommitted vs HEAD, or ref such as main...HEAD for unpushed commits), show (a commit, default HEAD), or branches. Read-only; fixed git commands only. Use the worktree's path to inspect a goal worker's unpushed commits.",
  parameters: Schema.Struct({
    ...repoTargetFields,
    view: RepoContextGitView,
    ref: Schema.optional(
      Schema.String.check(Schema.isMaxLength(255)).annotate({
        description:
          "Branch, tag, commit, or range such as main...HEAD. Ignored by status and branches.",
      }),
    ),
    path: Schema.optional(Schema.String),
    maxChars: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: REPO_CONTEXT_MAX_OUTPUT_CHARS })),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const RepoToolkit = Toolkit.make(ListDirTool, ReadFileTool, SearchTool, GitTool);
