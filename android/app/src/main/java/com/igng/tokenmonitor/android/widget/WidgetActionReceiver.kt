package com.igng.tokenmonitor.android.widget

import android.appwidget.AppWidgetManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * The only interactive surface a widget has. The refresh and metric actions are
 * non-exported: they can only be triggered through the immutable PendingIntents
 * the renderer puts on a view, not by another installed app.
 */
class WidgetActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val widgetId = intent.getIntExtra(
      WidgetIntents.EXTRA_WIDGET_ID,
      AppWidgetManager.INVALID_APPWIDGET_ID
    )
    if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return
    when (intent.action) {
      WidgetIntents.ACTION_REFRESH -> {
        runCatching { WidgetRenderer.showRefreshing(context, widgetId) }
        WidgetRefreshScheduler.refreshNow(context)
      }
      WidgetIntents.ACTION_TOGGLE_TREND -> {
        val store = context.widgetEntryPoint().widgetPreferences()
        val next = when (store.trendMetric(widgetId)) {
          WidgetTrendMetric.Tokens -> WidgetTrendMetric.Cost
          WidgetTrendMetric.Cost -> WidgetTrendMetric.Tokens
        }
        store.setTrendMetric(widgetId, next)
        runCatching { WidgetRenderer.updateWidget(context, widgetId) }
      }
    }
  }
}
