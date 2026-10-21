import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const REPO_CONTEXT_MAX_READ_BYTES = 200_000;
export const REPO_CONTEXT_MAX_SEARCH_RESULTS = 200;
export const REPO_CONTEXT_MAX_OUTPUT_CHARS = 200_000;

export const RepoContextDirEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  path: Schema.String,
  kind: Schema.Literals(["file", "directory", "symlink", "other"]),
});
export type RepoContextDirEntry = typeof RepoContextDirEntry.Type;

export const RepoContextListDirResult = Schema.Struct({
  path: Schema.String,
  entries: Schema.Array(RepoContextDirEntry),
  truncated: Schema.Boolean,
});
export type RepoContextListDirResult = typeof RepoContextListDirResult.Type;

export const RepoContextReadFileResult = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  startLine: PositiveInt,
  endLine: NonNegativeInt,
  totalLines: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type RepoContextReadFileResult = typeof RepoContextReadFileResult.Type;

export const RepoContextSearchMatch = Schema.Struct({
  path: Schema.String,
  line: PositiveInt,
  text: Schema.String,
});
export type RepoContextSearchMatch = typeof RepoContextSearchMatch.Type;

export const RepoContextSearchResult = Schema.Struct({
  matches: Schema.Array(RepoContextSearchMatch),
  truncated: Schema.Boolean,
});
export type RepoContextSearchResult = typeof RepoContextSearchResult.Type;

export const RepoContextGitView = Schema.Literals(["status", "log", "diff", "show", "branches"]);
export type RepoContextGitView = typeof RepoContextGitView.Type;

export const RepoContextGitResult = Schema.Struct({
  view: RepoContextGitView,
  output: Schema.String,
  truncated: Schema.Boolean,
});
export type RepoContextGitResult = typeof RepoContextGitResult.Type;
