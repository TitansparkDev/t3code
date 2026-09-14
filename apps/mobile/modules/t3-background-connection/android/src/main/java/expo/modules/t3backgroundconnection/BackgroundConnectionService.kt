package expo.modules.t3backgroundconnection

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the host process important enough for the existing JS connection
 * reporter to receive Android background time. It never owns a socket or a
 * credential; those remain in client-runtime's single supervisor.
 */
class BackgroundConnectionService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val tick = object : Runnable {
    override fun run() {
      if (!BackgroundConnectionState.isEnabled(this@BackgroundConnectionService)) {
        stopSelf()
        return
      }
      emitWake()
      handler.postDelayed(this, BackgroundConnectionState.WAKE_INTERVAL_MS)
    }
  }

  override fun onCreate() {
    super.onCreate()
    BackgroundConnectionState.createChannel(this)
    try {
      val notification = BackgroundConnectionState.notification(this)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          BackgroundConnectionState.NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        )
      } else {
        startForeground(BackgroundConnectionState.NOTIFICATION_ID, notification)
      }
      handler.post(tick)
    } catch (_: SecurityException) {
      // A denied notification permission or an OEM foreground-service policy
      // must not crash the React Native host. The persisted flag stays set so
      // a later foreground or boot can retry after the policy changes.
      stopSelf()
    } catch (_: RuntimeException) {
      stopSelf()
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (!BackgroundConnectionState.isEnabled(this)) {
      stopSelfResult(startId)
      return START_NOT_STICKY
    }
    if (intent?.action == BackgroundConnectionState.ACTION_WAKE) {
      emitWake()
    }
    return START_STICKY
  }

  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null)
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun emitWake() {
    val power = getSystemService(PowerManager::class.java)
    val wakeLock = power?.newWakeLock(
      PowerManager.PARTIAL_WAKE_LOCK,
      "T3Code:background-connection",
    ) ?: return
    wakeLock.setReferenceCounted(false)
    try {
      wakeLock.acquire(BackgroundConnectionState.WAKE_LOCK_TIMEOUT_MS)
      sendBroadcast(
        Intent(BackgroundConnectionState.ACTION_WAKE)
          .setPackage(packageName)
          .putExtra(BackgroundConnectionState.EXTRA_WAKE_AT, System.currentTimeMillis()),
      )
    } finally {
      if (wakeLock.isHeld) wakeLock.release()
    }
  }
}

internal object BackgroundConnectionState {
  const val ACTION_WAKE = "expo.modules.t3backgroundconnection.ACTION_WAKE"
  const val EXTRA_WAKE_AT = "wakeAt"
  const val NOTIFICATION_CHANNEL_ID = "t3-background-connection"
  const val NOTIFICATION_ID = 73002
  const val WAKE_INTERVAL_MS = 25_000L
  const val WAKE_LOCK_TIMEOUT_MS = 5_000L

  private const val STORE = "t3-background-connection"
  private const val ENABLED = "enabled"

  fun configure(context: Context, enabled: Boolean) {
    context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
      .edit()
      .putBoolean(ENABLED, enabled)
      .apply()
    val intent = Intent(context, BackgroundConnectionService::class.java)
    if (enabled) {
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          ContextCompat.startForegroundService(context, intent)
        } else {
          context.startService(intent)
        }
      } catch (_: RuntimeException) {
        // Keep the durable desire. The next foreground transition or boot
        // receiver can retry when Android permits a foreground start.
      }
    } else {
      context.stopService(intent)
    }
  }

  fun wake(context: Context) {
    if (!isEnabled(context)) return
    val intent = Intent(context, BackgroundConnectionService::class.java)
      .setAction(ACTION_WAKE)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ContextCompat.startForegroundService(context, intent)
      } else {
        context.startService(intent)
      }
    } catch (_: RuntimeException) {
      // The periodic service/boot path will retry without surfacing native
      // lifecycle policy failures to JavaScript.
    }
  }

  fun isEnabled(context: Context): Boolean = context
    .getSharedPreferences(STORE, Context.MODE_PRIVATE)
    .getBoolean(ENABLED, false)

  fun createChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java)
    manager?.createNotificationChannel(
      NotificationChannel(
        NOTIFICATION_CHANNEL_ID,
        "Background connections",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "Keeps active T3 Code environments reachable while the app is backgrounded."
        setShowBadge(false)
      },
    )
  }

  fun notification(context: Context): Notification {
    val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
    val contentIntent = launchIntent?.let {
      PendingIntent.getActivity(
        context,
        NOTIFICATION_ID,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
    val icon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
      .takeIf { it != 0 }
      ?: android.R.drawable.stat_notify_sync_noanim
    return NotificationCompat.Builder(context, NOTIFICATION_CHANNEL_ID)
      .setSmallIcon(icon)
      .setContentTitle("T3 Code connected")
      .setContentText("Keeping active environments reachable")
      .setContentIntent(contentIntent)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setShowWhen(false)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .build()
  }

  fun startFromSystem(context: Context) {
    if (!isEnabled(context)) return
    val intent = Intent(context, BackgroundConnectionService::class.java)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ContextCompat.startForegroundService(context, intent)
      } else {
        context.startService(intent)
      }
    } catch (_: RuntimeException) {
      // System broadcasts can arrive while the package is background-start
      // restricted. A later app foreground will reconcile the desired state.
    }
  }
}
