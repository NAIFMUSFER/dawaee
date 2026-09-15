package app.dawaee.exactalarm

import android.app.AlarmManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * Enqueues recovery of Expo's persisted local-notification alarms when Android
 * grants the user-controlled exact-alarm access.
 *
 * Revocation stops the process and deletes its exact alarms, so a screen resume
 * listener cannot cover this lifecycle. The broadcast itself must remain short:
 * schedule serialization can legitimately wait behind an in-flight JavaScript
 * cancel/rebuild, therefore replay runs in ExactAlarmRecoveryJobService instead
 * of holding BroadcastReceiver execution open with goAsync() and a raw thread.
 */
class ExactAlarmPermissionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    if (intent?.action != AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED) return
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return

    val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
    if (!alarmManager.canScheduleExactAlarms()) return

    if (!ExactAlarmRecoveryJobService.schedule(context.applicationContext)) {
      // Never log notification identifiers, content, provider data or exception text.
      Log.e(TAG, "Exact-alarm grant recovery could not be scheduled")
    }
  }

  private companion object {
    const val TAG = "DawaeeExactAlarm"
  }
}
