# ADR-0001: Database Location and WAL Mode

## Status

Accepted

## Context

AgentQueue requires a durable, concurrent, cross-worktree persistence store for task state, dependencies, claims, and landing queues. Multiple agents and worker processes may operate simultaneously across different Git worktrees of the same repository. We need a persistence mechanism that:

1. Is shared across all worktrees of a Git repository without path conflicts.
2. Does not pollute the Git working tree with temporary database files or untracked changes.
3. Supports high-concurrency read and write access across multiple independent OS processes.
4. Survives machine reboots, agent crashes, and system restarts.

## Decision

1. **Database Path**:
   The primary database for a repository's queue will reside at:

   ```
   <git-common-dir>/agentqueue/queue.sqlite
   ```

   Where `<git-common-dir>` is resolved via `git rev-parse --git-common-dir` (canonicalized to absolute path). In a standard repository, this resolves to `.git/agentqueue/queue.sqlite`. In linked worktrees, this points to the main repository's common git directory (`.git/agentqueue/queue.sqlite`).

2. **WAL Mode and Pragmas**:
   On initialization and connection open, the following SQLite pragmas will be strictly enforced:

   ```sql
   PRAGMA journal_mode = WAL;
   PRAGMA busy_timeout = 5000;
   PRAGMA synchronous = NORMAL;
   PRAGMA foreign_keys = ON;
   PRAGMA temp_store = MEMORY;
   PRAGMA cache_size = -64000; -- 64MB cache
   ```

3. **Multi-Repo Isolation**:
   Each Git repository has its own independent `queue.sqlite`. There is no global monolith database for all repositories, eliminating blast radius and cross-repo contention.

## Consequences

- **Positive**: All worktrees automatically discover and access the identical queue state without needing central coordination servers.
- **Positive**: `.git/` is naturally ignored by Git status and commits, preventing accidental inclusion of SQLite files in code check-ins.
- **Positive**: WAL mode allows concurrent readers while a writer commits, avoiding reader-writer starvation.
- **Risk Mitigation**: The directory `<git-common-dir>/agentqueue` will be created with `0700` or `0755` permissions with exclusive directory verification.
