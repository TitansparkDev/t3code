# OmniCode — fork notes and merge discipline

A personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) (MIT), started
clean from upstream `main` at `184d8ef33`. It replaces
[OmniLink](https://github.com/Titanspark21/omnilink).

- **Why this exists and what was decided:** `omni/CONVERSION.md`
- **What to build next:** `omni/PLAN.md`
- **Salvaged from the previous fork-of-a-fork:** `omni/salvage/`
- **Local checkout:** `C:\MySoftware\t3code`

Upstream is MIT and explicitly fork-friendly — their README says "If we ever go the wrong
direction, we want you to have everything you need to fork," and "a large number of our
users run forks." Taking updates is supported. Keeping it _cheap_ is on you, and that's
what this file is for.

---

## Antigravity is upstream's now

Upstream added Google Antigravity on 2026-09-03 (`06336460c`, #9348) using its
**official ACP agent** — it runs Antigravity's own `agy_acp_server` through the
same `AcpSessionRuntime` as every other ACP provider, with real
`session/request_permission` approvals, client-side file reads and writes, its
own auth methods, and an installer that downloads and verifies the server.

This fork previously carried its own Antigravity: sixteen files, chief among
them a ~750-line `acp/AntigravityAcpBridge.ts` that faked ACP on top of
`agy --print`. Print mode is one-shot — no permission protocol, no client
filesystem, no session model — so every capability T3 expects had to be
synthesized, which is why that one provider kept breaking in ways Claude and
Codex never did. All sixteen files are deleted; upstream's implementation is
the only one. Do not reintroduce a bridge.

The fork keeps its own account isolation, quota panel and provider presets, but
they now sit on top of upstream's provider rather than a private one.

---

## Releasing from this machine

`.github/workflows/release.yml` does not run on this fork — it wants Blacksmith
runners and a Mac, and there are no Actions minutes. Releases are built here:

```bash
node scripts/update-release-package-versions.ts <version>

T3CODE_DESKTOP_UPDATE_REPOSITORY=TitansparkDev/t3code \
T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true \
  node scripts/build-desktop-artifact.ts \
    --platform linux --target AppImage --arch x64 --build-version <version>

WINEPREFIX=/home/ajay/.cache/t3code-wine \
T3CODE_DESKTOP_UPDATE_REPOSITORY=TitansparkDev/t3code \
T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true \
  node scripts/build-desktop-artifact.ts \
    --platform win --target nsis --arch x64 --build-version <version>

git tag -a "v<version>-omni.$(date -u +%Y%m%d.%H%M)" -m "T3 Code <version> Omni"
gh release create <tag> release/T3-Code-* release/latest*.yml
```

Then restore the four `package.json` versions — the bump is never committed.

Three traps, each of which has already cost an afternoon:

- **Without `T3CODE_DESKTOP_UPDATE_REPOSITORY`** electron-builder writes no
  `latest*.yml`, and the in-app updater then sees nothing.
- **There is no Rust toolchain here**, so `T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR`
  is mandatory; it reuses `native/resource-monitor/target/*/release/`.
- **The default `~/.wine` prefix is broken** (`could not load kernel32.dll`).
  The Windows target needs the separate prefix above.

The server package is not part of that build. Pack it from `apps/server` with
the version bumped and `devDependencies`/`scripts` stripped, drop the Linux
`t3-resource-monitor` into `dist/resource-monitor/linux-x64/` first, then
install the tarball into `~/.t3/runtime/versions/<version>` and point
`service-state.json` at it.

---

## Branch model

```
main        exact mirror of upstream/main. Never commit here.
omni/main   your work. Everything happens here.
```

```bash
git remote add upstream https://github.com/pingdotgg/t3code.git

# weekly, on a fixed day — not "when something breaks"
git fetch upstream
git checkout main && git merge --ff-only upstream/main && git push origin main
git checkout omni/main && git merge main

# then reinstall — always with the mobile workspace excluded, see omni/PLAN.md S1
vp i --filter=!@t3tools/mobile
```

**Never plain `vp i` on this machine.** It fails with `ERR_PNPM_EPERM` unpacking Expo's
prebuilt native binaries, which Defender locks mid-copy. The flag skips the mobile
workspace, which you don't build anyway.

**Merge, never rebase.** Rebasing a long-lived divergent branch replays every conflict on
every sync, forever. Merging resolves each one once.

### You never need a pull request

Both branches are yours, and you sync them with `git merge` on the command line. There is
no PR anywhere in the workflow above.

After any push to `omni/main`, GitHub shows a yellow **"omni/main had recent pushes —
Compare & pull request"** banner. That is an offer, not a pull request; nothing has been
created. **Ignore it.**

It matters because on a fork GitHub defaults the _base_ of a new PR to the **parent repo**
— so clicking through and confirming would propose your entire fork to
`pingdotgg/t3code`, publicly, in front of their maintainers. Dismiss the banner with the
`×`. If you ever do want a PR against your own fork, change the base repo dropdown from
`pingdotgg/t3code` to `Titanspark21/t3code` first, and check it before submitting.

---

## The rule that decides how painful this is

**Add files. Don't edit them.**

Every line you change in an existing upstream file is a conflict you will resolve again on
every future sync. Every new file is free. The architecture is unusually kind about this:

| Adding     | Cost                                                                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A provider | New `Drivers/XDriver.ts` + `Layers/XAdapter.ts`, and **one line** in `builtInDrivers.ts`. Upstream's own docs: "No orchestration, contract, or client change is required for the common case." |
| A panel    | New component + one registration line                                                                                                                                                          |
| A contract | **A new file** in `packages/contracts/src/`                                                                                                                                                    |

### Contracts are the sharpest edge

`packages/contracts` ripples into server, web, mobile and desktop simultaneously. Put
additions in new files — `packages/contracts/src/quota.ts` — never as edits to
`orchestration.ts` or `providerRuntime.ts`.

### Never touch

All high-churn, all pure conflict, none of it worth it:

- `pnpm-workspace.yaml` catalog versions
- root and workspace build/test/lint scripts
- `.github/workflows/`
- `infra/`
- `apps/mobile/` — unless the fork feature explicitly crosses mobile. C4 handoff is the
  deliberate exception: it must preserve the same unsent-draft and lineage behavior on iOS
  and Android, including the quota-aware target picker.

### Keep the table below current

This _is_ your merge checklist. Before each sync, it tells you exactly where to look.
If a change isn't in this table, it shouldn't exist.

| Upstream file                                                           | Change                                                      | Why                                                             | Task    |
| ----------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------- | ------- |
| `packages/contracts/package.json`                                       | added quota, Antigravity and scheduled-task subpath exports | fork-local schemas resolve without changing upstream contracts  | B1/AUT  |
| `packages/contracts/src/rpc.ts`                                         | added quota and scheduled-task RPCs                         | fork state crosses the existing typed WebSocket boundary        | B1b/AUT |
| `packages/client-runtime/src/rpc/client.ts`                             | registered the quota subscription tag                       | lets shared client RPC machinery recognize the live stream      | B1b     |
| `packages/client-runtime/src/state/server.ts`                           | added quota and scheduled-task client operations            | exposes fork state through the per-environment state layer      | B1b/AUT |
| `apps/server/src/auth/RpcAuthorization.ts`                              | assigned scopes to quota and scheduled-task RPCs            | fork endpoints follow the existing authorization boundary       | B1b/AUT |
| `apps/server/src/provider/builtInDrivers.ts`                            | registered `AntigravityDriver`                              | adding a driver needs no other upstream edit                    | A3      |
| `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`      | feeds runtime events to the fork-local quota service        | the only place `account.rate-limits.updated` already lands      | B1b     |
| `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts` | covers instance-keyed quota ingestion                       | locks the narrow upstream seam to the intended behavior         | B1b     |
| `apps/server/src/server.ts`                                             | installs quota and scheduled-task service layers            | makes the fork services available to ingestion and RPC          | B1b/AUT |
| `apps/server/src/server.test.ts`                                        | supplies quota and scheduled-task test layers               | keeps server tests explicit about added dependencies            | B1b/AUT |
| `apps/server/src/serverRuntimeStartup.ts`                               | starts the durable scheduled-task runner                    | automation must recover and poll for due work with the server   | AUT     |
| `apps/server/integration/OrchestrationEngineHarness.integration.ts`     | supplies the empty quota test layer                         | keeps the integration harness explicit about the dependency     | B1b     |
| `apps/server/src/ws.ts`                                                 | handles quota and scheduled-task RPCs                       | publishes both fork read models to connected clients            | B1b/AUT |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`                     | mounts the quota panel in the footer                        | both sidebar shells render this footer, so one edit covers both | B2      |
| `apps/web/src/components/chat/ChatComposer.tsx`                         | passes the active environment to the model picker           | keeps account quota scoped to the thread's environment          | B5      |
| `apps/web/src/components/chat/ProviderModelPicker.tsx`                  | carries optional environment identity                       | lets reusable picker content resolve the right account snapshot | B5      |
| `apps/web/src/components/chat/ModelPickerContent.tsx`                   | joins model rows to instance-keyed quota                    | supplies live account detail without per-row subscriptions      | B5      |
| `apps/web/src/components/chat/ModelListRow.tsx`                         | adds quota detail to the provider/account label             | exposes the same 5-hour/weekly detail from the composer picker  | B5      |
| `apps/web/src/components/settings/ProviderSettingsPanel.tsx`            | joins provider cards to environment quota                   | keeps Settings account detail on the correct environment        | B5      |
| `apps/web/src/components/settings/ProviderInstanceCard.tsx`             | adds quota detail to the account heading                    | covers the Settings → Providers entry point                     | B5      |
| `apps/web/src/composerDraftStore.ts`                                    | migrates saved AGY model suffixes into effort selections    | preserves High/Medium/Low when the model catalogue is collapsed | A2      |
| `apps/web/src/modelSelection.test.ts`                                   | covers the saved AGY effort migration                       | prevents upgrades from silently changing reasoning effort       | A2      |
| `apps/web/src/components/settings/SettingsSidebarNav.tsx`               | registers Scheduled Tasks in Settings                       | saved automation needs a stable entry point                     | AUT     |
| `apps/web/src/components/settings/settingsSearch.ts`                    | makes Scheduled Tasks searchable                            | the Settings search must reach the new panel                    | AUT     |
| `apps/web/src/routeTree.gen.ts`                                         | registers the scheduled-task route                          | the generated router must expose the settings screen            | AUT     |
| `docs/README.md`                                                        | links the scheduled-task user guide                         | users need the automation behavior and limits documented        | AUT     |
| `packages/contracts/src/orchestration.test.ts`                          | removes a duplicated decoder declaration                    | keeps contract verification compiling after the upstream merge  | AUT     |
| `packages/contracts/src/orchestration.ts`                               | exposes persisted activity append to clients                | handoff lineage uses the existing event-sourced activity path   | C4      |
| `packages/client-runtime/src/operations/commands.ts`                    | adds the activity append command operation                  | keeps handoff writes on the typed WebSocket boundary            | C4      |
| `packages/client-runtime/src/state/threadCommands.ts`                   | registers the activity append atom command                  | web and mobile share the same durable lineage mutation          | C4      |
| `packages/shared/src/handoff.ts`                                        | builds bounded deterministic handoff briefs                 | provider-neutral transfer context works across all clients      | C4      |
| `packages/shared/src/handoffTargets.ts`                                 | derives quota-group targets and model routing               | web and mobile make the same honest account choice              | C4      |
| `apps/web/src/components/ChatView.tsx`                                  | writes briefs, creates targets, seeds drafts, links threads | web and desktop get the full handoff flow                       | C4      |
| `apps/web/src/components/chat/ChatHeader.tsx`                           | adds fork action and lineage breadcrumb                     | source and target threads link back to each other               | C4      |
| `apps/web/src/components/chat/HandoffTargetDialog.tsx`                  | presents quota groups and remaining percentages             | desktop/web target selection stays provider-neutral             | C4      |
| `apps/mobile/src/features/threads/ThreadRouteScreen.tsx`                | adds native fork actions and draft navigation               | iOS and Android expose the same no-turn handoff flow            | C4      |
| `apps/mobile/src/features/threads/HandoffTargetPicker.tsx`              | presents a scrollable native quota-group picker             | mobile supports more than the platform alert-button limit       | C4      |
| `packages/shared/src/themePalettes.ts`                                  | registers the shared OmniCode light/dark palette            | all clients need the same semantic color roles                  | C6      |
| `apps/web/src/themePalette.ts`                                          | re-exports OmniCode and the built-in registry               | web and desktop consume the shared theme source of truth        | C6      |
| `apps/web/src/components/settings/ThemeSettings.tsx`                    | renders the shared built-in registry                        | Appearance must expose every reviewed built-in on web/desktop   | C6      |
| `apps/mobile/src/lib/mobileTheme.ts`                                    | consumes the shared built-in registry                       | mobile native variables and terminal previews stay aligned      | C6      |
| `docs/user/appearance.md`                                               | documents built-in theme selection and OmniCode             | users need the shipped appearance behavior                      | C6      |
| `docs/internals/themes.md`                                              | records the cross-surface theme contract                    | maintainers need one source of truth for palette additions      | C6      |
| `packages/shared/src/providerRateLimit.ts`                              | centralizes explicit provider-limit detection and copy      | server and clients must agree on recoverable failures           | C2      |
| `apps/mobile/src/features/threads/ThreadRateLimitNotice.tsx`            | shows the in-thread mobile recovery path                    | rate-limited threads must be recoverable on every client        | C2      |
| `docs/user/usage.md`                                                    | documents rate-limit recovery                               | users need a clear way back after a provider reset              | C2      |
| `apps/server/src/provider/Layers/ProviderService.ts`                    | times out provider session starts after two minutes         | one hung provider handshake otherwise stalls every thread       | FIX     |
| `apps/server/src/provider/Layers/ProviderService.test.ts`               | covers the hung session start timeout                       | locks the reactor-unblocking behavior                           | FIX     |
| `apps/server/src/cli/project.ts`                                        | adds `t3 project move`                                      | re-link a project after its folder moves or is renamed          | RELINK  |
| `apps/server/src/bin.test.ts`                                           | covers `t3 project move`                                    | keeps threads attached when a project moves                     | RELINK  |
| `apps/server/src/provider/Errors.ts`                                    | missing-folder error names the fix                          | points users at Settings → Project → Folder                     | RELINK  |
| `apps/web/src/components/settings/ProjectSettingsPanel.tsx`             | editable folder for every project                           | re-link moved projects without a command line                   | RELINK  |
| `apps/mobile/src/features/threads/ThreadDetailScreen.tsx`               | shows failed and rate-limited turns                         | a turn that cannot start must explain itself on mobile          | C2      |

The C4 contract change is a narrow exception to the add-files preference: it promotes the
already-persisted `thread.activity.append` command into the client-dispatchable union rather
than inventing a second lineage event shape.

**Conflict warning on the B1b/B2 seams.** Upstream's unmerged
`t3code/usage-limits-analytics` branch edits several of the same RPC, ingestion, WebSocket,
state and sidebar files for the same feature. If it lands, expect semantic conflicts —
resolve them by keeping this fork's `ProviderInstanceId` keying rather than upstream's
one-snapshot-per-provider model. See `omni/PLAN.md` B0.

---

## Upstream what you can

Every patch they accept is one you stop carrying. Candidates in `omni/PLAN.md`:

- **C5** — Windows binary probing. Proving a candidate CLI runs `--version` rather than
  trusting that a file exists. Still the cleanest offer: small, self-contained, and nobody
  upstream is working on it.
- **B4** — _rescoped._ The quota panel is no longer a gap they have; upstream built their
  own on `t3code/usage-limits-analytics` in August. What's left to offer is the narrower
  fix that their snapshot-per-provider keying breaks as soon as one provider has two
  accounts. Make that offer only after B1b and B2 prove the instance-keyed version works
  here.

They say big features won't be accepted. Neither of these is a big feature.

---

## Two things that will bite

**Everything server-side is Effect.** Effect/Schema contracts, an event-sourced engine,
Atom client state, and a vendored beta `effect-smol`. Upstream's `AGENTS.md` tells agents
to read `.repos/effect-smol/LLMS.md` before writing server code. Do that.

**The toolchain is Vite+ (`vp`), not plain pnpm.** `vp i`, `vp run dev`, `vp test run`,
`vp lint`. It needs a global binary (`irm https://vite.plus/ps1 | iex` on Windows) and it's
VoidZero's commercial product, not part of the MIT repo. Confirm its terms cover your use
before investing — that's task S1, deliberately first in the plan.
