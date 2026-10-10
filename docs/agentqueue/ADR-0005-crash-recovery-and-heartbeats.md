# ADR-0005: Crash Recovery and Heartbeats

## Status

Accepted

## Context

Worker processes may crash due to OOM, unexpected system reboot, network interruption, or provider timeouts. A robust lease and fencing mechanism is required to detect dead workers and safely re-queue or quarantine tasks without data loss.

## Decision

1. **Heartbeat Protocol**:
   - Running workers update their `task_claims.heartbeat_at` and `expires_at` every 30 seconds.
   - Default lease duration: 120 seconds (`now + 120s`).

2. **Liveness Verification (Fencing)**:
   - Before declaring a lease expired, the scheduler checks if `worker_pid` is alive on the local host (via `process.kill(pid, 0)` and checking process start time / command).
   - If the PID exists and is verified to be the worker process, the lease is NOT broken even if the heartbeat was delayed due to high CPU load.
   - If the PID is dead or non-existent, the lease is considered abandoned.

3. **Safe Quarantine & Recovery**:
   - When an abandoned claim is detected:
     1. Uncommitted changes in the worker's worktree are inspected. If modifications exist, a recovery stash/branch `recovery/<task-id>-<timestamp>` is created so work is never lost.
     2. Task `retry_count` is incremented.
     3. If `retry_count <= max_retries`, task status returns to `pending`.
     4. If `retry_count > max_retries`, task status is marked `failed` with diagnostic reason, prompting human or Overseer review.

## Consequences

- No abandoned tasks block the queue indefinitely.
- No partial work is deleted or destroyed without preserving a recovery ref.
