# T3 Code

T3 Code is a multi-surface GUI for running coding agents through a local or remote T3 server. The
fork supports web, Electron desktop, and React Native mobile clients, with provider instances for
Codex, Claude, Cursor, Grok, OpenCode, and Antigravity.

## Current product behavior

- Provider sessions use the provider-native adapter protocol. Antigravity uses Google's ACP server
  for authentication, model discovery, permissions, turns, and session resume.
- When Codex, Claude, or OpenCode reports a usage limit, the server classifies that failure
  separately and preserves the provider reset time when one is available. Web can schedule a
  durable automatic resume, resume immediately, or cancel it; after a restart or remote client
  action, the server restores the schedule and uses bounded backoff if the provider still rejects
  the continuation. Other providers remain compatible with the optional state without opting into
  automatic resume until their adapter exposes equivalent reset metadata.
- Provider instances are isolated by instance ID, including Antigravity profiles and quota state.
- Desktop supports independent T3 windows from File → New Window (`CmdOrCtrl+Shift+N`). All windows
  share one background server; the primary window owns the persisted bounds and app shutdown state.
- Mobile thread rows and thread detail surfaces show linked development servers. Trusted private
  connection hosts replace environment loopback URLs while public, relay, tunnel, and unreachable
  hosts remain unchanged or disabled rather than being guessed reachable.
- The web and desktop clients show subscription limits in the AGY limits section when Antigravity
  publishes Gemini and other-model windows. Gemini windows are shown in blue; Claude/GPT and other
  model windows are shown in green, including separate five-hour and weekly buckets. Quota refresh is read-only
  and does not start a coding turn. The sidebar Usage icon previews pooled headroom and reset
  timing on hover or keyboard focus, and opens the Limits view when selected.
- Codex quota refreshes can run while an instance is idle, so reset times do not wait for the next
  prompt. Native Codex accounts are identified by workspace account ID when available, with plan
  separation as a fallback for older same-email accounts.
- Claude subscription limits preserve the last successful bars when a usage request is throttled.
  Enterprise and extra-usage spending budgets appear as monthly currency windows when rolling
  windows are unavailable.
- Claude usage sections show whether the current time is in Anthropic's weekday peak window of
  05:00–11:00 Pacific on web and mobile.
- Quota data is kept separate from thread state, keyed by provider instance, and refreshed on a
  background loop or by an explicit refresh action.
- On Android, mobile keeps the existing JavaScript-owned environment activity reporter alive while
  the app is backgrounded and environments remain registered. One native foreground service covers
  all environments, shows a low-priority ongoing notification, wakes the reporter periodically, and
  restores its desired state after device restart. It stops when the app returns to the foreground or
  no environments remain; notification permission and OEM battery policies can still limit delivery.
- Agent-awareness notifications can include bounded plain-text completion answers. Android activity
  cards are suppressed while the app is foregrounded, group updates by environment, expire stale
  activity, and deep-link back to the related thread; Android 16 live-update settings have a
  compatibility fallback on older devices.
- Mobile Markdown file screens can switch between rendered preview and source mode. The choice is
  remembered on the device, while files opened at a source line always stay in source mode and hide
  the mode controls. Unsupported, binary, missing, and truncated files retain the existing source
  or error fallback with a partial-file warning where applicable.
- Mobile native review colors flatten Material You `#RRGGBBAA` tokens against the active surface,
  keeping text, unchanged lines, and labels readable in both light and dark appearances.
- Android split-view thread, files, terminal, and empty-detail surfaces can hide and restore the
  persistent thread sidebar on tablets and foldables. Phone navigation and iOS native sidebar
  controls remain unchanged.
- Mobile connection, Settings → Environments, and T3 Connect onboarding rows expose a
  connected-environment-only “Refresh providers” action. It reports progress, success, and
  failures, ignores interrupted commands, and suppresses repeated taps while a refresh is active.
- Server config subscriptions serve the cached provider snapshot; provider refreshes continue
  through the background maintenance loop or explicit environment-scoped actions. Connection
  establishment allows slow valid setup to finish for up to 45 seconds, while health probes keep
  their existing shorter deadlines.
- Mobile composer images from picks, clipboard pastes, and native shares are copied into
  app-owned files. Drafts and queued messages persist only file metadata and references; older
  inline image drafts remain readable. Owned copies are size-checked and cleaned up when drafts,
  queued sends, retries, or review composers release them.
- Mobile model and provider-option changes update the current composer draft and the remembered
  default together, so a choice made in an existing thread is used by later new threads.
- Idle, settled conversations can be forked from web, desktop, and mobile into a fresh thread.
  Forking preserves the source, hands the new provider a bounded Markdown transcript, omits tool
  internals and binary attachment data while retaining attachment names, and blocks active or
  pending source work. The target provider and model must be enabled, installed, ready, and
  authenticated; servers without fork support hide the action.
- Agent-awareness completion alerts include a bounded plain-text excerpt of the completed
  assistant answer when one exists, with concise status fallbacks for empty answers and grouped
  alerts. Android ongoing activity notifications show Active or Review chips while work is live.
- Android 16+ exposes a Live Update Settings entry for the system promotion controls; older Android
  versions keep the ordinary ongoing notification behavior and use the existing app settings path.
- T3 Connect stores its managed public endpoint with the cloud link, and web pairing links can use
  that endpoint when it is available. Web and mobile cloud linking preserve the endpoint.
- Direct pairing also supports a user-managed public HTTPS endpoint, such as a Cloudflare Tunnel,
  that routes to the local T3 server. The client uses the hostname directly; this path does not
  require the hosted T3 Connect relay or its cloud services.
- Desktop release builds include the public T3 Connect configuration by default and use the
  production relay at `https://relay.t3.codes`; release variables can override it for a
  self-hosted relay.
- Desktop Connections settings can create a standard pairing link, show a QR code, and let the
  user choose the public T3 Connect endpoint instead of a loopback address.
- OmniCode is available as a built-in theme on web and mobile, with matching light and dark
  palettes.
- Desktop update feeds are published from the fork's GitHub releases, including the Windows and
  Linux updater manifests used by the in-app update controls.
- Linux desktop builds check for a release during the local 02:00 update window and install it
  unattended only after all active agent turns have settled.
- The fork's GitHub workflow mirrors upstream `main` and merges it into `omni/main` on a schedule;
  merge conflicts are reported in the Actions summary instead of being silently overwritten.

## Important boundaries

Remote connections must remain single-origin in development and must not bake localhost origins
into the client bundle. Provider and quota data crossing the server/client boundary uses the typed
contracts package. The server must never be run against the live `~/.t3/userdata` database during
development or verification.
