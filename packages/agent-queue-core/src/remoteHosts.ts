/**
 * Remote build machines (the Legion Go S and the laptop) that take queued work before this VM does.
 * Each remote is driven through a client executable (`legion`, `laptop`) that speaks the protocol in
 * `docs/agentqueue/remote-hosts.md`; the remote's own queue stays authoritative because CI shares it.
 */

/** The remote slot a request occupies. Only these classes are ever sent to another machine. */
export type RemoteClass = "heavy_build" | "android";

export interface RemoteHostConfig {
  readonly name: string;
  /** Absolute path of the client executable. */
  readonly client: string;
  readonly enabled: boolean;
  /** VM path prefix -> remote replacement, applied to argv words that start with the prefix. */
  readonly pathMap: Readonly<Record<string, string>>;
}

export interface RemoteHostStatus {
  readonly name: string;
  readonly reachable: boolean;
  readonly accepting: boolean;
  /** Not accepting now, but `<client> wake` may bring it up (idle and on power). */
  readonly wakeable: boolean;
  readonly free: Readonly<Record<RemoteClass, number>>;
  readonly checkedAt: number;
  /** Epoch ms until which this host is skipped after it refused or failed to start a job. */
  readonly coolingUntil?: number;
}

export interface RemotePlan {
  readonly class: RemoteClass;
  /** Top level of the worktree the command runs in; synced to the remote. */
  readonly dir: string;
  /** cwd relative to `dir` ("" at the top). */
  readonly cwdRel: string;
  /** Remote workspace key: stable per worktree. */
  readonly wsKey: string;
  /** Key under which an environment failure is remembered (repo + normalized command). */
  readonly avoidKey: string;
  /** The argv after the host's pathMap is applied. */
  argvFor(host: RemoteHostConfig): string[];
}

export interface RemoteRunResult {
  readonly host: string;
  /** False: the command never started there (refused, busy, unreachable); place it elsewhere. */
  readonly placed: boolean;
  /** It started, then the connection or the remote job was lost before an exit code came back. */
  readonly lost: boolean;
  /** The command's exit code (meaningful only when placed && !lost). */
  readonly code: number;
  /** It failed because the remote lacks something the VM has (tool, SDK, secret); rerun on the VM. */
  readonly envFailure: boolean;
  readonly tail: string;
  readonly runMs: number;
}

export interface RemoteRunOptions {
  readonly timeoutSec: number;
  readonly label: string;
  readonly stdio?: "inherit" | "pipe";
  readonly logFile?: string;
  readonly onStart?: () => void;
  readonly onBeat?: () => void;
}

/** Everything the broker side needs; injectable so tests never touch real machines. */
export interface RemoteDeps {
  hosts(): ReadonlyArray<RemoteHostConfig>;
  statuses(hosts: ReadonlyArray<RemoteHostConfig>): Promise<ReadonlyArray<RemoteHostStatus>>;
  plan(input: RemotePlanInput): RemotePlan | { readonly local: string };
  run(host: RemoteHostConfig, plan: RemotePlan, options: RemoteRunOptions): Promise<RemoteRunResult>;
  coolDown(host: string, ms: number): void;
  recordAvoid(avoidKey: string, reason: string): void;
}

export interface RemotePlanInput {
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  /** Broker resource names the request holds (after normalization). */
  readonly resources: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** First host in configured order that is accepting, has a free slot of `cls`, and is not cooling. */
export function pickHost(
  statuses: ReadonlyArray<RemoteHostStatus>,
  cls: RemoteClass,
  now: number = Date.now(),
): RemoteHostStatus | null {
  return (
    statuses.find(
      (status) =>
        status.reachable &&
        status.accepting &&
        status.free[cls] > 0 &&
        (status.coolingUntil === undefined || status.coolingUntil <= now),
    ) ?? null
  );
}

// Implemented by package P1a; these stubs keep the interface compiling for parallel work.
export function loadRemoteHosts(): ReadonlyArray<RemoteHostConfig> {
  return [];
}
export async function remoteStatuses(
  _hosts: ReadonlyArray<RemoteHostConfig>,
): Promise<ReadonlyArray<RemoteHostStatus>> {
  return [];
}
export function planRemote(_input: RemotePlanInput): RemotePlan | { readonly local: string } {
  return { local: "remote placement is not implemented" };
}
export async function runRemote(
  host: RemoteHostConfig,
  _plan: RemotePlan,
  _options: RemoteRunOptions,
): Promise<RemoteRunResult> {
  return {
    host: host.name,
    placed: false,
    lost: false,
    code: 0,
    envFailure: false,
    tail: "",
    runMs: 0,
  };
}
export function coolDown(_host: string, _ms: number): void {}
export function recordAvoid(_avoidKey: string, _reason: string): void {}

export const REAL_REMOTE: RemoteDeps = {
  hosts: () => loadRemoteHosts(),
  statuses: (hosts) => remoteStatuses(hosts),
  plan: (input) => planRemote(input),
  run: (host, plan, options) => runRemote(host, plan, options),
  coolDown: (host, ms) => coolDown(host, ms),
  recordAvoid: (key, reason) => recordAvoid(key, reason),
};
