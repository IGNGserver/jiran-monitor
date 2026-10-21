package com.igng.tokenmonitor.android.widget

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.time.Duration
import java.time.ZonedDateTime
import java.util.concurrent.TimeUnit

/**
 * One periodic refresh for every placed widget, not one per instance.
 *
 * WorkManager is the scheduling authority (`updatePeriodMillis` is 0 in all
 * four appwidget infos): it survives reboot, coalesces across Doze, and honours
 * the 15-minute floor. A separate one-shot runs just after local midnight so a
 * card does not keep calling yesterday "today" until the next 30-minute tick.
 */
object WidgetRefreshScheduler {
  private const val PERIODIC_WORK = "jiran-widget-refresh-periodic"
  private const val NOW_WORK = "jiran-widget-refresh-now"
  private const val MIDNIGHT_WORK = "jiran-widget-refresh-midnight"

  fun ensureScheduled(context: Context) {
    if (!WidgetRegistry.hasAnyWidgets(context)) {
      cancel(context)
      return
    }
    val preferences = context.widgetEntryPoint().preferences().read()
    val request = PeriodicWorkRequestBuilder<WidgetRefreshWorker>(
      preferences.widgetRefreshMinutes.toLong(),
      TimeUnit.MINUTES
    )
      .setConstraints(networkConstraints())
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.MINUTES)
      .build()
    WorkManager.getInstance(context).enqueueUniquePeriodicWork(
      PERIODIC_WORK,
      ExistingPeriodicWorkPolicy.UPDATE,
      request
    )
    scheduleMidnight(context)
  }

  /**
   * Best-effort 00:05 refresh. WorkManager may defer it; the renderer also
   * downgrades a snapshot whose `capturedLocalDate` is not today to "昨日数据",
   * so a late run can never present old numbers as current.
   */
  fun scheduleMidnight(context: Context) {
    if (!WidgetRegistry.hasAnyWidgets(context)) return
    val now = ZonedDateTime.now()
    val next = now.toLocalDate().plusDays(1).atTime(0, 5).atZone(now.zone)
    val minutes = Duration.between(now, next).toMinutes().coerceIn(1L, 24L * 60L)
    val request = OneTimeWorkRequestBuilder<WidgetRefreshWorker>()
      .setInitialDelay(minutes, TimeUnit.MINUTES)
      .setConstraints(networkConstraints())
      .build()
    WorkManager.getInstance(context).enqueueUniqueWork(
      MIDNIGHT_WORK,
      ExistingWorkPolicy.REPLACE,
      request
    )
  }

  /** Manual refresh from a card's refresh glyph. */
  fun refreshNow(context: Context) {
    if (!WidgetRegistry.hasAnyWidgets(context)) return
    val request = OneTimeWorkRequestBuilder<WidgetRefreshWorker>()
      .setConstraints(networkConstraints())
      .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
      .build()
    WorkManager.getInstance(context).enqueueUniqueWork(
      NOW_WORK,
      ExistingWorkPolicy.REPLACE,
      request
    )
  }

  fun cancel(context: Context) {
    val manager = WorkManager.getInstance(context)
    manager.cancelUniqueWork(PERIODIC_WORK)
    manager.cancelUniqueWork(NOW_WORK)
    manager.cancelUniqueWork(MIDNIGHT_WORK)
  }

  private fun networkConstraints(): Constraints =
    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
}
