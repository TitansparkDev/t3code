// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";

export interface VerificationExecutionResult {
  readonly taskId: string;
  readonly commitHash: string;
  readonly verificationCommand: string;
  readonly exitCode: number;
  readonly passed: boolean;
  readonly stdoutSnippet: string;
  readonly stderrSnippet: string;
  readonly durationMs: number;
  readonly verifiedAt: string;
}

/**
 * Runs the task verification command in the worktree and captures receipt.
 */
export async function runVerification(
  taskId: string,
  worktreePath: string,
  verificationCommand: string,
  timeoutMs = 60_000,
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

  let exitCode = 0;
  let stdoutSnippet = "";
  let stderrSnippet = "";

  try {
    const output = NodeChildProcess.execSync(verificationCommand, {
      cwd: worktreePath,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    stdoutSnippet = output.slice(-2000); // Last 2000 characters
  } catch (err: any) {
    exitCode = err.status ?? 1;
    stdoutSnippet = (err.stdout?.toString() ?? "").slice(-2000);
    stderrSnippet = (err.stderr?.toString() ?? err.message ?? "").slice(-2000);
  }

  const durationMs = Date.now() - startTime;
  const passed = exitCode === 0;

  return {
    taskId,
    commitHash,
    verificationCommand,
    exitCode,
    passed,
    stdoutSnippet,
    stderrSnippet,
    durationMs,
    verifiedAt,
  };
}
