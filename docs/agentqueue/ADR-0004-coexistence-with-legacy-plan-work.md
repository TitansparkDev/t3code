# ADR-0004: Coexistence with Legacy Plan-Work and PLAN.md

## Status

Accepted

## Context

During Phases 0 through 5 of the AgentQueue implementation, existing workflows and background agents may use `plan-work` (`/home/ajay/.local/bin/plan-work`) and markdown task lists (`PLAN.md`). AgentQueue must not break or conflict with running systems.

## Decision

1. **Existing Plan-Work Untouched Until Replacement**:
   `plan-work` remains the active workflow until AgentQueue passes all automated and pilot tests (Phase 5/6 transition gate).

2. **Dual-Landing Coordination & Lock Sharing**:
   Legacy `plan-work` locks `.git/plan-work-landing.lock` via `fcntl.flock(fd, fcntl.LOCK_EX)`. AgentQueue landing engine will acquire BOTH `.git/plan-work-landing.lock` AND the AgentQueue landing lock before performing any branch merge or fast-forward operation on shared integration targets.
   This guarantees zero landing race conditions between legacy agents and AgentQueue workers.

3. **Plan Markdown Importer / Reconciler**:
   AgentQueue will include a parser capable of importing legacy markdown checklists (`- [ ]`, `- [x]`, `Task N:`) and exporting execution state back to markdown when requested.

## Consequences

- Zero downtime or disruption to parallel work across any repository.
- Safe staged rollout.
