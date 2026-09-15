package app.dawaee.exactalarm

import java.util.concurrent.Semaphore

/**
 * Serializes Dawaee's JavaScript notification mutations with native exact-alarm
 * grant recovery. The recovery job and the JS bridge live in the same
 * application process, so one fair process-local permit prevents an older
 * persisted Expo snapshot from being replayed after a newer cancel/rebuild.
 *
 * A Semaphore is deliberate here: unlike a ReentrantLock, the permit may be
 * acquired on the Expo module's async worker and released after the JavaScript
 * operation completes on a different bridge thread. JobService recovery uses
 * the interruptible variant so Android can stop/reschedule background work
 * without leaving a worker blocked indefinitely on this gate.
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

  @Throws(InterruptedException::class)
  fun <T> withInterruptibleLease(block: () -> T): T {
    gate.acquire()
    return try {
      block()
    } finally {
      release()
    }
  }
}
