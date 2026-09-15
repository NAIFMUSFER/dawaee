package app.dawaee.exactalarm

import android.app.AlarmManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ExactAlarmAccessModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DawaeeExactAlarmAccess")

    Function("canScheduleExactAlarms") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
        return@Function true
      }

      val context = requireNotNull(appContext.reactContext)
      val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      alarmManager.canScheduleExactAlarms()
    }

    Function("openExactAlarmSettings") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
        return@Function false
      }

      val context = requireNotNull(appContext.reactContext)
      val packageUri = Uri.parse("package:${context.packageName}")
      val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, packageUri).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }

      try {
        context.startActivity(intent)
        true
      } catch (_: ActivityNotFoundException) {
        return@Function openApplicationSettings(context, packageUri)
      } catch (_: SecurityException) {
        return@Function openApplicationSettings(context, packageUri)
      }
    }

    AsyncFunction("acquireNotificationScheduleMutation") {
      NotificationScheduleMutationCoordinator.acquire()
    }

    Function("releaseNotificationScheduleMutation") {
      NotificationScheduleMutationCoordinator.release()
    }
  }

  private fun openApplicationSettings(context: Context, packageUri: Uri): Boolean {
    val fallback = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    return runCatching {
      context.startActivity(fallback)
      true
    }.getOrDefault(false)
  }
}
