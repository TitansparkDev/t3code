package expo.modules.t3backgroundconnection

import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24, 26, 33, 36], manifest = Config.NONE)
class BackgroundConnectionTest {
  private lateinit var context: Application
  private lateinit var notifications: NotificationManager

  @Before
  fun setUp() {
    context = RuntimeEnvironment.getApplication()
    context.getSharedPreferences("t3-background-connection", Context.MODE_PRIVATE)
      .edit()
      .clear()
      .commit()
    notifications = context.getSystemService(NotificationManager::class.java)
    shadowOf(notifications).setNotificationsEnabled(true)
  }

  @Test
  fun configurePersistsTheDesiredStateAndCreatesAnExplicitNotification() {
    BackgroundConnectionState.configure(context, true)

    assertTrue(BackgroundConnectionState.isEnabled(context))
    val notification = BackgroundConnectionState.notification(context)
    assertTrue(notification.flags and Notification.FLAG_ONGOING_EVENT != 0)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      assertEquals(BackgroundConnectionState.NOTIFICATION_CHANNEL_ID, notification.channelId)
    }

    BackgroundConnectionState.configure(context, false)
    assertFalse(BackgroundConnectionState.isEnabled(context))
  }

  @Test
  fun createsTheBackgroundConnectionChannelOnSupportedAndroidVersions() {
    BackgroundConnectionState.createChannel(context)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = notifications.getNotificationChannel(
        BackgroundConnectionState.NOTIFICATION_CHANNEL_ID,
      )
      assertNotNull(channel)
      assertEquals(NotificationManager.IMPORTANCE_LOW, channel?.importance)
      assertFalse(channel?.canShowBadge() ?: true)
    }
  }

  @Test
  fun bootReceiverRestartsOnlyWhenTheDurableFlagIsEnabled() {
    val receiver = BackgroundConnectionBootReceiver()
    val boot = Intent(Intent.ACTION_BOOT_COMPLETED)

    BackgroundConnectionState.configure(context, false)
    receiver.onReceive(context, boot)
    assertNull(shadowOf(context).nextStartedService)

    BackgroundConnectionState.configure(context, true)
    shadowOf(context).nextStartedService
    BackgroundConnectionState.configure(context, false)
    receiver.onReceive(context, boot)
    assertNull(shadowOf(context).nextStartedService)

    BackgroundConnectionState.configure(context, true)
    shadowOf(context).nextStartedService
    receiver.onReceive(context, boot)
    assertEquals(
      BackgroundConnectionService::class.java.name,
      shadowOf(context).nextStartedService?.component?.className,
    )
  }

  @Test
  fun wakeTakesTheProcessWakeLockAndBroadcastsToTheSamePackage() {
    val wake = mutableListOf<Intent>()
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        wake += intent
      }
    }
    context.registerReceiver(receiver, IntentFilter(BackgroundConnectionState.ACTION_WAKE))
    BackgroundConnectionState.configure(context, true)
    shadowOf(context).nextStartedService

    val service = Robolectric.buildService(BackgroundConnectionService::class.java).create().get()
    service.onStartCommand(
      Intent(context, BackgroundConnectionService::class.java)
        .setAction(BackgroundConnectionState.ACTION_WAKE),
      0,
      1,
    )

    assertEquals(1, wake.size)
    assertEquals(context.packageName, wake.single().`package`)
    assertTrue(wake.single().getLongExtra(BackgroundConnectionState.EXTRA_WAKE_AT, 0L) > 0L)
    service.onDestroy()
    context.unregisterReceiver(receiver)
  }
}
