# Plan

### 2026-09-13 — Master feature integration

#### Bugs

- [ ] Segment B — Stabilize reconnects and provider refresh before adding background connection work.
  - [ ] Inspect PRs [#11456](https://github.com/pingdotgg/t3code/pull/11456) and [#7163](https://github.com/pingdotgg/t3code/pull/7163), including every commit, changed file, review comment, unresolved thread, check result, and linked issue.
  - [ ] Compare both PRs with the current fork and current upstream code. Identify code that already landed, stale assumptions, conflicts with fork changes, missing tests, and regressions before applying anything.
  - [ ] Remove redundant provider refreshes during WebSocket subscription setup and raise the client setup deadline only where slow valid connections need it.
  - [ ] Add the mobile per-environment provider refresh action with clear busy, success, failure, offline, and repeated-tap behavior.
  - [ ] Check local, remote, relay, tunnel, multi-device, and multi-environment behavior. Preserve provider instance isolation.
  - [ ] Add or update focused tests. Run only the relevant server, client-runtime, and mobile checks.
  - [ ] Commit this segment on its own branch and give the integrator the commit hash, changed-file list, test results, open risks, and PR differences.

- [ ] Segment C — Make mobile draft images file-backed and repair draft preference persistence.
  - [ ] Inspect PRs [#9727](https://github.com/pingdotgg/t3code/pull/9727) and [#9372](https://github.com/pingdotgg/t3code/pull/9372), including every commit, changed file, review comment, unresolved thread, check result, and linked issue.
  - [ ] Compare both PRs with the current fork and current upstream code. Identify code that already landed, stale assumptions, conflicts with fork changes, missing migrations, missing cleanup, and regressions before applying anything.
  - [ ] Move draft image payloads from SQLite JSON to app-owned files and store only lightweight references in the draft and outbox data.
  - [ ] Design a safe outbox v4 migration for existing inline images, missing files, cancelled sends, retries, thread deletion, draft replacement, and app upgrades.
  - [ ] Make model and reasoning-effort changes save immediately and persist as the defaults for later threads. Remove the Android confirmation action without removing a clear way to dismiss the screen.
  - [ ] Check storage permissions, file lifecycle, retry behavior, process restart, offline use, and iOS compatibility even though Android is the primary target.
  - [ ] Add or update focused tests. Run only the relevant mobile state and storage checks.
  - [ ] Commit this segment on its own branch and give the integrator the commit hash, changed-file list, test results, open risks, and PR differences.

- [ ] Segment H — Add Android background connection support after Segment B lands.
  - [ ] Inspect PR [#5179](https://github.com/pingdotgg/t3code/pull/5179), including every commit, changed file, review comment, unresolved thread, check result, and linked issue.
  - [ ] Compare the PR with the integrated fork and current upstream code. Identify stale Android APIs, battery or privacy risks, duplicated reconnect work, missing cleanup, and regressions before applying anything.
  - [ ] Implement the foreground service, Headless JS task, wake handling, required manifest entries, notification channel, and the `application-active-preserved` connection path.
  - [ ] Define clear opt-in or settings behavior. Handle notification permission denial, battery restrictions, service termination, device restart, logout, connection removal, and multiple environments.
  - [ ] Confirm that the service keeps only the required connections alive and cannot point development checks at live T3 home data.
  - [ ] Add or update focused TypeScript and Android tests. Run a targeted mobile check and `./gradlew assembleDebug`.
  - [ ] Commit this segment on its own branch and give the integrator the commit hash, changed-file list, test results, open risks, and PR differences.

#### Visual

- [ ] Segment A — Add independent desktop windows.
  - [ ] Inspect the current Electron lifecycle, menu, deep-link, update, shutdown, and server ownership code before changing it. Search current upstream and open issues for related multi-window work.
  - [ ] Replace the single window reference with a registry that creates, focuses, restores, and removes windows safely.
  - [ ] Add File → New Window with `CmdOrCtrl+Shift+N`. Define how CLI arguments, deep links, and second-instance events choose between a new window and an existing window.
  - [ ] Keep one shared background server and prevent one window from stopping it while another window remains open.
  - [ ] Check macOS close-versus-quit behavior, Windows and Linux last-window behavior, updater prompts, saved bounds, external links, and app shutdown.
  - [ ] Add or update focused Electron tests. Run the targeted desktop build or checks without launching browser automation.
  - [ ] Commit this segment on its own branch and give the integrator the commit hash, changed-file list, test results, and open risks.

- [ ] Segment D — Add the web context token badge.
  - [ ] Inspect PR [#11450](https://github.com/pingdotgg/t3code/pull/11450), including every commit, changed file, review comment, unresolved thread, check result, and linked issue.
  - [ ] Compare the PR with the current fork and current upstream code. Confirm the context snapshot meaning, units, provider coverage, layout assumptions, and performance before applying anything.
  - [ ] Show the latest processed token count below the composer without causing extra activity scans or renders.
  - [ ] Handle missing usage data, narrow windows, long values, compact mode, desktop wrapping, and providers that report incomplete counts.
  - [ ] Add or update focused tests. Run only the relevant web checks.
  - [ ] Commit this segment on its own branch and give the integrator the commit hash, changed-file list, test results, open risks, and PR differences.

- [ ] Segment E — Apply the independent mobile interface fixes.
  - [ ] Inspect PRs [#10648](https://github.com/pingdotgg/t3code/pull/10648), [#11445](https://github.com/pingdotgg/t3code/pull/11445), and [#11339](https://github.com/pingdotgg/t3code/pull/11339), including every commit, changed file, review comment, unresolved thread, check result, and linked issue.
  - [ ] Compare all three PRs with the current fork and current upstream code. Identify code that already landed, stale assumptions, accessibility gaps, layout conflicts, missing tests, and regressions before applying anything.
  - [ ] Add a persistent Markdown preview/source toggle for supported files, with a correct fallback for binary, large, missing, and unsupported files.
  - [ ] Parse and blend 8-digit Material You colors correctly so ordinary text and unchanged diff lines remain readable in light and dark modes.
  - [ ] Let tablet and foldable users collapse and restore the sidebar from both a thread and the empty detail view. Preserve phone navigation and layout state during rotation or resizing.
  - [ ] Check accessibility labels, touch targets, focus, theme contrast, foldable size changes, and iOS behavior where shared code changes.
  - [ ] Add or update focused tests. Run only the relevant mobile checks.
  - [ ] Commit this segment on its own branch and give the integrator the commit hash, changed-file list, test results, open risks, and PR differences.

- [ ] Segment F — Detect and open linked development servers on mobile.
  - [ ] Inspect PR [#8562](https://github.com/pingdotgg/t3code/pull/8562), including every commit, changed file, review comment, unresolved thread, check result, and linked issue.
  - [ ] Compare the PR with the current fork and current upstream code. Identify stale network assumptions, unsafe URL handling, platform gaps, missing tests, and regressions before applying anything.
  - [ ] Show development server state on thread rows and open reachable URLs through the mobile browser flow.
  - [ ] Rewrite loopback hosts only when the environment supplies a trusted reachable host. Preserve paths, protocols, IPv6, authentication, and non-loopback hosts.
  - [ ] Check LAN, tailnet, relay, tunnel, offline, stale-process, multiple-server, and untrusted URL cases.
  - [ ] Add or update focused tests. Run only the relevant mobile and contract checks.
  - [ ] Commit this segment on its own branch and give the integrator the commit hash, changed-file list, test results, open risks, and PR differences.

- [ ] Segment I — Add final-answer notifications and Android live update chips after Segments B and H land.
  - [ ] Inspect PRs [#11025](https://github.com/pingdotgg/t3code/pull/11025) and [#11457](https://github.com/pingdotgg/t3code/pull/11457), including every commit, changed file, review comment, unresolved thread, check result, and linked issue.
  - [ ] Compare both PRs with the integrated fork and current upstream code. Identify stale Android APIs, data exposure risks, shared-module conflicts, missing fallbacks, missing tests, and regressions before applying anything.
  - [ ] Extract a short plain-text final answer on the server and include it only in eligible completion notifications.
  - [ ] Use Android expanded notification text with safe length limits and correct handling for Markdown, secrets, empty replies, and locked-device privacy settings.
  - [ ] Add Android 16+ live update chips for active work and required review. Supply normal notification behavior on older or unsupported Android versions.
  - [ ] Add a settings entry that opens the correct Android system screen and explain unsupported states clearly.
  - [ ] Check concurrent threads, multiple environments, cancelled turns, repeated events, app foreground transitions, permission denial, and notification replacement or cleanup.
  - [ ] Add or update focused server, mobile, and Android tests. Run a targeted mobile check and `./gradlew assembleDebug`.
  - [ ] Commit this segment on its own branch and give the integrator the commit hash, changed-file list, test results, open risks, and PR differences.

#### Other

- [ ] Segment G — Add cross-provider conversation forks.
  - [ ] Inspect PR [#11096](https://github.com/pingdotgg/t3code/pull/11096), including every commit, changed file, review comment, unresolved thread, check result, and linked issue.
  - [ ] Compare the PR with the current fork and current upstream code. Identify code that already landed, transcript format risks, provider-specific gaps, missing tests, and regressions before applying anything.
  - [ ] Define the typed fork command and result across contracts, server, web, and mobile before wiring the interface.
  - [ ] Build a bounded transcript handoff from persisted user and assistant turns. Preserve the original thread and create an independent provider session.
  - [ ] Define treatment for tool calls, images, attachments, hidden turns, permissions, pending work, failed turns, context limits, unsupported providers, and deleted projects.
  - [ ] Add fork actions to every suitable thread entry point on web and mobile. Show clear provider, model, progress, success, and failure states.
  - [ ] Check Codex, Claude, Cursor, Grok, OpenCode, and Antigravity. Record an explicit supported or unsupported decision for each provider.
  - [ ] Add or update focused contract, server, web, and mobile tests.
  - [ ] Commit this segment on its own branch and give the integrator the commit hash, changed-file list, test results, open risks, and PR differences.

- [x] Segment J — Add durable automatic resume after a provider limit resets, after Segment G lands.
  - [x] Inspect PR [#8577](https://github.com/pingdotgg/t3code/pull/8577), including every commit, changed file, review comment, unresolved thread, check result, and linked issue.
  - [x] Compare the PR with the integrated fork and current upstream code. Identify stale event shapes, provider classification gaps, timer durability risks, missing cancellation paths, missing tests, and regressions before applying anything.
  - [x] Add typed scheduled, attempted, and cancelled states. Keep timer decisions pure and put provider-specific error classification at adapter boundaries.
  - [x] Persist reset timing and dispatch one hidden continuation when the limit resets. Apply bounded exponential backoff when the provider still rejects work.
  - [x] Cancel or replace the schedule when the user resumes, sends a new prompt, changes provider through a fork, settles or deletes the thread, removes the environment, or another device acts first.
  - [x] Show the scheduled state on web with Resume now and Cancel actions. Ensure mobile can safely observe the new contract even if it has no new control.
  - [x] Check clock changes, process restart, duplicate timers, stale receipts, concurrent devices, all providers, unknown reset times, and remote connection modes.
  - [x] Add focused decider, reactor, persistence, contract, and web tests that wait on receipts and worker drains rather than time-based polling.
  - [x] Commit this segment on its own branch and give the integrator the commit hash, changed-file list, test results, open risks, and PR differences.

- [ ] Segment K — Integrate and verify all completed segments.
  - [ ] Use one clean integration branch. Merge or cherry-pick one reviewed segment at a time in dependency order: A, B, C, D, F, E, H, G, J, then I.
  - [ ] Resolve conflicts from intent, not by choosing one whole side. Re-run the focused checks for both segments after each conflict resolution.
  - [ ] Review the combined contracts, migrations, event compatibility, provider coverage, connection lifecycle, mobile storage lifecycle, Android services, and Electron shutdown behavior.
  - [ ] Confirm every segment includes its audit report, focused tests, and one conventional commit. Do not create upstream pull requests unless the user asks.
  - [ ] Run targeted builds and tests for the changed packages. Do not run the repository-wide suite.
  - [ ] Ask for permission before the one final integrated web or mobile browser pass. Use disposable worktree state and never the live T3 home database.
  - [ ] Run the Android debug build after all native segments land. Confirm that changes marked OTA-safe did not add native dependencies or configuration.
  - [ ] Update `SPEC.md`, this plan, `AGENTS.md`, and `tree.txt` only after the integrated behavior matches reality.
  - [ ] Commit and push the integrated result with the next version tag only after all required checks pass.

- [ ] Coordinator rules for parallel agents.
  - [ ] Give each agent exactly one segment and a separate git worktree and branch. Never let two agents edit the same worktree.
  - [ ] Keep one coordinator and at most three worker agents active. Start Segments A, B, and C in the first wave.
  - [ ] Start D and F in any free worker slots. Start E only after C. Start H only after B. Start G only after C. Start J only after G. Start I only after B and H.
  - [ ] Treat the listed PRs as design inputs, not patches to copy blindly. Every agent must inspect the full PR and the current code, then adapt and fix the design before implementation.
  - [ ] Stop a segment and report to the coordinator when it needs a contract or shared-file change owned by another active segment.
  - [ ] Keep each commit to one concern. A segment can contain more than one conventional commit when it groups separate source PRs. Do not push, tag, release, or open a pull request unless the coordinator assigns that action.
  - [ ] Each handoff must state what changed, what differed from the source PR, what tests ran, what remains uncertain, and the exact commit hash.

### 2026-09-07 — Custom Cloudflare relay

#### Bugs

- [ ] Authenticate the workspace to the user's Cloudflare account and provision the custom T3 Connect relay/domain.
  - [ ] User completes the one-time Cloudflare login and supplies the domain name if it is not discoverable from the account.
