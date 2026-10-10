// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

export interface GitContext {
  readonly rootDir: string;
  readonly gitCommonDir: string;
}

export function resolveGitContext(cwd: string = process.cwd()): GitContext {
  try {
    const commonDirRaw = NodeChildProcess.execSync("git rev-parse --git-common-dir", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const rootDirRaw = NodeChildProcess.execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    const gitCommonDir = NodePath.isAbsolute(commonDirRaw)
      ? commonDirRaw
      : NodePath.resolve(cwd, commonDirRaw);

    return {
      rootDir: rootDirRaw,
      gitCommonDir,
    };
  } catch (err) {
    throw new Error(`Current directory (${cwd}) is not inside a Git repository.`, { cause: err });
  }
}
