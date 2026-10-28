// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface VerificationExecutionResult {
  readonly taskId: string;
  readonly commitHash: string;
  readonly verificationCommand: string;
  /** The command's own exit code; 124 when it was stopped for running too long, 128+n for a signal. */
  readonly exitCode: number;
  readonly passed: boolean;
  /** How the run ended. A run that never finished is never "passed". */
  readonly outcome: "passed" | "failed" | "timed-out" | "no-command";
  readonly signal: string | null;
  readonly stdoutSnippet: string;
  readonly stderrSnippet: string;
  readonly diagnosticExcerpt?: string;
  readonly diagnosticLogPath?: string | null;
  readonly durationMs: number;
  readonly verifiedAt: string;
}

const TAIL_BYTES = 8000;
const MAX_LOG_CHARS = 512_000;
const KILL_GRACE_MS = 5_000;

const tail = (text: string) => text.slice(-TAIL_BYTES);

function boundedTail(current: string, appended: string): string {
  const combined = current + appended;
  if (combined.length <= MAX_LOG_CHARS) return combined;
  const start = combined.length - MAX_LOG_CHARS;
  const line = combined.indexOf("\n", start);
  return line < 0
    ? "[Earlier output truncated; long line omitted]"
    : `[Earlier output truncated]\n${combined.slice(line + 1)}`;
}

export function redactVerificationOutput(
  text: string,
  env: Readonly<Record<string, string>> | undefined,
): string {
  const secrets = Object.entries({ ...process.env, ...env })
    .flatMap(([name, value]) =>
      typeof value === "string" &&
      value.length >= 4 &&
      /(?:PASSWORD|PASSWD|SECRET|TOKEN|PRIVATE|CREDENTIAL|AUTH|API[_-]?KEY|ACCESS[_-]?KEY)/i.test(
        name,
      )
        ? [value]
        : [],
    )
    .sort((a, b) => b.length - a.length);
  let redacted = text;
  for (const secret of secrets) redacted = redacted.split(secret).join("<redacted>");
  return redacted
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1<redacted>")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/g,
      "<redacted>",
    )
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<redacted>")
    .replace(
      /(\b(?:password|passwd|secret|token|private[_-]?key|api[_-]?key|access[_-]?key|authorization)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1<redacted>",
    );
}

function diagnosticLine(line: string): boolean {
  return (
    /(?:^|[\s(])[^\s()]+\.(?:kt|java|xml|gradle|ts|tsx|js|jsx|py|go|rs):\d+(?::\d+)?/i.test(line) ||
    /\b(?:error|failed|failure|exception|fatal)\b/i.test(line)
  );
}

function diagnosticExcerptLine(line: string): string {
  if (line.length <= 2000) return line;
  const location =
    /(?:^|[\s(])[^\s()]+\.(?:kt|java|xml|gradle|ts|tsx|js|jsx|py|go|rs):\d+(?::\d+)?/i.exec(line);
  if (!location || location.index < 1200) return line.slice(0, 2000);
  return `${line.slice(0, 256)} … ${line.slice(Math.max(0, location.index - 128), location.index + 1600)}`;
}

function privateLogPath(taskId: string, worktreePath: string): string | null {
  try {
    const gitCommonDir = NodeChildProcess.execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const commonDirectory = NodePath.resolve(worktreePath, gitCommonDir);
    const realCommonDirectory = NodeFS.realpathSync(commonDirectory);
    let directory = commonDirectory;
    for (const segment of ["agentqueue", "verification-logs"]) {
      directory = NodePath.join(directory, segment);
      if (NodeFS.existsSync(directory)) {
        const stat = NodeFS.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      } else NodeFS.mkdirSync(directory, { mode: 0o700 });
    }
    const realDirectory = NodeFS.realpathSync(directory);
    if (
      realDirectory !== realCommonDirectory &&
      !realDirectory.startsWith(`${realCommonDirectory}${NodePath.sep}`)
    ) {
      return null;
    }
    NodeFS.chmodSync(directory, 0o700);
    const safeTaskId = taskId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "task";
    const path = NodePath.join(directory, `${safeTaskId}-${NodeCrypto.randomUUID()}.log`);
    return path;
  } catch {
    return null;
  }
}

function storePrivateLog(path: string | null, stdout: string, stderr: string): string | null {
  if (!path) return null;
  try {
    NodeFS.writeFileSync(path, `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    NodeFS.chmodSync(path, 0o600);
    return path;
  } catch {
    return null;
  }
}

/**
 * Runs the task verification command in the worktree and captures receipt. The command runs
 * asynchronously in its own process group (the server keeps serving while a long suite runs),
 * and a timeout stops the whole group so no test process outlives the check.
 */
export async function runVerification(
  taskId: string,
  worktreePath: string,
  verificationCommand: string,
  timeoutMs = 600_000,
  env?: Readonly<Record<string, string>>,
): Promise<VerificationExecutionResult> {
  const startTime = Date.now();
  const verifiedAt = new Date().toISOString();

  // Retrieve current commit hash
  let commitHash = "unknown";
  try {
    commitHash = NodeChildProcess.execSync("git rev-parse HEAD", {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {}

  // A task with no command is verified by git alone (commit, rebase and clean tree at landing).
  if (verificationCommand.trim() === "") {
    return {
      taskId,
      commitHash,
      verificationCommand: "",
      exitCode: 0,
      passed: commitHash !== "unknown",
      outcome: commitHash !== "unknown" ? "no-command" : "failed",
      signal: null,
      stdoutSnippet: "No verification command; checked by git state only.",
      stderrSnippet: "",
      durationMs: Date.now() - startTime,
      verifiedAt,
    };
  }

  const logPath = privateLogPath(taskId, worktreePath);
  const finished = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    locatedDiagnostics: string[];
    otherDiagnostics: string[];
    timedOut: boolean;
    spawnError: string | null;
  }>((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutLine = "";
    let stderrLine = "";
    const locatedDiagnostics: string[] = [];
    const otherDiagnostics: string[] = [];
    let timedOut = false;
    let settled = false;
    const child = NodeChildProcess.spawn("/bin/sh", ["-c", verificationCommand], {
      cwd: worktreePath,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {}
    };
    const done = (
      code: number | null,
      signal: NodeJS.Signals | null,
      spawnError: string | null,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout,
        stderr,
        locatedDiagnostics,
        otherDiagnostics,
        timedOut,
        spawnError,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
    }, timeoutMs);
    const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString();
      if (stream === "stdout") {
        stdout = boundedTail(stdout, text);
      } else {
        stderr = boundedTail(stderr, text);
      }
      const carry = (stream === "stdout" ? stdoutLine : stderrLine) + text;
      const lines = carry.split(/\r?\n/);
      let remainder = lines.pop()!;
      if (remainder.length > 4096) remainder = "";
      if (stream === "stdout") stdoutLine = remainder;
      else stderrLine = remainder;
      for (const line of lines) {
        if (!diagnosticLine(line)) continue;
        const target =
          /(?:^|[\s(])[^\s()]+\.(?:kt|java|xml|gradle|ts|tsx|js|jsx|py|go|rs):\d+(?::\d+)?/i.test(
            line,
          )
            ? locatedDiagnostics
            : otherDiagnostics;
        if (target.length < 24)
          target.push(redactVerificationOutput(diagnosticExcerptLine(line), env));
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.on("error", (error) => done(null, null, error.message));
    child.on("close", (code, signal) => {
      for (const line of [stdoutLine, stderrLine]) {
        if (!diagnosticLine(line)) continue;
        const target =
          /(?:^|[\s(])[^\s()]+\.(?:kt|java|xml|gradle|ts|tsx|js|jsx|py|go|rs):\d+(?::\d+)?/i.test(
            line,
          )
            ? locatedDiagnostics
            : otherDiagnostics;
        if (target.length < 24)
          target.push(redactVerificationOutput(diagnosticExcerptLine(line), env));
      }
      done(code, signal, null);
    });
  });

  const exitCode = finished.timedOut
    ? 124
    : finished.code !== null
      ? finished.code
      : finished.signal
        ? 128
        : 1;
  const passed = !finished.timedOut && finished.code === 0 && finished.spawnError === null;
  const sensitive: Readonly<Record<string, string>> = env ?? {};
  const redactedStdout = redactVerificationOutput(finished.stdout, sensitive);
  const redactedStderr = redactVerificationOutput(finished.stderr, sensitive);
  const diagnosticExcerpt = redactVerificationOutput(
    [...finished.locatedDiagnostics, ...finished.otherDiagnostics.slice(0, 8)]
      .join("\n")
      .slice(0, 8000),
    sensitive,
  );
  const diagnosticLogPath = storePrivateLog(logPath, redactedStdout, redactedStderr);
  const stderrSnippet = tail(
    finished.spawnError
      ? `${finished.spawnError}\n${redactedStderr}`
      : finished.timedOut
        ? `${redactedStderr}\nStopped after ${Math.round(timeoutMs / 1000)}s without finishing; a run that did not finish is not a pass.`
        : redactedStderr,
  );

  return {
    taskId,
    commitHash,
    verificationCommand,
    exitCode,
    passed,
    outcome: passed ? "passed" : finished.timedOut ? "timed-out" : "failed",
    signal: finished.signal,
    stdoutSnippet: tail(redactedStdout),
    stderrSnippet,
    diagnosticExcerpt,
    diagnosticLogPath,
    durationMs: Date.now() - startTime,
    verifiedAt,
  };
}
