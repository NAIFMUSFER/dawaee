package app.dawaee.exactalarm

import android.app.AlarmManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import expo.modules.notifications.service.delegates.ExpoSchedulingDelegate
import kotlin.concurrent.thread

/**
 * Restores Expo's persisted local-notification alarms when Android grants the
 * user-controlled exact-alarm access.
 *
 * Revocation stops the process and deletes its exact alarms, so a screen resume
 * listener cannot cover this lifecycle. Expo already persists each scheduled
 * request and uses the same delegate to restore it after reboot/package replace;
 * replaying that store here repairs the alarms without starting JavaScript or
 * reading Dawaee's encrypted clinical caches from a broadcast receiver.
 */
class ExactAlarmPermissionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    if (intent?.action != AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED) return
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return

    val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
    if (!alarmManager.canScheduleExactAlarms()) return

    val pendingResult = goAsync()
    thread(name = "dawaee-exact-alarm-recovery") {
      try {
        ExpoSchedulingDelegate(context.applicationContext).setupScheduledNotifications()
      } catch (_: Exception) {
        // Do not attach request identifiers or notification content to logs.
        Log.e(TAG, "Exact-alarm grant recovery failed")
      } finally {
        pendingResult.finish()
      }
    }
  }

  private companion object {
    const val TAG = "DawaeeExactAlarm"
  }
}
