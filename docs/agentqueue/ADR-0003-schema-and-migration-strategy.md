# ADR-0003: Schema and Migration Strategy

## Status

Accepted

## Context

AgentQueue requires a robust relational model to track tasks, dependency DAGs, worker execution leases, file scope reservations, event history, and Git landing requests. Schema changes must be safely applied across existing and new repositories without data loss.

## Decision

1. **Schema Definition**:
   The database schema includes the following primary tables:
   - `agentqueue_migrations`: Tracks applied migration versions.
   - `plans`: Stores registered plan metadata (id, file path, checksum, status, registered_at).
   - `tasks`: The primary unit of work.
     - `id`: TEXT PRIMARY KEY (e.g. `AQ-001` or generated slug/UUID)
     - `plan_id`: TEXT REFERENCES plans(id)
     - `title`: TEXT NOT NULL
     - `description`: TEXT
     - `status`: TEXT NOT NULL ('pending', 'claimed', 'running', 'verifying', 'completed', 'failed', 'blocked')
     - `priority`: INTEGER NOT NULL DEFAULT 100
     - `version`: INTEGER NOT NULL DEFAULT 1 (for CAS optimistic concurrency)
     - `scope_patterns`: TEXT NOT NULL DEFAULT '[]' (JSON array of file globs)
     - `dependencies`: TEXT NOT NULL DEFAULT '[]' (JSON array of task ids)
     - `verification_command`: TEXT
     - `max_retries`: INTEGER NOT NULL DEFAULT 3
     - `retry_count`: INTEGER NOT NULL DEFAULT 0
     - `timeout_seconds`: INTEGER NOT NULL DEFAULT 1800
     - `failure_reason`: TEXT
     - `created_at`: TEXT NOT NULL
     - `updated_at`: TEXT NOT NULL
   - `task_claims`: Tracks active worker ownership and leases.
     - `id`: INTEGER PRIMARY KEY AUTOINCREMENT
     - `task_id`: TEXT NOT NULL REFERENCES tasks(id)
     - `owner_token`: TEXT NOT NULL (unique claim identifier)
     - `worker_pid`: INTEGER NOT NULL
     - `worker_session_id`: TEXT
     - `worktree_path`: TEXT NOT NULL
     - `branch`: TEXT NOT NULL
     - `leased_at`: TEXT NOT NULL
     - `heartbeat_at`: TEXT NOT NULL
     - `expires_at`: TEXT NOT NULL
     - `released_at`: TEXT
   - `task_events`: Durable append-only event log (outbox cursor pattern).
     - `id`: INTEGER PRIMARY KEY AUTOINCREMENT
     - `task_id`: TEXT NOT NULL
     - `event_type`: TEXT NOT NULL ('created', 'claimed', 'heartbeat', 'verification_started', 'verification_passed', 'verification_failed', 'landed', 'released', 'recovered')
     - `payload_json`: TEXT NOT NULL DEFAULT '{}'
     - `created_at`: TEXT NOT NULL
   - `landing_queue`: Serialized integration queue.
     - `id`: INTEGER PRIMARY KEY AUTOINCREMENT
     - `task_id`: TEXT NOT NULL REFERENCES tasks(id)
     - `source_branch`: TEXT NOT NULL
     - `target_branch`: TEXT NOT NULL DEFAULT 'omni/main'
     - `status`: TEXT NOT NULL ('queued', 'merging', 'testing', 'landed', 'failed')
     - `queued_at`: TEXT NOT NULL
     - `started_at`: TEXT
     - `completed_at`: TEXT
     - `error_message`: TEXT

2. **Migration Mechanism**:
   Migrations are defined as forward-only SQL statements keyed by integer versions. On startup, `agentqueue` wraps schema inspection in `PRAGMA user_version` and executes pending migrations inside an immediate transaction.

## Consequences

- Clean, strongly typed domain model represented in SQLite.
- Enables rich DAG queries (recursive CTEs for unsatisfied dependencies).
- Full auditability via `task_events`.
