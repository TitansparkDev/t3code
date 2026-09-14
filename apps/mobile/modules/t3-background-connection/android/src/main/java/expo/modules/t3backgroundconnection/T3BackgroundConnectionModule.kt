package expo.modules.t3backgroundconnection

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val WAKE_EVENT = "onWake"

class T3BackgroundConnectionModule : Module() {
  private var wakeReceiver: BroadcastReceiver? = null

  override fun definition() = ModuleDefinition {
    Name("T3BackgroundConnection")

    Events(WAKE_EVENT)

    Function("configure") { enabled: Boolean ->
      appContext.reactContext?.let { BackgroundConnectionState.configure(it, enabled) }
    }

    Function("wake") {
      appContext.reactContext?.let { BackgroundConnectionState.wake(it) }
    }

    OnStartObserving(WAKE_EVENT) {
      val context = appContext.reactContext ?: return@OnStartObserving
      if (wakeReceiver != null) return@OnStartObserving
      val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
          if (intent.action == BackgroundConnectionState.ACTION_WAKE) {
            sendEvent(
              WAKE_EVENT,
              mapOf("at" to (intent.getLongExtra(BackgroundConnectionState.EXTRA_WAKE_AT, 0L))),
            )
          }
        }
      }
      wakeReceiver = receiver
      ContextCompat.registerReceiver(
        context,
        receiver,
        IntentFilter(BackgroundConnectionState.ACTION_WAKE),
        ContextCompat.RECEIVER_NOT_EXPORTED,
      )
    }

    OnStopObserving(WAKE_EVENT) {
      val context = appContext.reactContext
      val receiver = wakeReceiver ?: return@OnStopObserving
      if (context != null) {
        try {
          context.unregisterReceiver(receiver)
        } catch (_: IllegalArgumentException) {
          // The React context can be torn down before the listener lifecycle.
        }
      }
      wakeReceiver = null
    }

    OnDestroy {
      val context = appContext.reactContext
      val receiver = wakeReceiver ?: return@OnDestroy
      if (context != null) {
        try {
          context.unregisterReceiver(receiver)
        } catch (_: IllegalArgumentException) {
          // Already unregistered during app-context teardown.
        }
      }
      wakeReceiver = null
    }
  }
}
