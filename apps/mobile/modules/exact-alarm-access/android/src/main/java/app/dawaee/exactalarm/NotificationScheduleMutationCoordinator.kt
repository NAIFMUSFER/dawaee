package app.dawaee.exactalarm

import java.util.concurrent.Semaphore

/**
 * Serializes Dawaee's JavaScript notification mutations with native exact-alarm
 * grant recovery. The receiver and the JS bridge live in the same application
 * process, so one fair process-local permit is sufficient to prevent an older
 * persisted Expo snapshot from being replayed after a newer cancel/rebuild.
 *
 * A Semaphore is deliberate here: unlike a ReentrantLock, the permit may be
 * acquired on the Expo module's async worker and released after the JavaScript
 * operation completes on a different bridge thread.
 */
internal object NotificationScheduleMutationCoordinator {
  private val gate = Semaphore(1, true)

  fun acquire() {
    gate.acquireUninterruptibly()
  }

  fun release() {
    gate.release()
  }

  fun <T> withLease(block: () -> T): T {
    acquire()
    return try {
      block()
    } finally {
      release()
    }
  }
}
