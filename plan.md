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

---

## Reliability extension — agent hangs, memory pressure and provider failures (2026-10-21)

This section adds work; all preceding usage/model tasks and their recorded progress remain unchanged. It applies only to the RLY task IDs below. Keep the existing visual, efficiency and other work in the repository and queue intact. `plan.md` is the existing root file extended here; the distinct `PLAN.md`, `omni/PLAN.md` and `docs/agentqueue/PLAN.md` are not replaced. This edit does not import, claim, schedule or complete queue tasks.

### Evidence and remaining uncertainties

The incident was investigated against source commit `1c59606ae7`. Linux reports 26 GiB of online memory blocks and 25.43 GiB usable RAM (27.3 decimal GB). The hypervisor's configured allocation and any ballooning setting have not been inspected. Do not describe these guest measurements as proof of the host configuration.

At 2026-10-21 03:17:47 UTC the kernel recorded a global OOM kill. Four `tsc` processes had approximately 7.493, 6.514, 2.553 and 2.518 GiB resident, and another 3.401 GiB of swap between them. The kernel reported only 204 KiB of free swap out of 8 GiB. RSS is not a unique-memory accounting metric, but the compiler anonymous-memory and swap footprint establish real pressure, not just reclaimable file cache. The RAM tracker recorded less than 1 GiB available repeatedly during the preceding day. The integration thread's own output showed checks lasting 15–16 hours. The exact checker/plugin defect behind those durations has not been reproduced; do not label it a proven compiler leak.

Source findings: `resourceRunner.ts` classifies Gradle but not TypeScript checkers as heavy work; `resourceBroker.ts` estimates heavy work at 3500 MiB; `hostCapacity.ts` uses guest memory/load, not effective cgroup headroom, and lets the first worker bypass admission. Native provider tools are not automatically mediated by `agentq run`. `agentScope.ts` sets aggregate limits but not a separate budget for each owned run. `GoalService.ts` considers a busy session or background work alive without proving useful progress. `ProviderRuntimeRecoveryService.ts` reconciles at startup/shutdown; a stale running start effect remained until restart, blocking a later start for the same thread. These gaps require failure-path tests, not another blanket restart policy.

An interrupt requested at 23:26:41 was acknowledged at 03:17:54. The Claude adapter awaited an SDK interrupt without a deadline before closing the CLI. A local hotfix bounds that wait and continues cleanup on error: commit `75d4c743ba`, branch `fix/agent-stop-recovery-20261021`, installed privately as `0.1.4-incident.1`. Its source worktree is `/tmp/t3-incident-repair-20261021`; the main checkout does not contain that commit. Port the code/regressions without copying its private version label or unrelated dirty main-checkout files. The full adapter suite passed 287 tests and timed out in the existing foreground-subagent steering case; the same case failed on original source and passed once in isolation. RLY01 owns resolving that deterministic-test gap.

Two Claude attempts failed after about 90 seconds with `Claude Code did not answer the MCP server registration`. This establishes a failed local SDK/CLI/MCP handshake, not an authentication, quota or vendor-outage diagnosis. A post-recovery standalone registration probe answered in 1.6 seconds; it did not exercise the complete authenticated T3 tool flow. Codex's earlier stream closure and the stale start effect likewise need independent reproduction. Resource pressure is a contributor, not a proven explanation for every provider error.

### Fixed decisions for this extension

| Area                | Required behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ownership           | Preserve accounts, profiles, credentials, worktrees, edits, claims and persistent user services. Teardown uses an owned process handle/scope plus process identity, never name matching. An unrelated process is never a recovery target. A shared provider process is not exclusive ownership of every thread it serves: logical cancellation must preserve other active owners; whole-process escalation needs exclusive ownership proof.                                                                                                                                                                                                                                                                                                    |
| Existing safeguards | Extend AgentScope, the resource broker, effect outbox and Goal recovery; do not create a second scheduler or resource queue. Respect the incident's operator-set parent slice limits: 12 GiB high / 16 GiB maximum. Do not automatically raise them on restart or update.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Memory accounting   | Use MiB/GiB explicitly; show guest usable memory separately from configured/effective agent budget. On Linux consider ancestor cgroup limits/current use, reclaimable file cache, MemAvailable and memory PSI. Apply platform fallbacks honestly. Never sum process RSS and call it unique memory.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Heavy checks        | Add a distinct `typecheck` resource with capacity 1 and an initial 8192 MiB admission estimate. Classify `tsc`, `tsgo`, `tsc-rs`, `effect-tsgo`, and repository typecheck scripts, including executable paths and command wrappers. Give heavy build/check jobs a default 15-minute hard deadline; declared verification timeouts remain authoritative. Queue waiting does not consume execution time.                                                                                                                                                                                                                                                                                                                                         |
| Routing limits      | Repository scripts, T3-owned commands and queue gates acquire the existing broker before launch. Native provider tools outside T3's launch boundary are observable but cannot be claimed to be fully pre-admitted. Bound their owned run and descendants through the runtime watchdog and scope budget; do not change approval modes to obtain interception.                                                                                                                                                                                                                                                                                                                                                                                   |
| Cancellation        | Stop is independent of queued steering and earlier stuck start effects. Allow 10 seconds for graceful provider interruption, then stop the owned runtime/scope with a 10-second TERM-to-KILL escalation. Within 30 seconds of a responsive server receiving Stop, persist a truthful terminal or explicit cleanup-failure state. Do not claim completion before teardown is established.                                                                                                                                                                                                                                                                                                                                                       |
| Liveness            | Observe every ordinary thread, not only Goal workers. At 5 minutes without meaningful progress mark it suspect; probe owned runtime health with a 15-second deadline. An unhealthy/dead runtime triggers recovery. A healthy but progress-free turn reaches a 30-minute no-progress deadline; a single running turn has a configurable 90-minute execution budget. Bare CPU consumption, heartbeats and polling do not reset progress. Explicit approvals, quota-reset waits, scheduled waits and bounded tool waits have distinct reasons/deadlines and are excluded from no-progress cancellation while valid. Intentional persistent services require explicit ownership/lifecycle registration. Goal lifetime is not capped at 90 minutes. |
| Replay and retries  | No automatic replay after a tool may have produced side effects. A proven pre-prompt startup failure may get one isolated session restart. Further transient startup failures back off per provider instance at 5, 30 and 120 seconds, then remain actionable. Authentication, permission and quota failures follow their existing distinct handling. Stop overrides pending retries and automatic Goal continuations.                                                                                                                                                                                                                                                                                                                         |
| Diagnostics         | Stable reasons: `provider_start_timeout`, `mcp_registration_timeout`, `provider_stream_closed`, `tool_deadline_exceeded`, `resource_exhausted`, `cancel_timeout`, `stalled_runtime`. Persist timestamps and bounded metadata, not credentials, raw provider payloads, prompts, command arguments or environments. Display the real wait/failure stage and supported recovery action.                                                                                                                                                                                                                                                                                                                                                           |
| Tests and delivery  | Inject clocks, process handles, host/cgroup samples and fake provider transports. Dynamic ports and per-test databases only. Use existing checks, preserve validation and avoid retries of an identical failed revision/environment. Worker checks are focused; final gates are split by server, clients and packaging. This plan authorizes local code/artifact work only, not publishing or another service restart.                                                                                                                                                                                                                                                                                                                         |

### Worker notes

- One task per worker; the worker owns it until the server confirms it is integrated. The server verifies, merges, and brings the same worker back with exact details if a check or merge needs reasoning.
- Files outside `Scope:` that the task truly needs are approved automatically (except protected files; sensitive ones need a `SCOPE-REQUEST: path — reason`). A file another running task holds pauses the task until it is free.
- Shared tools go through `agentq run --owner <task id> --defer-after 120 -- <command>`; a busy resource is never a reason to stop or ask.
- Do not merge, rebase onto main, push, or tick checkboxes; the queue records completion.

### Implementation tasks

- [ ] **RLY01 — Complete bounded Stop and repair the Claude steering regression.**
  - Depends on: none.
  - Scope: apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts, apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts, apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts, apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts, apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts, apps/server/src/orchestration-v2/ProviderTurnControlService.ts, apps/server/src/orchestration-v2/ProviderTurnControlService.test.ts, packages/shared/src/AgentScope.ts, packages/shared/src/AgentScope.test.ts, apps/server/src/process/agentScope.ts, apps/server/src/process/agentScope.test.ts
  - Checks:
    - `vp test run src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts` (cwd: apps/server, timeout: 5m)
    - `vp test run src/orchestration-v2/ProviderTurnControlService.test.ts src/process/agentScope.test.ts` (cwd: apps/server, timeout: 3m)
  - Bring forward the proven interrupt timeout/error cleanup from the hotfix, using the fixed Stop deadline. Bound the complete path, including scope/session close, stream iteration/finalizers and acknowledgement ingestion; a timeout outside an uninterruptible cleanup is insufficient. On forced cleanup, preserve partial work and emit one truthful outcome; a late success frame must not replace the interrupted result. Native child tasks belonging to the stopped runtime must not keep compiling afterward. Extend existing Codex behaviour only where the same failure pattern is reproduced; preserve other-provider capability checks.
  - Reproduce the foreground-subagent `never answers` test in both isolated and full-file execution with the original source. Remove its hang by fixing the actual SDK-control/fiber lifecycle or a demonstrated clock/fixture race. Do not skip it, increase its real-time timeout, or weaken its assertions. Add fake-clock cases for never-answered interrupt, interrupt rejection, absent terminal acknowledgement, SDK exit during Stop, and a replacement run racing stale cleanup.
  - Acceptance: bounded Stop completes in the unresponsive-provider fixtures; all owned descendants exit; the complete Claude adapter file passes; a second Stop is harmless and unrelated runtimes remain alive.

- [ ] **RLY02 — Budget, deduplicate and diagnose heavyweight compiler jobs.**
  - Depends on: none.
  - Scope: packages/agent-queue-core/src/resourceRunner.ts, packages/agent-queue-core/src/resourceBroker.ts, packages/agent-queue-core/test/resourceBroker.test.ts, packages/agent-queue-core/test/resourceRunner.test.ts, packages/agent-queue-cli/src/resourceCommands.ts, package.json, apps/server/package.json, scripts/reliability-check.ts, scripts/reliability-check.test.ts
  - Checks:
    - `vp test run packages/agent-queue-core/test/resourceBroker.test.ts packages/agent-queue-core/test/resourceRunner.test.ts scripts/reliability-check.test.ts` (cwd: ., timeout: 3m)
  - New files in scope are the compiler-wrapper tests/script and resourceRunner test when absent. Route root/server typecheck script entry points through the existing broker and add the fixed typecheck resource/classification. Recognize nested script invocation without recursively acquiring the same ticket. Cover command paths, shell wrappers, escaped arguments and harmless text mentions; never classify arbitrary prompt text as a launch command.
  - Coalesce equivalent repository checks only for the same immutable source fingerprint, dependency/lock/config fingerprint, environment and command. A dirty source tree needs a content fingerprint; HEAD alone is insufficient. Share the in-flight/result receipt, not a second process. Changed inputs invalidate reuse; separate account authorization and stdout access remain intact. Preserve the actual exit status and mandatory checks.
  - Reproduce the incident's installed checker/plugin combination in a bounded fixture or representative pinned checkout. Record checker version, input fingerprint, elapsed time and peak private/resident memory. Diagnose the pathological checker path before choosing a scoped checker/config repair; do not substitute an unchecked successful command. Wrapper admission and timeout tests use tiny fake compilers, not multi-hour real runs. Document limits if the exact old compiler failure cannot be reproduced.
  - Acceptance: two identical concurrent requests launch one compiler, changed inputs launch a fresh check, only one typecheck grant exists, timeouts stop the owned process tree and release tickets, and 7.5-GiB demand is not admitted under a 3.5-GB estimate.

- [ ] **RLY03 — Make admission and memory limits use the effective agent budget.**
  - Depends on: none.
  - Scope: packages/agent-queue-core/src/hostCapacity.ts, packages/agent-queue-core/src/resourceBroker.ts, packages/agent-queue-core/test/resourceBroker.test.ts, packages/agent-queue-core/test/hostCapacity.test.ts, apps/server/src/process/agentScope.ts, apps/server/src/process/agentScope.test.ts, packages/shared/src/AgentScope.ts, packages/shared/src/AgentScope.test.ts, apps/server/src/goals/GoalService.ts, apps/server/src/goals/GoalService.test.ts
  - Checks:
    - `vp test run packages/agent-queue-core/test/hostCapacity.test.ts packages/agent-queue-core/test/resourceBroker.test.ts` (cwd: ., timeout: 3m)
    - `vp test run src/process/agentScope.test.ts` (cwd: apps/server, timeout: 2m)
  - Add hostCapacity tests when absent. Compute effective capacity from the minimum applicable host/ancestor-cgroup budget and current reservations, with unit-safe parsing of `max`, missing controllers, nested cgroups and limited containers. Count pending grants and resident work once. Historical swap usage alone must not block an otherwise recovered host; sustained memory PSI and swap-in/out pressure affect admission. Remove the unconditional first-worker bypass under critical pressure; an idle overloaded host waits without releasing claims or starting a retry storm.
  - Preserve operator limits, including the current parent-slice bounds, across launches/updates. Add a configurable per-owned-runtime memory ceiling within the aggregate budget. Use an initial 8192-MiB ceiling for a private runtime without a broker ticket; include an admitted child job's reservation when calculating a private runtime budget, bounded by the operator ceiling. Shared provider processes require accounting for all active owners rather than assigning one thread's allowance to the whole process. Prefer graceful stop of the identified offending owner to host OOM. Reclaim idle provider sessions/MCP children through existing unload paths when they have no pending requests, work or resume delivery; active sessions and user-owned persistent services are ineligible. Report reduced enforcement on platforms without cgroups rather than claiming hard limits there.
  - Acceptance: the 25.43-GiB host/16-GiB agent-budget fixture refuses overlapping oversized grants before launch, pressure recovery admits work again, idle cleanup leaves active sessions intact, and no task changes another user's scope.

- [ ] **RLY04 — Enforce owned tool deadlines and progress-aware runtime liveness.**
  - Depends on: none.
  - Scope: apps/server/src/orchestration-v2/RuntimeLiveness.ts, apps/server/src/orchestration-v2/RuntimeLiveness.test.ts, apps/server/src/orchestration-v2/RunExecutionService.ts, apps/server/src/orchestration-v2/RunExecutionService.test.ts, apps/server/src/orchestration-v2/ProviderSessionManager.ts, apps/server/src/orchestration-v2/ProviderTurnControlService.ts, apps/server/src/goals/GoalService.ts, apps/server/src/goals/GoalService.test.ts, apps/server/src/serverRuntimeStartup.ts, apps/server/src/processRunner.ts, apps/server/src/processRunner.test.ts, packages/contracts/src/settings.ts, packages/contracts/src/settings.test.ts, apps/server/src/persistence/Migrations/OrchestrationV2/
  - Checks:
    - `vp test run src/orchestration-v2/RuntimeLiveness.test.ts src/processRunner.test.ts` (cwd: apps/server, timeout: 3m)
  - Add RuntimeLiveness files. Reuse runtime activity, owned command/task identities and the existing recovery services; apply fixed liveness thresholds to regular threads and Goals alike. Persist the authoritative deadline/progress timestamps so restarts do not reset an abandoned job's lifetime. Only actual provider output, completed work or a changed bounded wait state counts as progress; repeated polling, CPU burn and lease renewal do not.
  - App-owned processes enforce deadlines at launch and kill their owned descendants on timeout. Native tools outside that boundary use provider activity/task IDs to enforce the owned runtime deadline; advertise that coverage distinction. Preserve explicit approvals, known quota waits and valid bounded MCP waits. Surface suspicion before forced cleanup, with stop reason and preserved partial result. The normal dispatcher, not a second watchdog scheduler, owns any continuation; never replay uncertain side effects.
  - Acceptance: fake clocks cover a 16-hour CPU-burning compiler, a silent vanished provider, a valid 65-minute wait, approval/quota waiting, a productive long Goal made of bounded turns, and restart midway through a deadline. No fixture sleeps for elapsed real minutes or needs provider credentials.

- [ ] **RLY05 — Recover stale effects and make Stop authoritative over the queue.**
  - Depends on: none.
  - Scope: apps/server/src/orchestration-v2/EffectOutbox.ts, apps/server/src/orchestration-v2/EffectWorker.ts, apps/server/src/orchestration-v2/EffectWorker.test.ts, apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts, apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts, apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.regression.test.ts, apps/server/src/orchestration-v2/Orchestrator.ts, apps/server/src/orchestration-v2/ProjectionRecovery.test.ts, apps/server/src/orchestration-v2/ProjectionStore.ts, apps/server/src/orchestration-v2/EventSink.ts, apps/server/src/persistence/Migrations/OrchestrationV2/, apps/server/src/mcp/OrchestratorMcpService.ts, apps/server/src/mcp/OrchestratorMcpService.test.ts
  - Checks:
    - `vp test run src/orchestration-v2/EffectWorker.test.ts src/orchestration-v2/ProviderRuntimeRecoveryService.regression.test.ts src/orchestration-v2/ProjectionRecovery.test.ts` (cwd: apps/server, timeout: 4m)
  - Reproduce a failed/terminal run with a running `provider-turn.start` effect that blocks its later start. Track the active executor's ownership and deadline; expire/reconcile an orphan without restarting the server and without reclaiming a still-live executor just because its lease timestamp passed. Recovery is bounded and idempotent, emits durable events and uses existing transactional outbox/cancellation signals. Distinguish replay-safe effects from process-bound effects whose result is uncertain; stale work is never blindly re-executed.
  - Persist Stop intent so earlier start/steer work cannot block it or later revive the stopped turn. Cancel queued steering/retries associated with that stopped run, retain explicit future work only when the existing queue policy requires it, and ensure the user sees exactly what remains. Cover the incident's cancelled latest run with an older orphan queued run. Late terminal frames, reconnects and Goal auto-resume must respect Stop intent; do not lose the user's message text or modify claims outside the normal owner lifecycle.
  - Acceptance: the captured stale-effect sequence settles and unblocks correctly while the server stays up; worker crash, lost acknowledgement, racing Stop and restart produce no duplicate launches or hidden queued message.

- [ ] **RLY06 — Diagnose provider startup/stream failures and make retry boundaries safe.**
  - Depends on: none.
  - Scope: apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts, apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts, apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts, apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts, apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts, packages/provider-acp/src/server/AcpSessionRuntime.ts, packages/provider-acp/src/server/adapter.ts, packages/provider-acp/src/server/mcpOverAcpBridge.ts, packages/provider-acp/src/server/mcpOverAcpBridge.test.ts, apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.test.ts, apps/server/src/orchestration-v2/ProviderTurnStartService.ts, apps/server/src/orchestration-v2/ProviderTurnStartService.test.ts, apps/server/src/orchestration-v2/RunExecutionService.ts, apps/server/src/orchestration-v2/RunExecutionService.test.ts, apps/server/src/orchestration-v2/ProviderSessionManager.ts, apps/server/src/orchestration-v2/ProviderSessionManager.test.ts, packages/contracts/src/orchestrationV2.ts, packages/contracts/src/orchestrationV2.test.ts
  - Checks:
    - `vp test run src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts -t registration` (cwd: apps/server, timeout: 2m)
    - `vp test run src/orchestration-v2/RunExecutionService.test.ts src/orchestration-v2/ProviderTurnStartService.test.ts` (cwd: apps/server, timeout: 4m)
  - Reproduce the real SDK control ordering with fake CLI transports: initialization pending, MCP registration never answered, registration answered after timeout, individual MCP server unavailable, stream closes before turn start, stream closes after tools, and a process exits without a terminal frame. Identify the failing stage and preserve the immediate cause internally. A single unavailable optional MCP server must not look like an account failure; required T3 tool registration must not silently disappear.
  - Bound initialization, registration, stream shutdown and scope disposal independently. Timed-out attempt resources must close before an eligible retry; a delayed response from the old attempt cannot alter its replacement. Apply fixed instance-local retry/backoff rules and shared reason codes. Never erase credentials, substitute another account, disable a working integration, or treat authentication/quota/approval failures as transient infrastructure. Do not infer vendor outage from a local stream error. Cover native Codex, Claude and shared ACP transport paths with capability-appropriate tests.
  - Acceptance: every failure settles once with its correct reason and timestamps, safe pre-prompt retry is bounded, post-tool failure is preserved without replay, and one failed account does not poison another instance.

- [ ] **RLY07 — Attribute resource use and bound retained runtime data.**
  - Depends on: none.
  - Scope: apps/server/src/process/agentScope.ts, apps/server/src/process/agentScope.test.ts, apps/server/src/orchestration-v2/ProviderSessionManager.ts, apps/server/src/orchestration-v2/ProviderSessionManager.test.ts, apps/server/src/orchestration-v2/ProviderTurnStartService.ts, apps/server/src/orchestration-v2/ProviderTurnStartService.memory.test.ts, apps/server/src/orchestration-v2/testkit/ProviderTurnStartMemory.fixture.mjs, apps/server/src/observability/Metrics.ts, apps/server/src/observability/Metrics.test.ts, apps/server/src/observability/EventLoopMonitor.ts, apps/server/src/observability/EventLoopMonitor.test.ts, apps/server/src/observability/RuntimeResourceDiagnostics.ts, apps/server/src/observability/RuntimeResourceDiagnostics.test.ts
  - Checks:
    - `vp test run src/observability/RuntimeResourceDiagnostics.test.ts src/orchestration-v2/ProviderTurnStartService.memory.test.ts src/observability/EventLoopMonitor.test.ts` (cwd: apps/server, timeout: 3m)
  - Add RuntimeResourceDiagnostics files. Attribute samples to owned runtime/run/tool and broker ticket, including anonymous/file memory, swap, cgroup high/max/OOM events, deadline, last progress and cancellation latency. Record the stage of an event-loop stall so stalls caused by pressure can be distinguished from synchronous server work. Sampling runs at most once every 10 seconds, has bounded work and storage (512 in-memory samples, 10 MiB rotated diagnostic files, 7-day retention), and does not scan foreign process environments/arguments.
  - Audit caches, SDK message queues, subscriptions, control-request promises, startup-history captures and session/task registries reached by repeated start/fail/cancel/retry. Fix demonstrated retention at the owner lifecycle, cap diagnostic/output buffers without truncating durable user history, and extend the existing GC fixture for repeated failed startup and cancellation. Do not call normal reclaimable file cache a leak or clear OS caches to fake a result.
  - Acceptance: repeated lifecycle fixtures return retained objects/listeners to a bounded baseline, pressure snapshots identify the offending owned run, and diagnostic artifacts contain no credentials, raw tool input or user text.

- [ ] **RLY08 — Show accurate failure, waiting and cleanup state on every client.**
  - Depends on: RLY04, RLY05, RLY06, RLY07.
  - RLY04 supplies the liveness snapshots this task consumes; RLY05 supplies queue/Stop outcomes; RLY06 supplies provider failure reasons; RLY07 supplies bounded resource snapshots. RLY07 is required because its bounded resource snapshot interface is consumed by the client mapping.
  - Scope: packages/contracts/src/orchestrationV2.ts, packages/contracts/src/orchestrationV2.test.ts, packages/contracts/src/server.ts, packages/contracts/src/server.test.ts, packages/shared/src/orchestrationV2ThreadError.ts, packages/client-runtime/src/state/threadDetail.ts, packages/client-runtime/src/state/threadDetail.test.ts, apps/web/src/components/chat/ThreadErrorBanner.tsx, apps/web/src/components/chat/ThreadErrorBanner.test.tsx, apps/web/src/components/chat/ThreadStatusLine.tsx, apps/web/src/components/ThreadStatusIndicators.tsx, apps/web/src/components/ThreadStatusIndicators.test.ts, apps/mobile/src/features/threads/ComposerErrorNotice.tsx, apps/mobile/src/features/threads/thread-activity-row-presentation.ts, apps/mobile/src/features/threads/thread-activity-row-presentation.test.ts, apps/server/src/mcp/OrchestratorMcpService.ts, apps/server/src/mcp/OrchestratorMcpService.activity.test.ts, docs/user/
  - Checks:
    - `vp test run packages/contracts/src/orchestrationV2.test.ts packages/client-runtime/src/state/threadDetail.test.ts apps/web/src/components/chat/ThreadErrorBanner.test.tsx apps/mobile/src/features/threads/thread-activity-row-presentation.test.ts` (cwd: ., timeout: 3m)
  - Replace undifferentiated "provider error" and misleading working duration with the fixed failure stage/reason, elapsed stage time, last progress, actual queue/resource/approval wait and cleanup state. Preserve normal completed history and mobile reconnection behaviour. Make Stop actionable while starting, waiting for resources, streaming or cleaning up. Reconnect must reconstruct the same authoritative state; use receipt timestamps rather than device wall-clock guesses. Show supported recovery actions and the preserved partial-work location without exposing internal credentials or unsupported "retry safely" promises.
  - Web and desktop share the web components; mobile and agent-readable MCP activity must show equivalent reasons. Keep the existing design system and accessible status announcements; the text must help a user act, not dump implementation jargon. New wire fields must be additive/optional for older clients and persisted events, with an honest unknown-stage fallback. User docs describe the recovery action and budget settings, not the internal scheduler.
  - Acceptance: client-state/interaction tests cover all fixed failure reasons, stale late events, Stop pending and terminal cleanup, queued versus executing work, and two different provider accounts/environments without crossing their state.

Shared lifecycle files deliberately overlap across several independent fixes. The queue must serialize occupied scopes; overlap is not a reason to invent a technical dependency or run competing check processes.

### Integration gates

- [ ] **RLY09 — Verify the integrated server failure and recovery paths.**
  - Depends on: RLY01, RLY02, RLY03, RLY04, RLY05, RLY06, RLY07, RLY08.
  - This gate consumes RLY01 cancellation cleanup, RLY02 compiler tickets, RLY03 effective budgets, RLY04 watchdog events, RLY05 durable recovery, RLY06 classified errors, RLY07 resource snapshots and RLY08 client-facing contracts to replay their interaction on one revision. RLY08 is required because this gate checks its final client-facing contract against the server event sequence.
  - Scope: apps/server/src/orchestration-v2/testkit/, apps/server/src/orchestration-v2/Reliability.integration.test.ts, apps/server/src/orchestration-v2/ProviderTurnControlService.test.ts, apps/server/src/orchestration-v2/EffectWorker.test.ts, apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.regression.test.ts, apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts
  - Checks:
    - `vp test run src/orchestration-v2/Reliability.integration.test.ts src/orchestration-v2/ProviderTurnControlService.test.ts src/orchestration-v2/EffectWorker.test.ts src/orchestration-v2/ProviderRuntimeRecoveryService.regression.test.ts src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts` (cwd: apps/server, timeout: 6m, requires: heavy_build)
  - Add the integration fixture/test named above. Replay the incident sequence with an isolated SQLite database, fake providers, fake clocks and owned disposable subprocesses: compiler overlap, constrained memory, MCP registration timeout, lost stream, stale start effect, queued steering and Stop, then server-runtime reconstruction. Verify bounded teardown, one durable outcome, released tickets and intact worktrees/messages/claims. Run against the integrated revision; record any failing case as a narrow repair using that case's check. CI retains responsibility for the repository-wide suite.
  - Acceptance: the full sequence settles without a service restart or raw database edits, the complete Claude adapter file is green, and no child process/ticket remains after the fixture exits.

- [ ] **RLY10 — Verify shared client and reconnect behaviour.**
  - Depends on: RLY08.
  - Requires the final shared diagnostic contract and web/mobile rendering changes.
  - Scope: packages/client-runtime/src/state/threadDetail.test.ts, apps/web/src/components/chat/ThreadErrorBanner.test.tsx, apps/web/src/components/ThreadStatusIndicators.test.ts, apps/mobile/src/features/threads/thread-activity-row-presentation.test.ts
  - Checks:
    - `vp test run packages/client-runtime/src/state/threadDetail.test.ts apps/web/src/components/chat/ThreadErrorBanner.test.tsx apps/web/src/components/ThreadStatusIndicators.test.ts apps/mobile/src/features/threads/thread-activity-row-presentation.test.ts` (cwd: ., timeout: 3m)
  - Run one integrated pass of the affected client tests, using decoded server events rather than static attribute assertions. Cover disconnect during Stop, reconnect after cleanup, delayed provider errors, out-of-order stage updates and account/environment isolation. Any harness correction stays in the existing test surfaces.
  - Acceptance: every client derives the same actionable status from the same event sequence, and a stale snapshot cannot resurrect an interrupted run.

- [ ] **RLY11 — Build and smoke-test a local rollback-ready server artifact.**
  - Depends on: RLY09, RLY10.
  - This candidate requires RLY09 server verification and RLY10 client verification so it packages the exact integrated, checked revision.
  - Scope: scripts/reliability-artifact-smoke.ts, scripts/reliability-artifact-smoke.test.ts, scripts/smoke-cli-archive.ts, scripts/build-cli-archive.ts, apps/server/scripts/cli.ts
  - Checks:
    - `vp test run scripts/reliability-artifact-smoke.test.ts` (cwd: ., timeout: 2m)
    - `node scripts/reliability-artifact-smoke.ts` (cwd: ., timeout: 15m, requires: heavy_build)
  - Add an artifact smoke wrapper/test that uses the existing build-exe/archive/smoke pipeline, the pinned Node 26.8.2 runtime through `VP_NODE_VERSION`, and matching built client/runtime dependencies. All output goes to an ignored temporary artifact directory. Reuse valid dependency/build results by revision, perform the local build once, and exercise binary startup plus clean shutdown against an isolated home with no account credentials. Check declared artifact version/hash, required files, port readiness and that the previous candidate remains available for rollback. No provider model calls are required.
  - Acceptance: the self-contained candidate starts and stops within bounded deadlines in the isolated home, checksums/provenance identify the exact integrated revision, and packaging does not read or modify the installed user's database or service.

### Limits

The plan does not change the hypervisor allocation, reset credentials, publish a release, restart the installed service, execute physical-device checks, or run an elapsed-time soak. The guest cannot prove its host allocation or diagnose host ballooning without host-side evidence. Fake provider/control fixtures establish failure-path behaviour, not the health of an external provider account. Before a later authorized release, the repository's normal CI/release workflow must pass; a local artifact and a green HTTP startup are not proof of authenticated end-to-end provider operation. No physical device or provider login is required by these executable tasks.

## Queue workspace and repair reliability — 2026-10-21 follow-up

Evidence: RLY06 had three failed pre-start attempts, RLY07 six, and RLY09 one. Repair prompts named new `-FU` worktrees, while durable thread bindings still named the removed original worktrees. GoalService.resumeOwner sends before updating only GoalChat bookkeeping; GoalThreads.send does not change the durable workspace. The overseer failed separately with APP_SHELL_NOT_LOADED / locked desktop keyring. A read-only module-resolution probe also fails for effect/Context from agentqueue-staging/packages/shared/src/HostProcess.ts while succeeding from the main checkout. Preserve all earlier tasks and completed commits; these tasks address queue infrastructure, not another implementation attempt at RLY01–RLY11.

- [ ] **RLY12 — Bind resumed repair conversations to their reserved workspaces before dispatch.**
  - Depends on: none.
  - Scope: apps/server/src/goals/GoalService.ts, apps/server/src/goals/GoalThreads.ts, apps/server/src/goals/GoalThreads.testkit.ts, apps/server/src/goals/GoalThreads.test.ts, apps/server/src/goals/GoalAgentQueueFlow.test.ts, apps/server/src/orchestration-v2/ThreadManagementService.ts, apps/server/src/orchestration-v2/ThreadManagementService.test.ts
  - Checks:
    - `vp test run src/goals/GoalAgentQueueFlow.test.ts src/goals/GoalThreads.test.ts` (cwd: apps/server, timeout: 5m, requires: heavy_build)
    - `vp test run src/orchestration-v2/ThreadManagementService.test.ts` (cwd: apps/server, timeout: 3m, requires: heavy_build)
  - Use the existing orchestration workspace-management path to prepare and durably bind the idle thread to the exact reserved task worktree and branch before sending a repair/retry message. Tear down or invalidate its old provider runtime before reopening in the new cwd. Updating GoalChat fields or mentioning the new path in a prompt is insufficient. Preserve conversation history, account/model selection, task claim and commits; never recreate an empty old folder or silently use the repository root. If rebinding is unavailable, checkpoint and hold the claim with a structured workspace failure without launching the model.
  - Make binding plus dispatch restart-safe and idempotent by claim/run identity; re-read authoritative binding before launch. Keep the one-writer check. Reject busy threads and mismatched branch/worktree ownership. Retire landed worktrees only after saved checkpoints and owned work are quiet, and prevent later resumes from targeting retired bindings. Distinguish pre-start workspace failure from a worker that started and failed; unchanged infrastructure failures must not consume code-repair retries or launch repeated model turns.
  - Acceptance: a real temporary Git fixture lands a task, retires its old worktree, assigns FU1 and FU2 to the original conversation, and starts each in its reserved folder. Assertions read durable thread/provider cwd as well as GoalChat bookkeeping. Inject failure before binding, after binding, and before dispatch; replay once without duplicate turns, lost claims, deleted work or spent repair budget. Cover both native and ACP provider boundaries through fakes.

- [ ] **RLY13 — Prepare revision-correct dependencies for every queue verification worktree.**
  - Depends on: none.
  - Scope: packages/agent-queue-core/src/baseline.ts, packages/agent-queue-core/src/followUpResolution.ts, packages/agent-queue-core/src/integration.ts, packages/agent-queue-core/src/audit.ts, packages/agent-queue-core/src/publication.ts, packages/agent-queue-core/test/baselineWorkspace.test.ts, packages/agent-queue-core/test/integration.test.ts, packages/agent-queue-core/test/followUpResolution.test.ts, packages/agent-queue-core/test/verificationAndFollowUp.test.ts
  - Checks:
    - `vp test run packages/agent-queue-core/test/baselineWorkspace.test.ts packages/agent-queue-core/test/followUpResolution.test.ts` (cwd: ., timeout: 4m, requires: heavy_build)
    - `vp test run packages/agent-queue-core/test/integration.test.ts packages/agent-queue-core/test/verificationAndFollowUp.test.ts` (cwd: ., timeout: 5m, requires: heavy_build)
  - Inspect and preserve existing uncommitted dependency-preparation work; obtain scope ownership before modifying occupied files. Share a verified dependency-preparation helper across staging, baseline, audit, unchanged-follow-up and publication checks. Populate package-level third-party resolution and rebind workspace package links to the checked-out probe revision. A root node_modules link alone is insufficient. After staging cleanup, restore dependencies before checking; never load candidate workspace source while claiming to verify an older revision. Use isolated probe identities and preserve unrelated worktrees.
  - Verify dependency resolution before executing checks. Classify missing verification dependencies as infrastructure preparation failure, preserve the actual failed import and stage, and do not blame a feature commit, open duplicate code repairs or consume its retry budget for this condition. Invalidate cached baseline results produced by the broken preparation fingerprint. Do not weaken declared checks, suppress failures or mark unfinished repairs complete; rerun through the authoritative queue after the environment is repaired.
  - Acceptance: temporary monorepo fixtures import a third-party dependency from a nested workspace and a sibling workspace whose contents differ between revisions. Candidate, baseline, staged integration, audit, follow-up and publication checks each resolve the dependency and read their own revision; repeat after cleanup. A missing install produces one infrastructure result without a false feature attribution. Existing legitimate failing-check repairs still open and remain blocking.

- [ ] **RLY14 — Stop unattended overseer launches when the desktop provider needs login.**
  - Depends on: none.
  - Scope: apps/server/src/goals/GoalService.ts, apps/server/src/goals/GoalService.test.ts, apps/server/src/goals/GoalAgentQueueFlow.test.ts, apps/server/src/goals/supervise.ts, apps/server/src/goals/supervise.test.ts
  - Checks:
    - `vp test run src/goals/GoalService.test.ts src/goals/supervise.test.ts` (cwd: apps/server, timeout: 4m, requires: heavy_build)
  - Consume the existing provider availability/health reason for APP_SHELL_NOT_LOADED and locked-keyring states before unattended overseer dispatch. Preserve the configured provider/account routing; do not substitute an account, restart the desktop, reboot, bypass the keyring or request secrets in chat. Keep queue repair claims/checkpoints and show one actionable login-required escalation. Suppress unchanged automatic relaunches until provider health changes or the operator explicitly retries. Distinguish human login from retryable transport failure and worker code failure.
  - Acceptance: fake provider health remains keyring-locked across repeated scheduler ticks and a runner restart, producing one actionable escalation and no repeated provider launches or worker penalties; healthy transition allows one overseer turn with the same routing. No test needs an actual desktop login.

Limits for this follow-up: unlocking the desktop keyring needs the operator's authenticated desktop session. The plan verifies availability handling with fake health; it cannot prove a real keyring was unlocked. The current goal is failed and has blocked repairs; these additions are reference tasks until imported through the existing queue workflow. Do not directly edit live databases, tick completed tasks, or automatically resume the failed goal before its environment and binding defects are repaired.

## Mobile speed and Android limits banner (2026-10-22)

Source: `.plans/mobile-experience-20261020/MOBILE_EXPERIENCE_PLAN.md` (prepared 2026-10-20 against `1c59606ae7`), re-checked against `omni/main` at v0.1.4 (`5d18fc1c1f`). This section covers its thread-speed tasks (MP01–MP06, renamed SP01–SP06) and its account-limit strip (MB01–MB02, renamed LB01–LB02) plus their gates. The Antigravity-activity tasks (MA01–MA03) stay in the source plan. All earlier sections of this file are unchanged.

Outcome: returning to an Android thread shows its content immediately without new background work, and a compact strip at the top of the T3 Android workspace (below the native route header) shows each Codex and Claude account's remaining short and weekly limits with reset countdowns, plus one combined Antigravity cell that expands horizontally.

### Worker notes

- One task per worker; the worker owns it until the server confirms it is integrated. The server verifies, merges, and brings the same worker back with exact details if a check or merge needs reasoning.
- Files outside `Scope:` that the task truly needs are approved automatically (except protected files; sensitive ones need a `SCOPE-REQUEST: path — reason`). A file another running task holds pauses the task until it is free.
- Shared tools go through `agentq run --owner <task id> --defer-after 120 -- <command>`; a busy resource is never a reason to stop or ask.
- Do not merge, rebase onto main, push, or tick checkboxes; the queue records completion.
- All test commands exclude `**/.worktrees/**` and `**/.claude/worktrees/**` because positional Vitest filters otherwise match the same paths in nested worktrees; never remove or modify those worktrees. New tests must test user-observable outcomes, not static prop wiring. Read `docs/internals/effect-services.md` before server changes.

### Fixed decisions

| Topic                                | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Speed definition                     | Measure first readable current viewport separately from current-through-sequence completion and native list readiness. A visible cached thread is useful before its connection catches up. Never mark a cached run live merely to remove a spinner.                                                                                                                                                                                                                                                                                                                                                                                   |
| Performance targets                  | Product targets, pending native evidence: warm in-process return p95 ≤150 ms; SQLite-cached return p95 ≤350 ms; fresh bounded open on an already authenticated 100 Mbps / 80 ms RTT fixture p95 ≤1,000 ms. Cold process bootstrap is measured separately, target cached selected thread ≤1,000 ms after JS runtime readiness. Actual WAN cold opens cannot be universally instantaneous.                                                                                                                                                                                                                                              |
| Deterministic gate                   | Gate cache availability before blocked network/auth milestones, request/byte counts, bounded retained rows, cancellation, render invalidation, and semantic event completeness. CI does not fail against arbitrary wall-clock timings on a loaded VM.                                                                                                                                                                                                                                                                                                                                                                                 |
| Memory cache                         | Extend existing retention, not a second transcript cache. Mobile detached snapshots: at most eight recently read threads, at most 8 MiB estimated encoded payload total, at most 30 minutes idle. The selected thread is leased independently. Detached retention holds data/cursor/history metadata only, never an RPC scope or socket. An individually oversized entry is read from SQLite rather than retained detached.                                                                                                                                                                                                           |
| Disk cache                           | Recent bounded windows only; at most 100 thread records and 64 MiB of encoded thread payload across the mobile database. Evict oldest successful writes first; protect the current write transaction. A record exceeding the total cap is skipped, not truncated into an invalid projection. PR caches/preferences/auth records have separate policies.                                                                                                                                                                                                                                                                               |
| Trimmed-cache correctness            | A locally trimmed display window is marked `requiresSnapshot: true` in the private cache envelope. It is readable immediately but cannot claim a valid server paging/replay base. Only an untrimmed server-origin window plus fully applied deltas resumes by sequence. Clients never decode or manufacture opaque history cursors.                                                                                                                                                                                                                                                                                                   |
| Active-run saves                     | Reuse the persistence queue and its ten-second maximum steady write frequency, with bounded recent projection construction in the worker. Save a final settled snapshot promptly through the same serialized lane; flush the latest already committed bounded snapshot on scope closure/background transition without blocking navigation. No background refresh service is added.                                                                                                                                                                                                                                                    |
| Prefetch                             | No network prefetch in this plan. Warm navigation uses actual visited data. Avoid adding traffic before measurements show a first-visit problem remains.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Banner data                          | Read cached/live ServerConfig through a narrow derived atom; share existing account deduplication. The strip sends zero new polling RPCs and zero cost/transcript scans. Existing provider probing retains ownership of freshness.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Banner order and capacity            | Individual Codex accounts → individual Claude accounts → one combined Antigravity cell. Support 1+1, 2+1, 1+2 and 2+2 ordinary-account configurations; two Codex + two Claude + AGY must fit without collapsed scrolling at every 320/360/390/430 dp test width. Preserve stable account-key order within each provider, never percentage order. Hide genuinely unconfigured providers; keep configured unavailable accounts in place.                                                                                                                                                                                                |
| Percentage meaning and reset display | Remaining capacity, rounded as existing helpers do. Each cell has a logo/account header and two data rows: short limit first, weekly second. Each row pairs a percentage with its actual reset countdown, e.g. `80% 4:25` and `100% 6d`. Replace visible `5h`/`7d` labels with countdowns; preserve actual window kind/duration in accessibility labels and account details. Unknown percentage/reset is independently `—`; a reported exhausted limit is `0%`.                                                                                                                                                                       |
| Antigravity summary                  | Pool matching windows across deduplicated accounts using existing equal-account pool semantics, not added percentages. For each short/weekly slot, show the lowest remaining compatible family pool; mark the cell with its logo, `×N` account count and a small disclosure chevron. Explain lowest-family pooling in its accessible name and details; omit a visible `min` label because it could be confused with countdown minutes. This is a conservative overview, not a promise of interchangeable tokens. Details name each family and sample coverage. Never average different model families into a fabricated global quota. |
| Missing AGY cadences                 | Use actual `session`/`weekly` kinds. An `other` quota can occupy the top slot, with its true quota family spoken and shown in details; never call it five-hour. Use its reported reset countdown without inventing a cadence. The bottom percentage/reset pair stays `— —` when no weekly window is reported.                                                                                                                                                                                                                                                                                                                         |
| Antigravity expansion                | Same-height horizontal replacement of the complete provider strip. Pin a 48 dp close control; place all AGY accounts in a horizontal scroll area, with stable account labels and their two quota slots. No vertical expansion, sheet, automatic timeout, or automatic collapse on data refresh.                                                                                                                                                                                                                                                                                                                                       |
| Scope of displayed accounts          | All enabled, saved environments already represented by the existing Usage data; deduplicate only when existing identity rules prove a match. Do not merge on email alone across distinct workspaces, and do not expose raw credential fingerprints. Details show environment/source. Removed environments disappear immediately.                                                                                                                                                                                                                                                                                                      |
| Battery                              | No new keep-awake, foreground service, background polling, all-thread subscription, per-row timer, second-by-second countdown, or repeating animation. Existing notifications/background watchdog behavior is preserved. Quota/cached-content readers do not extend background network leases.                                                                                                                                                                                                                                                                                                                                        |
| Compatibility                        | Shared fixes cover web/local-hosted web/desktop/mobile, direct/relay/tunnel paths, and older servers through existing feature negotiation. Other provider adapters retain their behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### Banner design contract

This is an extension of the current mobile UI, using the existing foreground/muted/separator/screen tokens, AppText, ProviderIcon, native Pressable states, and system-scaled typography. No standalone new design system or decorative gradient. The accompanying `banner-sketch.html` is a layout/interaction reference with synthetic values; source tokens and native safe-area measurements remain authoritative.

#### Placement and geometry

- Mount one strip at the workspace shell, outside thread feeds and individual screen render loops. Place it below the native route header and above route content. It stays fixed while scrolling. Preserve the native back/title/actions area and system status-bar inset. Account for its measured height in transparent/native iOS header and list insets; do not apply the safe-area top twice.
- Default strip height is 48 dp, including 1 dp bottom hairline. It spans the active workspace content width. On tablets/foldables show exactly one strip above workspace panes; opening an inspector/sidebar must not duplicate it or overlay the hinge.
- Each cell remains one full-height button with at least a 48 dp touch target. Reduce strip edge padding to 4 dp, adjacent cell gaps to 2 dp, and cell inline padding to 1 dp. Stack a 14 dp provider logo/account header above two 13 dp data rows; use 2 dp between header and data and 3 dp top/bottom padding inside the 48 dp strip. Do not add full provider names, pill backgrounds or repeated vertical separators. A subtle hairline marks provider-group boundaries only and overlays the gap rather than consuming a column.
- Lay out collapsed cells in one non-scrolling row with equal widths capped at 88 dp, centered as a compact cluster. Width per cell is `min(88, (availableWidth - 8 - 2*(cellCount-1))/cellCount)` dp. At 320 dp with five cells this is 60.8 dp per cell: four individual accounts plus combined AGY all remain visible. This layout rule applies to 1+1, 2+1, 1+2 and 2+2 ordinary accounts; never combine the two ordinary accounts into a percentage average. At most five cells in these configurations, with no overflow or swipe-to-reveal step. Beyond the requested two accounts per ordinary provider, keep all accounts available using horizontal overflow; that fallback is not used for any of the required configurations.
- For up to three cells use 12 sp percentages and 10 sp countdowns. With four/five cells use 11 sp percentages and 9 sp countdowns. Values are medium weight and countdowns are quieter while meeting text contrast. Use tabular digits, no letter-spacing squeeze, and a 2 dp percentage/countdown gap. Align percentage and countdown columns across both rows, with the timer trailing. Reserve enough width for `100%` and `48min`/`23:59`; a timer format change must not resize cells or reorder accounts. Both rows remain visible.
- At font scale ≥1.15 switch to an accessibility layout within the same five columns: for each window put its countdown below its percentage instead of beside it. Base values are 12 sp and timers 10 sp with normal OS font scaling. Set the strip height for that scale to at least `ceil(72*fontScale + 8)` dp and increase only to fit measured text. Expand AGY at the same measured height. At scales 1.3/1.8/2.0 and widths 320/360/390/430, all five cells remain accessible without horizontal scrolling, truncation, or suppressing font scaling. Account header height participates in this measurement. Standard scale remains 48 dp; accessibility growth is not account expansion.
- Safe-area and keyboard transitions cannot make the strip overlap the composer, jump feed scroll position, or change follow mode. Maintain its position while the keyboard is open. Rendering the banner must not remount ThreadFeed.

#### Collapsed and expanded behavior

- Default state: Codex accounts → Claude accounts → combined AGY. One ordinary account uses just its provider logo in the header. Two of the same provider use separate cells, each with the same logo and a tiny stable `1`/`2` badge in the header. Assign badges in stable account-key order, not the latest usage sort; accessible labels and account details carry the full displayName. Reserve header badge space so missing data does not cause geometry changes. Never show full email addresses in the permanent strip.
- Codex/Claude cell tap opens the existing Usage account detail route with the corresponding deduplicated account key and environment scope. Account removal between tap and navigation produces the existing unavailable-account state rather than selecting another account.
- AGY summary tap replaces the row with `[close] [AGY A1 percentage/countdown pairs] [AGY A2 …] …`, horizontally. The close control remains visible at the leading edge while accounts scroll. Account chips show their own lowest remaining known family quota per slot and a stable short account label. Tapping an account opens existing detail with all family windows and resets; it does not change the active provider/model or consume reset credits.
- On expansion focus the close control for assistive technologies; announce the number of accounts once. Close returns focus to the AGY summary; the required collapsed configurations have no horizontal scroll offset. Android Back and Escape collapse before leaving the route; swiping the strip does not steal vertical feed scrolling. Native back gestures outside the strip remain normal.
- Keep expansion across ordinary non-Settings navigation within the same foreground session. Collapse on Settings entry, app background, active account-scope removal, or loss of all AGY accounts. Returning to the workspace starts collapsed after those cases.
- Show on Home, thread, new-task, archive, Goals, thread files/review/terminal/browser/device routes and ordinary non-Settings workspace sheets. Hide for the SettingsSheet stack, SettingsLegal and all nested settings routes including Usage, plus onboarding/pairing/auth-only screens and immersive/fullscreen media. During Settings presentation the underlying workspace strip must also be hidden, not merely covered by a translucent sheet. Use actual navigation route state rather than a brittle pathname substring.
- Connect/manage-environment workspace routes show it only after usable account metadata exists. No account configured anywhere means no strip height. One configured provider still receives a compact strip; never create fake entries for the other two.

#### Reset countdown rules

- Use the window's actual `resetsAt`; do not derive a reset from a `5h` label, assume every short window is five hours, or display the account's local wall-clock time. `4:25` means four hours and 25 minutes until reset, not 04:25 AM. The same format applies to weekly or other windows after selecting the correct row.
- Calculate `ceil((resetsAt-now)/60_000)` from the current time on each shared minute tick: 1–59 minutes → `48min`; 60–1,439 minutes → hours and zero-padded minutes such as `4:25`; 1,440–2,879 minutes → whole hours rounded upward such as `35h`; ≥2,880 minutes → days rounded upward such as `6d`. When rounded days reach 100 or more use `>99d`. Positive durations below a minute show `1min`. At or after reset show `now` while retaining stale/awaiting-confirmation state; never set capacity to 100% on the clock alone. Missing/invalid timestamps show `—` even if percentage is known. Absolute reset time and full spoken duration remain available in details/accessibility.
- An AGY aggregate percentage pools several accounts, so its countdown is the next known capacity-restoring reset in the selected family/window pool (`restoresPercent > 0`), not a promise that the whole pool resets then. Explain “next refill” in the summary's accessible label and details; accounts without a known reset are excluded from that countdown, with partial timing coverage disclosed. A full pool with no capacity-restoring reset shows `—`; individual accounts may still show an actual reported reset. Per-account expanded chips use that account's selected window reset. Never pair one family's percentage with another family's reset.
- Use one minute clock shared by all cells, active only while the banner is visible and the app is foregrounded. Recompute immediately after foreground/data changes. Derive from current time rather than decrementing a stored counter, so suspension, clock changes and missed ticks cannot accumulate drift. No seconds ticks, automatic refresh RPC, per-cell interval, or background timer.

#### Freshness, missing data, and accessibility

- A successful sample is fresh for 15 minutes and before any relevant reported reset instant. An older sample, disconnected environment, expired reset, or current probe failure retains its last number with a small static stale dot and a spoken last-checked state. A clock passing the reset instant does not set remaining to 100%; awaiting a fresh sample is honest.
- Unsupported/auth-required/no-sample data uses `—`, with a concise reason available in detail. A configured account with a transient probe failure must not disappear because `collectLimitAccounts` omits it; reconcile configured account placeholders in the banner selector without changing existing Usage totals. No active loading spinners or shimmer. Update staleness when data arrives, on foreground, and on one foreground-only minute tick shared by the strip; no per-cell timers. Also suspend the minute clock while Settings hides the banner; reset countdowns follow the rules above.
- Default text is neutral. Use an existing warning token for known fresh remaining ≤20%, and destructive token for a known fresh 0%. Stale values use neutral text plus stale marker. Numbers/labels communicate all states without color. Do not animate quota digits or progress continuously.
- Example accessible label: `Codex, account 1, Personal, 80 percent of five-hour limit left, resets in 4 hours 25 minutes; 100 percent of weekly limit left, resets in 6 days; checked 2 minutes ago. Open account limits.` AGY summary says `Antigravity, 5 accounts, lowest family pool, ... Expand accounts.` Distinguish unavailable from zero and stale from fresh in the spoken label.
- Existing icon imagery is decorative inside a named button; avoid duplicate spoken provider names. Use button role, expanded state on AGY, visible pressed/focus states, adequate text contrast, and logical RTL order. Keep provider logical order stable; native horizontal direction and leading-edge close control follow RTL.
- Data updates must not move account positions, reset scroll, collapse expansion, or steal focus. No live-region announcement on every changed percentage.

### Implementation tasks

- [ ] **SP01 — Instrument thread-open stages and build deterministic regression workloads.**
  - Context: read this section's Fixed decisions, Banner design contract and Limits first.
  - Depends on: none.
  - Scope: apps/mobile/src/features/threads/, apps/mobile/src/state/use-thread-selection.ts, apps/mobile/src/features/review/reviewPerf.ts, packages/client-runtime/src/state/threads.ts, packages/client-runtime/src/state/threadSnapshotHttp.ts, packages/client-runtime/src/state/boundedThreadSnapshotHttp.ts, packages/client-runtime/src/connection/supervisor.ts, apps/server/src/orchestration-v2/ThreadTransportPerformance.test.ts, scripts/mobile-thread-performance.ts, scripts/mobile-thread-performance.test.ts
  - Checks:
    - `vp test run --exclude '**/.worktrees/**' --exclude '**/.claude/worktrees/**' scripts/mobile-thread-performance.test.ts packages/client-runtime/src/state/threads-sync.test.ts apps/server/src/orchestration-v2/ThreadTransportPerformance.test.ts apps/mobile/src/features/threads/thread-route-hydration.test.ts` (cwd: ., timeout: 5m, expect: 0)
  - New files: `scripts/mobile-thread-performance.ts` and `scripts/mobile-thread-performance.test.ts` do not exist yet; this task creates both.
  - Outcome: a local, opt-in stage trace and fixture-driven report that separates tap/route selection, in-memory hit, SQLite load/decode, environment readiness, HTTP start/first response/decode, subscription resume completion, feed derivation, first visible viewport, and final list layout. Use monotonic timing for durations and correlation IDs with no content/account/token fields. Extend the existing performance-mark idiom rather than adding an always-on telemetry backend. Default production paths incur no verbose logging, network diagnostics calls, or per-row marks.
  - Add deterministic fixtures for a small text thread, a long 10,000-item thread with large command bodies, an active AGY turn, and 200 shell threads. Fixture generators use v2 types and isolated IDs, no developer data. Test 0/80/250 ms injected RTT, 1/5/20/100 Mbps budgets, empty/disk/memory cache, interruption, and route changes using Deferreds/TestClock. Count stages and bytes; do not delay tests with sleeps. Report transfer estimate separately from server/decode/layout costs. Preserve bounded row/control dependencies.
  - Establish the baseline from current code without modifying behavior first; record finite run output in the task result outside tracked files. The report must label JS/fixture results as proxies, and must not claim native paint or home-link speed from them. Add focused tests for correlation, trace cancellation, and duplicate milestone suppression in the scoped suites.
  - Acceptance: the same workload identifies whether a blocked stage is network, state selection, decode, or list readiness; network being blocked cannot be misreported as decode time. The tool runs offline without provider credentials.

- [ ] **SP02 — Keep cached thread content readable through navigation and reconnect.**
  - Context: read this section's Fixed decisions, Banner design contract and Limits first.
  - Depends on: none.
  - Scope: packages/client-runtime/src/state/threads.ts, packages/client-runtime/src/state/threads-atoms.test.ts, packages/client-runtime/src/state/threads-sync.test.ts, packages/client-runtime/src/state/threadDetail.ts, packages/client-runtime/src/state/threadDetail.test.ts, packages/client-runtime/src/state/threadRetention.ts, packages/client-runtime/src/state/threadState.ts, packages/client-runtime/src/state/environmentStreams.ts, apps/mobile/src/state/threads.ts, apps/mobile/src/state/use-thread-selection.ts, apps/mobile/src/state/use-thread-detail.ts, apps/mobile/src/features/threads/thread-route-hydration.ts, apps/mobile/src/features/threads/thread-route-hydration.test.ts, apps/mobile/src/features/threads/ThreadRouteScreen.tsx
  - Checks:
    - `vp test run --exclude '**/.worktrees/**' --exclude '**/.claude/worktrees/**' packages/client-runtime/src/state/threads-atoms.test.ts packages/client-runtime/src/state/threads-sync.test.ts packages/client-runtime/src/state/threadDetail.test.ts apps/mobile/src/features/threads/thread-route-hydration.test.ts` (cwd: ., timeout: 5m, expect: 0)
  - Trace callers before editing: selected shell thread, projection-to-shell fallback, thread detail atoms, environment registration, foreground replacement, and HTTP loader. Render the matching cached projection immediately while shell/config/auth catches up. A nonempty cached projection remains displayed in `cached`/`synchronizing` and during recoverable connection errors; only genuine absence uses the opening placeholder. Loading previous activity cannot cover existing content. Route identity is the tuple environmentId + threadId, never threadId alone.
  - Extend the existing snapshot retention mechanism with the mobile budgets in Fixed decisions. Expose a small optional retention policy at the existing factory boundary with current defaults for web/desktop. Do not retain live atom mounts to keep data warm. Acquire data without waiting for a new authenticated session when a saved environment/cache is already known. Reuse existing persistence load; no new cache of rendered React trees. In-memory bytes are estimated on existing encoding or insertion, not on each atom read/token.
  - Navigation A→B→A, notification deep links, pending thread creation, process-restore selection, >5-minute detours, and connection replacement must all use the same behavior. Maintain cursor/projection/history atomicity, current pending approvals, and authoritative permission checks. Deletion, environment removal, sign-out/cache-clear paths must invalidate retained data so cached private history cannot reappear across account changes.
  - Add tests that hold auth/network/shell readiness behind Deferreds and prove A's cached rows arrive before those resolve, B never briefly shows A, and at most the visible thread owns a detail stream. Exercise count/byte/age eviction and cache clearing using fake time.
  - Acceptance: revisiting a retained thread needs no full snapshot and no full-screen spinner; reconnect preserves visible text while honestly indicating catch-up; a known deletion removes cached rows.

- [ ] **SP03 — Persist bounded active-thread snapshots and enforce disk limits.**
  - Context: read this section's Fixed decisions, Banner design contract and Limits first.
  - Depends on: none.
  - Scope: packages/client-runtime/src/state/threads.ts, packages/client-runtime/src/state/threads-sync.test.ts, packages/client-runtime/src/state/cachePersistence.ts, packages/client-runtime/src/state/cachePersistence.test.ts, packages/client-runtime/src/platform/persistence.ts, packages/client-runtime/src/platform/orchestrationCache.ts, packages/client-runtime/src/platform/orchestrationCache.test.ts, packages/client-runtime/src/platform/index.ts, packages/shared/src/orchestrationV2BoundedSnapshot.ts, apps/web/src/connection/storage.ts, apps/mobile/src/connection/environment-cache-store.ts, apps/mobile/src/connection/environment-cache-store.test.ts, apps/mobile/src/persistence/mobile-database.ts, apps/mobile/src/persistence/mobile-database.test.ts, apps/mobile/src/state/client-cache-state.ts
  - Checks:
    - `vp test run --exclude '**/.worktrees/**' --exclude '**/.claude/worktrees/**' packages/client-runtime/src/platform/orchestrationCache.test.ts packages/client-runtime/src/state/cachePersistence.test.ts packages/client-runtime/src/state/threads-sync.test.ts apps/mobile/src/connection/environment-cache-store.test.ts apps/mobile/src/persistence/mobile-database.test.ts` (cwd: ., timeout: 5m, expect: 0)
  - New files: `packages/client-runtime/src/state/cachePersistence.test.ts` does not exist yet; this task creates it next to the existing `cachePersistence.ts`.
  - Replace the blanket active-run persistence exclusion with queued bounded snapshots under the Fixed decisions write budget. Construct the bounded recent window in the persistence worker; an Effect fiber is still on the JS thread, so use the existing bounded representation and cooperative yielding for measured CPU-heavy work rather than claiming this is a background native thread; do not serialize the full projection on every provider delta. Expanded history stays in memory; persist a recent 75-item/about-1-MiB display derivative with necessary request/run/provider relationships and compact tool records. Server history cursors are explicitly opaque in contracts: never parse, re-encode, manufacture, or reuse an old cursor after trimming away its anchor window. Add a cache-only `CachedThreadSnapshot` type and `requiresSnapshot?: true` field to the private persistence envelope, not the WebSocket snapshot contract. A locally trimmed derivative sets the flag and clears unusable paging metadata. On restore show it immediately as cached, then fetch one authoritative bounded snapshot before enabling history paging or using `afterSequence`. The existing HTTP-load condition must support this flag even with nonempty display data. An unchanged server-origin window with fully applied deltas retains normal delta resume. Bump the thread cache version so older clients cannot mistake display-only windows for resumable canonical snapshots; older cache records may be discarded safely. Keep web storage serialization compatible with the extended private type while leaving mobile-only active-write/trim policy disabled for web by default. Reuse compact projection helpers; do not import server paging code into mobile.
  - Serialize projection + sequence + paging metadata from one committed state. A save finishing after navigation, deletion, account change, or a newer cache owner must not overwrite newer state. Queue the newest snapshot, coalesce busy updates, and ensure final settled data is not stuck behind an unrelated sleep. Scope finalization persists already accepted data best-effort, without awaiting it in the tap/navigation critical path. A cache restored mid-run is visibly cached until current-through-sequence confirmation.
  - Enforce the global thread-record/encoded-byte limits transactionally in SQLite. Reuse current cache tables; schema changes require a versioned migration and migration tests in the scoped database file. Do not evict credentials, preferences, shell, PR, or unrelated cache kinds. Corrupt records are discarded as today; old schema/missing data recover through a bounded fetch. Never log raw corrupt payloads.
  - Test crash/restart from a running turn, trimmed-cache restore fetching a snapshot despite nonempty data, expired cache-schema discard, no successful completion before restart, save/deletion races, rapid switches, final save, expanded pages, oversized records, Unicode byte counts, and budget eviction. Assert writes with TestClock, not real waits.
  - Acceptance: a restored active thread has recent readable content and a safe replay base or an explicit display-only refresh flag; a sustained fake stream produces at most the established steady save frequency plus a final settle/flush save; stored bytes and records remain bounded.

- [ ] **SP04 — Make foreground recovery single-flight without increasing background activity.**
  - Context: read this section's Fixed decisions, Banner design contract and Limits first.
  - Depends on: none.
  - Scope: apps/mobile/src/connection/app-state-wakeups.ts, apps/mobile/src/connection/app-state-wakeups.test.ts, apps/mobile/src/connection/platform.ts, apps/mobile/src/connection/background-activity.ts, apps/mobile/src/connection/background-activity-scopes.ts, apps/mobile/src/connection/background-activity.test.ts, packages/client-runtime/src/connection/wakeups.ts, packages/client-runtime/src/connection/supervisor.ts, packages/client-runtime/src/connection/supervisor.test.ts, packages/client-runtime/src/state/threads-sync.test.ts
  - Checks:
    - `vp test run --exclude '**/.worktrees/**' --exclude '**/.claude/worktrees/**' apps/mobile/src/connection/app-state-wakeups.test.ts apps/mobile/src/connection/background-activity.test.ts apps/mobile/src/connection/android-background.test.ts packages/client-runtime/src/connection/supervisor.test.ts` (cwd: ., timeout: 5m, expect: 0)
  - New files: `apps/mobile/src/connection/app-state-wakeups.test.ts` does not exist yet; this task creates it next to the existing `app-state-wakeups.ts`.
  - Keep the existing ten-second suspension safety threshold and reconnect/probe distinctions. Coalesce simultaneous foreground, network-change and native-wake signals into one supervisor replacement/catch-up attempt per environment. A queued signal must not cancel a healthy replacement and start it over. Session-generation checks reject old results. Offline transitions retain data and stop active retry churn until connectivity/foreground signals justify it.
  - Banner reads and detached snapshot retention must not add a thread-detail/background-activity lease. Existing provider-status/notification reporting and Android native service remain behaviorally compatible; do not remove the existing watchdog as a performance shortcut. Closing a hidden thread releases its stream/output subscription immediately. Cache/usage staleness timers stop on background. Foreground resume may schedule one normal catch-up, not every known thread.
  - Test rapid app-state sequences, repeated native wakes, failed session replacement, 9.9/10-second boundaries, offline→foreground→online, two environments, and cancellation using TestClock/Deferred. Assert replacement/request counts and observer teardown.
  - Acceptance: one foreground transition does not create duplicate full snapshots or redundant socket generations; added features generate no background traffic or wakes.

- [ ] **SP05 — Remove avoidable cold-open snapshot work while preserving wire budgets.**
  - Context: read this section's Fixed decisions, Banner design contract and Limits first.
  - Depends on: none.
  - Scope: packages/client-runtime/src/state/threads.ts, packages/client-runtime/src/state/threads-sync.test.ts, packages/client-runtime/src/state/boundedThreadSnapshotHttp.ts, packages/client-runtime/src/state/boundedThreadSnapshotHttp.test.ts, packages/client-runtime/src/state/threadSnapshotHttp.ts, apps/server/src/orchestration-v2/threadHistoryPaging.ts, apps/server/src/orchestration-v2/threadHistoryPaging.test.ts, apps/server/src/orchestration-v2/ThreadStream.ts, apps/server/src/orchestration-v2/ThreadStream.test.ts, apps/server/src/orchestration-v2/ThreadTransportPerformance.test.ts, apps/server/src/orchestration-v2/WireProjection.ts
  - Checks:
    - `vp test run --exclude '**/.worktrees/**' --exclude '**/.claude/worktrees/**' packages/client-runtime/src/state/boundedThreadSnapshotHttp.test.ts packages/client-runtime/src/state/threads-sync.test.ts apps/server/src/orchestration-v2/threadHistoryPaging.test.ts apps/server/src/orchestration-v2/ThreadTransportPerformance.test.ts` (cwd: ., timeout: 5m, expect: 0)
  - Trace the real empty-cache HTTP→socket path and remove redundant snapshot preparation, projection/JSON decode and duplicate fetches. Share in-flight bounded fetches for the same environment + route/session generation + thread; cancellation of an obsolete route must not publish its data into the next route. Bootstrap and shell enrichment that are unnecessary for reading a known thread cannot hold back its bounded snapshot. Keep server authorization and protocol compatibility checks.
  - Preserve the existing 75-row / approximately 1 MiB targets and dependency/control exceptions; do not simply shrink history until benchmarks look fast. Preserve the 128-event / 1 MiB resume budget, compact output, pagination, and original persisted-payload budgeting. Do not shorten the six-second bounded or twenty-second full fallback deadlines as a latency fix, race duplicate expensive HTTP/WS snapshots, or apply unconditional localhost/proxy/compression assumptions.
  - Exercise direct/relay/tunnel PreparedConnection request construction through existing authenticated HTTP tests, old server generic 404 fallback, authoritative missing-thread 404, timeout fallback, aborted navigation, and replay completion. Fresh data after the snapshot sequence arrives exactly once; errors cannot become false deletions.
  - Acceptance: one cold open does one bounded snapshot on supported servers then resumes from its sequence; warm opens fetch no full snapshot; test payload/query work stays bounded as unrelated thread history grows.

- [ ] **SP06 — Reduce initial feed work and preserve scroll continuity.**
  - Context: read this section's Fixed decisions, Banner design contract and Limits first.
  - Depends on: SP01.
  - Scope: apps/mobile/src/features/threads/ThreadFeed.tsx, apps/mobile/src/features/threads/ThreadDetailScreen.tsx, apps/mobile/src/features/threads/thread-feed-item-size.ts, apps/mobile/src/features/threads/thread-feed-item-size.test.ts, apps/mobile/src/features/threads/thread-feed-live-follow.ts, apps/mobile/src/features/threads/thread-feed-live-follow.test.ts, apps/mobile/src/features/threads/thread-work-log.tsx, apps/mobile/src/state/use-thread-composer-state.ts, packages/client-runtime/src/work-log/presentation.ts, packages/client-runtime/src/work-log/presentation.test.ts, scripts/legend-list-initial-reveal.test.ts
  - Checks:
    - `vp test run --exclude '**/.worktrees/**' --exclude '**/.claude/worktrees/**' apps/mobile/src/features/threads/thread-feed-item-size.test.ts apps/mobile/src/features/threads/thread-feed-live-follow.test.ts packages/client-runtime/src/work-log/presentation.test.ts scripts/legend-list-initial-reveal.test.ts` (cwd: ., timeout: 5m, expect: 0)
  - New files: `apps/mobile/src/features/threads/thread-feed-item-size.test.ts` does not exist yet; this task creates it next to the existing `thread-feed-item-size.ts`.
  - SP01 supplies the stage instrumentation and v2 workload needed to attribute the rendering work. Use it to remove full-feed transformations and unnecessary rich-content work before the first readable viewport. Keep LegendList, existing React Compiler transforms, stable row identities, and current keyboard-controller patches. Reuse existing viewability controls to defer offscreen markdown/code/image/diff work; do not eagerly render every work-log child in a collapsed group.
  - Preserve initial-scroll-at-end behavior, native measured insets, user reading position, turn folds, expanded output, selection/copy, screen-reader reading order, queued messages, and pending approvals. Subscribing the new quota strip or changing its percentages must not invalidate the feed or composer. Update only affected visible rows during provider streaming. Do not hide the entire list until unrelated row measurements, tool outputs, or image loads complete.
  - Test short and long feeds, a changed last row, large tool histories, keyboard opening, banner-height inset changes, history prepend, AGY tool interleaving, and user-scrolled-away behavior. Render-count/work-count checks must assert unrelated rows remain unchanged, not implementation-specific hook names.
  - Acceptance: existing content remains visible during catch-up; new progress does not reset the list, pull readers to the bottom, or repeatedly reparse offscreen history.

- [ ] **LB01 — Derive a small, stable quota-strip model from existing account data.**
  - Context: read this section's Fixed decisions, Banner design contract and Limits first.
  - Depends on: none.
  - Scope: apps/mobile/src/features/usage/usage-banner-model.ts, apps/mobile/src/features/usage/usage-banner-model.test.ts, apps/mobile/src/state/usage-banner.ts, apps/mobile/src/features/usage/UsageLimitsSection.test.ts, packages/shared/src/usageLimits.ts, packages/shared/src/usageLimits.test.ts, apps/mobile/src/widgets/subscriptionUsageSnapshot.test.ts
  - Checks:
    - `vp test run --exclude '**/.worktrees/**' --exclude '**/.claude/worktrees/**' apps/mobile/src/features/usage/usage-banner-model.test.ts packages/shared/src/usageLimits.test.ts apps/mobile/src/features/usage/UsageLimitsSection.test.ts apps/mobile/src/widgets/subscriptionUsageSnapshot.test.ts` (cwd: ., timeout: 5m, expect: 0)
  - New files: `usage-banner-model.ts`, `usage-banner-model.test.ts` (in `apps/mobile/src/features/usage/`) and `apps/mobile/src/state/usage-banner.ts` do not exist yet; this task creates them.
  - Implement the Fixed decisions and Banner design contract as pure selectors plus narrow atoms. Reuse `collectLimitAccounts` identity merging and account keys; do not derive a second account-identity system or use cost-based `useUsage`. Honor AuthDiagnosticsReadScope and existing usage access rules before reading cached/live limit data; permission loss removes values rather than retaining them as stale. Model grouped provider cells, configured placeholders, short/weekly slots with paired actual-reset countdowns, AGY matching family pools and next-refill semantics, stale reasons, account-detail navigation refs and accessible strings. Keep raw provider/source data available only to existing detail screens.
  - For two ordinary accounts show two cells, not a deceptively averaged account. For AGY use existing matching-window pooling, then the conservative per-slot family selection specified above; account slots use the equivalent minimum across that account's actual windows. Exclude unsupported/unknown windows from pool denominators and expose known/total coverage in the summary's spoken description. A fallback top-row quota identifies its actual family in details and accessible text, without a fabricated duration label. Tie-break equal windows by stable window ID, not provider response order. Additional Opus/Sonnet/other windows remain in existing details.
  - Reconcile placeholders from enabled native instances and source accounts omitted for transient unavailability. A placeholder cannot become a duplicate of a known fingerprint-deduplicated account. Preserve workspace/source distinctions and remove revoked/disabled accounts immediately; retain stale existing data only within still-authorized configured scope. Do not equate email equality with account identity.
  - Add focused new model tests within scope and run them in the declared task check. Cover native+proxy duplicate, same account across two environments, distinct workspaces, no fingerprint, all 1+1, 2+1, 1+2 and 2+2 Codex/Claude combinations, partial AGY source failure, 0/100/fractional percentages, changed window duration, model-only quotas, reset crossing, stale clock, unsupported/auth-required, no accounts, and stable order/reference identity when unrelated thread tokens change. Using fake timestamps and no elapsed waits, test minute boundaries 59/60, 1,439/1,440 and 2,879/2,880, plus sub-minute durations, missing/invalid/elapsed resets, very distant timestamps, clock jumps and foreground resume. Test aggregate next-refill selection, zero-restoration members and mixed-family reset pairing. Keep countdown formatting local to the banner so existing widget/Usage formats and pooling semantics do not change.
  - Acceptance: example 80% left is never rendered as 20%; unknown never appears as zero; adding the strip causes no usage RPC or transcript scan, and percentages update without reordering cells.

- [ ] **LB02 — Build and mount the fixed-height mobile quota strip.**
  - Context: read this section's Fixed decisions, Banner design contract and Limits first.
  - Depends on: LB01.
  - Scope: apps/mobile/src/features/usage/, apps/mobile/src/state/usage-banner.ts, apps/mobile/src/Stack.tsx, apps/mobile/src/features/layout/AdaptiveWorkspaceLayout.tsx, apps/mobile/src/features/layout/workspace-content-width.ts, apps/mobile/src/features/layout/native-glass-header-items.ts, apps/mobile/src/features/threads/ThreadDetailScreen.tsx, apps/mobile/src/features/threads/ThreadFeed.tsx, apps/mobile/src/lib/layoutMetrics.ts, apps/mobile/src/lib/adaptive-navigation.ts, apps/mobile/src/lib/adaptive-navigation.test.ts, apps/mobile/src/features/settings/components/settings-sheet-targets.ts
  - Checks:
    - `vp test run --exclude '**/.worktrees/**' --exclude '**/.claude/worktrees/**' apps/mobile/src/features/usage/UsageLimitBanner.test.tsx apps/mobile/src/features/usage/usage-banner-model.test.ts apps/mobile/src/features/usage/UsageLimitsSection.test.ts apps/mobile/src/lib/adaptive-navigation.test.ts apps/mobile/src/features/threads/thread-feed-live-follow.test.ts` (cwd: ., timeout: 5m, expect: 0)
  - New files: `apps/mobile/src/features/usage/UsageLimitBanner.tsx` and `UsageLimitBanner.test.tsx` do not exist yet; this task creates them.
  - LB01 provides the stable model, detail navigation refs, and percentage/freshness rules consumed here. Implement a feature-local `UsageLimitBanner.tsx` and one foreground-only minute clock. Account access is gated by the existing usage permission scope and authentication lifecycle; cached values are cleared on loss of that permission. Follow every geometry/state/route rule above, including SettingsSheet visibility while its underlying screen is frozen, native iOS translucent header offsets, Android Back, a pinned collapse button, RTL, accessible font sizing, and no additional background leases. Reuse ProviderIcon, existing themes and native feedback. Do not restyle generic UI exports into a bespoke control.
  - Add a focused interaction/state test file `UsageLimitBanner.test.tsx` using pure navigation/state integration where native rendering is not necessary in this scope, and run it in the declared task check. Use the repository's RN test conventions. Tests must drive real state transitions and navigation targets, not assert static markup/class names. Inject viewport/font scale/application state so no emulator is required for worker checks.
  - Cover 320/360/390/430 widths, 1.0/1.3/1.8/2.0 font scales, all 1+1, 2+1, 1+2 and 2+2 ordinary-account combinations and 0/1/5/20 AGY accounts; expansion with >viewport accounts, close/back/focus restore, Settings nested routes, translucent settings sheets, foreground/background, connection loss, removed account, account tap, and live quota changes while scrolled. Assert collapsed content width does not exceed available width through five cells; preserve expanded scroll offset and focus on refresh. Assert countdown changes cannot move columns or rerender the conversation, and there is exactly one foreground minute clock, stopped while hidden/backgrounded.
  - Acceptance: every required width fits two Codex + two Claude + AGY without collapsed scrolling, and normal font scale uses 48 dp height; AGY expands solely within that row and covers other provider cells horizontally; thread content position and composer behavior do not change between collapsed/expanded states. No banner appears in Settings. No refresh RPC is emitted by mounting, expanding, or collapsing it.

### Integration gates

- [ ] **SG01 — Verify the integrated thread runtime, wire and cache path.**
  - Depends on: SP02, SP03, SP04, SP05, SP06.
  - Scope: packages/client-runtime/src/state/threads-sync.test.ts, apps/server/src/orchestration-v2/ThreadTransportPerformance.test.ts, scripts/mobile-thread-performance.ts, scripts/mobile-thread-performance.test.ts
  - Checks:
    - `vp test run --exclude '**/.worktrees/**' --exclude '**/.claude/worktrees/**' apps/server/src/orchestration-v2/WireProjection.test.ts apps/server/src/orchestration-v2/threadHistoryPaging.test.ts apps/server/src/orchestration-v2/ThreadStream.test.ts apps/server/src/orchestration-v2/ThreadTransportPerformance.test.ts packages/client-runtime/src/state/boundedThreadSnapshotHttp.test.ts packages/client-runtime/src/state/threadDetail.test.ts packages/client-runtime/src/state/threads-sync.test.ts packages/client-runtime/src/platform/orchestrationCache.test.ts` (cwd: ., timeout: 10m, expect: 0)
    - `vp test run --exclude '**/.worktrees/**' --exclude '**/.claude/worktrees/**' scripts/mobile-thread-performance.test.ts` (cwd: ., timeout: 5m, expect: 0)
  - Needs SP02's retention, SP03's bounded persistence, SP04's reconnect handling, SP05's snapshot loading and SP06's feed derivation, because they share one snapshot/replay path; this gate exercises it once on the integrated revision. Exercise cold, warm, SQLite-restored, active-process-restore, history-expand, reconnect, delete and two-environment cases with generated v2 state and ephemeral resources.
  - Compare stage counts and encoded bytes with SP01's baseline and report before/after in the task result (not in tracked files). Assert the memory/disk budgets from Fixed decisions and zero unsolicited output subscriptions. Timing figures are labelled proxies; no real WAN p95 is claimed. A failure is repaired narrowly in the owning package, not by rerunning green checks.
  - Acceptance: transport budgets stay enforced, and cached rows appear before a deliberately blocked network becomes ready.

- [ ] **SG02 — Verify the integrated Android limits banner, routes and lifecycle.**
  - Depends on: LB02, SP02, SP03, SP04, SP06.
  - Scope: apps/mobile/src/features/usage/, apps/mobile/src/features/threads/thread-route-hydration.test.ts, apps/mobile/src/features/threads/thread-feed-live-follow.test.ts, apps/mobile/src/connection/, apps/mobile/src/lib/adaptive-navigation.test.ts, apps/mobile/src/lib/layout.test.ts, scripts/legend-list-initial-reveal.test.ts
  - Checks:
    - `vp test run --exclude '**/.worktrees/**' --exclude '**/.claude/worktrees/**' apps/mobile/src/features/usage/UsageLimitBanner.test.tsx apps/mobile/src/features/usage/usage-banner-model.test.ts apps/mobile/src/features/usage/UsageLimitsSection.test.ts apps/mobile/src/lib/adaptive-navigation.test.ts apps/mobile/src/lib/layout.test.ts apps/mobile/src/features/threads/thread-route-hydration.test.ts apps/mobile/src/features/threads/thread-feed-live-follow.test.ts apps/mobile/src/connection/environment-cache-store.test.ts apps/mobile/src/connection/background-activity.test.ts apps/mobile/src/connection/app-state-wakeups.test.ts apps/mobile/src/connection/android-background.test.ts scripts/legend-list-initial-reveal.test.ts` (cwd: ., timeout: 5m, expect: 0)
  - The banner (LB02) shares geometry and foreground state with cached navigation (SP02–SP04) and the feed (SP06), so they are checked together here. Exercise every width, font scale and state in the Banner design contract; assert expansion leaves feed position and follow state unchanged, Settings hides every banner instance, tablets show exactly one strip, and backgrounding adds no lease or polling.
  - This is a non-device proxy, not visual or native accessibility sign-off (see Limits).
  - Acceptance: ordering, five-cell no-scroll geometry, percentage/countdown pairing, AGY horizontal expansion, account correctness, stale/unknown handling and background request counts all pass together with thread navigation.

- [ ] **SG03 — Check integrated mobile package types.**
  - Depends on: LB02, SP02, SP03, SP04, SP06.
  - Scope: apps/mobile/tsconfig.json, apps/mobile/src/features/usage/usage-banner-model.test.ts, apps/mobile/src/features/usage/UsageLimitBanner.test.tsx
  - Checks:
    - `vp run typecheck` (cwd: apps/mobile, timeout: 10m, requires: heavy_build, expect: 0)
  - Needs LB02's banner components, SP02's cache-first routing, SP03's disk cache interfaces, SP04's foreground subscriptions and SP06's feed insets, because it checks their combined TypeScript surface, including `.ios` and Android route/header variants. Only this package's typecheck. Never hide an error with `any` or `@ts-ignore`.
  - Acceptance: mobile types pass for the integrated source and the shared exports it consumes.

- [ ] **SG04 — Check integrated shared client-runtime types.**
  - Depends on: SP02, SP03, SP04, SP05, SP06.
  - Scope: packages/client-runtime/tsconfig.json, packages/client-runtime/src/state/threads-sync.test.ts
  - Checks:
    - `vp run typecheck` (cwd: packages/client-runtime, timeout: 10m, requires: heavy_build, expect: 0)
  - Needs SP02's retention, SP03's persistence, SP04's supervisor lifecycle, SP05's HTTP loading and SP06's feed derivation, because their interfaces compile together in this package. Narrow compiler repairs only; no `any`, `@ts-ignore` or weakened schemas.
  - Acceptance: shared runtime compiles, and mobile-only factory defaults stay optional for other clients.

- [ ] **SG05 — Check web and desktop compatibility of the shared cache changes.**
  - Depends on: SP02, SP03, SP04, SP05, SP06.
  - Scope: apps/web/tsconfig.json
  - Checks:
    - `vp exec tsc-rs --noEmit -p .` (cwd: apps/web, timeout: 10m, requires: heavy_build, expect: 0)
  - Local-hosted web, hosted web and the Electron desktop consume the shared cache defaults (SP02, SP03), supervisor lifecycle (SP04), snapshot compatibility (SP05) and presentation (SP06). `apps/web` has no `typecheck` script, so run the checker directly. Desktop shell/IPC is unchanged; do not alter it to satisfy web compile errors.
  - Acceptance: web types pass, and mobile-only retention and banner settings are not imposed on web or desktop.

- [x] **SG06 — Check integrated server package types.**
  - Depends on: SP05.
  - Scope: apps/server/tsconfig.json, apps/server/src/orchestration-v2/ThreadTransportPerformance.test.ts
  - Checks:
    - `vp run typecheck` (cwd: apps/server, timeout: 15m, requires: heavy_build, expect: 0)
  - SP05 changes server snapshot preparation. Only this package's typecheck. At release 0.1.4 this package has 11 pre-existing `anyUnknownInErrorContext` diagnostics in `src/cli/pair.test.ts`; compare against that baseline and treat only new diagnostics as this gate's failures.
  - Acceptance: server snapshot surfaces compile with the integrated shared contracts and no new diagnostics.

### Limits

- Plan lint warns `broad-check` on SG03, SG04 and SG06: each `vp run typecheck` runs with a single-package `cwd`, never the repository-wide typecheck. It also warns `scope-overlap` between the SP tasks and between gates: the overlaps are intentional shared files, and the queue runs overlapping tasks one at a time.
- The performance targets are requirements to measure, not established results or guaranteed WAN latencies. A cached return can be near instant while fresh state still needs a network round trip; a first-ever open, auth renewal, server load or a slow phone has a different lower bound.
- No task runs an emulator, browser, physical device or computer use. After the plan lands, one authorized `test-t3-mobile` pass on an Android release (Hermes) build should cover the banner widths, font scales, Settings hiding, keyboard and AGY expansion. Proxy tests cannot prove native paint, accessibility focus, battery drain or Android back gestures.
- No iOS build host is provisioned here, so no iOS gate exists; iOS layout is verified later on a provisioned host.
- Real-link speed attribution needs stage traces from an installed build over LAN and the remote route; fixture bandwidth simulation cannot establish the actual uplink or relay behaviour. Reports never include credentials, pairing links or private transcripts.
- Publishing is not a task: the fork's release is built locally (GitHub Actions is disabled) and is run by the orchestrator after the gates pass, as for v0.1.4.
