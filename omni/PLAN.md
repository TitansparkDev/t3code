# OmniCode — worklist

Only unfinished work lives here. `omni/CONVERSION.md` explains why this fork exists and
what was decided; `OMNI.md` is the merge discipline. Delete a task when it's done — git
history is the changelog.

Product requirements come from OmniLink's `SPEC.md` (`Titanspark21/omnilink`), specifically
§7 (UI), §8 (features) and §13 (verified on-machine findings). Where this plan and that
spec disagree, this plan wins — see `omni/CONVERSION.md` §2 for what changed.

**Rule for every task below: add files, don't edit them.** Read `OMNI.md` before you touch
anything that already exists.

---

## Read this first — where the fork actually stands

Quota is now the first fork feature wired end to end: canonical provider events feed an
instance-keyed service, typed snapshot and subscription RPCs cross the wire, shared client
state merges environments without collapsing accounts, and web/desktop mount an honest
bottom-left limits panel. Focused automated verification passes; the real Codex/Claude and
visual gates remain because Claude is not authenticated and `AGENTS.md` requires explicit
approval before browser use.

Antigravity is now registered and selectable in the server and Add Provider flow. Its ACP
adapter, bridge isolation, multi-pool quota normalizer, trust-prompt guard and combined quota
headline are wired. Coding turns now preserve terminal output and fail visibly instead of ending
after tool calls with no response. The remaining Stage B work is visual/live verification.

---

## Stage 0 — prove the ground before building on it

- [ ] **S1 — Toolchain and licence.** Substantially done; one gate remains.
  - [x] `vp` installed; its shim supplies Node 24.19, satisfying the repo's `^24.13.1`.
  - [x] `vp i` succeeds — **but only as `vp i --filter=!@t3tools/mobile`.** A plain
        `vp i` dies with `ERR_PNPM_EPERM` while unpacking Expo packages
        (`expo-camera`, then `expo-paste-input`), and a retry just moves the failure to a
        different package. It is _not_ the Windows path limit — long paths are enabled
        and Node copies a 334-char path here, while the failures were at 290. It's
        Defender's real-time scanner locking prebuilt native mobile binaries (an iOS
        `.dSYM` bundle, a compiled Android `.dex`) mid-copy. Excluding the mobile
        workspace removes the whole failure class and costs nothing, since the decision
        is to use upstream's published mobile app rather than build it. Use that flag
        for every install, including after upstream syncs.
  - [x] Licence question — answered from VoidZero/Vite+ primary sources in
        `omni/TOOLCHAIN.md`: Vite+ is free/open source under MIT as of 2026-08-15.
  - [x] Run the source checkout on Windows — migrations complete, the backend listens, and
        Vite+ serves the web client from the isolated worktree home.
  - [x] Real Codex turn through the product — the orchestration HTTP API completed an actual
        `gpt-5.6-sol` turn and projected its native usage into `context-window.updated`
        (`23,942 / 258,400` tokens observed during the probe).
  - [ ] Real Claude turn — environment blocker, not a product failure: Claude Code `2.1.233`
        is installed but `claude auth status` reports `loggedIn: false`, `authMethod: none`;
        both `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are unset. Authenticate Claude
        on this Windows account, then rerun the source-product turn gate.
        **This now blocks more than S1**: B2's Claude rows, B6's binding-window fix and the
        C2 reproduction all need a live authenticated Claude account to verify against.

- [ ] **S2 — Use it as-is for a week.** Real work, Claude and Codex, no changes.
      This is a task, not a suggestion. Half of Stage 2 may stop mattering once you've
      lived with the thing, and you'll find out which parts of OmniLink's spec you actually
      miss versus which you only think you miss.
      _Gate: a written list of what genuinely annoyed you, in priority order. Re-order the
      rest of this plan against it._

- [ ] **S3 — Repair fresh-lock release smoke.** The checked-in lockfile and desktop builds use
      the patched `expo-sharing@57.0.16`, but a fresh lock resolves the mobile dependency past
      that exact patch and fails with `ERR_PNPM_UNUSED_PATCH`. Decide whether to pin the mobile
      dependency or refresh the patch before the next mobile or lockfile release.

---

## Stage B — Usage limits, visible

Promoted above Stage A. It is the thing that gets used every day, it is closest to done,
and — unlike the agy work — nothing in it is blocked on a 1,200-line adapter.

### The upstream branch you must look at before writing any more of this

**`upstream/t3code/usage-limits-analytics`** (8 commits, 2026-08-08, unmerged, not in
`main`). It builds much of the same idea:

- `apps/server/src/usage/AccountLimitsService.ts` — one cached snapshot per provider, fed
  passively from `account.rate-limits.updated`
- `accountLimitsTranscripts.ts` — **seeds Codex limits from the `rate_limits` objects its
  transcripts already carry on disk**, so numbers survive a restart
- a `ClaudeAdapter.ts` change that pulls the **full** window set through a throttled SDK
  usage control request
- `server.getAccountLimits` RPC, wired through `ws.ts`, `rpc.ts`, `RpcAuthorization.ts`
- `apps/web/src/state/accountLimits.ts` — client state that merges across environments and
  keeps the freshest snapshot
- `AccountLimits.tsx` — a Limits strip on the Usage page **plus a hover card on the sidebar
  Usage button**, and `limitsFormat.ts` for the copy

**Its data model is wrong for this fork and its plumbing is right.** Upstream keys by
`UsageProviderKind` — the contract comment literally says "At most one snapshot per
provider". With Codex 1 + Codex 2 + Claude 1 + Claude 2 configured, that collapses four
accounts into two rows showing whichever account reported last. That is exactly the
confident-wrong-number failure `packages/contracts/src/quota.ts` exists to prevent, and
this fork's model — keyed by `ProviderInstanceId`, with multiple groups per account — is
the correct one.

- [x] **B0 — Decide how to take that branch.** Decision: **(b), lift only the
      findings into fork-local files.** Re-read through `500cb9609` after the
      2026-08-23 upstream sync. The branch's RPC/auth/ws plumbing, Codex transcript
      seed, Claude full-window request and limits copy are useful; its one-snapshot-
      per-provider service is still incorrect for multiple accounts, and cherry-picking
      would take 22 high-churn upstream files. The durable decision is recorded in
      `omni/CONVERSION.md` decision 9.

### Built — quota core

- [x] **Contracts** — `packages/contracts/src/quota.ts`. New file, keyed by
      `ProviderInstanceId`, multiple `QuotaGroup`s per account (so agy's several pools need
      no special case later), windows classified by published duration, and absence
      modelled as absence rather than zero.
- [x] **Normalizer** — `apps/server/src/quota/normalizeRateLimits.ts` + tests. Codex and
      Claude payloads folded into that shape; sparse updates merged onto the previous
      snapshot so a rolling `primary`-only message can't erase `secondary`; unknown drivers
      return `undefined` rather than guessing.
- [x] **Reducer** — `apps/server/src/quota/quotaReducer.ts` + tests. Applies events to a
      `ReadonlyMap<ProviderInstanceId, AccountQuotaSnapshot>`, returns the same object when
      nothing changed (so the sidebar doesn't repaint on every assistant delta), forgets an
      instance when it's removed, and `isRateLimited` already self-clears on staleness and
      on a reset time that has passed — the logic C2 needs.

### Left to do

- [ ] **B1b — Wire the reducer to the event stream and the wire.** Core implementation
      landed on 2026-08-23; the live-product gate remains.

  - [x] Subscribe at `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` — that
        is where runtime events already land, and it is the file upstream's branch touched for
        the same reason.
  - [x] Hold the state in a fork-local service (`apps/server/src/quota/QuotaService.ts`), not
        inside an existing upstream service.
  - [x] Expose it: an RPC returning the snapshot map, plus a push so the panel is live rather
        than polled.
  - [x] Client state in `apps/web/src/state/quota.ts`, preserving environment identity while
        merging live snapshots from every connected environment.
  - [x] **Contracts only for mobile.** `apps/mobile/` stays untouched per `OMNI.md`; the panel
        is web + desktop. Say so in the commit body so it isn't read as an oversight.

  - [ ] _Live gate:_ real Codex and Claude figures land in the client, observed live, not in
        a test. Claude is blocked on authentication; browser/client verification requires the
        developer's explicit approval under `AGENTS.md`.

- [ ] **B2 — The panel. Bottom-left, always visible.** The web/desktop implementation landed
      on 2026-08-23; Antigravity aggregation landed on 2026-08-27. The visual/live gate remains.
      Mount inside `SidebarChromeFooter` in
      `apps/web/src/components/sidebar/SidebarChrome.tsx` — one import plus one JSX line, and
      both `Sidebar.tsx:3806` and `LegacySidebar.tsx:3700` already render that footer, so a
      single insertion covers both shells. Everything else goes in new files under
      `apps/web/src/components/quota/`.

      **Rows come from configured provider instances only** — decided. Add a third Codex
                  account and a row appears; remove one and it goes. Display name and accent colour come
                  from the instance config (OmniLink `SPEC.md` §7.5). Nothing is hard-coded, so
                  "Codex 1, Codex 2, Claude 1, Claude 2" is what *your* setup renders, not what the code
                  says.

                  **The agy row is a single combined row.** Its compact identity is `AGY` / `Combined`,
                  with the same fixed 5-hour and weekly columns as Codex and Claude. Clicking expands it to
                  one row per configured AGY instance, including the account email that instance actually
                  reported. Each duration uses the most constrained provider pool within an instance before
                  averaging fresh instances, so an exhausted Claude/GPT pool cannot be hidden by Gemini.

                  **Honesty rules, non-negotiable.** A group whose data can't be read shows an explicit
                  "not exposed" state. A snapshot past `QUOTA_SNAPSHOT_STALE_AFTER_MS` renders as stale
                  with its age, never as a current figure. Never a guessed or extrapolated number.

                  Reset countdowns on hover; click a row to refresh. Respect `AGENTS.md`: no
                  continuously repainting animation — countdowns tick on a coarse interval, and the
                  collapsed state must not re-render on unrelated sidebar traffic.

                  - [x] Mount once in `SidebarChromeFooter`, covering both sidebar shells.
                  - [x] Render enabled configured instances with their display names, provider icons,
                    accent colours, environment identity, multiple quota groups and reset detail.
                  - [x] Render explicit no-data, not-exposed and stale states; update countdowns once per
                    minute and publish no quota update for unrelated provider traffic.
                  - [x] Combine Antigravity accounts into the decided average headline with per-account
                    expansion. The layout remains one full-width row at wide and narrow sidebar sizes;
                    stale and absent accounts do not become zeroes.
                  - [ ] _Visual/live gate:_ inspect both sidebar shells with real Codex and Claude data,
                    including narrow width, stale data, multiple environments and keyboard focus.

- [ ] **B5 — Hover detail in the provider/account selector.** Implementation landed on
      2026-08-23; the visual/live gate remains.
      Hovering a provider/account in the picker shows a popup with that account's 5-hour and
      weekly usage. Cover both entry points, per `AGENTS.md`'s hit-every-surface rule:

      - the composer picker — `apps/web/src/components/chat/ModelListRow.tsx` is the row;
                    `ModelPickerContent.tsx` and `ProviderModelPicker.tsx` are its hosts
                  - Settings → Providers — `apps/web/src/components/settings/ProviderInstanceCard.tsx`

                  Reuse whatever B2 renders for a single account rather than writing second copy. The
                  upstream branch's `limitsFormat.ts` is worth reading for the wording it settled on
                  after two follow-up commits ("unambiguous limits copy", "reset text no longer wraps").
                  `QuotaAccountDetails` is now reused by both surfaces; the composer passes its active
                  environment through the picker so identical instance ids on two machines never
                  cross streams, while Settings uses its selected environment directly.

                  - [x] Composer model rows expose the selected account's live detail on its provider
                    label without adding a subscription per virtualized row.
                  - [x] Settings → Providers account headings expose the same detail component.
                  - [ ] _Visual/live gate:_ verify hover placement, keyboard access, narrow picker
                    layout, disabled model rows and real short/long windows on both surfaces.

- [ ] **B6 — Claude's streamed event only names the binding window.** New, and a real
      correctness gap.
      `normalizeClaudeRateLimits` parses defensively across several shapes, but the source
      event is the constraint: upstream's branch notes at `ClaudeAdapter.ts:3430` that the
      streamed `rate_limit_event` reports **only the window currently binding**. So a purely
      passive listener can populate 5-hour _or_ weekly, never reliably both — and B5
      explicitly promises both. The fix upstream chose is a throttled SDK usage control
      request pulling the full set (see `MIN_USAGE_CONTROL_INTERVAL`, `ClaudeAdapter.ts:106`).
      B0 decided to lift the behavior rather than cherry-pick the branch. Implement the
      narrowest adapter-bound equivalent of that throttled full-window request. The adapter pull,
      three-minute throttle, full-window normalizer and focused tests landed 2026-08-24; only the
      authenticated live gate remains.
      _Gate: a Claude account showing 5-hour and weekly simultaneously, verified live._

- [x] **B7 — Cold start.** Implemented 2026-08-24.
      An always-visible panel is empty on launch, because providers publish limits only as a
      side effect of doing work. Two different answers, and the panel must not pretend
      otherwise: - **Codex** — recoverable. Its transcripts carry `rate_limits` objects on disk;
      upstream's `accountLimitsTranscripts.ts` already reads them. Take or reimplement. - **Claude** — not recoverable. Limits never hit disk, so a fresh launch genuinely
      cannot know. The row must say "no data yet — send a message" rather than showing a
      blank bar that reads as 0% used.
      B0 is resolved. The honest Claude empty-state copy shipped with B2. Codex now scans bounded
      recent transcript tails at startup, ignores side meters and ambiguous shared multi-account
      directories, and replaces seeded snapshots when newer live events arrive.

- [x] **B3 — agy quota.** The server normalizer and instance-keyed ingestion now preserve agy's
      **more than one pool per account** —
      Gemini models in one, Claude/GPT models in another, each with independent weekly and
      5-hour windows (OmniLink `SPEC.md` §8.6.2, confirmed from live output). `QuotaGroup`
      now parses the bridge's pool shapes, and the combined B2 row averages across _pools within_
      an account as well as across accounts.

- [ ] **B4 — Revisit upstreaming after B1b + B2.** B0 chose the fork-local lift. This
      task used to say "offer B1+B2 upstream". Upstream has since built their own version on
      `t3code/usage-limits-analytics`, so the offer is no longer "here's a feature you don't
      have" — it's at most "your snapshot-per-provider model breaks with two accounts on one
      provider, here's the instance-keyed version". That is a smaller, better-targeted
      contribution and worth making _only after_ B1b and B2 prove it works here. If their
      branch lands first, sync and re-scope this to the keying fix alone.

---

## Stage C — the limit failure, and the rest

- [ ] **C1 — Verify the upstream lifecycle repairs against the original stuck-Working
      regression, then fix only any residual.** The 2026-08-23 upstream sync brought the
      exact Codex fix (`4e00471d1`, a completed child was incorrectly reactivated when its
      result was read), startup reconciliation for orphaned provider sessions (`0929907ff`),
      protection against status-free progress reviving idle work (`82b8a9380`), and a hard
      Claude Stop path (`4d12e5222`). Do not duplicate those changes. The remaining work is
      a focused real Codex + Claude verification of the original gate below and regression
      coverage/implementation only for a behavior that still fails.

      Original symptom: this was a real observed failure, not a timer-display bug. A turn can finish, and its final assistant summary (and
                  sometimes its final tool rows) can already be visible, while T3 Code keeps the thread in
                  `working` for hours. The same stale tool calls remain on screen, the Working timer keeps
                  increasing, and the red Stop button can do nothing. The reliable workaround observed on the
                  Windows fork is to send another message, creating a fresh turn, then Stop that new turn; only
                  then does the thread settle and the already-finished summary remain visible.

                  **Investigation finding:** transcript completion and lifecycle completion are separate event
                  paths. `ChatView`/`derivePhase` treats the projected session/thread `running` state as
                  authoritative for the Working UI. `ProviderService.sendTurn` persists `running` plus an
                  `activeTurnId`, and normal completion depends on a later terminal runtime event being mapped
                  and ingested to clear it. The red button calls turn interrupt only; `ProviderService.interruptTurn`
                  does not reconcile the persisted/projected state afterward. Therefore, if the provider has
                  actually become idle but the terminal lifecycle event was lost, rejected or never mapped,
                  interrupt can legitimately have nothing left to interrupt and the stale `running` projection
                  survives forever. Codex has an additional sharp edge: terminal `turn/completed` mapping can
                  currently return no canonical event when the native payload fails schema decoding, and its
                  child-thread notification routing is complex enough that this exact class of root completion
                  loss has happened before (there is already a guard against registering `/root` as its own
                  child). Claude likewise relies on its result/stream terminal path rather than interrupt itself
                  making the session ready. Fix the invariant across providers, not just one symptom.

                  Implementation order:
                  1. **Lock the bug down with regression tests first.** Cover “final assistant item visible but
                     lifecycle projection still running”, “provider is already idle when Stop is pressed”, and
                     “a normal active turn is interrupted”. Put common lifecycle tests in
                     `ProviderRuntimeIngestion.test.ts` / `ProviderCommandReactor.test.ts`; add provider-focused
                     cases in Codex and Claude adapter/runtime tests. Include a Codex multi-agent fixture where
                     root and child notifications are interleaved so a child can never consume the root
                     `turn/completed` event.
                  2. **Make Stop reconcile, not merely request an interrupt.** After the provider interrupt
                     path returns, obtain provider-authoritative session state. If the provider confirms there
                     is no active turn (ready/idle/error/closed), repair the canonical session projection and
                     persisted binding by clearing `activeTurnId` and applying the matching terminal/ready
                     state. If work is genuinely still active, keep it Working. Do not treat an orchestration
                     turn id as a provider-native turn id.
                  3. **Harden terminal-event ingestion.** A native terminal event must never disappear silently.
                     Codex terminal decode/routing failures need a logged/observable fallback that triggers
                     reconciliation instead of returning `[]` and leaving `running` behind. Treat an
                     authoritative root-thread idle/ready signal as another reconciliation opportunity, while
                     keeping child-thread idle signals isolated from the parent. Apply the same invariant at
                     provider stream exit/error boundaries.
                  4. **Repair stale persisted state on reconnect/reload.** When a live provider session says it
                     is ready/idle but the saved binding says running, reconcile to the provider rather than
                     resurrecting an hours-old Working state. Preserve queued/follow-up semantics: never clear
                     `running` if another provider turn is actually active or queued to become active.
                  5. **Make the Stop UX reflect backend truth.** While an interrupt/reconciliation request is
                     in flight, show a bounded “Stopping…” state and prevent duplicate clicks. When the backend
                     reports already-idle/reconciled, immediately restore the Send control and stop the timer.
                     Do not optimistically mark a genuinely active agent finished just to make the UI look
                     responsive.
                  6. **Add diagnostics for the invariant.** Log/measure repairs such as “projection running,
                     provider idle”, dropped/undecodable terminal events, and interrupts that found no active
                     provider turn. That makes any remaining provider-specific recurrence diagnosable from one
                     event trail instead of another multi-hour visual hang.

                  **Do not solve this with an elapsed-time cutoff.** Legitimate agents may run for hours. State
                  must end because a provider-terminal/idle condition is confirmed, never because the Working
                  timer crossed an arbitrary duration.

                  **Progress (2026-08-28):** the Stop path now reads the routed provider session after a
                  successful interrupt, persists the observed ready/stopped/error state, and emits a canonical
                  `session.state.changed` reconciliation event. The active composer keeps a
                  thread-and-turn-scoped “Stopping generation” state until that lifecycle projection settles,
                  prevents duplicate requests, and does not leak the disabled control across thread switches.
                  Codex terminal decode failures now emit an observable warning plus a terminal lifecycle
                  fallback; a failed Codex event consumer emits an error-state repair; startup compares live
                  provider session state with persisted projections and repairs idle/error/closed mismatches
                  without copying provider-native turn ids into orchestration state. Stale lifecycle events are
                  logged with their active/pending turn context. Focused adapter, startup, ingestion, reactor,
                  and web regression tests pass. The authenticated Codex/Claude live gate remains.

                  _Gate: after every normal Codex and Claude completion the final summary remains visible,
                  Working ends promptly, the timer stops, stale live tool rows are terminal, and Send returns;
                  Stop terminates a genuinely active turn; Stop also clears a stale-running projection when the
                  provider is already idle; no second user message is required; reload/reconnect cannot revive
                  a completed turn as Working; long-running legitimate turns remain Working; queued follow-ups
                  and Codex multi-agent child turns cannot incorrectly settle the parent._

- [ ] **C2 — The unrecoverable chat. Reproduce it before fixing it.** Expanded — this is the
      bug you actually hit, and it is currently the fork's most user-visible defect.
      _Symptom, from the developer:_ hitting a usage limit produces an error and the thread
      is unrecoverable **even after the window has reset**. Restarting the thread is the only
      way out.
      _What's known:_ `apps/server/src/orchestration/` contains **zero** rate-limit handling
      today — grep confirms it — so this is upstream's generic turn-failure path, not
      anything the fork introduced. `isRateLimited` in `quotaReducer.ts` already implements
      the self-clearing half (stale snapshots and passed reset times both clear), but it is
      wired to nothing.
      **Diagnose before coding.** The fix differs entirely depending on which of these it is,
      and guessing has already cost time elsewhere: - a thread status latched to an error state that no later event clears; - a provider session that died and is never re-spawned, so every subsequent send goes
      into a dead process; - a queued message stuck in a non-retryable state; - the error surfacing as an unreadable raw provider dump with no recovery affordance.
      _Then build:_ latch a `rate-limited` state that later redraws can't flip back to
      "working"; hold queued messages rather than firing them into a dead session; show a
      banner naming the window and its reset time; and — the part that fixes the actual
      complaint — **an explicit way back**, either automatic on reset or a visible "resume"
      control, with a test that proves a thread recovers after the window rolls over.
      **No automatic account rotation** — notify and pause (OmniLink `SPEC.md` §5.4, §8.9).
      Rule from OmniLink's parser work: 90% used is _not_ limited; ≥100% or an explicit
      limit signal is.
      **Progress (2026-08-28):** explicit `429`, rate-limit, quota-exceeded and usage-limit turn
      failures now get recovery-oriented copy and a distinct activity summary. The orchestration
      contract, event projector, web/desktop, mobile, inbox/settle rules and agent-awareness
      projection now carry a durable `rate-limited` session state; passive provider `ready`,
      `started`, `completed` and exit redraws cannot erase it. The next send explicitly clears the
      latch before reusing/restarting the provider session. Generic failures and percentage-only
      usage remain unchanged. Focused regression coverage proves the state survives a redraw and
      recovers on retry.
      The remaining gate is authenticated live reproduction with a real reset window, plus the
      visual check of the banner/status in both client families. Needs S1's Claude authentication
      for the Claude half.

      **2026-08-28 follow-up:** explicit limit detection and recovery copy now live in
                  `packages/shared`, so server classification, web banners, and the mobile in-thread notice
                  cannot drift. Mobile no longer requires navigating to the thread list to discover the
                  recoverable state. The code-level recovery path is complete; authenticated live reproduction
                  and visual checks remain the only C2 gates.

- [x] **C3 — Slash-command catalogue, fully featured.** Upstream carries
      `ServerProviderSlashCommand { name, description?, input? }`
      (`packages/contracts/src/server.ts:81`) — whatever the provider reports, name and blurb.
      Enrich it: exact syntax, argument help, side effects, whether it interrupts work,
      where its output appears, and a minimum verified CLI version with an explicit
      "not supported by this installed version" state. OmniLink verified 39 commands from
      provider-owned sources (Claude's official reference, Codex's `rust-v0.145.0` source,
      agy's documented text) — that research carries over intact.
      Only ever show the active provider's real commands. Never guess.
      **2026-08-27 progress:** the wire contract and command drawer now carry/render syntax,
      argument help, side effects, during-work behavior, output location, version floor and
      supported/unsupported state. Claude commands reported by the active SDK session are enriched
      from the verified catalogue; missing commands stay hidden on current CLIs, while commands
      requiring a newer installed Claude version appear disabled. Codex's app-server currently
      reports only `/feedback`, which is enriched; its TUI-only catalogue is deliberately not
      advertised through the app-server transport. Antigravity now exposes its conservative
      seven-command catalogue (`/help`, `/config`, `/settings`, `/model`, `/planning`, `/mcp`,
      `/quit`) from successful CLI probes, with support gated at the verified 1.1.7 floor. The
      catalogue stays visible but explicitly unverified when the CLI version cannot be parsed;
      optional bridge notifications are not required and undocumented TUI commands are not guessed.

- [ ] **C4 — Fork and handoff.** Lower priority, and worth re-checking after S2 — upstream's
      thread creation plus compatible-account continuation may already cover most of it.
      What's genuinely missing (OmniLink `SPEC.md` §8.5b): a deterministic, no-AI, no-network
      `HANDOFF.md` composed from the source thread and written into the checkout; the new
      thread opened with that brief sitting **unsent** in its composer so no provider turn is
      spent; and lineage visible in both directions in the header.
      The detail that makes it good: the target picker lists **quota groups with live
      remaining %**, not provider names — you choose by looking, not remembering. Needs B2.
      **2026-08-28 progress:** the deterministic brief, empty target thread, unsent draft,
      bidirectional activity lineage, web/native entry points, and quota-aware target selection
      are implemented. The shared resolver keeps account identity instance-scoped, maps
      multi-pool groups to an appropriate model, sorts fresh pools by remaining capacity, and
      labels stale/missing data without inventing percentages. The remaining gate is live visual
      verification of the picker and its no-turn handoff result.

- [x] **C5 — Windows binary probing.** Implemented 2026-08-24. _What this is:_ when the app looks for `claude`,
      `codex` or `agy`, a Microsoft Store stub or ACL-blocked packaged-app resource can
      appear before the real CLI on `PATH`. The 2026-08-23 upstream audit narrows this task:
      `packages/shared/src/shell.ts` now honours Windows `PATHEXT`, and provider health
      checks already run the chosen command's version probe. What remains is that command
      resolution still stops at the first filesystem-executable candidate; when that
      candidate cannot actually launch, the probe must continue to the next matching path entry.
      The shared verified-candidate iterator now does that for Codex, Claude and Antigravity probes,
      then promotes the verified directory for subsequent session spawns. Focused coverage includes
      `.COM`/`.EXE`/`.BAT`/`.CMD`, a blocked first candidate and a working second candidate. Good
      upstream candidate.

- [x] **C6 — Your theme.** Implemented 2026-08-28. OmniCode is a dark-first, restrained
      slate-and-cyan palette with a light companion, registered in the shared theme registry so
      web, desktop, mobile, previews, and the mobile terminal all consume the same semantic roles.
      Appearance settings now render that shared registry directly, avoiding another client-only
      theme list. Focused web/mobile palette tests cover canonical OKLCH values, mode resolution,
      native variables, and readable surfaces. A live visual pass remains part of the broader
      client verification gates because browser use requires explicit approval.

**Old context-window item removed — upstream already ships the honest context-window meter.**
`ContextWindowMeter.tsx` is fed by `deriveLatestContextWindowSnapshot`, which reads the latest
`context-window.updated` activity rather than cumulative history. Server ingestion creates that
activity from canonical `thread.token-usage.updated` runtime events. Codex emits those events from
native `thread/tokenUsage/updated` notifications (`last.totalTokens` for current-window use and
`modelContextWindow` for the limit); Claude emits the same canonical event from SDK stream/result
usage and `getContextUsage()` snapshots. The 2026-08-15 real Codex product probe confirmed this
path live end-to-end, including the projected `23,942 / 258,400` snapshot. Claude's code path is
covered by focused adapter/ingestion tests, but a real Claude source turn remains blocked by the
S1 authentication prerequisite above.

---

## Stage A — Antigravity (`agy`)

The one provider upstream doesn't have. Upstream ships five drivers registered in
`apps/server/src/provider/builtInDrivers.ts`; their docs say adding one needs "no
orchestration, contract, or client change."

**Stage A is now wired.** The driver, ACP adapter, quota bridge listener, account presets,
trust-prompt guard and verified slash-command catalogue are registered and covered by focused tests.
The remaining Antigravity work is the B2 live-product gate and upstream's missing multi-account
credential selector.

### A1 — transport spike: ANSWERED

`agy` has **no native ACP**. There is an open upstream request for an `--acp` flag
([antigravity-cli#31](https://github.com/google-antigravity/antigravity-cli/issues/31)),
and several community adapters wrap the CLI today
([agy-acp](https://github.com/shindgew/agy-acp),
[antigravity-acp](https://github.com/shubzkothekar/antigravity-acp),
[agy-agent-acp](https://github.com/jameslunardi/agy-agent-acp)). Zed has a registry
discussion open for it too.

**Decision: speak ACP to a configurable bridge process.** Reasons:

- it reuses `packages/effect-acp` and `apps/server/src/provider/acp/AcpSessionRuntime.ts`
  wholesale, the same path Cursor and Grok already take
- streaming, tool calls, approvals and interrupts all work, unlike `agy --print`
- when Google ships `--acp`, the only change is the default: point `bridgeCommand` at
  `agy` with `--acp` in `bridgeArgs`. Nothing downstream moves

The bridge command is a setting with **no default**, deliberately: an unconfigured
instance reports "no ACP bridge configured" with the fix, rather than silently spawning
some package off the network.

### Built — cores only, wired to nothing

- [x] **Settings** — `packages/contracts/src/antigravity.ts`. New file, no edit to
      `settings.ts`: `providerInstances` treats driver config as opaque exactly so a fork
      can add a driver.
- [x] **Account isolation** — `AntigravityHome.ts` + tests. Windows moves `USERPROFILE`
      only and pins `HOME`/`APPDATA`/`LOCALAPPDATA`/`GIT_CONFIG_GLOBAL` back to the real
      user; POSIX must move `HOME` and pins git identity and the npm cache back, with the
      residual ssh redirection reported by `antigravityIsolationCaveats` instead of hidden.
      AGY's operating-system keyring can still be shared across those homes, so the provider
      reports the email it actually used rather than claiming that a folder proves identity.
- [x] **Launch mapping** — `AntigravityLaunch.ts` + tests. Never emits
      `--dangerously-skip-permissions`; `full-access` maps to `--mode accept-edits`, and
      bypass flags pasted into settings are stripped and reported. Models parsed from
      `agy models`; suffix variants such as Gemini 3.8 Flash High/Medium/Low collapse into one
      model plus a separate Effort selector, and old saved suffix selections are migrated.
- [x] **Health probe** — `Layers/AntigravityProvider.ts`. Runs `--version` and `agy models`
      under the isolated environment, exposes the reported email, and does not claim an
      authenticated state when the model/login probe cannot be verified.
- [x] **ACP support surface** — `acp/AntigravityAcpSupport.ts` + tests. Bridge spawn under
      the isolated profile, `AGY_BINARY` pinned so the bridge cannot resolve a different CLI
      than the health probe checked, bypass flags stripped from user-editable bridge
      arguments, and the separate effort choice is joined back to agy's exact model id only at
      the provider boundary.

### Left to do

- [x] **A2 — the ACP adapter.** `Layers/AntigravityAdapter.ts`, modelled on
      `CursorAdapter.ts` (1,182 lines) with `AntigravityAcpSupport.ts` beside it like
      `GrokAcpSupport.ts` (108 lines). The shared `AcpSessionRuntime.ts` does the protocol;
      the adapter maps its events onto orchestration events.
      Implemented with `vp` verification. The adapter maps the shared ACP runtime, listens for
      bridge rate-limit extensions and emits `account.rate-limits.updated` with the instance id;
      the quota normalizer has an Antigravity multi-pool branch.
- [x] **A3 — driver + registration.** `Drivers/AntigravityDriver.ts` following
      `CursorDriver.ts`, plus its registration in `builtInDrivers.ts`. The disabled-by-default
      instance still reports the missing bridge clearly in its provider snapshot.
- [x] **A4 — account presets** in the Add Provider dialog ("Antigravity 1/2/3", filling the
      profile dir), as the old fork had — see `providerProfilePresets.ts`. Three presets are
      available for the three rotated signed-in accounts.
- [x] **A5 — first-run trust prompt.** A fresh agy session in a new project asks "Do you
      trust the contents of this project?". The adapter recognizes that request and bypasses
      full-access auto-approval so it remains visible for explicit user approval.
- [ ] **A6 — true multi-account AGY credentials.** Current AGY builds authenticate through one
      operating-system keyring and publish no supported profile/auth-store selector. T3 isolates
      settings, conversations and processes, shows each instance's actual reported email, and
      warns when profile folders share a login; it must not scrape or copy OAuth tokens. Revisit
      when `google-antigravity/antigravity-cli#381` gains a supported selector.

---

## Stage D — Android remote access without Tailscale

- [ ] **D1 — Deploy the existing T3 Connect path on the developer's Cloudflare domain.** T3
      already supports Android-to-PC/server access from unrelated networks through its relay and
      managed Cloudflare tunnel, so do not build a second networking stack. The remaining product
      choice is whether the domain should host the full multi-computer T3 Connect service or a
      simpler one-PC Cloudflare tunnel; after that, wire the chosen hostname and release the
      Android build.

---

## Not doing

Decided, with reasons. Don't relitigate without a new fact.

- **PWA / installable web client.** You're using the upstream mobile app. It's free from
  the stores, it's good, and it talks to this fork's server. A PWA would duplicate it.
- **Permission rule engine** (glob/regex/exact rules, learned approvals, hard deny-list).
  Upstream's four modes are enough for Claude and Codex. agy gets targeted guardrails in
  A2 instead. OmniLink's own `SPEC.md` §9.5 conceded a PTY parser was never a real wall
  anyway; headless providers under their own native sandboxes are closer to actual
  containment than that ever was.
- **Non-AI chat titles.** Upstream's generated titles are better and cost is trivial.
- **Removing or hiding upstream features** — the PR client, SSH environments, cloud/T3
  Connect, the mobile app. All excluded by OmniLink `SPEC.md` §1.1; all shipped upstream.
  Ignoring them is free. Removing them is a permanent merge tax.
- **Anything from `server/src/transcripts/`, `server/src/pty/` or `server/src/permissions/`
  in the OmniLink repo.** Read them for findings; don't port them. See
  `omni/CONVERSION.md` §2.
- **Building the quota panel for mobile.** `apps/mobile/` is off-limits per `OMNI.md`, and
  the mobile app you use is upstream's published build, which will never carry a fork-local
  panel. Contracts stay surface-neutral; the UI is web + desktop.

---

## Housekeeping

- [ ] **H1 — Audit OmniLink's git history for chat data, then archive it.**
      `Titanspark21/omnilink` tracks `.mobile-pwa-data/*.db-wal` and `*.db-shm` runtime
      database journals (its `PLAN.md` P2-12). Determine whether history contains real
      chat or credential data **before** archiving or making anything public. Keep
      `SPEC.md` and `T3CODE-MIGRATION.md` — they're the requirements behind this fork.

- [ ] **H2 — Delete `Titanspark21/t3code`** (the old fork-of-a-fork) once you've confirmed
      `omni/salvage/` has everything you want. It shares no git history with upstream and
      can never cleanly merge — see `omni/CONVERSION.md` §3.
