package app.dawaee.exactalarm

import android.app.AlarmManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import expo.modules.notifications.notifications.interfaces.SchedulableNotificationTrigger
import expo.modules.notifications.service.delegates.ExpoSchedulingDelegate
import kotlin.concurrent.thread

/**
 * Restores Expo's persisted local-notification alarms when Android grants the
 * user-controlled exact-alarm access.
 *
 * Revocation stops the process and deletes its exact alarms, so a screen resume
 * listener cannot cover this lifecycle. Expo already persists each scheduled
 * request and uses the same scheduling delegate to restore it after reboot or
 * package replace; replaying that store here repairs the alarms without starting
 * JavaScript or reading Dawaee's encrypted clinical caches from a receiver.
 *
 * Do not use ExpoSchedulingDelegate.setupScheduledNotifications() here. In the
 * pinned Expo implementation its per-request failure path logs the notification
 * request identifier and exception stack. This receiver replays the same store
 * one request at a time and emits only one generic Dawaee failure message.
 * Expired schedulable requests are removed before Expo's scheduler sees them,
 * because its stale-request cleanup path also logs the request identifier.
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
        val delegate = ExpoSchedulingDelegate(context.applicationContext)
        var restoreFailed = false
        try {
          delegate.getAllScheduledNotifications().forEach { request ->
            try {
              val trigger = request.trigger
              if (trigger is SchedulableNotificationTrigger && trigger.nextTriggerDate() == null) {
                delegate.removeScheduledNotifications(listOf(request.identifier))
                return@forEach
              }
              delegate.scheduleNotification(request)
            } catch (_: Exception) {
              restoreFailed = true
            }
          }
        } catch (_: Exception) {
          restoreFailed = true
        }

        if (restoreFailed) {
          // Never log notification request identifiers, content, or exception text.
          Log.e(TAG, "Exact-alarm grant recovery failed")
        }
      } finally {
        pendingResult.finish()
      }
    }
  }

  private companion object {
    const val TAG = "DawaeeExactAlarm"
  }
}
