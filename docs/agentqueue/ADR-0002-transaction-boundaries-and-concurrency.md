# ADR-0002: Transaction Boundaries and Concurrency Invariants

## Status

Accepted

## Context

SQLite supports single-writer multi-reader concurrency with WAL mode. Long-held transactions or uncommitted write locks lead to `SQLITE_BUSY` errors and system deadlocks, particularly when automated agents execute commands that may take seconds or minutes (such as LLM generation, test suites, or Git network transfers).

## Decision

1. **Explicit Short Transactions**:
   All state mutations must use explicit `BEGIN IMMEDIATE` transactions scoped strictly to atomic database reads/writes.
   Transactions MUST NOT exceed 100 milliseconds in normal operation (target latency < 10ms).

2. **Strict Invariant: No External Locks Held**:
   The following operations are **strictly prohibited** while holding a SQLite transaction or lock:
   - LLM / ACP model inference or turn generation.
   - External CLI commands, build tools, or test executions (`npm test`, `cargo test`, `pytest`).
   - Git operations (cloning, worktree additions/pruning, rebase, merge, network fetch/push).
   - Network calls, HTTP requests, or websocket wait loops.
   - Long-running disk scans.

3. **Optimistic Concurrency & CAS**:
   Mutations on task claims and state transitions use Compare-And-Swap (CAS) semantics:

   ```sql
   UPDATE tasks
   SET status = :next_status, version = version + 1, updated_at = :now
   WHERE id = :task_id AND version = :expected_version;
   ```

   If zero rows are updated, the caller re-reads the state and handles the race condition cleanly.

4. **Landing Serialization**:
   Landing code into target branches (e.g. `main`) requires a dedicated advisory Git landing lock (`<git-common-dir>/plan-work-landing.lock` / `<git-common-dir>/agentqueue/landing.lock`) using filesystem `fcntl.flock`, separate from the SQLite database. SQLite records the queue request; the landing worker executes outside SQLite transactions.

## Consequences

- Prevents database deadlocks and starvation across parallel workers.
- Guarantees high availability for concurrent status probes and CLI queries.
- Any crash during test execution or Git operations leaves the database unaffected and consistent.
