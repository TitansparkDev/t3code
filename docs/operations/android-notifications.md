# Android Notifications

The Android app receives Firebase Cloud Messaging (FCM) data messages through Google Play services and maps them onto system notifications in an Expo native module (`t3-agent-notifications`).

## Architecture and compatibility

The app's minimum is Android 7.0 (API 24), declared in `app.config.ts` and enforced by the relay's device-registration schema. Compile/target SDK versions follow the locked Expo/React Native toolchain (currently API 36). Notification channels begin at API 26; the notification permission prompt begins at API 33. Live Update promotion requires API 36 and remains subject to system settings and device support. Alerts and ordinary activity cards work below API 36.

On Android 16+, open T3 Code Settings → Live Update Settings to allow status bar chips. Android controls this separately from notification permission. The chip reads `Working` during work, `Approve` for approvals, and `Answer` for input requests; completed work returns to a normal notification. Use an Android 16 QPR2 or newer emulator image to verify the shipped promotion behavior.

API 24–25 use a single inexact system alarm to expire cards after process exit, with no exact-alarm permission. Android can delay that alarm in power-saving modes. API 26+ use notification timeouts. Disabling activity, dismissal, account changes and sign-out cancel the legacy alarm. A stale expiry broadcast cannot remove a newer run's card.

## Notification channels

Four channels are created on first launch or when incoming messages arrive:

| Channel ID             | Name              | Default importance                  | Sound / vibration                  | Description                                                                                          |
| ---------------------- | ----------------- | ----------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `t3_agent_activity`    | Agent activity    | `IMPORTANCE_LOW` (min on API 24–25) | Silent, no vibration               | Pinned progress notifications and Live Updates. Kept quiet to avoid spamming the user on every step. |
| `t3_agent_alerts`      | Agent alerts      | `IMPORTANCE_HIGH`                   | System default sound and vibration | Attention requests: question asked, approval needed, run completed, or run failed.                   |
| `t3_connection_alerts` | Connection alerts | `IMPORTANCE_DEFAULT`                | Silent, system default vibration   | Remote machine connection errors, relay disconnects, or authentication failures.                     |
| `t3_general`           | General           | `IMPORTANCE_LOW`                    | Silent, no vibration               | Background sync notices and system updates.                                                          |

Each channel has a user-visible description explaining what it handles and why it is silent or audible. Settings links direct users to these system channel settings when deeper customization is needed.

## Notification presentation

Incoming FCM data payloads must match the relay's activity or alert schemas. The native module parses and presents them:

```
[Agent Activity Notification]
Icon: App icon / agent monogram
Title: "Working on <task-title>" or "<Project>: <task-title>"
Text: Current step summary (e.g. "Editing src/index.ts")
Progress: Indeterminate horizontal progress bar when running
Style: BigTextStyle for expanded step descriptions
Actions:
  - "Pause" / "Resume" (direct broadcast back to relay)
  - "Open" (deep link to thread)
```

For agent alerts:

```
[Agent Alert Notification]
Icon: Warning / checkmark based on status
Title: "Input needed: <task-title>" or "Finished: <task-title>"
Text: Detailed question or final outcome
Category: CATEGORY_MESSAGE
Priority: PRIORITY_HIGH
Actions:
  - "View" (deep link to thread)
  - "Dismiss"
```

## Testing and verification

Use `adb` or Firebase Console to verify delivery across targets:

1. **Android 7.0–7.1 (API 24–25)**: Verify fallback alarm expiry without permission crashes.
2. **Android 8.0–12 (API 26–32)**: Verify channel creation and silent progress updates.
3. **Android 13+ (API 33+)**: Verify runtime notification permission flow and post-notification gating.
4. **Android 16+ (API 36+)**: Verify Live Update chip states and lock screen promotion.
