package com.igng.tokenmonitor.android.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import com.igng.tokenmonitor.android.R

data class WidgetSpec(
  val kind: WidgetKind,
  val provider: Class<out AppWidgetProvider>,
  val labelRes: Int
)

/**
 * The single place that knows which receiver owns which kind. The config
 * activity and the refresh scheduler both work from provider components, so a
 * widget id has exactly one kind without a separate id→kind table to drift.
 */
object WidgetRegistry {
  val specs: List<WidgetSpec> = listOf(
    WidgetSpec(WidgetKind.Today, TodayWidgetProvider::class.java, R.string.widget_today_label),
    WidgetSpec(WidgetKind.Quota, QuotaWidgetProvider::class.java, R.string.widget_quota_label),
    WidgetSpec(WidgetKind.Trend, TrendWidgetProvider::class.java, R.string.widget_trend_label),
    WidgetSpec(WidgetKind.Dashboard, DashboardWidgetProvider::class.java, R.string.widget_dashboard_label)
  )

  fun component(context: Context, kind: WidgetKind): ComponentName {
    val spec = specs.first { it.kind == kind }
    return ComponentName(context, spec.provider)
  }

  fun kindOf(providerClassName: String?): WidgetKind? =
    specs.firstOrNull { it.provider.name == providerClassName }?.kind

  fun kindForWidget(context: Context, widgetId: Int): WidgetKind? {
    val manager = AppWidgetManager.getInstance(context)
    return kindOf(manager.getAppWidgetInfo(widgetId)?.provider?.className)
  }

  fun hasAnyWidgets(context: Context): Boolean {
    val manager = AppWidgetManager.getInstance(context)
    return specs.any { spec ->
      manager.getAppWidgetIds(ComponentName(context, spec.provider)).isNotEmpty()
    }
  }

  fun allWidgetIds(context: Context): List<Int> {
    val manager = AppWidgetManager.getInstance(context)
    return specs.flatMap { spec ->
      manager.getAppWidgetIds(ComponentName(context, spec.provider)).toList()
    }
  }
}
