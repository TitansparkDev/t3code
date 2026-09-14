package expo.modules.t3backgroundconnection

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BackgroundConnectionBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      Intent.ACTION_BOOT_COMPLETED,
      Intent.ACTION_LOCKED_BOOT_COMPLETED,
      Intent.ACTION_MY_PACKAGE_REPLACED,
      -> BackgroundConnectionState.startFromSystem(context)
    }
  }
}
