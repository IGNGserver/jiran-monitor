package com.igng.tokenmonitor.android.widget

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

enum class WidgetTrendMetric(val storageKey: String) {
  Tokens("tokens"),
  Cost("cost");

  companion object {
    fun fromStorage(value: String?): WidgetTrendMetric =
      entries.firstOrNull { it.storageKey == value } ?: Tokens
  }
}

/**
 * Per-widget-instance choices. Android gives every placed widget an appWidgetId,
 * so "this trend card shows cost" must not mutate the global forecast for every
 * other trend card on the launcher.
 *
 * Global preferences (refresh cadence, hide cost) live in [UserPreferencesStore]
 * because they apply to all four widget kinds.
 */
@Singleton
class WidgetPreferencesStore @Inject constructor(
  @ApplicationContext context: Context
) {
  private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  fun trendMetric(widgetId: Int): WidgetTrendMetric =
    WidgetTrendMetric.fromStorage(prefs.getString(KEY_TREND_METRIC + widgetId, null))

  fun setTrendMetric(widgetId: Int, metric: WidgetTrendMetric) {
    prefs.edit().putString(KEY_TREND_METRIC + widgetId, metric.storageKey).apply()
  }

  fun selectedAccountIds(widgetId: Int): Set<String> =
    prefs.getStringSet(KEY_ACCOUNTS + widgetId, emptySet()).orEmpty()

  fun setSelectedAccountIds(widgetId: Int, ids: Set<String>) {
    prefs.edit().putStringSet(KEY_ACCOUNTS + widgetId, ids).apply()
  }

  fun clear(widgetId: Int) {
    prefs.edit()
      .remove(KEY_TREND_METRIC + widgetId)
      .remove(KEY_ACCOUNTS + widgetId)
      .apply()
  }

  private companion object {
    const val PREFS_NAME = "jiran_widget_prefs"
    const val KEY_TREND_METRIC = "trend_metric_"
    const val KEY_ACCOUNTS = "selected_accounts_"
  }
}
