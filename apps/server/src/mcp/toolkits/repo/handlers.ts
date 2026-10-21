import { OrchestratorMcpFailure, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as RepoContext from "../../../workspace/RepoContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { RepoToolkit } from "./tools.ts";

const workspaceRootOf = Effect.fn("mcp.repo.workspaceRootOf")(function* (projectId: ProjectId) {
  yield* readCaller();
  const projects = yield* ProjectService.ProjectService;
  const project = yield* projects.getById(projectId).pipe(Effect.mapError(unavailable));
  if (Option.isNone(project))
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The project was not found.",
    });
  return project.value.workspaceRoot;
});

/** Drops keys an optional MCP field left unset, so exactOptionalPropertyTypes accepts the call. */
const defined = <T extends object>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };

const repoFailure = (error: RepoContext.RepoContextError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "git_failed" || error.reason === "io_failed"
        ? "orchestration_error"
        : "invalid_request",
    message: error.message,
  });

export const layer = McpToolAccess.toLayer(RepoToolkit, {
  t3_repo_list_dir: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* workspaceRootOf(input.projectId);
      const repo = yield* RepoContext.RepoContext;
      return yield* repo
        .listDir({
          workspaceRoot,
          ...defined({ worktreePath: input.worktreePath, path: input.path }),
        })
        .pipe(Effect.mapError(repoFailure));
    }),
  ),
  t3_repo_read_file: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* workspaceRootOf(input.projectId);
      const repo = yield* RepoContext.RepoContext;
      return yield* repo
        .readFile({
          workspaceRoot,
          path: input.path,
          ...defined({
            worktreePath: input.worktreePath,
            startLine: input.startLine,
            maxLines: input.maxLines,
          }),
        })
        .pipe(Effect.mapError(repoFailure));
    }),
  ),
  t3_repo_search: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* workspaceRootOf(input.projectId);
      const repo = yield* RepoContext.RepoContext;
      return yield* repo
        .search({
          workspaceRoot,
          query: input.query,
          ...defined({
            worktreePath: input.worktreePath,
            glob: input.glob,
            regex: input.regex,
            maxResults: input.maxResults,
          }),
        })
        .pipe(Effect.mapError(repoFailure));
    }),
  ),
  t3_repo_git: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* workspaceRootOf(input.projectId);
      const repo = yield* RepoContext.RepoContext;
      return yield* repo
        .git({
          workspaceRoot,
          view: input.view,
          ...defined({
            worktreePath: input.worktreePath,
            ref: input.ref,
            path: input.path,
            maxChars: input.maxChars,
          }),
        })
        .pipe(Effect.mapError(repoFailure));
    }),
  ),
});
