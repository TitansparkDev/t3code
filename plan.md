# Usage limits and Antigravity model support

## Purpose

This is an implementation plan for making provider usage limits accurate, fresh, and consistent across the web, desktop, and mobile clients.

The plan covers:

- Codex limits that are sometimes stale until a manual refresh.
- Antigravity limits that are frequently wrong or incomplete.
- Consistent display of fresh, stale, unavailable, and estimated data.
- The Antigravity Claude and GPT-OSS models that are missing from the picker.
- Provider-specific fallbacks without hiding provider errors or inventing quota values.

This file is a handoff for smaller agents. The findings below distinguish observed code behavior from hypotheses; no live account comparison or failing reproduction was run while writing the plan.

## Desired result

Every client should answer these questions consistently:

1. Which account or provider instance does this limit belong to?
2. Which quota window is being shown?
3. How much has been used and how much remains?
4. When does the window reset?
5. When was the value observed by the provider?
6. Which source produced the value?
7. Is the value fresh, stale, estimated, unavailable, or currently refreshing?

The UI must never present an old value as if it were current, turn an unknown value into `0%` or `100%`, or average several model limits when the provider actually exposes one shared pool.

## Success criteria

### General

- The sidebar, main Usage → Limits page, provider health displays, and mobile limits page use the same normalized data.
- A successful refresh changes every relevant surface without requiring a page reload.
- A failed refresh preserves the last successful value, marks it stale, and shows a recoverable error state.
- Concurrent refreshes for the same account are coalesced into one provider request.
- Window IDs are stable across refreshes, so a reset does not create duplicate bars or make the UI reuse the wrong bar.
- All timestamps are handled as absolute timestamps. Reset countdowns are derived from `resetsAt`; they are not persisted as counters.
- Provider credentials, access tokens, cookies, and raw response bodies are never logged or sent to clients. Existing client-visible account labels and opaque routing IDs remain available where needed for account selection and reset-credit actions.

### Codex

- A current Codex usage value is visible shortly after a Codex turn or a provider rate-limit event.
- Manual refresh, automatic refresh, and app-server events converge on the same value.
- The Codex app-server read works as the active probe; a direct usage endpoint is added only if the reproduced failure needs it.
- A late fallback response cannot overwrite a newer event.
- Additional rate-limit windows are retained instead of being discarded.

### Antigravity

- The authoritative shared pools are represented as Gemini and Claude/GPT pools, each with five-hour and weekly windows when the provider exposes them.
- Per-model fallback data is shown with its lower confidence. It is merged into a shared pool only when model-to-pool mapping and window compatibility are established; the most restrictive comparable bucket wins.
- Antigravity sources are ranked by account match and quota completeness; local quota-summary and authenticated Cloud Code reads are candidates, with the existing CLI path available when needed.
- A transient OAuth, network, CLI, or entitlement failure does not erase a good previous value.
- The model picker can show all user-facing models confirmed selectable by the signed-in ACP session, including Claude Sonnet, Claude Opus, and GPT-OSS where available.

### Models

The current official names and known API IDs to support are:

| Display name                 | Known provider ID          | Notes                                               |
| ---------------------------- | -------------------------- | --------------------------------------------------- |
| Claude Sonnet 4.6 (Thinking) | `claude-sonnet-4-6`        | Use the live provider ID when supplied.             |
| Claude Opus 4.6 (Thinking)   | `claude-opus-4-6-thinking` | Use the live provider ID when supplied.             |
| GPT-OSS 120B (Medium)        | `gpt-oss-120b-medium`      | Keep the provider’s native reasoning/effort option. |

The user referred to “Sonic”; interpret that as Claude Sonnet. The attached picker image shows 4.6, while the user guessed 4.5. If a signed-in provider still exposes 4.5 IDs, keep them as dynamically discovered legacy options. The exact IDs in this table are research leads, not permission to claim a model is selectable; the signed-in ACP session must confirm each ID.

## Diagnosis from the current repository

### Two quota pipelines currently exist

This is a verified split in the implementation and a plausible contributor to the reported inconsistency. It is not yet a proven root cause of the specific Codex wrong-until-refresh report.

1. Live quota state is produced by:

   - `apps/server/src/quota/QuotaService.ts`
   - `apps/server/src/quota/quotaReducer.ts`
   - `apps/server/src/quota/QuotaRefreshLoop.ts`
   - `apps/web/src/state/quota.ts`
   - `apps/web/src/components/quota/QuotaPanel.tsx`

2. The main Usage → Limits page separately reads provider snapshots from:

   - `apps/web/src/components/usage/UsageLimits.tsx`
   - `apps/web/src/components/usage/UsageLimitsPooled.tsx`
   - `packages/shared/src/usageLimits.ts`
   - `ServerProvider.usageLimits` in `packages/contracts/src/server.ts`

The first pipeline can be fresh while the second still contains the last server-config snapshot. The main page already calls `refreshUsageLimits`, and the websocket refresh command also refreshes provider snapshots, so the agents must reproduce the reported mismatch and trace which value is stale before replacing either path.

### Antigravity has duplicate parsers and an overly broad grouping model

Antigravity parsing exists in both:

- `apps/server/src/provider/Drivers/AntigravityQuota.ts`
- `apps/server/src/quota/normalizeRateLimits.ts`

The parsers accept overlapping but not identical payload shapes. The driver currently reduces groups to `gemini` and `claude-gpt`; unknown non-Gemini groups can be collapsed into the latter without preserving enough model identity. The UI also hardcodes those two keys in `QuotaPanel.tsx` and related aggregation code.

The current [official Antigravity model page](https://www.antigravity.google/docs/models/) shows two shared quota pools. The implementation should:

- preserve the two official pools for quota accounting;
- preserve all model IDs and display names for model selection;
- preserve model-to-pool membership for diagnostics and detail views;
- use a limiting per-model bucket only as a labeled fallback when the buckets are actually comparable.

Additional concrete parser risks in `AntigravityQuota.ts` need fixture-backed checks: `creditsToUsage` puts monthly prompt/flow credits under the Gemini quota group; `remainingToUsed` accepts ambiguous numeric strings and clamps invalid fractions into plausible percentages; generated bucket IDs include array positions; and direct group merging can produce duplicate windows for one pool. The quota reducer also deletes the last Antigravity snapshot when a point-in-time probe emits no usable windows. These are code facts, not proof that any one caused the user's present display.

### Current refresh behavior may not meet the desired freshness

The background quota loop currently operates on a 15-minute interval with a 10-minute minimum age. The sidebar can also request an initial refresh and the Usage page has its own refresh path, so these timings do not by themselves explain the wrong-until-refresh report. The provider health refresh interval is a separate five-minute setting; agents must trace both paths before changing either schedule.

The implementation must distinguish:

- event-driven updates after provider activity;
- visible-page or visible-sidebar refreshes;
- idle background refreshes;
- a manual refresh;
- a refresh at a known reset boundary.

## External research and conclusions

The implementation should borrow the useful patterns below, while keeping all provider access server-side.

### Codex patterns

- [AI usage tracker](https://github.com/Danielw412/AI-usage-tracker) combines the Codex app-server, Claude usage data, local history, and rate-limit observations. It backs off after 429 responses and keeps the latest sample with an age indicator.
- [Codex Reset Tracker](https://github.com/AyalX/codex-reset-tracker) reads Codex authentication metadata and exposes five-hour/weekly windows and reset credits without mutating the account.
- [CodexBar Codex provider](https://github.com/bcharleson/codexbar/blob/main/docs/codex.md) uses a source hierarchy of OAuth usage, CLI RPC, and optional dashboard data. It uses bounded timeouts and avoids repeatedly spawning a background process after repeated failures.
- [OpenUsage Codex provider](https://github.com/janekbaraniewski/openusage/blob/main/docs/site/docs/providers/codex.md) combines `/wham/usage`, local JSONL, and app-server fallback. It preserves `primary`, `secondary`, and `additional_rate_limits`, and treats 401/403 as source failures rather than destroying local data.

Conclusion: investigate event/probe ordering and freshness first. Add a direct `/wham/usage` source only if a failing reproduction shows the existing native app-server read cannot provide the needed freshness or coverage; it is a third-party-documented, less stable integration than the provider's app-server API.

### Claude patterns

- [Claude Code usage and limits](https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code) describes five-hour and weekly subscription windows and identifies the provider’s own usage view as the source of truth.
- The existing T3 Claude adapter already receives provider-native rate-limit events. External usage trackers also capture rate-limit headers/statusline data when available and preserve the last successful snapshot after throttling.

Conclusion: keep the existing native event path, normalize its window IDs, and add freshness/backoff metadata rather than replacing it with UI scraping.

### Antigravity patterns

- [OpenUsage Antigravity provider](https://github.com/robinebers/openusage/blob/main/docs/providers/antigravity.md) identifies two shared pools, five-hour and weekly windows, local language-server data as the preferred source, and `retrieveUserQuotaSummary` as the strongest remote source. Its per-model fallback chooses the limiting bucket instead of averaging.
- [CodexBar Antigravity provider](https://github.com/bcharleson/codexbar/blob/main/docs/antigravity.md) uses local language-server/CLI sources first and the authenticated Cloud Code API second, with `RetrieveUserQuotaSummary` followed by `GetUserStatus` and model configuration fallbacks.
- [Usagebar Antigravity notes](https://github.com/luisleineweber/usagebar-fork-archive/blob/main/docs/providers/antigravity.md) documents local port/CSRF discovery, remote `retrieveUserQuotaSummary`, `fetchAvailableModels`, and careful handling of 401/403 responses.
- [Antigravity Manager quota implementation](https://github.com/lbjlaq/Antigravity-Manager/blob/main/src-tauri/src/modules/quota.rs) fuses real bucket data into models, uses the limiting bucket, and warns against inferring subscription tier from a model list.
- [Antigravity CLI usage](https://www.antigravity.google/docs/cli/commands/usage/) confirms that `/usage` and `/quota` request fresh usage data and show per-model remaining requests/tokens. Use the CLI as a bounded fallback, not by scraping its terminal UI.
- [Antigravity status line documentation](https://www.antigravity.google/docs/cli/statusline/) exposes structured `quota` buckets with `remaining_fraction` and `reset_time` during an active CLI session. Inspect whether T3 can consume an existing provider event or structured status payload without changing the user's status-line configuration.

Conclusion: compare each source against the same account and timestamp before ranking it. Local app or CLI quota-summary data may be richer than OAuth; a local IDE/model-availability response may be less complete. Source choice must depend on demonstrated completeness and account identity, not a universal local-first rule.

### Model catalog

- [Official Antigravity model documentation](https://www.antigravity.google/docs/models/) lists Gemini 3.8 Flash, Gemini 3.7 Flash, Gemini 3.6 Flash, Gemini 3.1 Pro, Claude Sonnet 4.6 (Thinking), Claude Opus 4.6 (Thinking), and GPT-OSS 120B (Medium).
- [Antigravity API specification](https://github.com/cortexkit/antigravity-auth/blob/main/packages/opencode/docs/ANTIGRAVITY_API_SPEC.md) documents the known Claude and GPT-OSS IDs used above.
- [OpenClaw’s Antigravity model issue](https://github.com/openclaw/openclaw/issues/10976) confirms the Opus 4.6 thinking ID and distinguishes the user-facing name from the API ID.

Conclusion: the model catalog must be data-driven and accept live provider model options. `model-manifest.json` can provide defaults and labels, but it must not be the only source of truth.

## Target architecture

### Phase 0: establish a red/green signal before changing quota logic

Owner: first implementing agent. This is a gate for the later phases, not a new subsystem.

1. Record a sanitized comparison for the **same provider account and window**: provider-owned usage view or structured CLI result, T3 sidebar value, T3 Usage → Limits value, observation time, reset time, and account identity. Never copy tokens or full provider payloads into a ticket.
2. Trace `serverRefreshProviders` through the provider probe, `QuotaService`, server-config publication, and both client reads. Determine whether the bad value originates in the provider response, parser, merge, account selection, refresh scheduling, or UI cache.
3. Create one named, fast, deterministic command that fails on the observed mismatch. Prefer an existing focused test with a sanitized provider-shaped fixture. Run it once and capture the red result **before** applying a fix. Use separate red checks for Codex stale-after-event, Antigravity percentage/pool, and missing model selection if they prove to be separate defects.
4. If the user-only symptom cannot be reproduced from available local state, do not call any suspected cause proven. Finish safe parser/model fixture checks and state exactly what account-level capture or environment access is missing.
5. Repeat the same command after the change and require green. A green general suite with no symptom-specific red signal is insufficient.

This is where the Diagnosing Bugs workflow changes the plan: the previous version chose an architecture before securing a reproducible failure.

### One canonical normalized snapshot

Prefer the existing `QuotaSummary` event stream for native subscription quotas. Keep `ServerProvider.usageLimits` where needed for existing provider snapshots, hub accounts, spend windows, and reset-credit routing. Feed the pooled view from the freshest compatible native snapshot while preserving the existing hub/account merge. Do not replace the large `packages/shared/src/usageLimits.ts` pipeline until a red check proves a narrower adapter insufficient.

Start with the minimum useful metadata on a provider account snapshot:

```text
providerInstanceId
groups[]
  key
  displayName
  windows[]
    id                    optional stable semantic ID when sparse merging requires one
    kind                  short | long | unknown (existing contract)
    label
    usedPercent           present only when known; unknown windows are absent
    resetsAt              optional absolute timestamp
    windowDurationMins    optional
lastAttemptAt
lastSuccessfulAt
source
errorCode                optional non-sensitive enum
```

Use the existing `observedAt` as the value timestamp. Derive `fresh`, `stale`, and `unavailable` in the view from observation age, reset boundary, and the last attempt result. An `estimated` badge follows from source provenance. Add optional wire fields only where a failing check needs them; bump `QUOTA_CONTRACT_VERSION` if the wire representation changes incompatibly, and verify version gating in both web and mobile.

### Source values

Extend the existing non-secret `QuotaSource` only for sources actually implemented. Candidate values are:

- `provider-event`
- `codex-wham`
- `codex-app-server`
- `codex-transcript`
- `claude-rate-limit-event`
- `claude-statusline`
- `antigravity-local-language-server`
- `antigravity-cli`
- `antigravity-quota-summary`
- `antigravity-model-fallback`

Keep existing `state-file` and `limit-signal` meanings. Mark transcript/local-history estimates as estimated; never present them as authoritative provider quota. Avoid duplicating per-window source fields unless windows in one snapshot genuinely come from different sources.

### Freshness rules

- `observedAt` is when the provider data was observed, not when the UI rendered it.
- `lastAttemptAt` changes on every attempted source call.
- `lastSuccessfulAt` changes only after a structurally valid provider response.
- A failed refresh does not replace the last successful windows, but an authoritative successful empty result must not silently refresh their age. Distinguish failure, unsupported, and truly empty success.
- Each provider has a normal freshness duration, but the UI also shows age. Start with:
  - Codex visible/active: consider 60 seconds;
  - Claude event-driven: consider 5 minutes unless a reset/event indicates otherwise;
  - Antigravity visible/active: consider 2 minutes;
  - idle background: keep the existing 10–15 minute sweep until measured need says otherwise.
- Treat those numbers as initial candidates. Measure provider latency and throttling in Phase 0 before lowering the actual schedule. Do not start a new probe from each mounted client or every render.
- A reset boundary triggers a refresh and can temporarily mark the previous value stale until a new provider response arrives.
- Do not claim a value is “live” merely because the websocket is connected.

### Stable window IDs

Where a source provides IDs, preserve them. Where sparse merging requires generated IDs, derive them from provider/account/pool/window semantics, never array indices. Examples:

- `codex:primary:five-hour`
- `codex:secondary:weekly`
- `claude:five-hour`
- `claude:seven-day`
- `antigravity:gemini:five-hour`
- `antigravity:gemini:weekly`
- `antigravity:claude-gpt:five-hour`
- `antigravity:claude-gpt:weekly`

The existing live `QuotaWindow` has no ID. Add one only if the observed sparse update cannot be safely matched by the existing kind/label/duration tuple; keep UI IDs stable regardless of array order.

## Implementation phases

Run Phase 0 first, then do only the phases its evidence requires. Agents should not edit overlapping files concurrently.

### Phase 1: contracts and canonical view model

Owner: contracts/shared-state agent.

Files to inspect and likely change:

- `packages/contracts/src/quota.ts`
- `packages/contracts/src/providerUsageLimits.ts`
- `packages/contracts/src/server.ts`
- `packages/shared/src/usageLimits.ts`
- related schema and contract tests.

Tasks:

1. Add only the source/attempt/success metadata required by the Phase 0 red checks, with backward-compatible optional fields where practical.
2. Build the smallest adapter that overlays newer native live quota onto the existing pooled `UsageLimitsReport`. Preserve the current hub, cross-environment account matching, reset-credit selection, and redemption routing in `packages/shared/src/usageLimits.ts`.
3. Keep hub/spend data separate from provider subscription quota. A spend budget must not be used to fill a missing subscription window.
4. Reuse existing identity rules for provider instances and accounts; add an identity field only if the fixture proves the current merge wrong.
5. Ensure sparse updates preserve earlier windows and full snapshots replace only the relevant provider/account snapshot. Preserve the semantic distinction between empty success and probe failure.
6. Preserve unknown windows as unknown rather than assigning a guessed duration.
7. Add one focused schema/aggregation check for each new state introduced.

Acceptance criteria:

- There is one shared native quota conversion used by both web and mobile limit views.
- A snapshot can represent “last good value, refresh failed” without losing the last good windows.
- Old clients can ignore new optional metadata without failing schema validation.

### Phase 2: server refresh coordinator

Owner: server orchestration agent.

Files to inspect and likely change:

- `apps/server/src/quota/QuotaService.ts`
- `apps/server/src/quota/quotaReducer.ts`
- `apps/server/src/quota/QuotaRefreshLoop.ts`
- `apps/server/src/ws.ts`
- `apps/server/src/provider/providerUsageLimits.ts`
- `apps/server/src/provider/makeManagedServerProvider.ts`

Tasks:

1. First check whether the existing provider refresh path already coalesces simultaneous requests. Add per-instance coalescing only for a reproduced duplicate-probe case.
2. Record `lastAttemptAt`, source, and non-sensitive error classification for every attempt.
3. Record the revision when a probe starts. At completion, reject it if a newer event or successful probe has already published for that account. Do not infer freshness from a provider timestamp if that provider does not publish one.
4. Preserve the last successful snapshot across 401, 403, 429, timeout, malformed-response, and process-start failures.
5. Add backoff only where a source returns a retryable 429/5xx. Honor `Retry-After` when valid; otherwise use a bounded backoff. Do not retry authentication/entitlement failures in a hot loop.
6. Publish provider events immediately. Probe on demand, on the existing idle sweep, and near a reset boundary where that materially improves freshness; avoid spawning a second probe for an event that already contains complete quota.
7. Continue to support the existing provider refresh command and receipts. Do not replace receipt-driven orchestration with sleep-based polling.
8. Make the refresh result observable by the existing websocket quota subscription so all clients receive the same result.

Acceptance criteria:

- One manual refresh updates the canonical server state and emits one coherent update.
- Two simultaneous refresh commands result in one provider probe per account.
- A stale/failed probe cannot erase a newer successful event.
- The loop does not continuously repaint or create unbounded subprocesses.

### Phase 3: Codex source hierarchy and reconciliation

Owner: Codex provider agent.

Files to inspect and likely change:

- `apps/server/src/provider/Drivers/CodexDriver.ts`
- `apps/server/src/quota/normalizeRateLimits.ts`
- `apps/server/src/provider/providerUsageLimits.ts`
- `apps/server/src/quota/CodexTranscriptQuota.ts`
- Codex driver and normalization tests.

Keep the existing app-server read as the first active Codex probe. Native `account/rateLimits/updated` remains the immediate event source. Consider this fallback order only after Phase 0 proves a gap in app-server data or freshness:

1. Local Codex app-server `account/read` and `account/rateLimits/read`.
2. Direct authenticated Codex usage endpoint for supported accounts, if its response demonstrably fixes a missing field or stale read. Treat the endpoint as version-sensitive, use the correct account identity, a bounded timeout, and no credential logging.
3. Newest local transcript rate-limit event as a stale/estimated fallback only.

Parser requirements:

- Accept wrapped and unwrapped payloads.
- Parse primary and secondary windows, plus `additional_rate_limits` when the chosen source actually publishes them.
- Accept Unix seconds and milliseconds only when the magnitude is unambiguous; reject impossible reset dates.
- Preserve `used_percent`, `window_minutes`, and reset timestamps.
- Keep reset credits as a separate balance/credit field, not as a percentage window.
- Handle accounts for which a source returns 401/403 by falling back without destroying the last good snapshot.
- Kill a child process on timeout and avoid repeatedly launching it after a short-term failure.
- Never infer a quota from token counts or spend when the provider did not expose a quota percentage.

Reconciliation requirements:

- Capture the local revision at probe start and compare it before publication.
- Use a provider observation timestamp only when that source actually supplies one; otherwise publication order and probe-start revision decide.
- Do not let an older probe overwrite a newer event or a later successful probe.
- Keep the newest valid window independently when a response contains a sparse update.

Refresh behavior:

- Event-driven updates are immediate.
- Visible limits views may request a refresh no more often than once per measured safe interval per account; begin by checking the existing refresh throttle.
- Idle refresh may remain at several minutes.
- Schedule a refresh around `resetsAt`.
- Back off 429 responses according to the provider's `Retry-After` where available; show the age of the last successful value.

Tests:

- Direct endpoint success with primary/secondary/additional windows.
- Wrapped and unwrapped responses.
- Seconds versus milliseconds.
- 401, 403, 429, timeout, malformed JSON, and process exit failure.
- App-server fallback.
- Transcript fallback marked estimated/stale.
- A newer event followed by a late older probe.
- Reset credits and absent optional fields.
- Manual refresh plus background refresh coalescing.

### Phase 4: Claude normalization and freshness

Status: Completed and merged into omni/main.

Files to inspect and likely change:

- Claude adapter and provider rate-limit normalization files.
- `apps/server/src/quota/quotaReducer.ts`.
- Existing Claude provider tests.

Tasks:

1. Preserve the native `rate_limit_event` path as the primary source.
2. Normalize canonical IDs for five-hour, seven-day, and model-specific weekly windows. Do not create duplicate windows when the provider changes a label.
3. Keep the current successful bars when a 429 or temporary provider error occurs, and attach stale age plus a retry state.
4. Capture provider-native headers/statusline data only where it is already available in the adapter or command protocol. Do not scrape the Claude UI.
5. Keep spend/usage accounting separate from subscription quota.
6. Refresh at reset boundaries and on manual request, with bounded backoff after throttling.

Tests:

- Full rate-limit event.
- Sparse rate-limit event merged by stable ID.
- 429 preserving the last good value.
- Weekly model-specific windows.
- Reset timestamp and stale metadata.

### Phase 5: Antigravity provider source stack

Status: Completed and merged into omni/main.

Files to inspect and likely change:

- `apps/server/src/provider/Drivers/AntigravityQuota.ts`
- `apps/server/src/provider/Drivers/AntigravityDriver.ts`
- `apps/server/src/provider/Layers/AntigravityAdapter.ts`
- `apps/server/src/quota/normalizeRateLimits.ts`
- Antigravity quota/driver tests.

Do not maintain two independent Antigravity interpretations. Extract shared parsing primitives so the direct driver and the bridge/event normalizer use the same rules.

#### Source priority

Check the completeness and identity of each source before deciding an order. The initial candidate order per profile/account is:

1. Running Antigravity desktop app quota-summary endpoint, when it exposes both shared pools.
2. Running `agy` local quota-summary endpoint or the existing structured `agy -p /quota --output-format json` command.
3. Authenticated Cloud Code OAuth `retrieveUserQuotaSummary`.
4. IDE local model/session data, official CLI status-line `quota` event if already available to T3, or remote per-model quota fallback, clearly labeled as partial.

Do not replace a complete two-pool quota summary with a newer model-availability response that lacks the weekly window. A source also must match the selected account/profile before its numbers can replace another source. The remote source must still work when the desktop app is not running.

#### Local discovery

- Discover only a relevant same-user running process and its explicit localhost port/CSRF arguments. Probe only loopback addresses; never send the CSRF token to a remote host.
- Do not use `pkill`, broad `pgrep | kill`, or process-name killing.
- Probe the observed local endpoints with bounded timeouts; the CodexBar implementation is a reference, not a provider stability guarantee.
- Prefer `RetrieveUserQuotaSummary`.
- Fall back to `GetUserStatus` and `GetCommandModelConfigs`/equivalent model configuration endpoints.
- Treat local 401 as a reauthentication signal, 403 as an entitlement signal, and 5xx/timeout as a fallback condition.
- Do not scrape terminal rendering or parse arbitrary UI text when a structured response exists.

#### Remote OAuth flow

- Read the existing Antigravity token file server-side only, with its configured profile directory as the identity boundary.
- Refresh tokens only against an explicit allowlist of Google token hosts.
- Call `loadCodeAssist` and use its `cloudaicompanionProject` if present. The existing T3 code intentionally sends `{}` to `retrieveUserQuotaSummary` when the companion project is absent; preserve that supported path and never substitute a guessed project ID.
- Call `retrieveUserQuotaSummary` as the primary quota source.
- Keep the currently working daily host by default. Add sandbox/production host fallback only after a sanitized, account-matched fixture proves it is needed and those hosts return the same quota semantics; a successful response from a different host can still belong to the wrong project or product.
- On 401, invalidate only the in-memory access token and report reauthentication; do not delete credentials.
- On 403, report entitlement/unsupported access and retain the previous value.
- On 429/5xx, retry a bounded number of times or use the next allowed host, then apply backoff.

#### CLI fallback

- Reuse the existing structured `agy -p /quota --output-format json` path where it actually returns a quota-summary payload.
- Keep the existing legacy text parser only for older CLI versions.
- Treat opening `/usage` or `/quota` as a provider refresh operation. The officially documented status-line JSON is a separate optional structured source, but do not overwrite the user's status-line settings to obtain it.
- Bound the process lifetime, capture stderr separately, and terminate only the child PID started for this request.

#### Payload normalization

The shared parser must accept the known root and nested forms:

- `groups`
- `quotaGroups`
- `modelGroups`
- `quotaSummary`
- `pools`
- keyed window maps as well as window arrays.

For each bucket:

- accept camelCase and snake_case field names;
- accept `remainingFraction` in `[0, 1]`;
- accept `remainingPercent` in `[0, 100]`;
- accept `usedPercent`/`utilization` in `[0, 100]`;
- reject out-of-range values and numeric strings unless a source-specific schema documents them; the legacy text parser may explicitly parse a `%` suffix;
- convert to one canonical `usedPercent` value exactly once;
- parse ISO timestamps and valid epoch seconds/milliseconds;
- preserve unknown duration/window kind instead of guessing.

Keep prompt/flow credits as a separate credit balance. `loadCodeAssist.quotaManagerState` must not become a Gemini five-hour or weekly subscription bar. If no quota summary is available, show “quota unavailable” and show credits separately only if there is already an appropriate credits UI.

#### Pool logic

Use these stable pool keys when the provider identifies the shared pools:

- `gemini` → `Gemini Models`
- `claude-gpt` → `Claude & GPT models`

The provider's current public UI groups Claude and GPT models in the second pool. Unknown model families stay unknown until the provider associates them with a pool. Do not silently put every unfamiliar model in the Claude/GPT pool.

When only per-model fallback data exists:

1. Map only recognized Gemini, Claude, and GPT-OSS models to a documented shared pool.
2. Group valid buckets by pool, window kind, account identity, and compatible reset period.
3. Choose the lowest remaining fraction among comparable buckets as a conservative estimate; this is not a replacement for an authoritative pooled summary.
4. Use the reset time belonging to the limiting bucket.
5. Mark the result `antigravity-model-fallback` and make partial coverage visible.
6. If a window is absent, leave that window unknown instead of treating it as unlimited.

Never average model percentages for a shared pool.

#### Refresh behavior

- Initial refresh runs in the background without blocking app startup.
- A visible limits page or sidebar may ask for a refresh at a measured safe interval. Start with the existing scheduling and lower it only after latency/throttling evidence, rather than adding a second cache by default.
- Idle profiles use the slower background interval.
- Manual refresh should bypass age throttling once, but remain subject to an in-flight request and provider backoff.
- A reset boundary schedules a fresh request.
- Account/profile identity is part of any cache key so one login cannot reuse another login’s quota. Do not put a token itself in the key or logs.
- Preserve the last good snapshot across transient failures and expose source plus age.

Tests:

- Direct quota summary with both pools and both windows.
- Nested and keyed payload shapes.
- Remaining fraction, remaining percent, and used percent inversion.
- Invalid/out-of-range values rejected.
- Weekly and five-hour duration parsing.
- Missing weekly bucket remains unknown.
- Per-model fallback selects the worst bucket.
- Monthly prompt/flow credits cannot appear as Gemini subscription quota.
- Reordered buckets keep stable identities and do not duplicate the same pool/window.
- A successful empty payload, a parse failure, and an authentication failure produce distinct outcomes.
- A complete, account-matched two-pool summary wins over a partial model or IDE response.
- A response from a different account or unproven project cannot overwrite the selected account.
- 401, 403, 429, 5xx, timeout, malformed JSON, and expired token.
- Multiple concurrent callers share one request.
- Previous good value survives a failed refresh.

### Phase 6: Antigravity model catalog

Owner: Antigravity model/options agent.

Files to inspect and likely change:

- `apps/server/src/provider/Layers/AntigravityProvider.ts`
- `apps/server/src/provider/acp/AntigravityAcpSupport.ts`
- `apps/server/src/provider/model-manifest.json`
- Antigravity provider and driver tests.

Tasks:

1. Capture a sanitized ACP `sessionSetupResult` and `configOptions` fixture from the affected signed-in profile. First determine whether Claude and GPT-OSS are absent from ACP, dropped by `buildAntigravityModelsFromSession`, or filtered later by manifest classification/the client picker.
2. Use live ACP `configOptions` model select as the primary selectable catalog. Preserve every user-facing option returned by ACP, including non-Gemini entries; the current helper already flattens grouped options, so add a failing fixture before changing it.
3. If ACP returns only Gemini, compare the structured local/remote model configuration with the ACP list. Show a model as selectable only after a real ACP `setModel` attempt or documented ACP capability confirms the ID works for that account. A remotely advertised ID by itself is insufficient.
4. Filter only explicitly internal, empty, malformed, or provider-declared unsupported models. Do not use a Gemini-only allowlist.
5. Preserve the exact provider ID separately from the display label.
6. Keep model display labels provider-owned when present; otherwise apply the verified manifest labels.
7. Update `model-manifest.json` with known Claude/GPT-OSS classification metadata only if a failing test shows manifest classification suppresses or mislabels live options. Do not change the default model merely to add choices; live provider data wins.
8. Keep 4.5 aliases only when the provider returns them. Support both `claude-opus-4-5-thinking` and any live Sonnet 4.5 equivalent through discovery, not unconditional fake availability.
9. Ensure a saved explicit model selection survives a config refresh if it is still valid.
10. If a saved model disappears, confirm current ACP behavior and provide a clear fallback to a valid provider option; do not silently pretend the saved model was selected.
11. Pass the provider’s native thinking/effort selection. Do not turn “thinking” into a fake local boolean if ACP expects a separate option.

Required fixture options:

- all existing Gemini models;
- Claude Sonnet 4.6 (Thinking);
- Claude Opus 4.6 (Thinking);
- GPT-OSS 120B (Medium);
- an optional 4.5 legacy model;
- an internal model that must be filtered.

Acceptance criteria:

- The model picker shows the three new user-facing model entries when ACP confirms them selectable for that account.
- Selecting each entry sends the exact provider ID and succeeds in an ACP fixture/integration check.
- Restarting the session does not reduce the list back to Gemini-only.
- A provider that does not expose a model does not show it as selectable.

### Phase 7: one UI aggregation path

Owner: web/mobile UI agent.

Files to inspect and likely change:

- `apps/web/src/components/usage/UsageLimits.tsx`
- `apps/web/src/components/usage/UsageLimitsPooled.tsx`
- `apps/web/src/components/quota/QuotaPanel.tsx`
- `apps/web/src/components/quota/quotaAggregation.ts`
- `apps/web/src/state/quota.ts`
- `apps/mobile/src/features/usage/UsageLimitsPooled.tsx`
- related shared limit components and tests.

Tasks:

1. Feed the main Usage → Limits page the newest compatible native quota snapshot from the live subscription, while preserving its existing server-config hub data, account deduplication, pooled presentation, and reset-credit routing.
2. Keep provider snapshots for existing consumers. If simpler and proven by the Phase 0 repro, publish the same canonical native value into both server-config and live quota streams at the server boundary instead of adding a client overlay.
3. Keep the two known Antigravity pool keys. Preserve and render any unknown provider group as unknown instead of silently assigning it to `claude-gpt`; add generic rendering only if a fixture actually exposes a third group.
4. Show:
   - used/remaining percentage;
   - reset time/countdown;
   - source;
   - age or “updated just now”;
   - stale/unavailable/estimated state;
   - retry/manual refresh affordance.
5. Keep one refresh action per visible surface that reaches the same server refresh operation and publishes both subscribed values where needed. Respect the Usage page's environment selection.
6. Use the limiting window for pool-level warning state. Do not average windows or models to decide whether a pool is exhausted.
7. Keep reset countdown updates lightweight and event-driven; do not introduce continuously repainting animations.
8. Make the same semantics work in web, desktop-wrapped web, and mobile. Mobile may use a compact layout but must not use a second parser.
9. Ensure accessible labels expose provider, pool, window, percentage, reset time, freshness, and error status.
10. Avoid showing raw provider errors, URLs, tokens, or internal routing IDs in ordinary quota copy; keep the existing redacted account-identification controls where users need them.

Suggested Antigravity display:

```text
Antigravity
  Gemini Models
    5-hour       42% used · resets 2h 10m · updated 18s ago
    Weekly       61% used · resets Tue 09:00 · updated 18s ago
  Claude & GPT models
    5-hour       78% used · resets 1h 04m · updated 18s ago
    Weekly       unavailable · provider did not expose this window
```

If the provider only returns per-model fallback data, show “partial model data” and the observed model names. Do not label it an exact shared-pool percentage unless confirmed against a provider quota summary.

### Phase 8: focused verification and integration

Owner: verification agent, after all previous phases are merged.

Do not run repo-wide checks. Run the smallest relevant checks first:

1. Re-run every named red/green command from Phase 0 and preserve its red-before/green-after evidence.
2. Contract/schema tests for any changed contract files.
3. Focused server tests for the provider parsers, refresh path, and model catalog actually changed.
4. Focused shared/web/mobile tests for any changed aggregation and stale/error states.
5. Targeted lint/typecheck for the touched packages.
6. One integrated web pass in the project’s T3 test environment after permission to use a browser has been obtained, if UI behavior changed. Verify:
   - initial load;
   - manual refresh;
   - a provider failure preserving the previous value;
   - stale indicator;
   - Codex event followed by page navigation;
   - Antigravity two-pool display;
   - model picker entries and selected IDs.
7. Run a mobile integrated pass if mobile code changed and a runnable target exists.

Use fake HTTP servers, fixture JSON, fake child-process responses, and fake clocks. Do not use real provider credentials in tests.

## Suggested agent handoff order

Use one agent per step, in this order:

0. Reproduce, capture sanitized fixtures, and trace each value end to end.
1. Contracts/shared view model, only if a wire or UI adapter change is needed.
2. Server refresh coordination, only for a reproduced race, stale publication, or duplicate probe.
3. Codex freshness and source fallback, starting with its existing app-server path.
4. Claude hardening, only for verified regressions or shared-contract changes.
5. Antigravity parser/source corrections, beginning with credit separation and percentage validity.
6. Antigravity model catalog, beginning with the signed-in ACP options fixture.
7. Web/mobile UI updates required by the chosen data path.
8. Focused regression and integrated verification.

Each agent should return:

- files changed;
- focused tests run and their results;
- source/freshness behavior implemented;
- any provider-specific limitation that remains;
- a short note for the next agent.

Do not have parallel agents edit the same parser, contract, or UI aggregation files. If a phase discovers a contract problem, stop and update Phase 1 before adding a local workaround.

## Definition of done

The work is complete only when all of the following are true:

- The main Limits page and sidebar show the same account/window values or explain a documented source difference with timestamps.
- Codex event and app-server behavior is tested; direct endpoint and transcript fallback are included only if Phase 0 proves they are needed.
- Claude native events remain accurate and are not erased by throttling.
- Every Antigravity source actually used is account matched, bounded, and tested; partial fallbacks are visibly marked.
- Antigravity per-model fallback uses the limiting comparable bucket as a labeled estimate; authoritative summary pools retain their provider-published values.
- Freshness and source are visible wherever a value might otherwise appear current when it is stale or partial.
- Antigravity model discovery includes all live user-facing models, including Claude Sonnet, Claude Opus, and GPT-OSS where the account exposes them.
- Manual refresh, reset-boundary refresh, background refresh, and failed-refresh behavior are covered.
- Web and mobile use the same aggregation semantics.
- No credentials or raw provider responses appear in logs, tests, screenshots, or client payloads.
- Focused checks pass and any remaining provider limitation is explicitly visible rather than silently guessed.

## Non-goals

- Do not scrape provider web dashboards or terminal presentation when a structured API/CLI response exists.
- Do not infer subscription tier from the model list.
- Do not treat local conversation spend/history as authoritative subscription quota.
- Do not add a new database or third-party usage service unless the existing provider sources cannot satisfy the freshness requirement.
- Do not change provider authentication or delete credentials as part of a quota refresh failure.
- Do not make every model its own Antigravity quota pool when the provider exposes shared pools.

## Execution Progress & Handoff Summary

### Phases 0-5: Completed

- Phase 0: Traced reproduction and fixtures across Codex, Claude, and Antigravity.
- Phase 1: Shared contracts and view models (`packages/contracts/src/quota.ts`, `packages/shared/src/usageLimits.ts`).
- Phase 2: Server refresh coordination & quota reducer (`apps/server/src/quota/QuotaService.ts`, `QuotaRefreshLoop.ts`, `quotaReducer.ts`).
- Phase 3: Codex freshness and app-server integration verified with event timestamps and classified error fallback.
- Phase 4: Claude native event normalization and throttle resilience preserved.
- Phase 5: Antigravity parser/source corrections with credit separation, percentage sanity, and dual-pool normalization (`apps/server/src/quota/antigravityQuotaParser.ts`, `normalizeRateLimits.ts`, `AntigravityQuota.ts`).

### Phase 6: Antigravity Model Catalog (Completed)

- Verified and validated complete live model catalog in ACP options:
  - Gemini models: Gemini 3.8 Flash, Gemini 3.7 Flash, Gemini 3.6 Flash, Gemini 3.1 Pro.
  - Claude models: Claude Sonnet 4.6 (Thinking), Claude Opus 4.6 (Thinking).
  - GPT models: GPT-OSS 120B (Medium).
- Model catalog driver and ACP support tests verified (42 tests in `AntigravityAcpSupport.test.ts`, 25 tests in `AntigravityProvider.test.ts`).

### Phase 7: Unified Web & Mobile UI Aggregation Path (Completed)

- **Web UI**:
  - `QuotaPanel.tsx` renders unified Antigravity dual-pool cards (`Gemini Models` and `Claude & GPT models`) with custom brand accents (`#4f8cff` and `#34d399`), 5-hour and weekly session metrics, and single-click manual refresh affordance.
  - `UsageLimits.tsx` consumes `useQuota()` and overlays live quota snapshots via `withNativeQuotaSnapshots(serverConfig.providers, envSnapshots)`.
  - Stale indicators and reset countdowns correctly anchored to minute clock without animation churn.
- **Mobile UI**:
  - Implemented `apps/mobile/src/state/quota.ts` (mirroring `apps/web/src/state/quota.ts` over mobile's atom wiring and registry).
  - Integrated `useQuota()` and `withNativeQuotaSnapshots` in `apps/mobile/src/features/usage/UsageLimitsPooled.tsx` for both `UsageLimitsSection` and `UsageLimitAccountScreen`.
  - Mobile now shares the exact same live native quota aggregation semantics as Web, displaying pooled limits across connected environments.
  - Added unit test suite `apps/mobile/src/features/usage/usageLimitsOverlay.test.ts` validating live snapshot overlay, Antigravity dual-pool handling, and freshness timestamp precedence.

### Phase 8: Focused Verification & Integration (Completed)

- Ran focused test suite across 15 test files covering all touched layers:
  - `packages/contracts/src/quota.test.ts` (3 tests passed)
  - `apps/server/src/quota/quotaReducer.test.ts` (24 tests passed)
  - `apps/server/src/quota/normalizeRateLimits.test.ts` (37 tests passed)
  - `apps/server/src/quota/QuotaRefreshLoop.test.ts` (4 tests passed)
  - `apps/server/src/quota/CodexTranscriptQuota.test.ts` (2 tests passed)
  - `apps/server/src/quota/QuotaService.test.ts` (8 tests passed)
  - `apps/server/src/provider/Drivers/AntigravityQuota.test.ts` (11 tests passed)
  - `apps/server/src/provider/acp/AntigravityAcpSupport.test.ts` (42 tests passed)
  - `apps/server/src/provider/Layers/AntigravityProvider.test.ts` (25 tests passed)
  - `packages/shared/src/usageLimits.test.ts` (32 tests passed)
  - `packages/client-runtime/src/state/usage.test.ts` (7 tests passed)
  - `apps/server/src/provider/usageLimits.test.ts` (4 tests passed)
  - `apps/web/src/components/quota/quotaAggregation.test.ts` (10 tests passed)
  - `apps/mobile/src/features/usage/usageEnvironmentSelection.test.ts` (6 tests passed)
  - `apps/mobile/src/features/usage/usageLimitsOverlay.test.ts` (2 tests passed)
  - **Total**: 217 passed (100% green).
- Typecheck:
  - `@t3tools/mobile` typecheck cleanly passed (`tsc --noEmit` code 0).
  - `@t3tools/web` typecheck cleanly passed (`tsc --noEmit` code 0).
- Lint & formatting:
  - `vp fmt --check` clean across all modified files.
  - `vp lint` clean across all modified files with 0 warnings, 0 errors.
