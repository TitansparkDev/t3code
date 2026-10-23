import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  REPO_CONTEXT_MAX_OUTPUT_CHARS,
  REPO_CONTEXT_MAX_READ_BYTES,
  REPO_CONTEXT_MAX_SEARCH_RESULTS,
  type RepoContextDirEntry,
  type RepoContextGitResult,
  type RepoContextGitView,
  type RepoContextListDirResult,
  type RepoContextReadFileResult,
  type RepoContextSearchMatch,
  type RepoContextSearchResult,
} from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";

const READ_FILE_MAX_SOURCE_BYTES = 5_000_000;
const READ_FILE_DEFAULT_LINES = 400;
const READ_FILE_MAX_LINES = 2_000;
const LIST_DIR_MAX_ENTRIES = 1_000;
const SEARCH_DEFAULT_RESULTS = 50;
const SEARCH_LINE_MAX_CHARS = 500;
const GIT_LOG_MAX_COMMITS = 50;
const GIT_DEFAULT_MAX_CHARS = 60_000;
const GIT_OUTPUT_BYTES_PER_CHAR = 4;
const GIT_REF_PATTERN = /^[\w.\/@^~-]+$/;

const REASON_MESSAGES = {
  target_not_found: "The project or worktree was not found. Use a worktree from t3_worktree_list.",
  path_outside_root: "The path is outside the project or worktree.",
  secret_path: "This file is excluded because it may hold secrets.",
  not_found: "The path does not exist.",
  not_a_file: "The path is not a file.",
  not_a_directory: "The path is not a directory.",
  binary_file: "The file is binary and cannot be shown as text.",
  file_too_large: "The file is too large to read.",
  invalid_ref: "The ref is not a valid git ref name.",
  invalid_glob: "The glob must be a plain relative pattern.",
  git_failed: "Git could not answer the request.",
  io_failed: "The file system could not answer the request.",
} as const;

export class RepoContextError extends Schema.TaggedError<RepoContextError>()("RepoContextError", {
  reason: Schema.Literals([
    "target_not_found",
    "path_outside_root",
    "secret_path",
    "not_found",
    "not_a_file",
    "not_a_directory",
    "binary_file",
    "file_too_large",
    "invalid_ref",
    "invalid_glob",
    "git_failed",
    "io_failed",
  ]),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return REASON_MESSAGES[this.reason];
  }
}

export interface RepoTarget {
  readonly workspaceRoot: string;
  readonly worktreePath?: string;
}

/**
 * Pathspecs git must skip when a read would show secret content (diffs and grep
 * hits can include files that the path checks alone never see).
 */
const SECRET_PATHSPEC_EXCLUDES = [
  ":(exclude,glob)**/.t3/**",
  ":(exclude,glob)**/secrets/**",
  ":(exclude,glob)**/.env",
  ":(exclude,glob)**/.env.*",
  ":(exclude,glob)**/*.pem",
  ":(exclude,glob)**/*.key",
  ":(exclude,glob)**/id_*",
];

const SECRET_DIRECTORY_NAMES = new Set([".git", ".t3", "secrets"]);

const isSecretRelativePath = (relativePath: string): boolean => {
  const parts = relativePath.split(/[\\/]/).filter((part) => part.length > 0);
  const name = parts.at(-1);
  if (parts.some((part) => SECRET_DIRECTORY_NAMES.has(part))) return true;
  if (name === undefined) return false;
  if (name === ".env.example") return false;
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name.endsWith(".pem") ||
    name.endsWith(".key") ||
    name.startsWith("id_")
  );
};

const toPosix = (relativePath: string) => relativePath.split("\\").join("/");

export class RepoContext extends Context.Service<
  RepoContext,
  {
    readonly listDir: (
      input: RepoTarget & { readonly path?: string },
    ) => Effect.Effect<RepoContextListDirResult, RepoContextError>;
    readonly readFile: (
      input: RepoTarget & {
        readonly path: string;
        readonly startLine?: number;
        readonly maxLines?: number;
      },
    ) => Effect.Effect<RepoContextReadFileResult, RepoContextError>;
    readonly search: (
      input: RepoTarget & {
        readonly query: string;
        readonly glob?: string;
        readonly regex?: boolean;
        readonly maxResults?: number;
      },
    ) => Effect.Effect<RepoContextSearchResult, RepoContextError>;
    readonly git: (
      input: RepoTarget & {
        readonly view: RepoContextGitView;
        readonly ref?: string;
        readonly path?: string;
        readonly maxChars?: number;
      },
    ) => Effect.Effect<RepoContextGitResult, RepoContextError>;
  }
>()("t3/workspace/RepoContext") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* VcsProcess.VcsProcess;

  const fail = (reason: RepoContextError["reason"], cause?: unknown) =>
    new RepoContextError({ reason, ...(cause === undefined ? {} : { cause }) });

  const realPath = (target: string, reason: RepoContextError["reason"]) =>
    fileSystem.realPath(target).pipe(Effect.mapError((cause) => fail(reason, cause)));

  const isWithin = (base: string, target: string) => {
    const relative = path.relative(base, target);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };

  const runGit = (cwd: string, args: ReadonlyArray<string>, maxOutputBytes?: number) =>
    vcs
      .run({
        operation: "RepoContext.git",
        command: "git",
        args,
        cwd,
        allowNonZeroExit: true,
        ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
      })
      .pipe(Effect.mapError((cause) => fail("git_failed", cause)));

  // Git is the source of truth for which checkouts belong to a project, so a
  // goal worker's worktree is included without a registry of its own.
  const worktreeRoots = Effect.fn("RepoContext.worktreeRoots")(
    function* (workspaceRoot: string) {
      const output = yield* vcs.run({
        operation: "RepoContext.worktrees",
        command: "git",
        args: ["worktree", "list", "--porcelain"],
        cwd: workspaceRoot,
      });
      const roots = output.stdout
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length));
      return yield* Effect.forEach(roots, (root) =>
        fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => undefined)),
      ).pipe(Effect.map((real) => real.filter((root): root is string => root !== undefined)));
    },
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

  const resolveBase = Effect.fn("RepoContext.resolveBase")(function* (target: RepoTarget) {
    const root = yield* realPath(target.workspaceRoot, "target_not_found");
    if (target.worktreePath === undefined) return root;
    const requested = yield* realPath(target.worktreePath, "target_not_found");
    const allowed = [root, ...(yield* worktreeRoots(root))];
    if (!allowed.includes(requested)) return yield* fail("target_not_found");
    return requested;
  });

  const resolveInside = Effect.fn("RepoContext.resolveInside")(function* (
    base: string,
    requested: string | undefined,
  ) {
    const relative = requested ?? ".";
    if (path.isAbsolute(relative)) return yield* fail("path_outside_root");
    const lexical = path.resolve(base, relative);
    if (!isWithin(base, lexical)) return yield* fail("path_outside_root");
    if (isSecretRelativePath(path.relative(base, lexical))) return yield* fail("secret_path");
    const real = yield* fileSystem
      .realPath(lexical)
      .pipe(Effect.mapError((cause) => fail("not_found", cause)));
    if (!isWithin(base, real)) return yield* fail("path_outside_root");
    const realRelative = path.relative(base, real);
    if (isSecretRelativePath(realRelative)) return yield* fail("secret_path");
    return {
      absolute: real,
      relative: realRelative === "" ? "." : toPosix(realRelative),
    };
  });

  const listDir: RepoContext["Service"]["listDir"] = Effect.fn("RepoContext.listDir")(
    function* (input) {
      const base = yield* resolveBase(input);
      const dir = yield* resolveInside(base, input.path);
      const info = yield* fileSystem
        .stat(dir.absolute)
        .pipe(Effect.mapError((cause) => fail("io_failed", cause)));
      if (info.type !== "Directory") return yield* fail("not_a_directory");
      const names = (yield* fileSystem
        .readDirectory(dir.absolute)
        .pipe(Effect.mapError((cause) => fail("io_failed", cause)))).toSorted();
      const entries: Array<RepoContextDirEntry> = [];
      let truncated = false;
      for (const name of names) {
        const childRelative = dir.relative === "." ? name : `${dir.relative}/${name}`;
        if (isSecretRelativePath(childRelative)) continue;
        if (entries.length >= LIST_DIR_MAX_ENTRIES) {
          truncated = true;
          break;
        }
        const childAbsolute = path.join(dir.absolute, name);
        const isLink = yield* fileSystem.readLink(childAbsolute).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        const childInfo = yield* fileSystem
          .stat(childAbsolute)
          .pipe(Effect.orElseSucceed(() => undefined));
        const kind = isLink
          ? "symlink"
          : childInfo?.type === "File"
            ? "file"
            : childInfo?.type === "Directory"
              ? "directory"
              : "other";
        entries.push({ name, path: childRelative, kind });
      }
      return { path: dir.relative, entries, truncated };
    },
  );

  const readFile: RepoContext["Service"]["readFile"] = Effect.fn("RepoContext.readFile")(
    function* (input) {
      const base = yield* resolveBase(input);
      const file = yield* resolveInside(base, input.path);
      const info = yield* fileSystem
        .stat(file.absolute)
        .pipe(Effect.mapError((cause) => fail("io_failed", cause)));
      if (info.type !== "File") return yield* fail("not_a_file");
      if (Number(info.size) > READ_FILE_MAX_SOURCE_BYTES) return yield* fail("file_too_large");
      const bytes = yield* fileSystem
        .readFile(file.absolute)
        .pipe(Effect.mapError((cause) => fail("io_failed", cause)));
      if (bytes.subarray(0, 8_000).includes(0)) return yield* fail("binary_file");
      const text = new TextDecoder().decode(bytes);
      const lines = text.split("\n");
      const totalLines = text.endsWith("\n") ? lines.length - 1 : lines.length;
      const startLine = Math.max(1, input.startLine ?? 1);
      const maxLines = Math.min(input.maxLines ?? READ_FILE_DEFAULT_LINES, READ_FILE_MAX_LINES);
      let content = lines.slice(startLine - 1, startLine - 1 + maxLines).join("\n");
      let truncated = startLine - 1 + maxLines < totalLines;
      let endLine = Math.min(totalLines, startLine - 1 + maxLines);
      const encoded = new TextEncoder().encode(content);
      if (encoded.byteLength > REPO_CONTEXT_MAX_READ_BYTES) {
        content = new TextDecoder().decode(encoded.subarray(0, REPO_CONTEXT_MAX_READ_BYTES));
        truncated = true;
        endLine = startLine - 1 + content.split("\n").length;
      }
      return {
        path: file.relative,
        content,
        startLine,
        endLine,
        totalLines,
        truncated,
      };
    },
  );

  const search: RepoContext["Service"]["search"] = Effect.fn("RepoContext.search")(
    function* (input) {
      const base = yield* resolveBase(input);
      if (input.glob !== undefined && (input.glob.startsWith("-") || input.glob.includes(":")))
        return yield* fail("invalid_glob");
      const limit = Math.min(
        input.maxResults ?? SEARCH_DEFAULT_RESULTS,
        REPO_CONTEXT_MAX_SEARCH_RESULTS,
      );
      const args = [
        "grep",
        "-n",
        "-I",
        "-z",
        "--no-color",
        "--untracked",
        input.regex === true ? "-E" : "-F",
        "-e",
        input.query,
        "--",
        ".",
        ...(input.glob === undefined ? [] : [`:(glob)${input.glob}`]),
        ...SECRET_PATHSPEC_EXCLUDES,
      ];
      const output = yield* runGit(
        base,
        args,
        REPO_CONTEXT_MAX_OUTPUT_CHARS * GIT_OUTPUT_BYTES_PER_CHAR,
      );
      // git grep exits 1 for no matches; anything else is a failed search.
      if (Number(output.exitCode) > 1) return yield* fail("git_failed");
      const matches: Array<RepoContextSearchMatch> = [];
      let truncated = output.stdoutTruncated;
      for (const record of output.stdout.split("\n")) {
        if (record.length === 0) continue;
        const [file, lineText, ...rest] = record.split("\0");
        if (file === undefined || lineText === undefined || isSecretRelativePath(file)) continue;
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
        matches.push({
          path: toPosix(file),
          line: Number(lineText),
          text: rest.join("\0").slice(0, SEARCH_LINE_MAX_CHARS),
        });
      }
      return { matches, truncated };
    },
  );

  const git: RepoContext["Service"]["git"] = Effect.fn("RepoContext.git")(function* (input) {
    const base = yield* resolveBase(input);
    if (input.ref !== undefined && (input.ref.startsWith("-") || !GIT_REF_PATTERN.test(input.ref)))
      return yield* fail("invalid_ref");
    const maxChars = Math.min(
      input.maxChars ?? GIT_DEFAULT_MAX_CHARS,
      REPO_CONTEXT_MAX_OUTPUT_CHARS,
    );
    const file = input.path === undefined ? undefined : yield* resolveInside(base, input.path);
    const pathArgs = file === undefined ? [] : ["--", file.relative];
    const scopedPathArgs = file === undefined ? ["--", ".", ...SECRET_PATHSPEC_EXCLUDES] : pathArgs;
    const args = ((): ReadonlyArray<string> => {
      switch (input.view) {
        case "status":
          return ["status", "--short", "--branch", ...pathArgs];
        case "log":
          return [
            "log",
            "--oneline",
            "--decorate",
            `--max-count=${GIT_LOG_MAX_COMMITS}`,
            input.ref ?? "HEAD",
            ...pathArgs,
          ];
        case "diff":
          return ["diff", "--no-color", input.ref ?? "HEAD", ...scopedPathArgs];
        case "show":
          return [
            "show",
            "--no-color",
            "--stat",
            "--patch",
            input.ref ?? "HEAD",
            ...scopedPathArgs,
          ];
        case "branches":
          return ["branch", "--all", "--verbose", "--no-color"];
      }
    })();
    const output = yield* runGit(base, args, maxChars * GIT_OUTPUT_BYTES_PER_CHAR);
    if (Number(output.exitCode) !== 0) return yield* fail("git_failed");
    return {
      view: input.view,
      output: output.stdout.slice(0, maxChars),
      truncated: output.stdoutTruncated || output.stdout.length > maxChars,
    };
  });

  return RepoContext.of({ listDir, readFile, search, git });
});

export const layer = Layer.effect(RepoContext, make).pipe(Layer.provide(VcsProcess.layer));
