# Usage and limits

Track token usage and monitor subscription rate limits across providers and connected environments.

## View usage

Open **Usage** from the sidebar or bottom navigation to see tokens consumed by model and time
period. Filter by environment or project to focus on specific work.

The overview shows total tokens, estimated cost, and a breakdown across providers. Cost estimates
use each provider's published rates and exclude free or included allowances.

Detailed logs show per-turn consumption: prompt tokens, completion tokens, cached tokens, and reasoning tokens when reported.

## Subscription rate limits

Open **Usage → Limits** to see current rate-limit windows for Codex, Claude, and configured
subscription providers.

A status bar shows capacity across active accounts. Segments show who is running now and who is
waiting.

When an account is in a reset window, its segment is patterned. Numbers below
the bar show when the next reset lands and how much it hands back. The hatched
part of a segment is what that reset restores. Tap a segment or account row for the account's plan,
where it is signed in, and its reset time. On web, you can hover too. Codex and Claude accounts
with banked reset credits show a ticket count and the **Use reset** action in the account details.
Claude resets are not available when the server runs on macOS, where Claude keeps its login in the
Keychain. On narrow screens, numbered rows below
the bar show each account's quota, countdown, and credits. Tap a row to open its details.

The same account signed in on more than one environment, or reported by a hub as well, counts once.
Filter with the environment dropdown to see what a single machine has.

Opening Limits checks the selected connected environments automatically. Each client waits at
least five minutes between automatic checks of an environment, including after a failed check.
If a window still looks stale, refresh Limits to re-check every provider and hub.

Pick `/usage-limits` from the composer's command menu, or send it as a message, to check the
current model's limits without leaving the conversation. The result opens above the composer and
closes when you dismiss it or send your next message. It uses the same snapshot as **Usage → Limits**, so it does not run the agent or refresh
anything. The command is offered only for providers that appear under **Usage → Limits**.

OpenCode Go reports its session, weekly, and monthly allowance when OpenCode runs locally in
the environment. T3 cannot report limits for external OpenCode servers because their credentials
belong to the remote server. Cursor reports
its monthly allowance, including separate Auto and API usage, using the CLI login or
`CURSOR_AUTH_TOKEN`. On macOS, this includes the default Keychain login after you enable Cursor
usage. Keychain login is used for limits only with Cursor's default API endpoint. If you configure
a custom Cursor endpoint, use an explicit token or file-based CLI login for limits.

Grok reports the remaining subscription allowance and reset time for its current billing period
after signing in with `grok login`. Explicit `XAI_API_KEY` connections and custom authentication
or endpoint configurations do not report subscription limits.

API-key accounts may not report subscription limits. This also applies to Claude connections
using a proxy through `ANTHROPIC_AUTH_TOKEN`.

## Connect a CLIProxyAPI hub

To see pooled accounts, open **Settings → Providers → Usage providers → Add hub**. Choose the
environment that will connect to the hub and enter its URL and management key.

The accounts appear under **Usage → Limits**. Codex accounts show banked reset credits; select an
account and choose **Use reset** to redeem one. No hub plugin is required.

This connection supplies usage information; configure
the provider separately to send agent requests through the hub. Remove the hub from the same
settings section when you no longer need it.

## Subscription usage widget

Add **Subscription usage** from your iOS or Android widget gallery to see remaining Codex and
Claude quotas. Tap it to open **Usage → Limits**. On iOS, use **Edit Widget** to choose Session,
Weekly, or both for each provider. Return to Usage → Limits or pull to refresh to update expired
readings. The Android widget requires Android 12L or later.
