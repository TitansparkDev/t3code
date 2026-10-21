#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalConsole:off - a standalone release smoke script run with plain node.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_FOR_SEA = "26.8.2";
const COMMAND_TIMEOUT_MS = 15 * 60_000;

type Candidate = {
  readonly version: string;
  readonly revision: string;
  readonly archive: string;
  readonly sha256: string;
};

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function candidateDirectory(root: string, version: string, revision: string): string {
  return join(root, "candidates", `${version}-${revision}`);
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? process.env,
      stdio: "inherit",
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), COMMAND_TIMEOUT_MS);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code ?? signal}`));
    });
  });
}

async function gitRevision(): Promise<string> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("git", ["rev-parse", "HEAD"], { cwd: ROOT });
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolvePromise() : reject(new Error("git rev-parse failed")),
    );
  });
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function assertCleanCheckout(): Promise<void> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd: ROOT,
    });
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolvePromise() : reject(new Error("git status failed")),
    );
  });
  const status = Buffer.concat(chunks).toString("utf8").trim();
  if (status)
    throw new Error(`Build from a clean committed revision so provenance is exact:\n${status}`);
}

async function readCandidate(directory: string): Promise<Candidate | undefined> {
  try {
    const candidate = JSON.parse(
      await readFile(join(directory, "candidate.json"), "utf8"),
    ) as Candidate;
    const archivePath = join(directory, candidate.archive);
    const digest = sha256(await readFile(archivePath));
    const checksums = (await readFile(join(directory, "SHA256SUMS"), "utf8")).trim();
    if (digest !== candidate.sha256 || checksums !== `${digest}  ${candidate.archive}`)
      return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

async function main() {
  await assertCleanCheckout();
  const tempRoot = resolve(process.env.TMPDIR ?? "/tmp");
  const artifactRoot = join(tempRoot, "reliability-artifact-smoke");
  const revision = await gitRevision();
  const server = JSON.parse(await readFile(join(ROOT, "apps/server/package.json"), "utf8")) as {
    version: string;
  };
  const version = server.version;
  const platform =
    process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
  if (!arch || (platform === "mac" && arch !== "arm64")) {
    throw new Error(
      `The CLI archive does not support this smoke-test host (${process.platform}/${process.arch}).`,
    );
  }

  const candidateDir = candidateDirectory(artifactRoot, version, revision);
  const archiveName = `t3-${version}-${process.platform}-${arch}.${platform === "win" ? "zip" : "tar.gz"}`;
  const archivePath = join(candidateDir, archiveName);
  const env = {
    ...process.env,
    TMPDIR: tempRoot,
    VP_NODE_VERSION: NODE_FOR_SEA,
  };
  await mkdir(candidateDir, { recursive: true });

  let candidate = await readCandidate(candidateDir);
  if (!candidate) {
    await rm(join(candidateDir, "SHA256SUMS"), { force: true });
    await rm(join(candidateDir, "candidate.json"), { force: true });
    // Vite Plus caches these build tasks by their inputs; the archive itself is
    // revision-scoped so a retry reuses a complete candidate without clobbering
    // the previous one.
    await run("vp", ["run", "--filter", "@t3tools/web", "build"], { env });
    await run("vp", ["run", "build:resource-monitor"], { env });
    await run("node", ["apps/server/scripts/cli.ts", "build"], { env });
    await run("node", ["apps/server/scripts/cli.ts", "build-exe"], { env });

    const monitorTarget = join(ROOT, "native/resource-monitor/target/release");
    const monitorName = `t3-resource-monitor${platform === "win" ? ".exe" : ""}`;
    const monitorSource = join(monitorTarget, monitorName);
    const monitorDir = join(candidateDir, "resource-monitor");
    await mkdir(monitorDir, { recursive: true });
    await cp(monitorSource, join(monitorDir, monitorName));

    await run(
      "node",
      [
        "scripts/build-cli-archive.ts",
        "--platform",
        platform,
        "--arch",
        arch,
        "--version",
        version,
        "--output-dir",
        candidateDir,
        "--resource-monitor-dir",
        monitorDir,
      ],
      { env },
    );

    const entries = await readdir(candidateDir);
    const archive = entries.find((entry) => entry === archiveName);
    if (!archive) throw new Error(`Archive builder did not produce ${archiveName}.`);
    const digest = sha256(await readFile(join(candidateDir, archive)));
    const sums = `${digest}  ${archive}\n`;
    await writeFile(join(candidateDir, "SHA256SUMS"), sums, { flag: "wx" });
    candidate = { version, revision, archive, sha256: digest };
    await writeFile(
      join(candidateDir, "candidate.json"),
      `${JSON.stringify(candidate, null, 2)}\n`,
      { flag: "wx" },
    );
  }

  if (
    candidate.version !== version ||
    candidate.revision !== revision ||
    candidate.archive !== archiveName
  ) {
    throw new Error("Candidate metadata does not match the current version and revision.");
  }
  const checksums = (await readFile(join(candidateDir, "SHA256SUMS"), "utf8")).trim();
  if (checksums !== `${candidate.sha256}  ${candidate.archive}`) {
    throw new Error("SHA256SUMS does not match candidate provenance.");
  }
  const archiveBytes = await readFile(archivePath);
  if (sha256(archiveBytes) !== candidate.sha256 || (await stat(archivePath)).size === 0) {
    throw new Error("Candidate archive checksum or size is invalid.");
  }

  const portBase = process.env.AGENTQUEUE_PORT_BASE;
  if (!portBase)
    throw new Error("AGENTQUEUE_PORT_BASE must be set to the task's reserved port range.");
  const smoke = (archive: string, expectedVersion: string) =>
    run(
      "node",
      ["scripts/smoke-cli-archive.ts", "--archive", archive, "--expect-version", expectedVersion],
      { env: { ...env, AGENTQUEUE_PORT_BASE: portBase } },
    );
  await smoke(archivePath, version);

  // Preserve the prior verified candidate as the rollback target before
  // advancing current.json. Candidate directories are never removed.
  const currentPath = join(artifactRoot, "current.json");
  const previousPath = join(artifactRoot, "previous.json");
  let rollback: (Candidate & { directory: string }) | undefined;
  try {
    const previous = JSON.parse(await readFile(currentPath, "utf8")) as Candidate & {
      directory: string;
    };
    const previousCandidate = await readCandidate(previous.directory);
    if (previousCandidate?.sha256 === previous.sha256 && previous.revision !== revision) {
      rollback = previous;
    }
  } catch {
    // A first candidate has no current pointer yet.
  }
  if (!rollback) {
    const candidatesRoot = join(artifactRoot, "candidates");
    const directories = await readdir(candidatesRoot, { withFileTypes: true });
    const existing = await Promise.all(
      directories
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => ({
          directory: join(candidatesRoot, entry.name),
          modified: (await stat(join(candidatesRoot, entry.name))).mtimeMs,
        })),
    );
    existing.sort((left, right) => right.modified - left.modified);
    for (const entry of existing) {
      const prior = await readCandidate(entry.directory);
      if (prior && prior.revision !== revision && prior.version === version) {
        rollback = { ...prior, directory: entry.directory };
        break;
      }
    }
  }
  if (rollback) {
    // Re-smoke an older local archive before declaring it a rollback target;
    // interrupted or incomplete attempts are never promoted by metadata alone.
    await smoke(join(rollback.directory, rollback.archive), rollback.version);
    await writeFile(previousPath, `${JSON.stringify(rollback, null, 2)}\n`);
  }
  await writeFile(
    currentPath,
    `${JSON.stringify({ ...candidate, directory: candidateDir }, null, 2)}\n`,
  );
  if (rollback) {
    const savedRollback = JSON.parse(await readFile(previousPath, "utf8")) as Candidate & {
      directory: string;
    };
    if ((await readCandidate(savedRollback.directory))?.sha256 !== savedRollback.sha256) {
      throw new Error("Previous candidate is no longer available for rollback.");
    }
  }
  console.log(`Verified ${candidate.archive} from ${revision} (sha256 ${candidate.sha256}).`);
  console.log(`Rollback candidates are retained under ${join(artifactRoot, "candidates")}.`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
