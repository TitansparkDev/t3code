// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";

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
  readonly durationMs: number;
  readonly verifiedAt: string;
}

const TAIL_BYTES = 2000;
const KILL_GRACE_MS = 5_000;

const tail = (text: string) => text.slice(-TAIL_BYTES);

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
): Promise<VerificationExecutionResult> {
  const startTime = Date.now();
  const verifiedAt = new Date().toISOString();

  // Retrieve current commit hash
  let commitHash = "unknown";
  try {
    commitHash = NodeChildProcess.execSync("git rev-parse HEAD", {
      cwd: worktreePath,
      encoding: "utf8",
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

  const finished = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    spawnError: string | null;
  }>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = NodeChildProcess.spawn("/bin/sh", ["-c", verificationCommand], {
      cwd: worktreePath,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
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
      resolve({ code, signal, stdout, stderr, timedOut, spawnError });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
    }, timeoutMs);
    // Keep only the tail: a chatty suite must not grow the server's memory.
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(-TAIL_BYTES * 4);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-TAIL_BYTES * 4);
    });
    child.on("error", (error) => done(null, null, error.message));
    child.on("close", (code, signal) => done(code, signal, null));
  });

  const exitCode = finished.timedOut
    ? 124
    : finished.code !== null
      ? finished.code
      : finished.signal
        ? 128
        : 1;
  const passed = !finished.timedOut && finished.code === 0 && finished.spawnError === null;
  const stderrSnippet = tail(
    finished.spawnError
      ? `${finished.spawnError}\n${finished.stderr}`
      : finished.timedOut
        ? `${finished.stderr}\nStopped after ${Math.round(timeoutMs / 1000)}s without finishing; a run that did not finish is not a pass.`
        : finished.stderr,
  );

  return {
    taskId,
    commitHash,
    verificationCommand,
    exitCode,
    passed,
    outcome: passed ? "passed" : finished.timedOut ? "timed-out" : "failed",
    signal: finished.signal,
    stdoutSnippet: tail(finished.stdout),
    stderrSnippet,
    durationMs: Date.now() - startTime,
    verifiedAt,
  };
}
