package com.igng.tokenmonitor.android.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.os.Bundle

/**
 * Shared lifecycle for the four receiver classes.
 *
 * `onUpdate` is the launcher's "this card was just placed / the device booted"
 * signal, not our refresh cadence (all four providers set updatePeriodMillis=0).
 * It therefore renders the cached document immediately and asks WorkManager for
 * one fresh poll; a card never sits empty until the next half-hour tick.
 */
abstract class BaseWidgetProvider : AppWidgetProvider() {
  protected abstract val kind: WidgetKind

  override fun onUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray
  ) {
    runCatching { WidgetRenderer.updateAll(context) }
    WidgetRefreshScheduler.ensureScheduled(context)
    WidgetRefreshScheduler.refreshNow(context)
  }

  override fun onAppWidgetOptionsChanged(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetId: Int,
    newOptions: Bundle
  ) {
    runCatching { WidgetRenderer.updateWidget(context, appWidgetId) }
    WidgetRefreshScheduler.ensureScheduled(context)
  }

  override fun onDeleted(context: Context, appWidgetIds: IntArray) {
    val prefs = context.widgetEntryPoint().widgetPreferences()
    appWidgetIds.forEach(prefs::clear)
    if (WidgetRegistry.hasAnyWidgets(context)) {
      WidgetRefreshScheduler.ensureScheduled(context)
    } else {
      WidgetRefreshScheduler.cancel(context)
    }
  }

  override fun onEnabled(context: Context) {
    WidgetRefreshScheduler.ensureScheduled(context)
  }

  override fun onDisabled(context: Context) {
    if (!WidgetRegistry.hasAnyWidgets(context)) {
      WidgetRefreshScheduler.cancel(context)
    }
  }
}

class TodayWidgetProvider : BaseWidgetProvider() {
  override val kind: WidgetKind = WidgetKind.Today
}

class QuotaWidgetProvider : BaseWidgetProvider() {
  override val kind: WidgetKind = WidgetKind.Quota
}

class TrendWidgetProvider : BaseWidgetProvider() {
  override val kind: WidgetKind = WidgetKind.Trend
}

class DashboardWidgetProvider : BaseWidgetProvider() {
  override val kind: WidgetKind = WidgetKind.Dashboard
}
