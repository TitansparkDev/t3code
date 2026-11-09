# Chat, goals and mobile usability

Improve model selection, context visibility, goal settlement and truthful thread activity across web, desktop and mobile. Preserve provider and account identity, remote connections and existing data.

## Fixed decisions

| Area          | Decision                                                                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pickers       | Search by model, provider and account; show favorites and current selection, retain effort and count, and avoid rendering an unbounded inline list. Use existing provider visibility and availability rules.                                                                                      |
| Context       | Put a ring beside attachment controls on each composer. Show used and maximum tokens, freshness and only provider-reported breakdowns; never invent categories or a maximum. Offer supported manual compaction with an explanation when unavailable. Auto compaction remains provider controlled. |
| Activity      | Distinguish working, waiting for background work, needing input, completed and failed. Derive completion from authoritative active runs and tracked work, not a timer alone; do not let unrelated long-lived servers hold completion. Preserve actionable approvals and interruption.             |
| Goals         | Settle terminal workers and overseers after their work and pending delivery finish, including after goal termination. Retry unsuccessful settlement without interrupting active work or removing escalation history.                                                                              |
| Notifications | Suppress completion notifications for goal workers and overseers using durable identity, not thread titles. Regular threads notify once per actual completion, including remote relay and desktop paths.                                                                                          |
| Upstream      | Review PRs 24512, 27587, 27284 and 31481 against current code; port applicable small changes with attribution and focused regression coverage. Avoid duplicated changes and dependency upgrades solely for parity.                                                                                |

## Worker notes

- One task per worker; the worker owns it until the server confirms it is integrated. The server verifies, merges, and brings the same worker back with exact details if a check or merge needs reasoning.
- Everything needed is in the task text and Fixed decisions. Do not ask the owner anything; nothing in this plan is the owner's to do.
- Files outside `Scope:` that the task truly needs are approved automatically (except protected files; sensitive ones need `SCOPE-REQUEST: path — reason`). A file another running task holds pauses the task until it is free.
- Run checks and shared tools through `agentq run --owner <task id> --defer-after 120 --timeout <seconds> -- <command>`. A busy resource is never a reason to stop or ask; if it answers QUEUED, commit and end the turn with `WAITING FOR <id>`.
- Before finishing, run `agentq task finalize <task id>`; exit 3 means not finished, so fix what it names and run it again.
- Do not merge, rebase onto main, push, or tick checkboxes; the queue records completion.

## Tasks

- [ ] **UX01 — Improve mobile chat model selection.**
  - Depends on: none.
  - Priority: 150
  - Scope: apps/mobile/src/features/threads/ThreadSettingsSheet.tsx, apps/mobile/src/features/threads/thread-settings-sheet-state.ts, apps/mobile/src/features/threads/thread-settings-sheet-state.test.ts, apps/mobile/src/lib/modelOptions.ts
  - Checks:
    - `vp test run apps/mobile/src/features/threads/thread-settings-sheet-state.test.ts` (cwd: ., timeout: 5m, expect: 0)
  - Inspect the current sheet and PRs 24512 and 27587. Make favorites and search discoverable and responsive, including legacy models on explicit search; preserve hidden models, account selection and accessibility. Reuse existing list and persistence; add focused search/filter cases to the existing test.
  - Acceptance: a user can find and select a model from a large multi-account catalog without expanding every provider.

- [ ] **UX02 — Improve goal model selection on mobile and desktop.**
  - Depends on: UX01.
  - Reuse UX01's mobile search and selection behavior.
  - Scope: apps/mobile/src/features/goals/GoalSetupRouteScreen.tsx, apps/web/src/components/goals/GoalSetupPage.tsx, apps/web/src/components/goals/ProviderOptionsPicker.tsx
  - Verify: none — picker interaction and layout are verified together in the client gate.
  - Replace mobile's unbounded inline rows and desktop's separate native lists with accessible searchable selection using existing picker patterns. Preserve environment-local accounts, model options, overseer order and worker count. Reuse UX01 behavior where practical.
  - Acceptance: search and selection work for worker and overseer models at phone and desktop sizes.

- [ ] **CTX01 — Normalize context telemetry and compaction capability.**
  - Depends on: none.
  - Priority: 150
  - Scope: packages/contracts/src/orchestrationV2.ts, apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts, apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts, apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts, apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts
  - Checks:
    - `vp test run apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts -t 'context usage'` (cwd: ., timeout: 5m, expect: 0)
    - `vp test run apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts -t 'context usage'` (cwd: ., timeout: 5m, expect: 0)
  - Trace each provider's usage and compact capability; extend the wire contract only for actual reported category data and freshness. Check upstream PRs 28822, 31601, 31370 and 31203 against current adapters; port applicable behavior. Never infer a breakdown from billing totals. Extend existing adapter tests for fresh, stale, compaction and unsupported data.
  - Acceptance: clients receive truthful current usage, known window and supported compaction state across provider changes and reconnects.

- [ ] **CTX02 — Add context controls to mobile and enrich web.**
  - Depends on: CTX01.
  - Consume CTX01's telemetry and compaction capability contract.
  - Scope: apps/mobile/src/features/threads/ThreadDetailScreen.tsx, apps/mobile/src/components/ComposerToolbar.tsx, apps/web/src/components/chat/ContextWindowMeter.tsx, apps/web/src/lib/contextWindow.ts
  - Verify: none — visual and interaction behavior is covered in the client gate; telemetry is checked by CTX01.
  - Reuse the web meter's ring and compact behavior as the model. Add mobile composer access next to attachments and an accessible breakdown sheet; extend web with reported categories, free space, threshold and update time where known. Handle unavailable telemetry and disabled compaction honestly, without unnecessary polling.
  - Acceptance: both clients expose the same truthful usage and supported compact action with touch and keyboard access.

- [ ] **ACT01 — Track genuine thread activity and waiting.**
  - Depends on: CTX01.
  - Extend CTX01's shared contract after context telemetry lands.
  - Priority: 150
  - Scope: apps/server/src/orchestration-v2/ThreadManagementService.ts, packages/contracts/src/orchestrationV2.ts, packages/client-runtime/src/state/models.ts, packages/client-runtime/src/state/threadInbox.ts, packages/client-runtime/src/state/threadInbox.test.ts
  - Checks:
    - `vp test run packages/client-runtime/src/state/threadInbox.test.ts` (cwd: ., timeout: 5m, expect: 0)
  - Reproduce a provider turn ending with a watcher or subagent and its subsequent continuation using existing background-work fixtures. Trace tracked work through shell projections; preserve a distinct waiting state until owned work resolves, while excluding detached servers and respecting approval, error, stop and reconnect. Extend the lowest-level existing tests that fail before the fix.
  - Acceptance: repeated short watchers and running subagents do not make the parent appear completed between continuations; an actually finished thread returns normally.

- [ ] **GOAL01 — Settle finished goal conversations.**
  - Depends on: ACT01.
  - Use ACT01's authoritative background-work state when settling.
  - Scope: apps/server/src/goals/GoalService.ts, apps/server/src/goals/GoalService.test.ts, apps/server/src/goals/GoalThreads.ts, apps/server/src/goals/GoalThreads.testkit.ts
  - Checks:
    - `vp test run apps/server/src/goals/GoalService.test.ts` (cwd: ., timeout: 10m, expect: 0)
  - Inspect finishOverseer, settleFinishedChats and terminal goal ticks. Reconcile completed workers and overseers after outstanding work and delivery, including retry after failed settlement and stopped goals. Preserve running, held and resumable chats and escalation state; use the engine's settlement operation. Add event-driven regression cases.
  - Acceptance: finished goal chats leave the main active section and their sessions settle without killing ongoing work.

- [ ] **ACT02 — Make notifications follow real completion.**
  - Depends on: ACT01, GOAL01.
  - Use ACT01's activity state and GOAL01's settled lifecycle when publishing notifications.
  - Scope: apps/server/src/relay/AgentAwarenessRelay.ts, apps/server/src/relay/AgentAwarenessRelay.test.ts
  - Checks:
    - `vp test run apps/server/src/relay/AgentAwarenessRelay.test.ts` (cwd: ., timeout: 5m, expect: 0)
  - Trace relay and desktop notification paths. Use durable goal membership and the activity state from ACT01 to suppress goal worker and overseer completion alerts and prevent repeated notifications during watcher continuations. Preserve regular thread completion, failures and actionable notifications, including reconnect and multiple environments. Extend existing relay tests.
  - Acceptance: one regular completion produces one alert; goal completions and intermediate waits produce none.

- [ ] **MOB01 — Integrate applicable mobile performance fixes.**
  - Depends on: UX01, CTX02.
  - Retain UX01's picker and CTX02's composer layout while changing thread rendering.
  - Scope: apps/mobile/src/features/home/, apps/mobile/src/features/threads/, patches/, scripts/legend-list-initial-reveal.test.ts
  - Checks:
    - `vp test run scripts/legend-list-initial-reveal.test.ts` (cwd: ., timeout: 5m, expect: 0)
  - Compare upstream PRs 27284 and 31481 with the current fork and existing caching work. Port applicable shelf and thread-open improvements only when their assumptions match this version; preserve scroll position and streaming behavior. Record measured proxy results and any already-present changes in the task result. Extend existing regression tests for adopted behavior.
  - Acceptance: no redundant list work on shelf expansion and no feed jump when opening long threads.

## Gates

- [ ] **GATE01 — Verify integrated lifecycle and notifications.**
  - Depends on: ACT02.
  - Scope: apps/server/src/goals/, apps/server/src/relay/, packages/client-runtime/src/state/
  - Checks:
    - `vp test run apps/server/src/goals/GoalService.test.ts apps/server/src/relay/AgentAwarenessRelay.test.ts packages/client-runtime/src/state/threadInbox.test.ts` (cwd: ., timeout: 15m, expect: 0)
  - Acceptance: lifecycle and alert regression cases pass together.

- [ ] **GATE02 — Verify integrated client changes.**
  - Depends on: UX02, CTX02, MOB01.
  - Compile UX02's picker, CTX02's context controls and MOB01's performance changes together.
  - Scope: apps/mobile/tsconfig.json, packages/client-runtime/tsconfig.json
  - Checks:
    - `vp run typecheck` (cwd: apps/mobile, timeout: 15m, requires: heavy_build, expect: 0)
    - `vp run typecheck` (cwd: packages/client-runtime, timeout: 15m, requires: heavy_build, expect: 0)
  - Acceptance: integrated mobile and shared client types pass. Use the repository's test-t3-app and test-t3-mobile workflows for one integrated client pass where their fixtures are available.

## Addition 2026-11-08: restore RLY11 repair under the live plan

This restores the pending queue task RLY11 (same id, dependencies and checks as the 2026-10-21 reliability plan) so the queue can re-import it and run its repair. RLY09 and RLY10 are already completed and integrated in the queue.

- [ ] **RLY11 — Build and smoke-test a local rollback-ready server artifact.**
  - Depends on: none.
  - RLY09 and RLY10 are completed and landed in the queue, so they are not listed in this file; this candidate packages the exact integrated, checked revision.
  - Scope: scripts/reliability-artifact-smoke.ts, scripts/reliability-artifact-smoke.test.ts, scripts/smoke-cli-archive.ts, scripts/build-cli-archive.ts, apps/server/scripts/cli.ts
  - Checks:
    - `vp test run scripts/reliability-artifact-smoke.test.ts` (cwd: ., timeout: 2m)
    - `node scripts/reliability-artifact-smoke.ts` (cwd: ., timeout: 15m, requires: heavy_build)
  - Add an artifact smoke wrapper/test that uses the existing build-exe/archive/smoke pipeline, the Node runtime declared in the root `package.json` `engines.node` (read it at run time through `VP_NODE_VERSION`; do not hardcode a version, since the smoke script previously pinned 26.8.2 while the repository requires 26.12.1), and matching built client/runtime dependencies. All output goes to an ignored temporary artifact directory. Reuse valid dependency/build results by revision, perform the local build once, and exercise binary startup plus clean shutdown against an isolated home with no account credentials. Check declared artifact version/hash, required files, port readiness and that the previous candidate remains available for rollback. No provider model calls are required.
  - Acceptance: the self-contained candidate starts and stops within bounded deadlines in the isolated home, checksums/provenance identify the exact integrated revision, and packaging does not read or modify the installed user's database or service.

## Addition 2026-11-09: restore SG05 with the pinned TypeScript compiler

The blocked queue task SG05 called `tsc-rs`, which the pinned `@tsc-rs/typescript@0.8.0` (catalog entry `typescript`) does not provide; its only bin is `tsc`. This restores SG05 under the same id, dependencies and scope, with the same web typecheck run through `tsc`, the compiler that package provides. The check is still required and still runs under heavy_build with expect 0; nothing is exempted. SP02 to SP06 are completed and integrated in the queue, so they are not listed here.

- [ ] **SG05 — Check web and desktop compatibility of the shared cache changes.**
  - Depends on: none.
  - Scope: apps/web/tsconfig.json
  - Checks:
    - `vp exec tsc --noEmit -p .` (cwd: apps/web, timeout: 10m, requires: heavy_build, expect: 0)
  - Local-hosted web, hosted web and the Electron desktop consume the shared cache defaults (SP02, SP03), supervisor lifecycle (SP04), snapshot compatibility (SP05) and presentation (SP06). `apps/web` has no `typecheck` script, so run `tsc` directly. Desktop shell/IPC is unchanged; do not alter it to satisfy web compile errors.
  - Acceptance: web types pass, and mobile-only retention and banner settings are not imposed on web or desktop.

Final verification: `vp test run packages/client-runtime/src/state/threadInbox.test.ts apps/mobile/src/features/threads/thread-settings-sheet-state.test.ts` (cwd: ., timeout: 10m)

## Limits

- Provider breakdowns and manual compaction are limited to capabilities each provider actually exposes.
- Physical-device performance, live provider accounts and iOS native verification require provisioned environments; automated fixtures cannot establish real network latency.
