# T3 Code

T3 Code is a multi-surface GUI for running coding agents through a local or remote T3 server. The
fork supports web, Electron desktop, and React Native mobile clients, with provider instances for
Codex, Claude, Cursor, Grok, OpenCode, and Antigravity.

## Current product behavior

- Provider sessions use the provider-native adapter protocol. Antigravity uses Google's ACP server
  for authentication, model discovery, permissions, turns, and session resume.
- Provider instances are isolated by instance ID, including Antigravity profiles and quota state.
- The web and desktop clients show subscription limits in the AGY limits section when Antigravity
  publishes Gemini and Claude/GPT windows. Gemini windows are shown in blue; Claude/GPT windows
  are shown in green, including separate five-hour and weekly buckets. Quota refresh is read-only
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
- T3 Connect stores its managed public endpoint with the cloud link, and web pairing links can use
  that endpoint when it is available. Web and mobile cloud linking preserve the endpoint.
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
