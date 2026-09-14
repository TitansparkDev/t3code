# Plan

### 2026-09-14 — Finish master feature integration

#### Bugs

- [x] Segment H — Finish Android background connection support in the active worktree.
  - [x] Finish the constrained Android debug build, or record the exact machine/toolchain blocker
        if the build cannot complete; confirm the new module compiles and the generated manifest has
        the service, boot receiver, permissions, notification channel, and wake handling.
  - [x] Review the staged and unstaged H changes together for foreground/background ownership,
        retained-thread cleanup, relay-account transitions, logout, device restart, permission denial,
        battery restrictions, and multiple environments.
  - [x] Run the focused mobile, persistence, auth, outbox, wakeup, and shared-supervisor checks,
        then commit the complete segment with its test results, changed-file list, and open risks.
        Verification: Android debug APK, 16 Robolectric cases across API 24/26/33/36, and 114 focused
        JS tests plus mobile typecheck/lint. Open risks are platform-specific OEM battery restrictions,
        denied notification permission, and no attached emulator for an end-to-end device pass.

#### Visual

- [ ] Segment I — Land final-answer notifications and Android live update chips after H lands.
  - [ ] Rebase or cherry-pick the already-implemented Segment I branch onto the merged main line
        after H, and resolve shared contract, mobile, and Android conflicts by intent.
  - [ ] Verify final-answer privacy and length limits, empty and Markdown replies, repeated events,
        concurrent environments, foreground transitions, permission denial, cleanup, and older Android
        fallback behavior against the H connection lifecycle.
  - [ ] Run the focused server, client-runtime, mobile, and Android checks; commit the integrated
        result with the exact verification and any environment limitations.

#### Other

- [ ] Segment K — Complete the final integration and release gate.
  - [ ] Integrate H and then I into `omni/main`; A–G and J are already merged, and no partial H
        work may be included.
  - [x] Resolve the post-merge Segment G fork-handler typecheck errors in `apps/server/src/ws.ts`
        and add focused coverage for the corrected RPC error/options shapes.
  - [ ] Re-run targeted tests and typechecks for the affected server, contracts, client-runtime,
        web, desktop, and mobile packages. Review migrations, event compatibility, provider coverage,
        fork-plus-usage-limit-resume behavior, connection ownership, mobile storage, Android services,
        notifications, and Electron shutdown behavior together.
  - [ ] Run the Android debug build after all native changes land. Keep the final real-client web or
        mobile pass behind explicit user permission and use disposable state, never live T3 userdata.
  - [ ] Update `SPEC.md`, `AGENTS.md`, `PLAN.md`, and `tree.txt` to match the final behavior, then
        make the final conventional commit and push only the verified result.
