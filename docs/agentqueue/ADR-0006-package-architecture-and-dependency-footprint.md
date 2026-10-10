# ADR-0006: Package Architecture and Dependency Footprint

## Status

Accepted

## Context

AgentQueue must be integrated into both the T3 Code monorepo (for server-side Goal execution, web UI rendering, and orchestration) and standalone CLI environments (for manual developer control, shell scripting, and external agent compatibility).

## Decision

1. **Repository Layout**:
   - `packages/contracts/src/queue.ts`: Effect schemas and DTOs shared across server, client, and CLI.
   - `packages/agent-queue-core/`: Pure TypeScript package containing SQLite storage engine, DAG scheduler, verification runner, Git worktree manager, and CLI commands. Uses `better-sqlite3` or Node/Bun SQLite.
   - `apps/server/src/queue/`: Effect service layer integrating `agent-queue-core` with T3 Code `GoalService`, WebSocket event relays, and projection tables.
   - `apps/web/src/components/queue/`: UI components for inspecting DAG, task statuses, worktrees, and integration landing progress.

2. **Zero Unnecessary Dependencies**:
   - SQLite access relies on lightweight, battle-tested native driver (`better-sqlite3`).
   - Git operations use direct child process execution of system `git` with structured argument escaping and timeouts.
   - No heavyweight external daemon or network service required.

## Consequences

- Clean separation between core scheduling logic and UI/RPC transport.
- CLI is fast, responsive, and works out of the box in any shell or worktree.
