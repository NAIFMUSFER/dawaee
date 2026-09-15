package app.dawaee.exactalarm

import android.app.AlarmManager
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.util.Log
import expo.modules.notifications.notifications.interfaces.SchedulableNotificationTrigger
import expo.modules.notifications.service.delegates.ExpoSchedulingDelegate
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

/**
 * Lifecycle-managed exact-alarm grant recovery.
 *
 * Android broadcasts have a bounded execution window. The permission receiver
 * therefore only enqueues this job; potentially blocking schedule serialization
 * and Expo replay happen here, where Android can stop and reschedule the work.
 */
class ExactAlarmRecoveryJobService : JobService() {
  private val worker = AtomicReference<Thread?>(null)

  override fun onStartJob(params: JobParameters): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || !canScheduleExactAlarms(this)) return false

    lateinit var task: Thread
    task = thread(start = false, name = "dawaee-exact-alarm-recovery") {
      var reschedule = false
      try {
        NotificationScheduleMutationCoordinator.withInterruptibleLease {
          // The grant broadcast may be followed by a near-immediate revoke while
          // this job is queued behind a JavaScript mutation. Re-check at the
          // protected boundary before touching persisted notification state.
          if (!canScheduleExactAlarms(this)) return@withInterruptibleLease
          reschedule = shouldRescheduleAfterReplay(replayPersistedNotifications(applicationContext))
        }
      } catch (_: InterruptedException) {
        reschedule = true
        Thread.currentThread().interrupt()
      } catch (_: Exception) {
        // Never log notification request identifiers, content or exception text.
        Log.e(TAG, "Exact-alarm grant recovery failed")
        reschedule = runCatching { shouldRescheduleAfterReplay(false) }.getOrDefault(false)
      } finally {
        // onStopJob owns rescheduling after it clears/interupts the active task;
        // only a task that still owns this slot may report completion itself.
        if (worker.compareAndSet(task, null)) {
          jobFinished(params, reschedule)
        }
      }
    }

    worker.set(task)
    task.start()
    return true
  }

  override fun onStopJob(params: JobParameters): Boolean {
    worker.getAndSet(null)?.interrupt()
    return true
  }

  private fun replayPersistedNotifications(context: Context): Boolean {
    val delegate = ExpoSchedulingDelegate(context)
    var restoreFailed = false

    try {
      for (request in delegate.getAllScheduledNotifications()) {
        if (Thread.currentThread().isInterrupted) throw InterruptedException()
        try {
          val trigger = request.trigger
          if (trigger is SchedulableNotificationTrigger && trigger.nextTriggerDate() == null) {
            delegate.removeScheduledNotifications(listOf(request.identifier))
            continue
          }
          delegate.scheduleNotification(request)
        } catch (interrupted: InterruptedException) {
          throw interrupted
        } catch (_: Exception) {
          restoreFailed = true
        }
      }
    } catch (interrupted: InterruptedException) {
      throw interrupted
    } catch (_: Exception) {
      restoreFailed = true
    }

    if (restoreFailed) {
      Log.e(TAG, "Exact-alarm grant recovery failed")
    }
    return !restoreFailed
  }

  private fun shouldRescheduleAfterReplay(replaySucceeded: Boolean): Boolean {
    val preferences = getSharedPreferences(RETRY_PREFERENCES_NAME, Context.MODE_PRIVATE)
    if (replaySucceeded) {
      preferences.edit().remove(REPLAY_FAILURE_COUNT_KEY).apply()
      return false
    }

    val failureCount = preferences.getInt(REPLAY_FAILURE_COUNT_KEY, 0) + 1
    // Persist the counter before asking JobScheduler for another run. If durable
    // bookkeeping itself fails, stop retrying rather than create an unbounded loop.
    if (!preferences.edit().putInt(REPLAY_FAILURE_COUNT_KEY, failureCount).commit()) return false
    return failureCount < MAX_REPLAY_FAILURES
  }

  companion object {
    private const val TAG = "DawaeeExactAlarm"
    private const val JOB_ID = 0x0DAAEE
    private const val RETRY_PREFERENCES_NAME = "dawaee.exactalarm.recovery"
    private const val REPLAY_FAILURE_COUNT_KEY = "replay_failure_count"
    private const val MAX_REPLAY_FAILURES = 3

    fun schedule(context: Context): Boolean {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false
      val scheduler = context.getSystemService(JobScheduler::class.java) ?: return false
      val component = ComponentName(context, ExactAlarmRecoveryJobService::class.java)

      val expedited = JobInfo.Builder(JOB_ID, component)
        .setExpedited(true)
        .build()
      if (scheduler.schedule(expedited) == JobScheduler.RESULT_SUCCESS) return true

      // Expedited quota can be unavailable. A regular no-constraint job keeps
      // recovery durable instead of extending BroadcastReceiver lifetime.
      val fallback = JobInfo.Builder(JOB_ID, component).build()
      return scheduler.schedule(fallback) == JobScheduler.RESULT_SUCCESS
    }

    private fun canScheduleExactAlarms(context: Context): Boolean {
      val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return false
      return alarmManager.canScheduleExactAlarms()
    }
  }
}
