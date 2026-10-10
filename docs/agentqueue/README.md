# AgentQueue Architecture Documentation

This directory contains the Architecture Decision Records (ADRs) and design documentation for AgentQueue, a high-reliability autonomous work scheduling and serialized integration system for multi-agent software engineering.

## Architecture Decision Records (ADRs)

- [ADR-0001: Database Location and WAL Mode](ADR-0001-database-location-and-wal.md) - Location at `<git-common-dir>/agentqueue/queue.sqlite` and WAL concurrency pragmas.
- [ADR-0002: Transaction Boundaries and Concurrency Invariants](ADR-0002-transaction-boundaries-and-concurrency.md) - Explicit short `BEGIN IMMEDIATE` transactions; absolute prohibition of locks held over model calls, Git operations, or test runs.
- [ADR-0003: Schema and Migration Strategy](ADR-0003-schema-and-migration-strategy.md) - Relational data model for tasks, claims, outbox event log, and serialized landing queue.
- [ADR-0004: Coexistence with Legacy Plan-Work and PLAN.md](ADR-0004-coexistence-with-legacy-plan-work.md) - Safety protocol for running alongside existing `plan-work` and dual-lock landing coordination.
- [ADR-0005: Crash Recovery and Heartbeats](ADR-0005-crash-recovery-and-heartbeats.md) - Lease expiry, PID liveness fencing, and worktree recovery preservation.
- [ADR-0006: Package Architecture and Dependency Footprint](ADR-0006-package-architecture-and-dependency-footprint.md) - Monorepo package boundaries (`packages/contracts`, `packages/agent-queue-core`, `apps/server/src/queue`).
