# OmniLink → T3 Code fork: what carries over, what doesn't, what you decide

Assessment written 2026-08-14 against OmniLink `main` (`3f8a231`) and t3code `184d8ef3`.
Sources read: `README.md`, `SPEC.md` (1,136 lines), `PLAN.md` (864), `BUILD-PLAN.md`,
`AGENTS.md`, OmniLink's ~28k lines of TypeScript across `server/ web/ electron/ contracts/`;
t3code's `AGENTS.md`, `docs/internals/*`, `docs/user/*`, and its `apps/server`,
`apps/web`, `apps/mobile`, `packages/*` source.

---

## 0. The one fact that decides everything else

**OmniLink drives the real interactive TUI in a PTY. T3 Code does not run a TUI at all.**

OmniLink `SPEC.md` §4.1–4.2 is explicit: input goes to a PTY running the real CLI, the chat
view is rendered by parsing each CLI's own transcript files on disk, and "Do not build on
`claude -p`, `codex exec`, `agy -p`, or the Agent SDK."

T3 Code does exactly the thing OmniLink forbids:

| Provider                 | T3 Code transport                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------- |
| Claude                   | `@anthropic-ai/claude-agent-sdk` (`apps/server/src/provider/Layers/ClaudeAdapter.ts`) |
| Codex                    | app-server JSON-RPC (`packages/effect-codex-app-server`)                              |
| Cursor / Grok / OpenCode | ACP (`packages/effect-acp`)                                                           |

There is no TUI to attach to, no transcript to parse, and no PTY in the agent path. PTYs exist
in t3code only for **user** terminals (`apps/server/src/terminal/`, node-pty and bun-pty
adapters, plus a native Ghostty VT renderer).

The chat view is not parsed from files — it is an event-sourced log the server owns
(`OrchestrationEngine` → `decider` → `projector`). That is strictly more reliable than
transcript parsing: ordered, durable, complete, and immune to format drift.

**Consequence:** the largest single body of work in OmniLink — three transcript parsers, the
schema-less protobuf wire reader, the agy SQLite/WAL watcher, PTY command injection with
delayed-Enter, the PTY approval auto-answer — has no home in a fork. That is most of the 28k
lines. What survives is the _research_, not the code.

One nuance worth knowing: transcript parsing survives upstream in exactly one place —
`apps/server/src/usage/usageTranscriptReader.ts` reads Codex and Claude session history for
the token-cost analytics page.

### On the reason §4.2 gave

§4.2's rationale was that Anthropic might move SDK/`-p` usage off subscription limits onto
metered credits. Your own spec records that the change was **paused on 15 June 2026 and is
not in force**. T3 Code ships the SDK path to a stated 100,000+ users against their
subscriptions today. The risk you were hedging has not materialised. That does not make the
decision wrong — it makes it a live choice rather than a settled constraint. See Decision 1.

---

## 1. What t3code already gives you that OmniLink never finished

This is the actual argument for the fork. Every item below is an open or partly-open box in
your `PLAN.md`, already shipped upstream:

- **Five live providers** — Codex, Claude, Cursor, Grok, OpenCode, each a driver + adapter
  behind one `ProviderAdapter` interface. Adding one is "write a driver, add a line to
  `builtInDrivers.ts`" with no orchestration, contract, or client change.
- **Multi-account per provider**, including the exact Codex shared-home + shadow-home pattern
  your §5.7 flagged as an unproven spike (`PLAN.md` "Run the Codex shadow-home spike" — still
  unchecked). It ships, it's documented in `docs/user/providers-codex.md`, and compatible
  accounts can continue an existing thread.
- **Per-turn checkpoints as hidden git refs, with revert** — and t3code reverts _the provider
  conversation too_, not just the working tree. Your §9.4 undo, done, plus more.
- **Diff panel, file tree + preview, browser preview with favicons, terminal panel with
  tabs/splits** — your entire §8.14 inspector.
- **Worktrees**, branch toolbar, worktree cleanup, per-project scripts and icons.
- **Command palette and fully customisable keybindings** (§8.16).
- **Remote access**, four ways: LAN, Tailscale Serve HTTPS, desktop-managed SSH launch, and
  the T3 Connect tunnel. Pairing by one-time token/QR, session-based afterwards, revocable
  (`t3 auth`). Your entire M3 remote milestone, including the Tailscale Serve automation that
  is still unchecked in `PLAN.md`.
- **Native iOS and Android apps** with an offline outbox, live activities and push.
- **Signed Electron desktop with auto-update** (`electron-updater`), distributed via winget,
  Homebrew and AUR. Your `PLAN.md` still has "Sign the installer" open as an owner purchase.
- **Source control**: GitHub / GitLab / Bitbucket / Azure PR creation and review panels,
  clone, publish. (You excluded this — see List 2.)
- **MCP support, diagnostics, resource telemetry, server version-skew handling, theming with
  VS Code theme import and OpenVSX.**
- **Event-sourced typed contracts, drainable workers, receipts, idempotent command receipts** —
  which is, almost line for line, what your `SPEC.md` §4.3 asks for and your P1-06/P1-07
  boxes are still trying to build.

Against that: your P0-01 through P2-13 audit list is eleven open items, several of them
security-critical, and the last commit on `main` records an agent handing back PR #2 unable
to even install dependencies.

---

## 2. LIST ONE — What can be added

Ordered by value per unit of effort. Each is additive: new files, minimal edits to upstream
files, low merge cost.

### 2.1 Subscription quota panel — 5-hour and weekly windows _(best value on the list)_

Your §8.6 quota panel with per-account rows, used %, reset countdowns, source labelling and
an honest "not exposed" state does not exist upstream. T3 Code's Usage page is something
different: API-equivalent **token cost** analytics over provider session history
(`docs/user/usage.md`), not subscription window state.

But it's half-built already. Both adapters emit the event and nothing consumes it:

- `apps/server/src/provider/Layers/CodexAdapter.ts:1395` — `account/rateLimits/updated`
- `apps/server/src/provider/Layers/ClaudeAdapter.ts:3477` — same event type
- `packages/contracts/src/providerRuntime.ts:239,702` — `account.rate-limits.updated`, with
  the payload typed as `Schema.Unknown`

Nothing in `apps/server/src/orchestration/` handles it. The work is: type the payload,
project it, add a sidebar panel. No probe PTYs needed — the providers push it. Your §8.6.3
hidden-probe machinery becomes unnecessary, which is a straight win.

### 2.2 Limit detection → notify and pause

Builds directly on 2.1: latched `rate-limited` status that redraws can't flip back, queued
messages held rather than fired into a dead session, a banner naming the window and its reset
time, and explicitly **no** automatic account rotation (§5.4, §8.9). Your parser-level rule —
90% used is not limited, ≥100% or an explicit limit signal is — carries over as logic.

### 2.3 Persistent permission rule engine

T3 Code's approval decisions are `accept | acceptForSession | decline | cancel`
(`packages/contracts/src/orchestration.ts:134`). Session-scoped only. There is no persisted
rule store, no glob/regex/exact matching, no learned rules, no hard deny-list.

Your §9.3/§9.6 engine — project and global scope, approve-once / always-this-command /
always-this-pattern, non-overridable denies for `rm -rf`, `git push --force`, registry
writes, and any access to account profile directories — is genuinely missing and genuinely
additive. It hooks the approval path before the decision reaches the adapter.

Read Decision 6 before building it, though. The reasoning that motivated it has changed.

### 2.4 Antigravity (`agy`) as a provider driver

Your only truly unique provider. T3 Code has no `agy` driver; "Antigravity" appears upstream
only as an _editor_ you can open a project in (`apps/web/src/components/chat/OpenInPicker.tsx`).
There is a `gemini` driver kind stubbed in `AddProviderInstanceDialog.tsx:87` alongside
`githubCopilot`, `acpRegistry` and `piAgent`, all rendered disabled — planned, not built.

The good news: as a headless driver you do **not** need the protobuf/SQLite transcript
decoding at all. `SPEC.md` §11 records that agy ships an HTTP wrapper at
`<profile>\.gemini\antigravity-cli\bin\agentapi.bat`. That, or an ACP shim, is the shape
that fits `ProviderAdapter`. Your verified on-machine research carries over intact: launch
flags, the `agy models` catalogue, `--mode accept-edits|plan`, `--conversation <id>` resume,
and the `USERPROFILE`-override isolation recipe with `HOME`/`APPDATA`/`LOCALAPPDATA`/
`GIT_CONFIG_GLOBAL` passed back to the real profile (§5.2) — which is exactly the kind of
per-instance environment t3code's `mergeProviderInstanceEnvironment` already supports.

Effort: highest single item on this list. See Decision 3 on whether it's worth it.

### 2.5 Cross-provider handoff with `HANDOFF.md` and visible lineage

Your §8.5(b) deterministic, no-AI, no-network brief written into the checkout, the new thread
opened with the brief sitting **unsent** in its composer, and lineage shown both directions in
the header. Upstream has thread creation and compatible-account continuation; the brief and
the lineage link are additive.

The detail worth keeping is the fork dialog listing **quota groups with live remaining
percentage**, not provider names — you choose by looking, not remembering. That only works
once 2.1 lands.

### 2.6 Curated, version-gated slash-command catalogue

Upstream carries `ServerProviderSlashCommand { name, description?, input? }`
(`packages/contracts/src/server.ts:81`) — whatever the provider reports, name and blurb.

Your 39 conservatively verified commands with exact syntax, argument help, side effects,
during-work behaviour, where output appears, and a minimum verified CLI version with an
explicit "not supported by this installed version" state is a real enrichment on top. It also
survives the headless move, because it's metadata, not PTY behaviour.

### 2.7 Context-window meter

Absent upstream — no `contextWindow` or equivalent in `packages/contracts`. Codex reports
`model_context_window` and per-turn usage; your §7.3 meter (warm at 70%, red at 90%, hidden
entirely where there's no honest figure) is additive and small.

### 2.8 Installable PWA on the web app

`apps/web` has no service worker and no web app manifest. If you want a phone client that
isn't the App Store app, adding an installable PWA with the offline outbox is additive and
needs no Apple/Google developer account. See Decision 5 — you may not need it.

### 2.9 Windows-native polish and discovery discipline

T3 Code supports Windows properly — winget distribution, NSIS builds, `win32` branches in
`bootstrap.ts`, `processRunner.ts`, `terminal/Manager.ts`, `ClaudeExecutable.ts` — but the
docs and daily development are Mac-first (`brew install` everywhere).

Your discovery contract is better than what's upstream in one specific way: it _proves_ a
candidate binary by running `--version`, continues past ACL-blocked candidates so a standalone
CLI on `PATH` can beat a blocked packaged-app resource, honours `PATHEXT`, and puts the
verified candidate first on the spawned process's `PATH` (§2.2). That's a small, genuinely
useful, upstreamable contribution.

### 2.10 Non-AI chat titles

T3 Code generates titles with a model (`apps/server/src/textGeneration/`, plus a "Regenerate
title" action). Your §8.8 rule — first ~50 characters of the first user message, no AI, no
network, no cost — becomes a settings toggle. Trivial.

### 2.11 Your visual direction

Phase 5 of your build plan becomes nearly free. T3 Code has a theme token layer plus VS Code
theme import and OpenVSX themes; your restrained dark theme is a data change, not surgery.

---

## 3. LIST TWO — What can't be added, or can't be removed without pain

### 3.1 The interactive TUI dual view — not addable

Everything that hangs off it goes with it:

- Chat/Terminal toggle over one session, and the auto-flip to Terminal when input starts `/`
- Shared PTY sizing across multiple windows (server sizes to the smallest connected viewer)
- Model/effort changes by injecting the provider's own slash command with delayed Enter
- Auto-confirming Claude's "Switch model?" dialog
- PTY-level approval auto-answering
- Terminal-typed prompts appearing in chat, and reflecting terminal `/model` back into the
  picker (§8.1.1 — explicit owner feedback)

Rebuilding this means running a second, parallel provider system next to t3code's, which is
the whole product again. Partial consolation: t3code has genuinely good terminals, so you can
run `claude` by hand in one. It just isn't the thread's session, and nothing syncs.

### 3.2 Transcript-file-driven chat — obsolete, not portable

Your three parsers, the protobuf wire reader, the agy SQLite + `-wal` watcher, the unknown-
block labelling, `Provider.parseTranscriptFile` — none of it has a consumer. The event log
replaces it and is better. Keep the _findings_ (§13.1 formats, the Codex `turn_context`
discovery, the AGENTS.md-injected-as-user-turn bug); discard the code.

### 3.3 "Build fresh, do not fork" and "no headless mode"

`SPEC.md` §3.1 and §4.2. Both are structurally incompatible with this plan. If either is
non-negotiable, the fork is off. Everything else in this document assumes both are being
retired.

### 3.4 Four of your §1.1 exclusions are already in the box

You can hide these behind settings. Deleting them means editing dozens of upstream files that
upstream keeps changing — a permanent merge tax:

| Your exclusion                         | What upstream ships                                                                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| No full Git/PR client                  | GitHub, GitLab, Bitbucket, Azure DevOps: PR create, review panels, clone, publish, branch checkout                                  |
| No multi-machine fleet, no cloud       | SSH-launched remote environments, multi-environment lists, T3 Connect tunnel, Clerk accounts, `infra/relay`                         |
| No native mobile app                   | `apps/mobile`, a full Expo app — and roughly half of recent upstream commits are `fix(mobile)`                                      |
| No AI reviewer / no injected behaviour | "Auto" mode delegates Codex's routine approvals to an **AI reviewer** (`docs/user/permission-modes.md`); titles are model-generated |

### 3.5 Effect, event sourcing and Atom are the spine

`SPEC.md` §4.3 says plainly: "Do not adopt T3Code's full Effect/event-sourced architecture
merely to obtain these guarantees." Forking _is_ adopting it — Effect/Schema contracts,
`Effect.Atom` client state, an event-sourced engine, and a vendored beta `effect-smol` you
are told to read before writing server code. There is no partial adoption.

Practically: every server change you make is Effect code. If that's unfamiliar, budget for it.

### 3.6 The Vite+ (`vp`) toolchain

`pnpm-workspace.yaml` pins `vite-plus@0.2.2` (`npm:@voidzero-dev/vite-plus-core`), and
contributing requires a global `vp` binary installed by `curl -fsSL https://vite.plus | bash`.
Every package's build, test, lint, typecheck and format script runs through it, and the root
`prepare` script runs `effect-tsgo patch && vp config`.

Swapping it out means rewriting every workspace script — and guaranteeing a conflict with
every upstream change to any of them. **Check Vite+'s licence and pricing terms for your
use before committing to the fork**; it is VoidZero's commercial product, not part of the
MIT-licensed repo.

### 3.7 Push to your phone runs through their cloud

`apps/mobile/src/features/agent-awareness/remoteRegistration.ts` registers the device with
`ManagedRelay` — T3's hosted relay — and delivers through Expo push. Your §8.11 design (your
own server holds only Web Push key material, sends only a title, a fixed phrase and a deep
link, dedupes per chat/kind every 30 seconds) does not exist upstream.

Self-hosting means running `infra/relay` yourself and holding your own Expo/EAS project plus
Apple and Google developer accounts. Or building the PWA (2.8) and doing web push from your
own server, which is what you already designed.

### 3.8 The build environment changes shape, it doesn't get easier

Upstream requires Node `^24.13.1`, pnpm 11, a Rust toolchain for `native/resource-monitor`
and `native/libghostty-vt`, Bun on some paths, and Expo/EAS for mobile. Your current pain —
`better-sqlite3` failing to build under Node 24 because ClangCL isn't installed, which is
literally what blocked the last agent — is replaced by a different set of native build
problems, not by none.

### 3.9 The security posture is theirs, not yours

Your P0-01 ("loopback-only by default, authenticate every remote surface") and P0-02
("authenticate the Electron-to-server boundary") are largely solved upstream — `EnvironmentAuth`
authenticates the WebSocket upgrade, `RPC_REQUIRED_SCOPE` enforces per-method scopes, pairing
issues revocable sessions. But it's built as a multi-device, multi-credential system with a
hosted web app, not as your single-owner model. You inherit their threat model. Note also
that their `AGENTS.md` says outright: "Security is important, but should not be over-indexed
on, especially for dev mode/maintainer-only features."

---

## 4. LIST THREE — What you have to decide

### Decision 1 — Headless, or the TUI? _(everything depends on this)_

If the real interactive TUI is non-negotiable, stop here; there is no fork, and OmniLink stays
a solo build with eleven open P0/P1 audit items.

**Recommendation: retire §4.2 and fork.** The metering risk it guarded against was paused and
never came back; t3code ships the SDK path against subscriptions to a very large user base;
and you have spent a long time not shipping. The thing you lose — typing in a real TUI and
watching it in chat — is real, and it's the price.

### Decision 2 — How much of the excluded surface do you keep?

PR client, SSH environments, cloud/Clerk, mobile app. Three options:

1. **Keep it all, ignore what you don't use.** Cheapest merges by a wide margin.
2. **Hide it behind settings/feature flags.** Moderate cost, moderate ongoing conflict.
3. **Delete it.** Highest cost, permanent conflict on every upstream release.

**Recommendation: (1), with (2) only where something is actively confusing you daily.**

### Decision 3 — Is Antigravity worth a driver?

It is the single largest remaining piece of unique work, and the honest question is whether
you use `agy` daily or whether it was collected. Note your own `PLAN.md` records that on your
machine there was "no present agy account" during the Plan-behaviour harness runs.

If daily: build it, via `agentapi` HTTP or an ACP shim. If not: dropping it removes the
biggest chunk of scope in this whole document.

### Decision 4 — Do you upstream the quota panel?

t3code says "big features will not be [accepted]", but a panel that consumes rate-limit
events they already emit is small, obviously useful, and doesn't touch their architecture.
If it lands upstream you stop maintaining it forever.

**Recommendation: build it as a clean, separable slice either way**, then offer it.

### Decision 5 — Phone: their app, or your PWA?

Their iOS/Android apps are free from the stores, genuinely good, and talk to _your_ fork's
server — but version skew between your fork and their released app is a real risk, and push
runs through their relay. The PWA is more work, but no store, no Expo, no Apple account, no
relay.

**Recommendation: use their app first.** Build the PWA only if version skew actually bites.

### Decision 6 — Do you still need the permission rule engine?

Your §9.1 argument was: you approve everything without reading, so approvals are pure latency,
and safety must come from containment. Then §9.5 conceded there is no generic PTY jail and
§13.11 left every provider's containment behaviourally unproven — which is precisely why
P0-04 is still open.

Headless changes this. Providers run under their own native sandboxes (Codex's `-s read-only`
/ `workspace-write`, Claude's permission modes) rather than behind a PTY text parser. That is
closer to actual containment than your approval parser ever was.

So decide what your real safety story is. Candidly, "Full access inside a worktree, plus
per-turn checkpoint undo" may be the whole answer.

**Recommendation: skip the rule engine at first.** Keep the hard deny-list idea in your back
pocket for when you find a real enforcement point, rather than building an advisory one again.

### Decision 7 — Fork mechanics and merge policy

Two shapes: `main` mirrors upstream untouched with all your work on a long-lived branch you
merge into; or you merge upstream into your own `main` on a cadence. Pick one now, because
switching later is expensive. Details in §5.

### Decision 8 — What happens to the OmniLink repo?

`PLAN.md` P2-12 flags tracked runtime database journals — `.mobile-pwa-data/*.db-wal` and
`*.db-shm` — and asks whether history contains user or chat data. **Settle that before
archiving or making anything public.** Then archive the repo and keep `SPEC.md` as the
requirements document for the fork.

### Decision 9 — What you keep from OmniLink

Not code. Keep:

- `SPEC.md` as your product requirements — §1.1 exclusions, §7 UI spec, §8 feature specs and
  §9 safety intent are all still the right description of what you want.
- Every verified §13 finding: transcript formats, agy 1.1.5 flags and model list, Codex
  0.145.0 rollout format and `turn_context`, mode flag mappings per provider, the
  `USERPROFILE` isolation recipe, the `CLAUDECODE` environment-variable trap.
- The judgement calls: no AI titling, no automatic rotation, "not exposed" over a guessed
  number, checkpoints over approval dialogs, quota groups as the unit of choice.

---

## 5. Staying mergeable with upstream

Upstream is MIT (`LICENSE`, T3 Tools Inc.), explicitly fork-friendly — "If we ever go the
wrong direction, we want you to have everything you need to fork" — and states "a large number
of our users run forks." So this is supported in spirit. Making it work in practice is
mechanical:

**Repository shape**

```bash
# fork on GitHub, then:
git remote add upstream https://github.com/pingdotgg/t3code.git
git fetch upstream
```

Keep `main` as a clean mirror of `upstream/main`. Do all your work on `omni/main`. Merge
upstream into it on a fixed cadence — weekly, not "when something breaks".

**Merge, do not rebase.** Rebasing a long-lived divergent branch replays every conflict on
every sync. Merging resolves each one once.

**The rule that actually matters: add, don't edit.**

Every line you change in an existing upstream file is a future conflict. Every new file is
free. The architecture is unusually kind here:

- New provider → new file in `apps/server/src/provider/Drivers/` + **one line** in
  `builtInDrivers.ts`. Their own docs: "No orchestration, contract, or client change is
  required for the common case."
- New panel → new component + one registration line.
- New contract → **a new file** in `packages/contracts/src/` (e.g. `omniQuota.ts`), never an
  edit to `orchestration.ts`. Contracts are the sharpest edge in the repo: a change there
  ripples into server, web, mobile and desktop simultaneously.

**Never touch** (all high-churn, all pure conflict): `pnpm-workspace.yaml` catalog versions,
root and workspace build scripts, `.github/workflows/`, `infra/`, and `apps/mobile/` unless
you have decided to own a mobile build.

**Keep an `OMNI.md`** at the repo root listing every upstream file you have modified and why.
That file _is_ your merge checklist — before each sync, it tells you exactly where to look.

**Upstream what you can.** Every patch they accept is one you stop carrying. The Windows
binary-probing discipline (2.9) and the rate-limit projection (2.1) are the two most likely
to land.

---

## 6. Suggested order of work

1. Fork, get `vp i` and `vp run dev` working on your Windows machine. Nothing else matters
   until the toolchain runs. **This is also where you find out whether Vite+'s terms work
   for you** — do it before writing any code.
2. Use it for a week as-is, with Claude and Codex, on real work. Half this document's List 1
   may stop mattering once you've lived with the thing.
3. Quota panel (2.1) — smallest real win, and it teaches you the Effect/event-sourcing spine
   on a bounded problem.
4. Limit detection and notify-and-pause (2.2).
5. Decide on Antigravity (Decision 3). If yes, it's the next big block.
6. Handoff and lineage (2.5), command catalogue (2.6), context meter (2.7).
7. Theme (2.11) whenever you feel like it.

Do not port anything from `server/src/transcripts/`, `server/src/pty/`, or
`server/src/permissions/`. Read them for findings, then let them go.
