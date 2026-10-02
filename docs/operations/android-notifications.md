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

## Clerk sign-in for private builds

Clerk's native Android sign-in uses `clerk://<applicationId>.callback`. In the Clerk instance selected by the build's publishable key, its administrator must allow the exact callback under **Native applications > Allowlist for mobile SSO redirect**. For the development package, add:

```text
clerk://com.t3tools.t3code.dev.callback
```

The app already declares the matching callback receiver. A "redirect url ... does not match an authorized redirect URI" error requires a Clerk configuration change; rebuilding the same APK does not fix it. Reopen sign-in after the administrator saves the entry. See [Android native sign-in redirects](./connect-setup.md#android-native-sign-in-redirects) for the other variants.

Using T3's existing production publishable key selects the maintainers' Clerk instance. It grants no access to change that instance's allowlist. The chosen package's callback must already be allowed or be added by that instance's administrator. Android device registration and hosted delivery separately require the relay deployment below. A successful direct-pairing or FCM smoke test does not verify hosted sign-in or device registration.

Building with `APP_VARIANT=production` selects `com.t3tools.t3code` and its corresponding Clerk callback. Set the same variant during prebuild and bundling, and supply a Google services file that includes that package. Keep OTA updates disabled for a private binary. A locally signed build with this package cannot update an official installation signed by the maintainer or coexist with it; removing that installation also removes its app-local data. The development package remains a separate app.

## Focused delivery check

`infra/relay/scripts/android-push-smoke.ts` sends a message through the production FCM client implementation without provisioning the relay's database, Clerk integration, or Cloudflare queues. It verifies only Firebase-to-device delivery.

Provide a private device JSON file containing the app's native FCM `token`, registered `deviceId`, signed-in `userId`, and Android `packageName`. An optional `deepLink` can target an existing thread for tap verification. The app must have registered its local native notification handler and have notification permission. From `infra/relay`:

```sh
vp run push:android:smoke /path/service-account.json /path/device.json running
vp run push:android:smoke /path/service-account.json /path/device.json approval
vp run push:android:smoke /path/service-account.json /path/device.json completed
```

Supported states are `running`, `approval`, `input`, `completed`, `failed`, and `end`. Firebase acceptance is not proof that a device displayed the message. Check the actual notification, background the app, and test a notification tap. Also test dismissal, disabling ongoing activity, sign-out, token rotation, and delivery after the app process has exited. Android Settings **Force stop** intentionally prevents delivery until the app is opened again.

With the app in the foreground, Android suppresses an alert only for the thread currently on screen, matching iOS notification presentation; alerts for other threads still show. Activity cards still update in the foreground and retain finished results silently. Check that completion stays quiet while its thread is open, alerts while another screen is open, alerts after backgrounding, and that retrying a suppressed alert does not show it later. This uses the app lifecycle and route on the receiving phone, not thread visibility on other clients.

With ongoing activity enabled, verify two threads entering approval/input together produce one `2 agents need attention` alert, and two observed active threads completing/failing together produce one `2 agents finished` alert. The body lists their titles. The relay shares iOS transition selection and retains its delivered baseline when work finishes; publishing the same states again must not produce another alert. Grouped alerts open the aggregate’s priority thread; individual alerts retain their thread link.

Verify an expanded card with five threads, attention/failure priority, project names and statuses. When all work finishes, the card should show **Agent work completed** or **Agent work failed**, lose its ongoing/promotion flag, and expire 15 minutes after the newest displayed result. Replays must not extend that deadline. Quiet running work uses the relay’s two-hour state lifetime; approval/input states use 24 hours. Reopen the same signed-in app and confirm existing alerts and dismissal survive, with a silent aggregate replay on cold start or a foreground after at least 60 seconds. Also check empty replays remove an orphaned card and completions older than two minutes never alert, even with ongoing activity disabled.

After Android prebuild, run the native presentation regression tests from `apps/mobile/android`:

```sh
./gradlew :t3-agent-notifications:testDebugUnitTest --tests expo.modules.t3agentnotifications.AgentNotificationsTest
```

## Relay deployment

### Local verification with existing T3 services

You do not need to duplicate T3 Connect's hosted infrastructure to develop Android push. Keep the normal Clerk login and environment connections. `scripts/android-push-watch.ts` subscribes to one paired environment's shell stream, uses the shared agent-awareness projection, and sends updates through the new FCM client. It holds transient state in memory and needs no hosted database or Clerk secret.

Create a private `connection.json` containing `wsUrl` (the environment's `/ws` URL) and `bearerToken` (a normal paired environment access token). Use a separate pairing credential for this watcher. Supply the same device file described above, then run from `infra/relay`:

```sh
vp run push:android:watch /path/service-account.json /path/device.json /path/connection.json
```

The Android native handler must already be configured with that device and account, and notifications must be allowed. A native instrumentation harness can configure a disposable emulator before testing; a signed-in development app configures the handler during device registration. This watcher is a development transport: it observes all unarchived threads in its paired environment, enables all alert types, keeps no durable queue, and must stay running. It does not register Android devices with the existing hosted relay. The hosted relay needs the changes below before its notification settings and delivery work end to end.

### Hosted delivery

The existing Alchemy deployment provisions Cloudflare Workers, delivery queues, Hyperdrive, tunnel/DNS resources, PlanetScale Postgres, and Axiom observability by default. It requires credentials for the enabled services and private Clerk configuration; the repository's public app settings do not grant deployment access. Set `APNS_ENABLED=false` in an Android-only development relay to skip Apple delivery and its credential requirements. APNs remains enabled by default.

#### Personal stage in the existing deployment accounts

A maintainer with access to the existing Alchemy state and deployment credentials can deploy the Android changes to a personal stage. Non-production stages reference the retained database and DNS zones owned by the `prod` stage, create a separate PlanetScale branch, and apply migrations to that branch. A personal stage is therefore not a standalone deployment into an unrelated account.

1. Apply the Android changes to a checkout with the existing deployment credentials. Create a private `infra/relay/.env.android-dev` using the existing Cloudflare, PlanetScale, Axiom, domain, and Clerk configuration described in the [relay README](../../infra/relay/README.md#deployment-ci). Keep `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and `CLERK_JWT_AUDIENCE` on the same Clerk instance used by the test clients.
2. Add the Firebase service-account JSON as `FCM_SERVICE_ACCOUNT` and set `APNS_ENABLED=false` for this Android-only stage. Leave `RELAY_DOMAIN` unset so the deployment derives a hostname for the personal stage instead of using the production hostname.
3. From the repository root, inspect the deployment plan, then deploy the same stage:

   ```sh
   vp run --filter t3code-relay deploy --stage dev_ryan_android --env-file .env.android-dev --dry-run
   vp run --filter t3code-relay deploy --stage dev_ryan_android --env-file .env.android-dev
   ```

4. Give the tester the deployed relay URL and matching public Clerk configuration. The deploy wrapper also writes the relay URL and public tracing configuration into that checkout's root `.env`. Rebuild the private APK with this `T3CODE_RELAY_URL`, the existing Firebase Android file, and OTA updates disabled. If using the separate development package, authorize its Clerk callback as described above.
5. Configure one isolated T3 server with the same relay URL and link that test environment through the new relay. Existing production relay links do not automatically move to a personal stage. Enable activity publishing for the test environment, enable notifications on the phone, and verify a real agent turn produces a running update and completion alert while the phone is locked.

The maintainer can perform deployment themselves and return only the public client configuration; the tester does not need copies of their hosting or Clerk server credentials. A fully independent deployment needs its own initial Cloudflare stack, PostgreSQL database, Firebase project, and a Clerk instance the operator can configure. Its Alchemy deployment needs PlanetScale and Axiom credentials.

Build the host client and mobile app with the same relay URL and Clerk public configuration. A source server or desktop development build can host the test environment; keep its T3 home separate from an existing installation. Signing into the phone alone does not link a host environment. Use the host client's T3 Connect settings to link it and enable activity publishing. A private Clerk instance also needs its own CLI OAuth application before using `t3 connect login`; the repository's production CLI client ID belongs to the maintainers' instance.

For deployment through GitHub Actions, add `FCM_SERVICE_ACCOUNT` to the `production` environment's secrets. The relay workflow passes it to Alchemy. The maintainer must also supply `google-services.json` for the production Android package in the native build environment; changing the relay secret alone cannot move an installed app to another Firebase project.

Android delivery uses `RelayFcmDeliveryQueue` and a separate dead-letter queue. Failed requests are retried; messages expire after five minutes. Before sending, the consumer rechecks the device token, current preferences, environment links, and current thread state. `UNREGISTERED` responses invalidate only the matching device token. OAuth tokens are cached within the FCM service and refreshed after an authorization failure.
