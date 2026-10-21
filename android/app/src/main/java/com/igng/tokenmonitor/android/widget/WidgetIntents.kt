package com.igng.tokenmonitor.android.widget

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import com.igng.tokenmonitor.android.MainActivity

/**
 * Every PendingIntent here is immutable and explicit. The widget's click target
 * is a route name, never a URL or a secret; the receiver that can spend the
 * owner key's network is not exported.
 */
object WidgetIntents {
  const val EXTRA_DESTINATION = "com.igng.tokenmonitor.android.extra.DESTINATION"
  const val EXTRA_WIDGET_ID = "com.igng.tokenmonitor.android.extra.WIDGET_ID"

  const val ACTION_REFRESH = "com.igng.tokenmonitor.android.widget.action.REFRESH"
  const val ACTION_TOGGLE_TREND = "com.igng.tokenmonitor.android.widget.action.TOGGLE_TREND"

  fun routeFor(kind: WidgetKind): String = when (kind) {
    WidgetKind.Today, WidgetKind.Dashboard -> "overview"
    WidgetKind.Quota -> "status"
    WidgetKind.Trend -> "analytics"
  }

  fun open(context: Context, kind: WidgetKind, widgetId: Int): PendingIntent {
    val intent = Intent(context, MainActivity::class.java).apply {
      putExtra(EXTRA_DESTINATION, routeFor(kind))
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or
        Intent.FLAG_ACTIVITY_CLEAR_TOP or
        Intent.FLAG_ACTIVITY_SINGLE_TOP
    }
    return PendingIntent.getActivity(
      context,
      requestCode(widgetId, 1),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  fun refresh(context: Context, widgetId: Int): PendingIntent =
    action(context, widgetId, ACTION_REFRESH, 2)

  fun toggleTrend(context: Context, widgetId: Int): PendingIntent =
    action(context, widgetId, ACTION_TOGGLE_TREND, 3)

  private fun action(context: Context, widgetId: Int, action: String, slot: Int): PendingIntent {
    val intent = Intent(context, WidgetActionReceiver::class.java).apply {
      this.action = action
      putExtra(EXTRA_WIDGET_ID, widgetId)
    }
    return PendingIntent.getBroadcast(
      context,
      requestCode(widgetId, slot),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun requestCode(widgetId: Int, slot: Int): Int =
    (widgetId.coerceIn(0, 100_000) * 8) + slot
}
