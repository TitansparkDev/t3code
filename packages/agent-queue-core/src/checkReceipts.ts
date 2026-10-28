// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/** Private, versioned receipts for checks whose inputs and outputs are explicitly attested. */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { brokerHome, openBroker, processIsLive, processStartTicks } from "./resourceBroker.ts";

/** Checker packages whose installed versions are part of a check's identity. */
const CHECKERS = ["typescript", "tsc-rs", "@effect/tsgo"] as const;
const ISOLATED_TASK_ENV = new Set([
  "AGENTQUEUE_TASK_ID",
  "AGENTQUEUE_SLOT",
  "AGENTQUEUE_PORT_BASE",
  "AGENTQUEUE_PORT_COUNT",
  "AGENTQUEUE_DB_NAME",
  "AGENTQUEUE_NAMESPACE",
  "AGENTQUEUE_DB_NAMESPACE",
  "AGENTQUEUE_EMULATOR_PORT",
  "ANDROID_SERIAL",
  "COMPOSE_PROJECT_NAME",
  "PWD",
  "OLDPWD",
  "TMP",
  "TEMP",
  "TMPDIR",
]);
/** Receipts older than this are removed when another receipt is written. */
const RECEIPT_RETENTION_MS = 7 * 24 * 3600_000;
const RECEIPT_SCHEMA_VERSION = 2;
const MAX_IDENTITY_FILES = 20_000;
const MAX_IDENTITY_BYTES = 1024 * 1024 * 1024;
const MAX_DEPENDENCY_DIRECTORIES = 50_000;
const EXCLUDED_DIRS = new Set([".git", "node_modules", ".t3"]);
const TOOLCHAIN_PATTERNS = [
  "**/package.json",
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/bun.lock*",
  "**/Cargo.toml",
  "**/Cargo.lock",
  "**/go.mod",
  "**/go.sum",
  "**/uv.lock",
  "**/poetry.lock",
  "**/Pipfile.lock",
  "**/requirements*.txt",
  "**/Gemfile.lock",
  "**/composer.lock",
  "**/gradle.lockfile",
  "**/gradle-wrapper.jar",
  "**/gradle-wrapper.properties",
  "**/*.gradle",
  "**/*.gradle.kts",
  "**/libs.versions.toml",
  "**/tsconfig*.json",
  "**/vitest.config.*",
  "**/vite.config.*",
  "**/pyproject.toml",
] as const;
const EXCLUDED_GLOBS = [...EXCLUDED_DIRS].map((directory) => `**/${directory}/**`);
const fileDigestCache = new Map<string, string>();

export interface CheckIdentity {
  readonly key: string;
  readonly checkers: Readonly<Record<string, string | null>>;
  readonly repoRoot: string;
  readonly gitCommonDir: string;
  readonly commitHash: string;
}

export interface CheckReceipt {
  readonly schemaVersion: 2;
  readonly key: string;
  readonly commandHash: string;
  readonly outcome: "ok";
  readonly exitCode: number;
  readonly elapsedMs: number;
  /** Peak resident memory of the check's process tree, in KiB. */
  readonly peakRssKb: number;
  readonly checkers: Readonly<Record<string, string | null>>;
  readonly outputs: Readonly<Record<string, string>>;
  readonly finishedAt: number;
}

interface RunningMarker {
  readonly pid: number;
  readonly start: number | null;
  readonly owner: string;
}

const sha256 = (value: string | Buffer): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

function isWithin(directory: string, path: string): boolean {
  const relative = NodePath.relative(directory, path);
  return (
    relative === "" ||
    (!relative.startsWith(`..${NodePath.sep}`) &&
      relative !== ".." &&
      !NodePath.isAbsolute(relative))
  );
}

function git(cwd: string, args: ReadonlyArray<string>): Buffer | null {
  const result = NodeChildProcess.spawnSync("git", [...args], {
    cwd,
    maxBuffer: 1 << 30,
  });
  return result.status === 0 ? result.stdout : null;
}

/** The installed version of a package, found the way Node finds it: the nearest node_modules. */
function installedVersion(cwd: string, name: string): string | null {
  let dir = cwd;
  while (true) {
    try {
      const manifest = JSON.parse(
        NodeFS.readFileSync(NodePath.join(dir, "node_modules", name, "package.json"), "utf8"),
      ) as { version?: unknown };
      return typeof manifest.version === "string" ? manifest.version : null;
    } catch {
      // not installed here; try the parent directory
    }
    const parent = NodePath.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function identityContext(cwd: string) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) return null;
  let root: string;
  let common: string;
  let directory: string;
  try {
    root = NodeFS.realpathSync(top.toString().trim());
    const commonOutput = git(root, ["rev-parse", "--git-common-dir"]);
    const head = git(root, ["rev-parse", "--verify", "HEAD"]);
    if (!commonOutput || !head) return null;
    common = NodeFS.realpathSync(NodePath.resolve(root, commonOutput.toString().trim()));
    const realCwd = NodeFS.realpathSync(cwd);
    if (!isWithin(root, realCwd)) return null;
    directory = NodePath.relative(root, realCwd);
    return { root, common, directory, commitHash: head.toString().trim() };
  } catch {
    return null;
  }
}

function ensureChecksDir(home: string): string {
  const dir = NodePath.join(home, "checks");
  NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = NodeFS.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Unsafe check receipt directory.");
  NodeFS.chmodSync(dir, 0o700);
  return dir;
}

function environmentKey(home: string): Buffer {
  const dir = ensureChecksDir(home);
  const path = NodePath.join(dir, "environment.key");
  const temp = `${path}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    const key = NodeCrypto.randomBytes(32);
    NodeFS.writeFileSync(temp, key, { flag: "wx", mode: 0o600 });
    try {
      NodeFS.linkSync(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    try {
      NodeFS.unlinkSync(temp);
    } catch {
      // No temporary key was published.
    }
  }
  const stat = NodeFS.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe check receipt key file.");
  NodeFS.chmodSync(path, 0o600);
  const key = NodeFS.readFileSync(path);
  if (key.length !== 32) throw new Error("Invalid check receipt key.");
  return key;
}

function environmentDigest(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  declaredNames: ReadonlyArray<string> = [],
): string {
  const declared = new Set(declaredNames);
  const values = Object.fromEntries(
    Object.entries(env)
      .filter(([name]) => declared.has(name) || !isQueueScopedEnvironment(name))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const names = [...declared].sort();
  return NodeCrypto.createHmac("sha256", environmentKey(home))
    .update(JSON.stringify({ values, declared: names }))
    .digest("hex");
}

function isQueueScopedEnvironment(name: string): boolean {
  return (
    name === "AGENTQUEUE_RESOURCE_TICKET" ||
    name === "AGENTQUEUE_CHECK_CHAIN" ||
    name === "AGENTQUEUE_RESOURCES" ||
    name === "AGENTQUEUE_OWNER" ||
    name.startsWith("AGENTQUEUE_SLOT_") ||
    ISOLATED_TASK_ENV.has(name)
  );
}

/** Returns the current environment names, excluding injected queue and temporary identities. */
export function defaultReuseEnv(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.keys(env)
    .filter((name) => !isQueueScopedEnvironment(name))
    .sort();
}

function relativeInputPath(value: string): string | null {
  const path = value.trim().replace(/^`|`$/g, "");
  if (
    path === "" ||
    path.startsWith("/") ||
    path.startsWith("~") ||
    /^[A-Za-z]:/.test(path) ||
    path.includes("\\") ||
    /[\0\r\n,;]/.test(path) ||
    path.split("/").some((part) => part === ".." || part === "") ||
    path.split("/").some((part) => EXCLUDED_DIRS.has(part))
  ) {
    return null;
  }
  const normalized = NodePath.posix.normalize(path);
  return normalized === "." || normalized.startsWith("../") ? null : normalized;
}

function collectFiles(
  root: string,
  patterns: ReadonlyArray<string>,
  allowMissing: boolean,
): ReadonlyArray<string> | null {
  const files = new Set<string>();
  for (const rawPattern of patterns) {
    const pattern = relativeInputPath(rawPattern);
    if (!pattern) return null;
    let matches: string[];
    try {
      if (/[*?{}[\]]/.test(pattern)) {
        const wildcard = pattern.search(/[*?{}[\]]/);
        const directory = pattern.slice(0, wildcard).replace(/[^/]*$/, "");
        matches = NodeFS.globSync(pattern, { cwd: root, exclude: EXCLUDED_GLOBS });
        if (!TOOLCHAIN_PATTERNS.includes(rawPattern as (typeof TOOLCHAIN_PATTERNS)[number]))
          matches.push(
            ...NodeFS.globSync(`${directory}**/.*`, { cwd: root, exclude: EXCLUDED_GLOBS }),
          );
      } else {
        matches = NodeFS.existsSync(NodePath.resolve(root, pattern)) ? [pattern] : [];
      }
    } catch {
      return null;
    }
    if (matches.length === 0) {
      if (!allowMissing) return null;
      continue;
    }
    const visit = (relative: string): boolean => {
      if (relative.split(/[\\/]/).some((part) => EXCLUDED_DIRS.has(part))) return true;
      const candidate = NodePath.resolve(root, relative);
      if (!isWithin(root, candidate)) return false;
      let ancestor = root;
      for (const part of NodePath.relative(root, candidate).split(NodePath.sep).filter(Boolean)) {
        ancestor = NodePath.join(ancestor, part);
        try {
          if (NodeFS.lstatSync(ancestor).isSymbolicLink()) return false;
        } catch {
          return false;
        }
      }
      let stat: NodeFS.Stats;
      try {
        stat = NodeFS.lstatSync(candidate);
      } catch {
        return false;
      }
      if (stat.isSymbolicLink()) return false;
      if (stat.isDirectory()) {
        let children: string[];
        try {
          children = NodeFS.readdirSync(candidate).sort();
        } catch {
          return false;
        }
        for (const child of children) {
          if (EXCLUDED_DIRS.has(child)) continue;
          if (!visit(NodePath.posix.join(relative, child))) return false;
        }
      } else if (stat.isFile()) files.add(NodePath.posix.normalize(relative));
      else return false;
      return files.size <= MAX_IDENTITY_FILES;
    };
    for (const match of matches) if (!visit(match)) return null;
  }
  if (!allowMissing && files.size === 0) return null;
  return [...files].sort();
}

function digestFiles(root: string, files: ReadonlyArray<string>): string | null {
  const hash = NodeCrypto.createHash("sha256");
  let total = 0;
  for (const relative of files) {
    const path = NodePath.resolve(root, relative);
    try {
      if (!isWithin(root, path) || NodeFS.lstatSync(path).isSymbolicLink()) return null;
      if (!isWithin(root, NodeFS.realpathSync(path)) || NodeFS.lstatSync(path).isSymbolicLink())
        return null;
      const stat = NodeFS.statSync(path);
      total += stat.size;
      if (total > MAX_IDENTITY_BYTES) return null;
      hash.update(`${relative}\0${stat.mode & 0o777}\0${stat.size}\0`);
      hash.update(readFileDigest(path));
    } catch {
      return null;
    }
  }
  return hash.digest("hex");
}

function readFileDigest(path: string): string {
  const stat = NodeFS.statSync(path);
  const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached = fileDigestCache.get(path);
  if (cached?.startsWith(`${signature}:`)) return cached.slice(signature.length + 1);
  const digest = sha256(NodeFS.readFileSync(path));
  if (fileDigestCache.size >= MAX_IDENTITY_FILES * 2) fileDigestCache.clear();
  fileDigestCache.set(path, `${signature}:${digest}`);
  return digest;
}

function resolveExecutable(
  argv: ReadonlyArray<string>,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  if (argv.length === 0) return null;
  const executable = argv[0]!;
  const pathValue = env.PATH ?? process.env.PATH ?? "";
  const candidates = executable.includes(NodePath.sep)
    ? [NodePath.resolve(cwd, executable)]
    : pathValue
        .split(NodePath.delimiter)
        .map((directory) => NodePath.resolve(directory, executable));
  for (const candidate of candidates) {
    try {
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      if (NodeFS.statSync(candidate).isFile()) return NodeFS.realpathSync(candidate);
    } catch {
      // Search the rest of PATH.
    }
  }
  return null;
}

function toolFingerprint(
  argv: ReadonlyArray<string>,
  cwd: string,
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  allowExternalScripts: boolean,
): string | null {
  const resolved = resolveExecutable(argv, cwd, env);
  if (!resolved) return null;
  const addFile = (path: string, allowExternal: boolean): string | null => {
    let real: string;
    try {
      real = NodeFS.realpathSync(path);
      if (!allowExternal && !isWithin(root, real)) return null;
      if (!NodeFS.statSync(real).isFile()) return null;
      return real;
    } catch {
      return null;
    }
  };
  const executableFile = addFile(resolved, true);
  if (!executableFile) return null;
  const files = [executableFile];
  const scriptArgument = argv
    .slice(1)
    .find((arg) => !arg.startsWith("-") && /\.(?:[cm]?js|ts|py|sh|go|rs)$/i.test(arg));
  if (scriptArgument) {
    const scriptPath = NodePath.resolve(cwd, scriptArgument);
    const script = addFile(scriptPath, allowExternalScripts);
    if (!script) return null;
    files.push(script);
  }
  const unique = [...new Set(files)].sort();
  let packageRoot: string | null = null;
  if (resolved.split(NodePath.sep).includes("node_modules")) {
    for (let directory = NodePath.dirname(resolved); ; directory = NodePath.dirname(directory)) {
      if (NodePath.basename(directory) === "node_modules") break;
      if (NodeFS.existsSync(NodePath.join(directory, "package.json"))) {
        packageRoot = directory;
        break;
      }
      const parent = NodePath.dirname(directory);
      if (parent === directory) break;
    }
  }
  const packageFiles = packageRoot ? collectFiles(packageRoot, ["package.json", "**/*"], true) : [];
  if (packageRoot && !packageFiles) return null;
  const fingerprint = digestFiles(NodePath.parse(resolved).root, [
    ...unique,
    ...(packageRoot ? packageFiles!.map((path) => NodePath.join(packageRoot!, path)) : []),
  ]);
  if (!fingerprint) return null;
  return sha256(JSON.stringify({ executable: resolved, packageRoot, files: unique, fingerprint }));
}

function dependencyFingerprint(input: {
  readonly repoRoot: string;
  readonly cwd: string;
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
}): string | null {
  const roots = new Map<string, string>();
  let unsafeDependencyTree = false;
  const addRoot = (path: string) => {
    try {
      const stat = NodeFS.lstatSync(path);
      if (stat.isSymbolicLink()) {
        unsafeDependencyTree = true;
        return;
      }
      if (!stat.isDirectory()) return;
      const absolute = NodePath.resolve(path);
      const label = isWithin(input.repoRoot, absolute)
        ? `repo/${NodePath.relative(input.repoRoot, absolute)}`
        : `external/${absolute}`;
      roots.set(label, absolute);
    } catch {
      // This path is not an installed dependency root.
    }
  };
  const addNodeModulesAncestors = (start: string) => {
    let current = start;
    try {
      if (!NodeFS.statSync(current).isDirectory()) current = NodePath.dirname(current);
    } catch {
      current = NodePath.dirname(current);
    }
    while (true) {
      addRoot(NodePath.join(current, "node_modules"));
      const parent = NodePath.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  };
  addNodeModulesAncestors(input.cwd);
  const executable = resolveExecutable(input.argv, input.cwd, input.env);
  if (executable) addNodeModulesAncestors(NodePath.dirname(executable));
  for (const directory of (input.env.PATH ?? "").split(NodePath.delimiter).filter(Boolean))
    addNodeModulesAncestors(directory);
  for (const directory of (input.env.NODE_PATH ?? "").split(NodePath.delimiter).filter(Boolean))
    addRoot(directory);

  let scannedDirectories = 0;
  const findProjectRoots = (directory: string): boolean => {
    if (++scannedDirectories > MAX_DEPENDENCY_DIRECTORIES) return false;
    let children: string[];
    try {
      children = NodeFS.readdirSync(directory).sort();
    } catch {
      return false;
    }
    for (const child of children) {
      if (EXCLUDED_DIRS.has(child) || ["build", "dist", "target", ".cache"].includes(child))
        continue;
      const path = NodePath.join(directory, child);
      let stat: NodeFS.Stats;
      try {
        stat = NodeFS.lstatSync(path);
      } catch {
        return false;
      }
      if (child === "node_modules") {
        if (stat.isSymbolicLink()) unsafeDependencyTree = true;
        else if (stat.isDirectory()) addRoot(path);
        continue;
      }
      if (stat.isSymbolicLink()) {
        unsafeDependencyTree = true;
        continue;
      }
      if (stat.isDirectory() && !findProjectRoots(path)) return false;
    }
    return true;
  };
  if (!findProjectRoots(input.repoRoot) || unsafeDependencyTree) return null;

  const files = new Map<string, string>();
  let totalBytes = 0;
  for (const [label, root] of [...roots].sort(([left], [right]) => left.localeCompare(right))) {
    const activeDirectories = new Set<string>();
    const visit = (path: string, relative: string, moduleRoot: boolean): boolean => {
      let stat: NodeFS.Stats;
      let target = path;
      try {
        stat = NodeFS.lstatSync(path);
      } catch {
        return false;
      }
      if (stat.isSymbolicLink()) {
        let real: string;
        try {
          real = NodeFS.realpathSync(path);
          stat = NodeFS.statSync(real);
        } catch {
          return false;
        }
        const dependencyRoot = [...roots]
          .filter(([, candidate]) => isWithin(candidate, real))
          .sort((left, right) => right[1].length - left[1].length)[0];
        if (!dependencyRoot && !isWithin(input.repoRoot, real)) return false;
        const targetLabel = dependencyRoot
          ? `${dependencyRoot[0]}/${NodePath.relative(dependencyRoot[1], real)}`
          : `repo/${NodePath.relative(input.repoRoot, real)}`;
        files.set(`${label}/${relative}#link`, sha256(targetLabel));
        target = real;
      }
      if (stat.isDirectory()) {
        let real: string;
        try {
          real = NodeFS.realpathSync(target);
        } catch {
          return false;
        }
        if (activeDirectories.has(real)) return true;
        activeDirectories.add(real);
        let children: string[];
        try {
          children = NodeFS.readdirSync(target).sort();
        } catch {
          activeDirectories.delete(real);
          return false;
        }
        for (const child of children) {
          if (moduleRoot && [".bin", ".pnpm"].includes(child)) continue;
          if (!visit(NodePath.join(target, child), NodePath.posix.join(relative, child), false)) {
            activeDirectories.delete(real);
            return false;
          }
        }
        activeDirectories.delete(real);
        return true;
      }
      if (!stat.isFile() || !/\.(?:[cm]?tsx?|[cm]?jsx?|json|node|wasm)$/i.test(path)) return true;
      if (files.size >= MAX_IDENTITY_FILES) return false;
      totalBytes += stat.size;
      if (totalBytes > MAX_IDENTITY_BYTES) return false;
      const key = `${label}/${relative}`;
      try {
        files.set(key, sha256(`${stat.mode & 0o777}\0${stat.size}\0${readFileDigest(target)}`));
      } catch {
        return false;
      }
      return true;
    };
    if (!visit(root, "", true)) return null;
  }
  return sha256(JSON.stringify([...files].sort(([left], [right]) => left.localeCompare(right))));
}

function identityFor(input: {
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly declaredInputs: ReadonlyArray<string>;
  readonly declaredEnv: ReadonlyArray<string>;
}): CheckIdentity | null {
  const context = identityContext(input.cwd);
  if (!context) return null;
  const effectiveEnv: Readonly<Record<string, string | undefined>> = {
    ...process.env,
    ...input.env,
  };
  const tool = toolFingerprint(input.argv, input.cwd, context.root, effectiveEnv, false);
  if (!tool) return null;
  const dependencies = dependencyFingerprint({
    repoRoot: context.root,
    cwd: input.cwd,
    argv: input.argv,
    env: effectiveEnv,
  });
  if (!dependencies) return null;
  const inputFiles = collectFiles(context.root, input.declaredInputs, false);
  const toolchainFiles = collectFiles(context.root, TOOLCHAIN_PATTERNS, true);
  if (!inputFiles || !toolchainFiles) return null;
  const additionalFiles = [...new Set([...inputFiles, ...toolchainFiles])].sort();
  const content = digestFiles(context.root, additionalFiles);
  if (!content) return null;
  const checkers = Object.fromEntries(
    CHECKERS.map((name) => [name, installedVersion(input.cwd, name)]),
  );
  let envDigest: string;
  try {
    envDigest = environmentDigest(effectiveEnv, brokerHome(), input.declaredEnv);
  } catch {
    return null;
  }
  const key = sha256(
    JSON.stringify({
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      account: { uid: NodeOS.userInfo().uid, username: NodeOS.userInfo().username },
      repository: context.common,
      argv: input.argv,
      directory: context.directory,
      content,
      toolchain: tool,
      dependencies,
      lockfilesAndConfig: toolchainFiles,
      checkers,
      node: process.version,
      environment: envDigest,
      reuseInputs: input.declaredInputs,
      reuseEnv: input.declaredEnv,
    }),
  );
  return {
    key,
    checkers,
    repoRoot: context.root,
    gitCommonDir: context.common,
    commitHash: context.commitHash,
  };
}

/** Identity for a declared deterministic check; absent or non-attestable inputs force a fresh run. */
export function declaredCheckIdentity(input: {
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly reuseInputs: ReadonlyArray<string>;
  readonly reuseEnv: ReadonlyArray<string>;
}): CheckIdentity | null {
  if (input.reuseInputs.length === 0 || !isReusableCommand(input.argv)) return null;
  return identityFor({
    ...input,
    declaredInputs: input.reuseInputs,
    declaredEnv: input.reuseEnv,
  });
}

/** Commands with shell expansion, custom wrappers, or unknown execution semantics always run fresh. */
export function isReusableCommand(argv: ReadonlyArray<string>): boolean {
  if (
    argv.length === 0 ||
    argv.some(
      (word) => word === "" || /\s/.test(word) || /[;&|<>`$()'"\\\n\r*?\[\]{}#~!]/.test(word),
    )
  )
    return false;
  const executable = NodePath.basename(argv[0]!).replace(/\.(?:exe|cmd|bat)$/i, "");
  if (["vp", "pnpm", "npm", "yarn", "bun"].includes(executable))
    return argv[1] === "run" && argv.at(-1) === "typecheck";
  if (!new Set(["tsc", "tsgo", "tsc-rs"]).has(executable)) return false;
  return !argv
    .slice(1)
    .some(
      (word) =>
        ["-p", "--project", "-b", "--build", "--tsBuildInfoFile"].includes(word) ||
        /(?:^|=)(?:\/|\.{1,2}[\\/]|[A-Za-z]:[\\/])|(?:^|=)[^=]+\.(?:jsonc?|[cm]?tsx?|jsx?|d\.ts)(?:$|=)/i.test(
          word,
        ),
    );
}

/** Hashes declared outputs without following symlinks; null means a path is missing or unsafe. */
export function outputSnapshot(
  repoRoot: string,
  patterns: ReadonlyArray<string> | undefined,
): Readonly<Record<string, string>> | null {
  if (patterns === undefined) return null;
  if (patterns.length === 0) return {};
  const files = collectFiles(repoRoot, patterns, false);
  if (!files) return null;
  const outputs: Record<string, string> = {};
  let total = 0;
  for (const relative of files) {
    const path = NodePath.resolve(repoRoot, relative);
    try {
      if (!isWithin(repoRoot, NodeFS.realpathSync(path)) || NodeFS.lstatSync(path).isSymbolicLink())
        return null;
      const stat = NodeFS.statSync(path);
      total += stat.size;
      if (total > MAX_IDENTITY_BYTES) return null;
      outputs[relative] = sha256(`${stat.mode & 0o777}\0${stat.size}\0${readFileDigest(path)}`);
    } catch {
      return null;
    }
  }
  return outputs;
}

/** Finds an exact successful receipt whose current artifacts still match. */
export function matchingReceipt(
  identity: CheckIdentity,
  outputs: Readonly<Record<string, string>> | null,
  home: string = brokerHome(),
): CheckReceipt | null {
  if (outputs === null) return null;
  const receipt = readReceipt(identity.key, home);
  if (!receipt || receipt.outcome !== "ok") return null;
  return JSON.stringify(receipt.outputs) === JSON.stringify(outputs) ? receipt : null;
}

/** Waits without a resource grant so a duplicate request cannot hold a claim owner's resource. */
export async function waitForCheck(
  key: string,
  home: string = brokerHome(),
  timeoutMs = Number.POSITIVE_INFINITY,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const broker = openBroker({ home });
  try {
    while (runningCheckWithBroker(key, broker)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
    }
    return true;
  } finally {
    broker.close();
  }
}

function checksDir(home: string): string {
  return NodePath.join(home, "checks");
}

function validCheckKey(key: string): boolean {
  return /^[a-f0-9]{64}$/.test(key);
}

const receiptPath = (key: string, home: string) => NodePath.join(checksDir(home), `${key}.json`);

function readCheckClaim(key: string, broker: ReturnType<typeof openBroker>): RunningMarker | null {
  if (!validCheckKey(key)) return null;
  const row = broker.db
    .prepare("SELECT pid, pid_start, owner FROM check_claims WHERE key = ?")
    .get(key) as { pid: number; pid_start: number | null; owner: string } | undefined;
  return row ? { pid: row.pid, start: row.pid_start ?? null, owner: row.owner } : null;
}

function removeCheckClaim(key: string, owner: string, broker: ReturnType<typeof openBroker>): void {
  broker.db.exec("BEGIN IMMEDIATE;");
  try {
    broker.db.prepare("DELETE FROM check_claims WHERE key = ? AND owner = ?").run(key, owner);
    broker.db.exec("COMMIT;");
  } catch (error) {
    broker.db.exec("ROLLBACK;");
    throw error;
  }
}

/** The receipt of a completed check with these exact inputs, if there is one. */
export function readReceipt(key: string, home: string = brokerHome()): CheckReceipt | null {
  try {
    if (!validCheckKey(key)) return null;
    ensureChecksDir(home);
    const path = receiptPath(key, home);
    if (NodeFS.lstatSync(path).isSymbolicLink()) return null;
    const value = JSON.parse(NodeFS.readFileSync(path, "utf8")) as Partial<CheckReceipt>;
    if (
      value.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
      value.key !== key ||
      value.outcome !== "ok" ||
      !Number.isSafeInteger(value.exitCode) ||
      value.exitCode !== 0 ||
      !Number.isSafeInteger(value.finishedAt) ||
      !Number.isSafeInteger(value.elapsedMs) ||
      !Number.isSafeInteger(value.peakRssKb) ||
      typeof value.commandHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.commandHash) ||
      !value.outputs ||
      typeof value.outputs !== "object" ||
      Array.isArray(value.outputs) ||
      !value.checkers ||
      typeof value.checkers !== "object" ||
      Object.values(value.outputs).some(
        (digest) => typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest),
      )
    )
      return null;
    return value as CheckReceipt;
  } catch {
    return null;
  }
}

/**
 * The live process running this check now, or null. A claim left by a process that is gone is
 * deleted conditionally by owner, so one crashed check never blocks the next one.
 */
export function runningCheck(key: string, home: string = brokerHome()): RunningMarker | null {
  const broker = openBroker({ home });
  try {
    return runningCheckWithBroker(key, broker);
  } finally {
    broker.close();
  }
}

function runningCheckWithBroker(
  key: string,
  broker: ReturnType<typeof openBroker>,
): RunningMarker | null {
  const marker = readCheckClaim(key, broker);
  if (!marker) return null;
  if (processIsLive(marker.pid, marker.start)) return marker;
  try {
    removeCheckClaim(key, marker.owner, broker);
  } catch {
    // A newer owner may have replaced this stale claim.
  }
  return null;
}

/** Claim the right to run this check. Of all processes asking at once, exactly one wins. */
export function claimCheck(key: string, home: string = brokerHome()): string | null {
  if (!validCheckKey(key)) return null;
  const broker = openBroker({ home });
  const owner = NodeCrypto.randomUUID();
  try {
    broker.db.exec("BEGIN IMMEDIATE;");
    try {
      const existing = broker.db
        .prepare("SELECT pid, pid_start, owner FROM check_claims WHERE key = ?")
        .get(key) as { pid: number; pid_start: number | null; owner: string } | undefined;
      if (existing && processIsLive(existing.pid, existing.pid_start ?? null)) {
        broker.db.exec("COMMIT;");
        return null;
      }
      if (existing)
        broker.db
          .prepare("DELETE FROM check_claims WHERE key = ? AND owner = ?")
          .run(key, existing.owner);
      broker.db
        .prepare(
          "INSERT INTO check_claims (key, pid, pid_start, owner, claimed_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(key, process.pid, processStartTicks(process.pid), owner, Date.now());
      broker.db.exec("COMMIT;");
      return owner;
    } catch (error) {
      broker.db.exec("ROLLBACK;");
      throw error;
    }
  } finally {
    broker.close();
  }
}

/** Release this process's claim. A claim held by anyone else is left alone. */
export function releaseCheck(key: string, owner: string, home: string = brokerHome()): void {
  if (!validCheckKey(key)) return;
  const broker = openBroker({ home });
  try {
    broker.db
      .prepare("DELETE FROM check_claims WHERE key = ? AND pid = ? AND owner = ?")
      .run(key, process.pid, owner);
  } finally {
    broker.close();
  }
}

/** Store the receipt of a completed check, then prune receipts past their retention. */
export function writeReceipt(receipt: CheckReceipt, home: string = brokerHome()): void {
  if (!validCheckKey(receipt.key)) throw new Error("Invalid check receipt key.");
  if (
    receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
    receipt.outcome !== "ok" ||
    receipt.exitCode !== 0
  )
    throw new Error("Only completed successful checks can be stored.");
  const dir = ensureChecksDir(home);
  const path = receiptPath(receipt.key, home);
  const temp = `${path}.${process.pid}.tmp`;
  NodeFS.writeFileSync(
    temp,
    JSON.stringify({
      schemaVersion: receipt.schemaVersion,
      key: receipt.key,
      commandHash: receipt.commandHash,
      outcome: receipt.outcome,
      exitCode: receipt.exitCode,
      elapsedMs: receipt.elapsedMs,
      peakRssKb: receipt.peakRssKb,
      checkers: receipt.checkers,
      outputs: receipt.outputs,
      finishedAt: receipt.finishedAt,
    }),
    { mode: 0o600 },
  );
  NodeFS.renameSync(temp, path);
  const cutoff = Date.now() - RECEIPT_RETENTION_MS;
  for (const file of NodeFS.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      if (NodeFS.statSync(NodePath.join(dir, file)).mtimeMs < cutoff)
        NodeFS.rmSync(NodePath.join(dir, file));
    } catch {
      // removed concurrently
    }
  }
}
