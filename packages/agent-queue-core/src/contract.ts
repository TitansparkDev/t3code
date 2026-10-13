// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * What a repository says about how its work must be done, and how AgentQueue learns it.
 *
 * Repositories differ: one accepts only `agent/*` branches, another runs a hook on commit,
 * another keeps generated files that every branch touches. Nothing here assumes a
 * convention. The contract is read, in this order of authority, from
 *  1. `<git-common-dir>/agentqueue/contract.json` (a local override, never committed),
 *  2. `.agentqueue/contract.json` at the target branch (then the plan's integration branch),
 *  3. what the repository's own instruction files and guard scripts imply (inferred).
 * It is never read from a worker's branch, so a worker cannot change the rules it is held to.
 * Inference only proposes: a proposed rule is accepted when probing it in a real worktree
 * works (see preflight.ts), never on trust.
 *
 * @module contract
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { inspectCheckCommand } from "./verificationSpec.ts";

export interface GuardSpec {
  readonly name: string;
  /** Shell command run in the worktree. Placeholders: {taskId} {branch} {base} {worktree} {allowPaths} {scopePaths}. */
  readonly run: string;
  /** `start` runs before a worker is dispatched; `submit` before a candidate is accepted. */
  readonly phase: "start" | "submit";
  /** The command's verdict depends on the branch name, so a branch-prefix probe may fix it. */
  readonly branchSensitive: boolean;
  readonly optional: boolean;
}

export interface GeneratedFileRule {
  readonly paths: ReadonlyArray<string>;
  /** Shell command (run in the staging worktree) that rewrites the files from the merged tree. */
  readonly regenerate: string | null;
  /** Without a command a conflict takes this side. */
  readonly onConflict: "regenerate" | "base";
  /** Rebuild the files whenever a task lands, as the repository's commit hook would on the base branch. */
  readonly refreshOnLand: boolean;
}

export interface ToolSpec {
  readonly name: string;
  readonly probe: string | null;
  readonly optional: boolean;
  /** Command the repository authorises AgentQueue to run when the tool is missing. */
  readonly install: string | null;
}

export interface CapabilitySpec {
  /** Read-only command; exit 0 means workers may be given tasks that need this capability. */
  readonly probe: string | null;
  readonly description: string | null;
}

/**
 * Something the repository cannot share between two workers at once: a fixed port, container
 * or database name its tests use, a single emulator, a GPU. A task needs it when its scope
 * overlaps `scope` or one of its checks matches `commands`; at most `limit` running tasks hold it.
 */
export interface ExclusiveResource {
  readonly name: string;
  readonly limit: number;
  readonly scope: ReadonlyArray<string>;
  readonly commands: ReadonlyArray<string>;
}

export interface RepoContract {
  readonly version: 1;
  /** Branch prefixes the repository accepts, most preferred first. Each ends with "/". */
  readonly branchPrefixes: ReadonlyArray<string>;
  readonly guards: ReadonlyArray<GuardSpec>;
  readonly generated: ReadonlyArray<GeneratedFileRule>;
  /** Paths any task may legitimately touch besides its scope (evidence folders, changelogs...). */
  readonly supportingPaths: ReadonlyArray<string>;
  /** Paths no worker may change and no amendment may grant. */
  readonly protectedPaths: ReadonlyArray<string>;
  /**
   * Files the agents' own tooling drops into a worktree (an MCP server's project folder, local
   * assistant settings). They are never part of a task: kept out of commits and out of scope audits.
   */
  readonly ignoredPaths: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<ToolSpec>;
  readonly capabilities: Readonly<Record<string, CapabilitySpec>>;
  readonly resources: ReadonlyArray<ExclusiveResource>;
  readonly scopeEnforcement: "strict" | "report";
  /** Extra environment for workers' and checks' processes. `{slot}` / `{taskId}` are replaced. */
  readonly env: Readonly<Record<string, string>>;
  /** Merge the target branch into the plan's branch when it moved and merges cleanly. */
  readonly syncBase: boolean;
  /**
   * Files where two branches each adding lines is normal (barrel exports, registries, changelogs):
   * a conflict in them keeps both sides' lines. The task's own checks must still pass on the result.
   */
  readonly unionMerge: ReadonlyArray<string>;
}

export type ContractSource = "local" | "committed" | "inferred" | "default";

export interface LoadedContract {
  readonly contract: RepoContract;
  /** True when a committed or local contract chose the branch prefixes itself. */
  readonly explicitPrefixes: boolean;
  readonly sources: ReadonlyArray<ContractSource>;
  readonly problems: ReadonlyArray<string>;
  /** Changes whenever the contract's content changes. */
  readonly digest: string;
}

export const DEFAULT_BRANCH_PREFIX = "agentqueue/";

const EMPTY: RepoContract = {
  version: 1,
  branchPrefixes: [DEFAULT_BRANCH_PREFIX],
  guards: [],
  generated: [],
  supportingPaths: [],
  protectedPaths: [],
  ignoredPaths: [".serena/", ".claude/settings.local.json"],
  tools: [],
  capabilities: {},
  resources: [],
  scopeEnforcement: "strict",
  env: {},
  syncBase: true,
  unionMerge: [],
};

function git(cwd: string, args: ReadonlyArray<string>): { code: number; stdout: string } {
  try {
    const stdout = NodeChildProcess.execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { code: 0, stdout: stdout.trim() };
  } catch (error: any) {
    return { code: error.status ?? 1, stdout: (error.stdout?.toString() ?? "").trim() };
  }
}

const asStrings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : [];

const normalizePrefix = (prefix: string) => {
  const trimmed = prefix.trim().replace(/^\/+/, "");
  return trimmed === "" ? "" : trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
};

/** Reads a contract document leniently; every defect is reported, none is fatal. */
export function parseContract(
  text: string,
  origin: string,
): { partial: Partial<RepoContract>; problems: string[] } {
  const problems: string[] = [];
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { partial: {}, problems: [`${origin}: not valid JSON (${(error as Error).message})`] };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { partial: {}, problems: [`${origin}: must be a JSON object`] };
  }
  const partial: { -readonly [K in keyof RepoContract]?: RepoContract[K] } = {};
  if (raw.branchPrefixes !== undefined) {
    const prefixes = asStrings(raw.branchPrefixes).map(normalizePrefix).filter(Boolean);
    if (prefixes.length === 0)
      problems.push(`${origin}: branchPrefixes must list at least one prefix`);
    else partial.branchPrefixes = prefixes;
  }
  if (raw.guards !== undefined) {
    const guards: GuardSpec[] = [];
    for (const [index, entry] of (Array.isArray(raw.guards) ? raw.guards : []).entries()) {
      if (typeof entry?.run !== "string" || entry.run.trim() === "") {
        problems.push(`${origin}: guards[${index}] needs a "run" command`);
        continue;
      }
      guards.push({
        name: typeof entry.name === "string" ? entry.name : `guard-${index + 1}`,
        run: entry.run.trim(),
        phase: entry.phase === "submit" ? "submit" : "start",
        branchSensitive: entry.branchSensitive === true,
        optional: entry.optional === true,
      });
    }
    partial.guards = guards;
  }
  if (raw.generated !== undefined) {
    const rules: GeneratedFileRule[] = [];
    for (const [index, entry] of (Array.isArray(raw.generated) ? raw.generated : []).entries()) {
      const paths = asStrings(entry?.paths);
      if (paths.length === 0) {
        problems.push(`${origin}: generated[${index}] needs "paths"`);
        continue;
      }
      const regenerate =
        typeof entry.regenerate === "string" && entry.regenerate.trim()
          ? entry.regenerate.trim()
          : null;
      rules.push({
        paths,
        regenerate,
        onConflict: entry.onConflict === "base" || regenerate === null ? "base" : "regenerate",
        refreshOnLand: entry.refreshOnLand === true && regenerate !== null,
      });
    }
    partial.generated = rules;
  }
  if (raw.supportingPaths !== undefined) partial.supportingPaths = asStrings(raw.supportingPaths);
  if (raw.protectedPaths !== undefined) partial.protectedPaths = asStrings(raw.protectedPaths);
  if (raw.ignoredPaths !== undefined) partial.ignoredPaths = asStrings(raw.ignoredPaths);
  if (raw.tools !== undefined) {
    partial.tools = (Array.isArray(raw.tools) ? raw.tools : [])
      .map((entry: any) =>
        typeof entry === "string"
          ? { name: entry, probe: null, optional: false, install: null }
          : typeof entry?.name === "string"
            ? {
                name: entry.name,
                probe: typeof entry.probe === "string" ? entry.probe : null,
                optional: entry.optional === true,
                install:
                  typeof entry.install === "string" && entry.install.trim()
                    ? entry.install.trim()
                    : null,
              }
            : null,
      )
      .filter((entry: ToolSpec | null): entry is ToolSpec => entry !== null);
  }
  if (raw.capabilities && typeof raw.capabilities === "object") {
    const capabilities: Record<string, CapabilitySpec> = {};
    for (const [name, entry] of Object.entries<any>(raw.capabilities)) {
      capabilities[name.toLowerCase()] = {
        probe: typeof entry?.probe === "string" && entry.probe.trim() ? entry.probe.trim() : null,
        description: typeof entry?.description === "string" ? entry.description : null,
      };
    }
    partial.capabilities = capabilities;
  }
  if (Array.isArray(raw.resources)) {
    partial.resources = raw.resources
      .filter((entry: any) => typeof entry?.name === "string" && entry.name.trim() !== "")
      .map((entry: any) => ({
        name: String(entry.name).toLowerCase(),
        limit: Number.isInteger(entry.limit) && entry.limit > 0 ? entry.limit : 1,
        scope: asStrings(entry.scope),
        commands: asStrings(entry.commands),
      }));
  }
  if (raw.scopeEnforcement === "strict" || raw.scopeEnforcement === "report") {
    partial.scopeEnforcement = raw.scopeEnforcement;
  }
  if (raw.env && typeof raw.env === "object") {
    partial.env = Object.fromEntries(
      Object.entries(raw.env).filter(([, v]) => typeof v === "string"),
    ) as Record<string, string>;
  }
  if (typeof raw.syncBase === "boolean") partial.syncBase = raw.syncBase;
  if (raw.unionMerge !== undefined) partial.unionMerge = asStrings(raw.unionMerge);
  return { partial, problems };
}

const readAt = (repoRoot: string, ref: string, file: string): string | null => {
  const shown = NodeChildProcess.spawnSync("git", ["show", `${ref}:${file}`], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return shown.status === 0 ? shown.stdout : null;
};

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"];
const GUARD_WORDS =
  /guard|pre-?flight|isolated|checkout|before (its|any|the|your) (first )?(repository )?write/i;

/**
 * Proposes a start-phase guard from the repository's own instruction files: a backticked
 * command that runs a script in the repository, on a line that talks about a guard or
 * pre-flight. It must pass the safe-runner policy. Probing decides whether it is used.
 */
export function inferGuards(repoRoot: string, refs: ReadonlyArray<string>): GuardSpec[] {
  const found: GuardSpec[] = [];
  for (const ref of refs) {
    for (const file of INSTRUCTION_FILES) {
      const text = readAt(repoRoot, ref, file);
      if (!text) continue;
      for (const line of text.split("\n")) {
        if (!GUARD_WORDS.test(line)) continue;
        for (const match of line.matchAll(/`([^`\n]{4,200})`/g)) {
          const command = match[1]!.trim();
          if (/<|>|\.\.\.|\$\{?[A-Z]/.test(command) || /\s--(?:require|allow|check)/.test(command))
            continue;
          const words = command.split(/\s+/);
          const script = words.find((word, i) => i > 0 && /\.(py|sh|js|mjs|ts)$/.test(word));
          if (!script || !/^(python3?|bash|sh|node|bun)$/.test(words[0]!)) continue;
          if (script.startsWith("/") || script.includes("..")) continue;
          if (git(repoRoot, ["cat-file", "-e", `${ref}:${script}`]).code !== 0) continue;
          if (inspectCheckCommand(command, { declared: true }) !== null) continue;
          // A branch guard talks about branches; a spec or lint checker that merely sits near the
          // word "guard" in the documents is not a precondition for starting work.
          if (!/branch/i.test(readAt(repoRoot, ref, script) ?? "")) continue;
          if (found.some((guard) => guard.run === command)) continue;
          found.push({
            name: NodePath.basename(script),
            run: command,
            phase: "start",
            branchSensitive: true,
            optional: false,
          });
        }
      }
    }
  }
  return found;
}

/** Branch prefixes a guard script appears to accept (literal prefixes it tests). */
export function prefixesMentionedBy(repoRoot: string, ref: string, guardRun: string): string[] {
  const words = guardRun.split(/\s+/);
  const script = words.find((word, i) => i > 0 && /\.(py|sh|js|mjs|ts)$/.test(word));
  const source = script ? readAt(repoRoot, ref, script) : null;
  if (!source) return [];
  const found = new Set<string>();
  const patterns = [
    /startswith\(\s*["']([A-Za-z][\w.-]*\/)["']\s*\)/g,
    /startsWith\(\s*["']([A-Za-z][\w.-]*\/)["']\s*\)/g,
    /\b([A-Za-z][\w.-]*)\/\*\)/g,
    /\^?([A-Za-z][\w.-]*\/)\.\*/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const prefix = normalizePrefix(match[1]!);
      if (prefix) found.add(prefix);
    }
  }
  return [...found];
}

/** Prefixes already used by this repository's local branches, for repositories with a convention but no contract. */
export function prefixesInUse(repoRoot: string): string[] {
  const refs = git(repoRoot, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]).stdout.split("\n");
  const counts = new Map<string, number>();
  for (const ref of refs) {
    const slash = ref.indexOf("/");
    if (slash <= 0) continue;
    const prefix = ref.slice(0, slash + 1);
    if (prefix.startsWith("salvage/") || prefix.startsWith("recovery/")) continue;
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([prefix]) => prefix);
}

export interface LoadContractInput {
  readonly repoRoot: string;
  readonly gitCommonDir: string;
  /** Branches to read the committed contract from, authoritative first. */
  readonly refs: ReadonlyArray<string>;
}

const loadCache = new Map<string, LoadedContract>();

/** Cached by the tips of the refs it reads and the local override's age: it runs on every reservation. */
export function loadContract(input: LoadContractInput): LoadedContract {
  const localFile = NodePath.join(input.gitCommonDir, "agentqueue", "contract.json");
  const tips = input.refs.map(
    (ref) => git(input.repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).stdout,
  );
  let localStamp = "none";
  try {
    localStamp = String(NodeFS.statSync(localFile).mtimeMs);
  } catch {
    // No local override.
  }
  const key = `${input.repoRoot}|${tips.join(",")}|${localStamp}`;
  const cached = loadCache.get(key);
  if (cached) return cached;
  const loaded = readContract(input);
  if (loadCache.size > 64) loadCache.clear();
  loadCache.set(key, loaded);
  return loaded;
}

function readContract(input: LoadContractInput): LoadedContract {
  const problems: string[] = [];
  const sources: ContractSource[] = [];
  let merged: { -readonly [K in keyof RepoContract]?: RepoContract[K] } = {};

  let committed: string | null = null;
  for (const ref of input.refs) {
    committed = readAt(input.repoRoot, ref, ".agentqueue/contract.json");
    if (committed !== null) break;
  }
  if (committed !== null) {
    const parsed = parseContract(committed, ".agentqueue/contract.json");
    problems.push(...parsed.problems);
    merged = { ...merged, ...parsed.partial };
    sources.push("committed");
  }
  const localFile = NodePath.join(input.gitCommonDir, "agentqueue", "contract.json");
  if (NodeFS.existsSync(localFile)) {
    const parsed = parseContract(NodeFS.readFileSync(localFile, "utf8"), localFile);
    problems.push(...parsed.problems);
    merged = { ...merged, ...parsed.partial };
    sources.push("local");
  }

  const explicitPrefixes = merged.branchPrefixes !== undefined;
  if (merged.guards === undefined) {
    const guards = inferGuards(input.repoRoot, input.refs);
    if (guards.length > 0) {
      merged.guards = guards;
      sources.push("inferred");
    }
  }
  if (merged.branchPrefixes === undefined) {
    const candidates: string[] = [];
    for (const guard of merged.guards ?? []) {
      for (const ref of input.refs)
        candidates.push(...prefixesMentionedBy(input.repoRoot, ref, guard.run));
    }
    if (candidates.length > 0) {
      // The default stays last: it is what unconfigured repositories get.
      merged.branchPrefixes = [...new Set([...candidates, DEFAULT_BRANCH_PREFIX])];
      if (!sources.includes("inferred")) sources.push("inferred");
    }
  }
  if (sources.length === 0) sources.push("default");

  const contract: RepoContract = { ...EMPTY, ...merged };
  const digest = NodeCrypto.createHash("sha1")
    .update(JSON.stringify(contract))
    .digest("hex")
    .slice(0, 16);
  return { contract, explicitPrefixes, sources, problems, digest };
}

// ───────────────────────────── paths ─────────────────────────────

export function normalizeRepoPath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .trim()
    .replace(/^\.?\//, "");
}

function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        source += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else source += "[^/]*";
    } else if (c === "?") source += "[^/]";
    else source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** A directory ("dir/" or "dir"), an exact file, or a glob. */
export function pathMatches(path: string, pattern: string): boolean {
  const file = normalizeRepoPath(path);
  const rule = normalizeRepoPath(pattern);
  if (rule === "" || rule === "." || rule === "**") return true;
  if (rule.endsWith("/")) return file.startsWith(rule);
  if (/[*?]/.test(rule))
    return globToRegExp(rule).test(file) || globToRegExp(`${rule}/**`).test(file);
  return file === rule || file.startsWith(`${rule}/`);
}

export const matchesAny = (path: string, patterns: ReadonlyArray<string>) =>
  patterns.some((pattern) => pathMatches(path, pattern));

// ───────────────────────────── commands ─────────────────────────────

export const shellQuote = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

export interface CommandVariables {
  readonly taskId: string;
  readonly branch: string;
  readonly base: string;
  readonly worktree: string;
  readonly allowedPaths: ReadonlyArray<string>;
}

export function expandCommand(template: string, vars: CommandVariables): string {
  return template
    .replaceAll("{taskId}", shellQuote(vars.taskId))
    .replaceAll("{branch}", shellQuote(vars.branch))
    .replaceAll("{base}", shellQuote(vars.base))
    .replaceAll("{worktree}", shellQuote(vars.worktree))
    .replaceAll(
      "{allowPaths}",
      vars.allowedPaths.map((path) => `--allow-path ${shellQuote(path)}`).join(" "),
    )
    .replaceAll("{scopePaths}", vars.allowedPaths.map(shellQuote).join(" "));
}

/** Runs a short, read-only probe or guard command. Output is trimmed to a tail. */
export function runShell(
  command: string,
  cwd: string,
  options: { readonly timeoutMs?: number; readonly env?: Readonly<Record<string, string>> } = {},
): { readonly code: number; readonly output: string } {
  const result = NodeChildProcess.spawnSync("sh", ["-c", command], {
    cwd,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 120_000,
    env: { ...process.env, ...options.env },
    maxBuffer: 4 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { code: result.status ?? 1, output: output.slice(-1500) };
}

export function toolAvailable(tool: ToolSpec, cwd: string): boolean {
  const probe = tool.probe ?? `command -v ${shellQuote(tool.name)}`;
  return runShell(probe, cwd, { timeoutMs: 30_000 }).code === 0;
}

export function capabilityAvailable(
  contract: RepoContract,
  name: string,
  cwd: string,
): { readonly known: boolean; readonly available: boolean } {
  const capability = contract.capabilities[name.toLowerCase()];
  if (!capability) return { known: false, available: true };
  if (capability.probe === null) return { known: true, available: false };
  return {
    known: true,
    available: runShell(capability.probe, cwd, { timeoutMs: 60_000 }).code === 0,
  };
}

/**
 * A digest of everything whose change could cure a configuration, prerequisite or external
 * failure: the contract, the guard scripts as committed on the given refs, which tools
 * exist and which capabilities probe as available. Equal fingerprints mean nothing that
 * matters has changed, so a held task stays held and costs nothing.
 */
export function environmentFingerprint(input: {
  readonly repoRoot: string;
  readonly loaded: LoadedContract;
  readonly refs: ReadonlyArray<string>;
  readonly extraTools?: ReadonlyArray<string>;
  /**
   * `capabilities` is for blockers that only the outside world can lift (production access, a
   * host): only a capability appearing or disappearing releases them, never a guard or tool fix.
   */
  readonly only?: "capabilities";
}): string {
  const { contract } = input.loaded;
  if (input.only === "capabilities") {
    const caps = Object.keys(contract.capabilities)
      .sort()
      .map(
        (name) => `cap:${name}=${capabilityAvailable(contract, name, input.repoRoot).available}`,
      );
    return NodeCrypto.createHash("sha1").update(caps.join("\n")).digest("hex").slice(0, 16);
  }
  const parts: string[] = [input.loaded.digest];
  for (const ref of input.refs) {
    const head = git(input.repoRoot, ["rev-parse", `${ref}^{commit}`]).stdout;
    if (!head) continue;
    for (const guard of contract.guards) {
      for (const word of guard.run.split(/\s+/)) {
        if (!/\.(py|sh|js|mjs|ts)$|^\.githooks\//.test(word)) continue;
        parts.push(`${ref}:${word}=${git(input.repoRoot, ["rev-parse", `${ref}:${word}`]).stdout}`);
      }
    }
    parts.push(`${ref}:.githooks=${git(input.repoRoot, ["rev-parse", `${ref}:.githooks`]).stdout}`);
  }
  const names = new Set([...contract.tools.map((tool) => tool.name), ...(input.extraTools ?? [])]);
  for (const name of [...names].sort()) {
    const spec = contract.tools.find((tool) => tool.name === name) ?? {
      name,
      probe: null,
      optional: false,
      install: null,
    };
    parts.push(`tool:${name}=${toolAvailable(spec, input.repoRoot)}`);
  }
  for (const name of Object.keys(contract.capabilities).sort()) {
    parts.push(`cap:${name}=${capabilityAvailable(contract, name, input.repoRoot).available}`);
  }
  return NodeCrypto.createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 16);
}

/** The exclusive resources a task needs, from its scope and the commands of its checks. */
export function resourcesNeededBy(
  contract: RepoContract,
  scope: ReadonlyArray<string>,
  commands: ReadonlyArray<string>,
): string[] {
  const needed: string[] = [];
  for (const resource of contract.resources) {
    const byScope = scope.some((pattern) =>
      resource.scope.some((other) => pathMatches(pattern, other) || pathMatches(other, pattern)),
    );
    const byCommand = commands.some((command) =>
      resource.commands.some((expression) => {
        try {
          return new RegExp(expression).test(command);
        } catch {
          return false;
        }
      }),
    );
    if (byScope || byCommand) needed.push(resource.name);
  }
  return needed;
}
