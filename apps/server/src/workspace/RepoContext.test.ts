import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as RepoContext from "./RepoContext.ts";

const layerLive = Layer.mergeAll(RepoContext.layer, VcsProcess.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const withFixture = <A, E, R>(
  body: (fixture: { readonly root: string; readonly wt: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const vcs = yield* VcsProcess.VcsProcess;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "repo-context-" });
    const wt = yield* fileSystem.makeTempDirectoryScoped({ prefix: "repo-context-wt-" });
    const git = (cwd: string, ...args: ReadonlyArray<string>) =>
      vcs
        .run({ operation: "test.git", command: "git", args, cwd })
        .pipe(
          Effect.flatMap((output) =>
            Number(output.exitCode) === 0
              ? Effect.succeed(output.stdout)
              : Effect.die(output.stderr),
          ),
        );
    const write = (relative: string, contents: string) =>
      Effect.gen(function* () {
        const target = path.join(root, relative);
        yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
        yield* fileSystem.writeFileString(target, contents);
      });

    yield* git(root, "init", "-q", "-b", "main");
    yield* write("src/app.ts", "export const a = 1;\nconst needle = 2;\n");
    yield* write(".env", "TOKEN=hunter2\nneedle=secret\n");
    yield* write(".env.example", "TOKEN=\n");
    yield* git(root, "add", "-A");
    yield* git(
      root,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "-m",
      "init",
    );
    yield* write("src/new.ts", "// needle untracked\n");
    yield* git(root, "worktree", "add", "-q", "-b", "goal", wt);
    yield* fileSystem.writeFileString(path.join(wt, "unpushed.txt"), "local work\n");
    yield* git(wt, "add", "-A");
    yield* git(
      wt,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "-m",
      "unpushed",
    );
    return yield* body({ root, wt });
  });

it.layer(layerLive)("RepoContext", (it) => {
  it.effect("lists directories and reads line ranges, hiding secret entries", () =>
    withFixture(({ root }) =>
      Effect.gen(function* () {
        const repo = yield* RepoContext.RepoContext;
        const listing = yield* repo.listDir({ workspaceRoot: root });
        const names = listing.entries.map((entry) => entry.name);
        expect(names).toContain("src");
        expect(names).not.toContain(".env");

        const file = yield* repo.readFile({
          workspaceRoot: root,
          path: "src/app.ts",
          startLine: 1,
          maxLines: 1,
        });
        expect(file.content).toBe("export const a = 1;");
        expect(file.totalLines).toBe(2);
        expect(file.truncated).toBe(true);
      }),
    ),
  );

  it.effect("searches tracked and untracked files but never secret files", () =>
    withFixture(({ root }) =>
      Effect.gen(function* () {
        const repo = yield* RepoContext.RepoContext;
        const result = yield* repo.search({ workspaceRoot: root, query: "needle" });
        const paths = result.matches.map((match) => match.path).toSorted();
        expect(paths).toEqual(["src/app.ts", "src/new.ts"]);
      }),
    ),
  );

  it.effect("refuses paths that leave the root, including through symlinks", () =>
    withFixture(({ root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "repo-context-out-" });
        yield* fileSystem.writeFileString(path.join(outside, "note.txt"), "outside\n");
        yield* fileSystem.symlink(path.join(outside, "note.txt"), path.join(root, "escape.txt"));
        const repo = yield* RepoContext.RepoContext;
        for (const requested of ["../outside", path.join(outside, "note.txt"), "escape.txt"]) {
          const error = yield* repo
            .readFile({ workspaceRoot: root, path: requested })
            .pipe(Effect.flip);
          expect(error.reason).toBe("path_outside_root");
        }
      }),
    ),
  );

  it.effect("refuses secret paths for reads and listings", () =>
    withFixture(({ root }) =>
      Effect.gen(function* () {
        const repo = yield* RepoContext.RepoContext;
        for (const requested of [
          ".env",
          ".env.local",
          "keys/server.pem",
          "id_rsa",
          ".git/config",
          "secrets/token.txt",
          ".t3/state.sqlite",
        ]) {
          const error = yield* repo
            .readFile({ workspaceRoot: root, path: requested })
            .pipe(Effect.flip);
          expect(error.reason).toBe("secret_path");
        }
        const example = yield* repo.readFile({ workspaceRoot: root, path: ".env.example" });
        expect(example.content).toBe("TOKEN=\n");
        const error = yield* repo.listDir({ workspaceRoot: root, path: ".git" }).pipe(Effect.flip);
        expect(error.reason).toBe("secret_path");
      }),
    ),
  );

  it.effect("reports git status, diffs, and unpushed commits in a worktree", () =>
    withFixture(({ root, wt }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repo = yield* RepoContext.RepoContext;
        yield* fileSystem.writeFileString(path.join(root, "src/app.ts"), "export const a = 9;\n");

        const status = yield* repo.git({ workspaceRoot: root, view: "status" });
        expect(status.output).toContain("M src/app.ts");

        const diff = yield* repo.git({ workspaceRoot: root, view: "diff" });
        expect(diff.output).toContain("+export const a = 9;");

        const unpushed = yield* repo.git({
          workspaceRoot: root,
          worktreePath: wt,
          view: "diff",
          ref: "main...HEAD",
        });
        expect(unpushed.output).toContain("unpushed.txt");

        const error = yield* repo
          .git({ workspaceRoot: root, view: "log", ref: "--output=/tmp/x" })
          .pipe(Effect.flip);
        expect(error.reason).toBe("invalid_ref");
      }),
    ),
  );

  it.effect("refuses a worktreePath that is not a checkout of the project", () =>
    withFixture(({ root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const stranger = yield* fileSystem.makeTempDirectoryScoped({ prefix: "repo-context-x-" });
        const repo = yield* RepoContext.RepoContext;
        const error = yield* repo
          .listDir({ workspaceRoot: root, worktreePath: stranger })
          .pipe(Effect.flip);
        expect(error.reason).toBe("target_not_found");
      }),
    ),
  );
});
