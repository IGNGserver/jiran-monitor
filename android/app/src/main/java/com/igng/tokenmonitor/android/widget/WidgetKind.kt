package com.igng.tokenmonitor.android.widget

enum class WidgetKind {
  Today,
  Quota,
  Trend,
  Dashboard
}

enum class WidgetLayout {
  TodaySmall,
  TodayMedium,
  QuotaSmall,
  QuotaMedium,
  TrendMedium,
  Dashboard
}

/**
 * Launcher cells are not pixels: a 2×2 card on a 5-column phone can be 110 dp,
 * while the same 2×2 on a tablet is 190 dp. Every breakpoint here is measured
 * from `AppWidgetManager.getAppWidgetOptions`, not from the device's screen
 * width, so a resized widget gets the layout that actually fits it.
 */
object WidgetSizing {
  const val MEDIUM_MIN_WIDTH_DP = 210

  fun today(widthDp: Int): WidgetLayout =
    if (widthDp >= MEDIUM_MIN_WIDTH_DP) WidgetLayout.TodayMedium else WidgetLayout.TodaySmall

  fun quota(widthDp: Int): WidgetLayout =
    if (widthDp >= MEDIUM_MIN_WIDTH_DP) WidgetLayout.QuotaMedium else WidgetLayout.QuotaSmall

  fun trend(): WidgetLayout = WidgetLayout.TrendMedium

  fun dashboard(): WidgetLayout = WidgetLayout.Dashboard

  /** Four rows need a 4×3 card; a 4×2 shows two, which is the honest maximum. */
  fun quotaRowCount(heightDp: Int): Int = when {
    heightDp < 150 -> 2
    heightDp < 210 -> 3
    else -> 4
  }

  /**
   * The dashboard is designed at 4×4. If a launcher lets the card shrink to
   * 4×3 we keep the today hero and the chart, and drop the quota rows rather
   * than squeezing three line-heights into pixels that do not exist.
   */
  fun dashboardQuotaRows(heightDp: Int): Int = if (heightDp >= 230) 2 else 0

  fun dashboardShowsTrend(heightDp: Int): Boolean = heightDp >= 200

  fun todayShowsFooter(heightDp: Int): Boolean = heightDp >= 128
}
