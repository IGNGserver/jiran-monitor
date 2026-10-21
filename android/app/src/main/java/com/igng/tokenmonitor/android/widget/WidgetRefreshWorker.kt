package com.igng.tokenmonitor.android.widget

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

class WidgetRefreshWorker(
  appContext: Context,
  params: WorkerParameters
) : CoroutineWorker(appContext, params) {
  override suspend fun doWork(): Result {
    if (!WidgetRegistry.hasAnyWidgets(applicationContext)) {
      WidgetRefreshScheduler.cancel(applicationContext)
      return Result.success()
    }
    val outcome = runCatching {
      applicationContext.widgetEntryPoint().updater().refreshFromNetwork()
    }.getOrElse {
      return Result.retry()
    }
    WidgetRefreshScheduler.scheduleMidnight(applicationContext)
    return if (!outcome.ok && outcome.retry && runAttemptCount < 2) {
      Result.retry()
    } else {
      Result.success()
    }
  }
}

data class WidgetRefreshOutcome(val ok: Boolean, val retry: Boolean)
