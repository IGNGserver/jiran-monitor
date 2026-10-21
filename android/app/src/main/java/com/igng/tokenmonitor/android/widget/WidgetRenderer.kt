package com.igng.tokenmonitor.android.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import android.view.View
import android.widget.RemoteViews
import com.igng.tokenmonitor.android.R
import com.igng.tokenmonitor.android.data.local.UserPreferences
import com.igng.tokenmonitor.android.ui.components.ClientIcons
import com.igng.tokenmonitor.android.ui.components.formatMoneyAmount
import java.time.LocalDate
import java.time.format.TextStyle
import java.util.Locale
import kotlin.math.max
import kotlin.math.roundToInt

private data class WidgetSize(val widthDp: Int, val heightDp: Int)

private data class RowIds(
  val row: Int,
  val icon: Int,
  val name: Int,
  val plan: Int,
  val bar: Int,
  val remaining: Int,
  val reset: Int
)

/**
 * Builds RemoteViews from the snapshot. No network, no ViewModel, no Compose:
 * a launcher may ask for four cards in one frame, and none of them is allowed to
 * depend on the app's foreground state.
 */
object WidgetRenderer {
  fun hasWidgets(context: Context): Boolean = WidgetRegistry.hasAnyWidgets(context)

  fun updateAll(context: Context) {
    val input = input(context)
    val manager = AppWidgetManager.getInstance(context)
    WidgetRegistry.specs.forEach { spec ->
      val ids = manager.getAppWidgetIds(WidgetRegistry.component(context, spec.kind))
      ids.forEach { id -> render(context, manager, id, spec.kind, input, refreshing = false) }
    }
  }

  fun updateWidget(context: Context, widgetId: Int) {
    val kind = WidgetRegistry.kindForWidget(context, widgetId) ?: return
    render(
      context,
      AppWidgetManager.getInstance(context),
      widgetId,
      kind,
      input(context),
      refreshing = false
    )
  }

  fun showRefreshing(context: Context, widgetId: Int) {
    val kind = WidgetRegistry.kindForWidget(context, widgetId) ?: return
    render(
      context,
      AppWidgetManager.getInstance(context),
      widgetId,
      kind,
      input(context),
      refreshing = true
    )
  }

  private data class RenderInput(
    val snapshot: WidgetSnapshot?,
    val preferences: UserPreferences,
    val widgetPreferences: WidgetPreferencesStore,
    val connected: Boolean
  )

  private fun input(context: Context): RenderInput {
    val entry = context.widgetEntryPoint()
    val connected = runCatching { entry.connection().read().isComplete }.getOrDefault(false)
    return RenderInput(
      snapshot = entry.snapshotStore().read(),
      preferences = entry.preferences().read(),
      widgetPreferences = entry.widgetPreferences(),
      connected = connected
    )
  }

  private fun render(
    context: Context,
    manager: AppWidgetManager,
    widgetId: Int,
    kind: WidgetKind,
    input: RenderInput,
    refreshing: Boolean
  ) {
    val size = sizeOf(manager, widgetId, kind)
    val layout = when (kind) {
      WidgetKind.Today -> WidgetSizing.today(size.widthDp)
      WidgetKind.Quota -> WidgetSizing.quota(size.widthDp)
      WidgetKind.Trend -> WidgetSizing.trend()
      WidgetKind.Dashboard -> WidgetSizing.dashboard()
    }
    val layoutRes = when (layout) {
      WidgetLayout.TodaySmall -> R.layout.widget_today_small
      WidgetLayout.TodayMedium -> R.layout.widget_today_medium
      WidgetLayout.QuotaSmall -> R.layout.widget_quota_small
      WidgetLayout.QuotaMedium -> R.layout.widget_quota_medium
      WidgetLayout.TrendMedium -> R.layout.widget_trend_medium
      WidgetLayout.Dashboard -> R.layout.widget_dashboard
    }
    val views = RemoteViews(context.packageName, layoutRes)
    val palette = WidgetPalettes.resolve(context, input.preferences)
    val bitmaps = WidgetBitmaps(context)
    val now = System.currentTimeMillis()
    val zone = java.time.ZoneId.systemDefault()

    applySurface(views, bitmaps, size, layout, palette)
    views.setOnClickPendingIntent(R.id.widget_root, WidgetIntents.open(context, kind, widgetId))

    val state = stateOf(input.snapshot, now, input.preferences.widgetRefreshMinutes, input.connected, zone)
    val stateLine = if (refreshing) {
      "正在刷新…"
    } else {
      stateLineOf(input, now, zone)
    }
    applyChrome(
      context = context,
      views = views,
      layout = layout,
      kind = kind,
      palette = palette,
      bitmaps = bitmaps,
      dotColor = if (refreshing) palette.brand else dotColor(state, palette),
      freshness = input.snapshot
        ?.takeIf { it.capturedAtMs > 0L }
        ?.let { WidgetCopy.age(now, it.capturedAtMs) }
        .orEmpty(),
      stateLine = stateLine,
      showStateLine = refreshing || state != WidgetDataState.Fresh,
      widgetId = widgetId
    )

    when (kind) {
      WidgetKind.Today -> renderToday(
        views, layout, size, input, palette, bitmaps, now, refreshing
      )
      WidgetKind.Quota -> renderQuota(
        views, layout, size, input, palette, bitmaps, now, refreshing, widgetId
      )
      WidgetKind.Trend -> renderTrend(
        context, views, layout, size, input, palette, bitmaps, now, refreshing, widgetId
      )
      WidgetKind.Dashboard -> renderDashboard(
        views, layout, size, input, palette, bitmaps, now, refreshing, widgetId
      )
    }
    manager.updateAppWidget(widgetId, views)
  }

  private fun applySurface(
    views: RemoteViews,
    bitmaps: WidgetBitmaps,
    size: WidgetSize,
    layout: WidgetLayout,
    palette: WidgetPalette
  ) {
    val (minW, minH) = when (layout) {
      WidgetLayout.TodaySmall -> 110 to 110
      WidgetLayout.TodayMedium -> 230 to 120
      WidgetLayout.QuotaSmall -> 110 to 110
      WidgetLayout.QuotaMedium -> 230 to 120
      WidgetLayout.TrendMedium -> 250 to 130
      WidgetLayout.Dashboard -> 250 to 240
    }
    val width = size.widthDp.coerceIn(minW, 600)
    val height = size.heightDp.coerceIn(minH, 600)
    // The rounded Canvas surface leaves its four corner pixels to the host. Paint
    // the root with the same top colour so an unclipped host sees the card, not
    // the wallpaper or a stale white preview background.
    views.setInt(R.id.widget_root, "setBackgroundColor", palette.surfaceTop)
    views.setImageViewBitmap(R.id.widget_surface, bitmaps.surface(width.toFloat(), height.toFloat(), palette))
  }

  private fun applyChrome(
    context: Context,
    views: RemoteViews,
    layout: WidgetLayout,
    kind: WidgetKind,
    palette: WidgetPalette,
    bitmaps: WidgetBitmaps,
    dotColor: Int,
    freshness: String,
    stateLine: String,
    showStateLine: Boolean,
    widgetId: Int
  ) {
    val brandSize = when (layout) {
      WidgetLayout.TodaySmall -> 13f
      WidgetLayout.TodayMedium, WidgetLayout.QuotaMedium, WidgetLayout.TrendMedium -> 14f
      WidgetLayout.QuotaSmall -> 12f
      WidgetLayout.Dashboard -> 16f
    }
    views.image(R.id.widget_brand_mark, bitmaps.mark(brandSize, palette))
    views.text(R.id.widget_eyebrow, eyebrow(kind, layout), palette.fg3)

    if (hasDot(layout)) {
      views.image(R.id.widget_status_dot, bitmaps.dot(5f, dotColor))
    }
    if (hasFreshness(layout)) {
      views.text(R.id.widget_freshness, freshness, palette.fg4, visible = freshness.isNotBlank())
    }
    if (hasRefresh(layout)) {
      views.image(R.id.widget_refresh, bitmaps.refresh(20f, palette.fg3))
      views.setOnClickPendingIntent(R.id.widget_refresh, WidgetIntents.refresh(context, widgetId))
    }
    if (hasStateLine(layout)) {
      val color = when {
        stateLine.startsWith("离线") || stateLine.contains("失败") -> palette.danger
        stateLine.contains("陈旧") || stateLine.startsWith("昨日") -> palette.warning
        else -> palette.fg4
      }
      views.text(R.id.widget_state_line, stateLine, color, visible = showStateLine || hasPersistentStateLine(layout))
    }
  }

  private fun renderToday(
    views: RemoteViews,
    layout: WidgetLayout,
    size: WidgetSize,
    input: RenderInput,
    palette: WidgetPalette,
    bitmaps: WidgetBitmaps,
    now: Long,
    refreshing: Boolean
  ) {
    val copy = WidgetCopy.today(
      snapshot = input.snapshot,
      nowMs = now,
      refreshMinutes = input.preferences.widgetRefreshMinutes,
      hideCost = input.preferences.widgetHideCost,
      connected = input.connected
    )
    views.text(R.id.today_tokens, copy.tokensText, palette.fg1)
    views.text(R.id.today_unit, "token", palette.fg4)
    views.text(R.id.today_cost, copy.costText, palette.brand)
    views.text(R.id.today_delta, copy.deltaText, palette.fg3, visible = copy.deltaText.isNotBlank())
    views.text(
      R.id.widget_state_line,
      if (refreshing) "正在刷新…" else copy.stateLine,
      stateLineColor(copy.state, palette),
      visible = refreshing || copy.state != WidgetDataState.Fresh
    )

    if (layout == WidgetLayout.TodaySmall) {
      val values = input.snapshot?.days.orEmpty().map { it.tokens.toDouble() }
      if (values.isNotEmpty() && values.any { it > 0.0 }) {
        val width = max(60, size.widthDp - 16)
        views.image(
          R.id.today_spark,
          bitmaps.chart(
            widthDp = width.toFloat(),
            heightDp = 18f,
            values = values,
            labels = emptyList(),
            activeIndex = values.lastIndex,
            palette = palette,
            showLabels = false
          )
        )
      } else {
        views.setViewVisibility(R.id.today_spark, View.GONE)
      }
      // The small card has no footer; when the snapshot is stale the delta line
      // gives way to the honest state line rather than showing two competing
      // "how old is this" signals.
      views.setViewVisibility(
        R.id.today_delta,
        if (copy.state == WidgetDataState.Fresh) View.VISIBLE else View.GONE
      )
    } else {
      views.text(R.id.today_exact, copy.exactTokensText, palette.fg4, visible = copy.exactTokensText.isNotBlank())
      views.setInt(R.id.today_divider, "setBackgroundColor", palette.hairline)
      val values = input.snapshot?.days.orEmpty().map { it.tokens.toDouble() }
      if (values.isNotEmpty() && values.any { it > 0.0 }) {
        views.image(
          R.id.today_chart,
          bitmaps.chart(
            widthDp = 100f,
            heightDp = 54f,
            values = values,
            labels = dayLabels(input.snapshot?.days.orEmpty()),
            activeIndex = values.lastIndex,
            palette = palette,
            showLabels = true
          )
        )
      } else {
        views.setViewVisibility(R.id.today_chart, View.GONE)
      }
      views.text(R.id.today_month, "本月 ${copy.monthText}", palette.fg4)
      views.text(R.id.today_all, "全部 ${copy.allTimeText}", palette.fg4)
      views.text(
        R.id.today_online,
        onlineText(input.snapshot),
        palette.fg4
      )
      views.setViewVisibility(
        R.id.today_footer,
        if (WidgetSizing.todayShowsFooter(size.heightDp) &&
          copy.hasData && copy.state == WidgetDataState.Fresh
        ) View.VISIBLE else View.GONE
      )
    }

    views.setCharSequence(
      R.id.widget_root,
      "setContentDescription",
      buildString {
        append("计然今日用量 ")
        append(copy.tokensText)
        append(" token")
        if (!input.preferences.widgetHideCost) {
          append("，费用 ")
          append(copy.costText)
        }
        append("，")
        append(copy.stateLine)
      }
    )
  }

  private fun renderQuota(
    views: RemoteViews,
    layout: WidgetLayout,
    size: WidgetSize,
    input: RenderInput,
    palette: WidgetPalette,
    bitmaps: WidgetBitmaps,
    now: Long,
    refreshing: Boolean,
    widgetId: Int
  ) {
    val selected = input.widgetPreferences.selectedAccountIds(widgetId)
    val copy = WidgetCopy.quota(
      snapshot = input.snapshot,
      nowMs = now,
      refreshMinutes = input.preferences.widgetRefreshMinutes,
      connected = input.connected,
      selectedIds = selected
    )
    val badgeText = if (layout == WidgetLayout.QuotaSmall) shortBadge(copy) else copy.badgeText
    val badgeWidth = if (layout == WidgetLayout.QuotaSmall) 58f else 84f
    val badgeHeight = if (layout == WidgetLayout.QuotaSmall) 16f else 17f
    views.image(
      R.id.quota_badge_bg,
      bitmaps.pill(badgeWidth, badgeHeight, palette.toneBackground(copy.badgeTone))
    )
    views.text(R.id.quota_badge, badgeText, palette.toneForeground(copy.badgeTone))

    if (layout == WidgetLayout.QuotaSmall) {
      val row = copy.mostUrgent
      val account = row?.let { model ->
        input.snapshot?.accounts?.firstOrNull { it.id == model.accountId }
      }
      val statusWord = row?.statusWord
      val fraction = if (statusWord == null) row?.fraction else null
      val ringColor = when (row?.severity) {
        WidgetSeverity.Danger -> palette.danger
        WidgetSeverity.Warning -> palette.warning
        else -> palette.brand
      }
      views.image(
        R.id.quota_ring,
        bitmaps.ring(42f, fraction, ringColor, palette.track)
      )
      val remaining = account?.remainingPercent
      val percent = when {
        row == null -> "—"
        statusWord != null -> shortStatus(statusWord)
        account?.isBalanceOnly == true -> "余额"
        remaining != null -> "${remaining.roundToInt().coerceIn(0, 100)}%"
        else -> "—"
      }
      views.text(R.id.quota_ring_text, percent, palette.severityColor(row?.severity ?: WidgetSeverity.Normal))
      val caption = if (account?.isBalanceOnly == true) {
        formatMoneyAmount(account?.balanceAmount, account?.balanceCurrency)
      } else {
        "剩余"
      }
      views.text(R.id.quota_ring_caption, caption, palette.fg4)
      views.text(
        R.id.quota_name,
        row?.providerName ?: if (input.connected) "等待额度数据" else "尚未连接 Hub",
        palette.fg1
      )
      views.text(R.id.quota_plan, row?.planLine.orEmpty(), palette.fg4)
      views.text(
        R.id.quota_reset,
        if (refreshing) {
          "正在刷新…"
        } else if (copy.state == WidgetDataState.Fresh && row != null) {
          row.resetText
        } else {
          copy.stateLine
        },
        stateLineColor(copy.state, palette)
      )
    } else {
      val rowCount = WidgetSizing.quotaRowCount(size.heightDp)
      val barWidth = max(70, size.widthDp - 115)
      quotaRowIds.forEachIndexed { index, ids ->
        val row = copy.rows.getOrNull(index)
        if (index >= rowCount || row == null) {
          views.setViewVisibility(ids.row, View.GONE)
        } else {
          applyQuotaRow(views, ids, row, palette, bitmaps, barWidth.toFloat())
        }
      }
      val syncLine = input.snapshot?.let {
        WidgetCopy.quotaSyncLine(it, now, java.time.ZoneId.systemDefault())
      }
      views.text(
        R.id.widget_state_line,
        if (refreshing) {
          "正在刷新…"
        } else if (copy.rows.isEmpty()) {
          "Hub 未上报额度"
        } else if (copy.state == WidgetDataState.Fresh && syncLine != null) {
          syncLine
        } else {
          copy.stateLine
        },
        stateLineColor(copy.state, palette)
      )
    }

    views.setCharSequence(
      R.id.widget_root,
      "setContentDescription",
      "计然额度，${copy.badgeText}，${copy.stateLine}"
    )
  }

  private fun renderTrend(
    context: Context,
    views: RemoteViews,
    layout: WidgetLayout,
    size: WidgetSize,
    input: RenderInput,
    palette: WidgetPalette,
    bitmaps: WidgetBitmaps,
    now: Long,
    refreshing: Boolean,
    widgetId: Int
  ) {
    val metric = input.widgetPreferences.trendMetric(widgetId)
    val copy = WidgetCopy.trend(
      snapshot = input.snapshot,
      nowMs = now,
      refreshMinutes = input.preferences.widgetRefreshMinutes,
      connected = input.connected,
      metric = metric
    )
    val tokensActive = metric == WidgetTrendMetric.Tokens
    if (tokensActive) {
      views.image(R.id.trend_tokens_bg, bitmaps.pill(37f, 18f, palette.brandTint))
      views.setViewVisibility(R.id.trend_cost_bg, View.GONE)
    } else {
      views.setViewVisibility(R.id.trend_tokens_bg, View.GONE)
      views.image(R.id.trend_cost_bg, bitmaps.pill(37f, 18f, palette.brandTint))
    }
    views.text(
      R.id.trend_tokens,
      "Token",
      if (tokensActive) palette.brandTintFg else palette.fg3
    )
    views.text(
      R.id.trend_cost,
      "费用",
      if (!tokensActive) palette.brandTintFg else palette.fg3
    )
    views.setOnClickPendingIntent(R.id.trend_tokens, WidgetIntents.toggleTrend(context, widgetId))
    views.setOnClickPendingIntent(R.id.trend_cost, WidgetIntents.toggleTrend(context, widgetId))

    views.text(R.id.trend_total, copy.totalText, palette.fg1)
    views.text(R.id.trend_total_caption, "7 日合计", palette.fg4)
    views.text(R.id.trend_average, copy.averageText, palette.fg2)
    views.text(
      R.id.trend_peak,
      copy.peakText.ifBlank { "暂无趋势数据" },
      palette.fg4
    )
    views.text(
      R.id.widget_state_line,
      if (refreshing) "正在刷新…" else copy.stateLine,
      stateLineColor(copy.state, palette)
    )

    val values = copy.points.map { it.value }
    if (values.isNotEmpty() && values.any { it > 0.0 }) {
      views.image(
        R.id.trend_chart,
        bitmaps.chart(
          widthDp = max(120, size.widthDp - 26).toFloat(),
          heightDp = 38f,
          values = values,
          labels = copy.points.map { it.label },
          activeIndex = values.lastIndex,
          palette = palette,
          showLabels = true
        )
      )
    } else {
      views.setViewVisibility(R.id.trend_chart, View.GONE)
    }

    views.setCharSequence(
      R.id.widget_root,
      "setContentDescription",
      "计然七日趋势，${copy.totalText}，${copy.stateLine}"
    )
  }

  private fun renderDashboard(
    views: RemoteViews,
    layout: WidgetLayout,
    size: WidgetSize,
    input: RenderInput,
    palette: WidgetPalette,
    bitmaps: WidgetBitmaps,
    now: Long,
    refreshing: Boolean,
    widgetId: Int
  ) {
    val metric = input.widgetPreferences.trendMetric(widgetId)
    val selected = input.widgetPreferences.selectedAccountIds(widgetId)
    val copy = WidgetCopy.dashboard(
      snapshot = input.snapshot,
      nowMs = now,
      refreshMinutes = input.preferences.widgetRefreshMinutes,
      hideCost = input.preferences.widgetHideCost,
      connected = input.connected,
      metric = metric,
      selectedIds = selected
    )
    views.text(R.id.dash_tokens, copy.today.tokensText, palette.fg1)
    views.text(R.id.dash_unit, "token", palette.fg4)
    views.text(R.id.dash_cost, copy.today.costText, palette.brand)
    views.text(R.id.dash_delta, copy.today.deltaText, palette.fg3, visible = copy.today.deltaText.isNotBlank())
    views.text(
      R.id.dash_month,
      if (copy.today.hasData) "本月 ${copy.today.monthText}" else "",
      palette.fg4
    )
    views.text(
      R.id.dash_all,
      if (copy.today.hasData) "全部 ${copy.today.allTimeText}" else "",
      palette.fg4
    )
    views.text(R.id.dash_online, copy.onlineText, palette.fg4)
    views.setInt(R.id.dash_divider, "setBackgroundColor", palette.hairline)
    views.text(
      R.id.widget_state_line,
      if (refreshing) "正在刷新…" else copy.today.stateLine,
      stateLineColor(copy.today.state, palette)
    )

    val values = copy.trend.points.map { it.value }
    val showTrend = WidgetSizing.dashboardShowsTrend(size.heightDp) &&
      values.isNotEmpty() && values.any { it > 0.0 }
    if (showTrend) {
      views.image(
        R.id.dash_chart,
        bitmaps.chart(
          widthDp = max(120, size.widthDp - 28).toFloat(),
          heightDp = 46f,
          values = values,
          labels = copy.trend.points.map { it.label },
          activeIndex = values.lastIndex,
          palette = palette,
          showLabels = true
        )
      )
    } else {
      views.setViewVisibility(R.id.dash_chart, View.GONE)
      views.setViewVisibility(R.id.dash_divider, View.GONE)
    }

    val rows = WidgetSizing.dashboardQuotaRows(size.heightDp).coerceAtMost(copy.quota.rows.size)
    if (rows <= 0) {
      views.setViewVisibility(R.id.dash_quota_block, View.GONE)
    } else {
      views.setViewVisibility(R.id.dash_quota_block, View.VISIBLE)
      val barWidth = max(70, size.widthDp - 119).toFloat()
      dashboardRowIds.forEachIndexed { index, ids ->
        val row = copy.quota.rows.getOrNull(index)
        if (index >= rows || row == null) {
          views.setViewVisibility(ids.row, View.GONE)
        } else {
          applyQuotaRow(views, ids, row, palette, bitmaps, barWidth)
        }
      }
    }

    views.setCharSequence(
      R.id.widget_root,
      "setContentDescription",
      "计然仪表盘，今日 ${copy.today.tokensText} token，${copy.quota.badgeText}，${copy.onlineText}"
    )
  }

  private fun applyQuotaRow(
    views: RemoteViews,
    ids: RowIds,
    row: QuotaRowModel,
    palette: WidgetPalette,
    bitmaps: WidgetBitmaps,
    barWidthDp: Float
  ) {
    views.setViewVisibility(ids.row, View.VISIBLE)
    val icon = providerIcon(row.provider)
    if (icon != 0) {
      views.setImageViewResource(ids.icon, icon)
    } else {
      views.image(ids.icon, bitmaps.monogram(16f, row.providerName, palette))
    }
    views.text(ids.name, row.providerName, palette.fg1)
    views.text(ids.plan, row.planLine, palette.fg4)
    // A status word means the percentage is no longer a fact: an expired key's
    // last number or a provider that is rate-limiting right now is not a gauge.
    val fraction = if (row.statusWord != null) null else row.fraction
    views.image(
      ids.bar,
      bitmaps.bar(barWidthDp, 3f, fraction, palette.severityColor(row.severity), palette.track)
    )
    views.text(ids.remaining, row.remainingText, palette.severityColor(row.severity))
    views.text(ids.reset, row.resetText, palette.fg4)
  }

  private fun stateOf(
    snapshot: WidgetSnapshot?,
    nowMs: Long,
    refreshMinutes: Int,
    connected: Boolean,
    zone: java.time.ZoneId
  ): WidgetDataState = when {
    !connected -> WidgetDataState.Unconfigured
    snapshot == null || !snapshot.hasData -> WidgetDataState.Empty
    else -> WidgetCopy.stateOf(snapshot, nowMs, refreshMinutes, zone)
  }

  private fun stateLineOf(
    input: RenderInput,
    nowMs: Long,
    zone: java.time.ZoneId
  ): String {
    val snapshot = input.snapshot
    if (snapshot == null || !snapshot.hasData) {
      return if (input.connected) "正在等待首次同步" else "尚未连接 Hub"
    }
    return WidgetCopy.stateLine(
      snapshot = snapshot,
      nowMs = nowMs,
      refreshMinutes = input.preferences.widgetRefreshMinutes,
      connected = input.connected,
      zone = zone
    )
  }

  private fun stateLineColor(state: WidgetDataState, palette: WidgetPalette): Int = when (state) {
    WidgetDataState.Offline -> palette.danger
    WidgetDataState.Stale -> palette.warning
    else -> palette.fg4
  }

  private fun dotColor(state: WidgetDataState, palette: WidgetPalette): Int = when (state) {
    WidgetDataState.Fresh -> palette.success
    WidgetDataState.Stale -> palette.warning
    WidgetDataState.Offline -> palette.danger
    WidgetDataState.Unconfigured -> palette.fg4
    WidgetDataState.Empty -> palette.fg3
  }

  private fun eyebrow(kind: WidgetKind, layout: WidgetLayout): String = when (kind) {
    WidgetKind.Today -> if (layout == WidgetLayout.TodaySmall) "今日" else "今日 · TODAY"
    WidgetKind.Quota -> if (layout == WidgetLayout.QuotaSmall) "额度" else "额度 · LIMITS"
    WidgetKind.Trend -> "趋势 · 7 日"
    WidgetKind.Dashboard -> "计然 · 仪表盘"
  }

  private fun hasDot(layout: WidgetLayout): Boolean = when (layout) {
    WidgetLayout.TodaySmall, WidgetLayout.TodayMedium, WidgetLayout.Dashboard -> true
    else -> false
  }

  private fun hasFreshness(layout: WidgetLayout): Boolean = when (layout) {
    WidgetLayout.TodaySmall, WidgetLayout.TodayMedium, WidgetLayout.Dashboard -> true
    else -> false
  }

  private fun hasRefresh(layout: WidgetLayout): Boolean = when (layout) {
    WidgetLayout.TodayMedium, WidgetLayout.QuotaMedium, WidgetLayout.TrendMedium, WidgetLayout.Dashboard -> true
    else -> false
  }

  private fun hasStateLine(layout: WidgetLayout): Boolean = when (layout) {
    WidgetLayout.QuotaSmall -> false
    else -> true
  }

  /** Trend / quota / dashboard always show "更新于…"; today shows it only when stale. */
  private fun hasPersistentStateLine(layout: WidgetLayout): Boolean = when (layout) {
    WidgetLayout.TrendMedium, WidgetLayout.QuotaMedium, WidgetLayout.Dashboard -> true
    else -> false
  }

  private fun shortBadge(copy: QuotaSummaryModel): String = when (copy.badgeTone) {
    WidgetTone.Danger -> "告急"
    WidgetTone.Warning -> "注意"
    WidgetTone.Success -> "正常"
    WidgetTone.Brand -> "额度"
    // Neutral covers waiting/unconfigured/no-accounts and rows that simply carry
    // no meter. Only the empty state may use the full badge words; once rows
    // exist, "无数据" is the short, honest form.
    WidgetTone.Neutral -> if (copy.rows.isEmpty()) copy.badgeText.take(4) else "无数据"
  }

  private fun shortStatus(status: String): String = when (status) {
    "凭证过期" -> "过期"
    "服务商限流" -> "限流"
    "获取失败" -> "失败"
    else -> status.take(3)
  }

  private fun onlineText(snapshot: WidgetSnapshot?): String = when {
    snapshot == null || snapshot.totalDevices == 0 -> "暂无设备"
    else -> "${snapshot.onlineDevices}/${snapshot.totalDevices} 台在线"
  }

  private fun dayLabels(days: List<WidgetDay>): List<String> = days.map { day ->
    runCatching {
      LocalDate.parse(day.date)
        .dayOfWeek
        .getDisplayName(TextStyle.NARROW, Locale.SIMPLIFIED_CHINESE)
    }.getOrDefault("")
  }

  private fun providerIcon(provider: String): Int = ClientIcons.drawable(
    when (provider) {
      "zaiteam" -> "zai"
      "anthropic" -> "claude"
      "openai" -> "codex"
      "google" -> "gemini"
      else -> provider
    }
  )

  private fun sizeOf(
    manager: AppWidgetManager,
    widgetId: Int,
    kind: WidgetKind
  ): WidgetSize {
    val options = manager.getAppWidgetOptions(widgetId)
    val width = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0)
    val height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0)
    return when (kind) {
      WidgetKind.Today -> WidgetSize(
        widthDp = width.takeIf { it > 0 } ?: 110,
        heightDp = height.takeIf { it > 0 } ?: 110
      )
      WidgetKind.Quota -> WidgetSize(
        widthDp = width.takeIf { it > 0 } ?: 110,
        heightDp = height.takeIf { it > 0 } ?: 110
      )
      WidgetKind.Trend -> WidgetSize(
        widthDp = width.takeIf { it > 0 } ?: 250,
        heightDp = height.takeIf { it > 0 } ?: 130
      )
      WidgetKind.Dashboard -> WidgetSize(
        widthDp = width.takeIf { it > 0 } ?: 250,
        heightDp = height.takeIf { it > 0 } ?: 300
      )
    }
  }

  private val quotaRowIds = arrayOf(
    RowIds(
      R.id.quota_row_1, R.id.quota_icon_1, R.id.quota_name_1,
      R.id.quota_plan_1, R.id.quota_bar_1, R.id.quota_remaining_1, R.id.quota_reset_1
    ),
    RowIds(
      R.id.quota_row_2, R.id.quota_icon_2, R.id.quota_name_2,
      R.id.quota_plan_2, R.id.quota_bar_2, R.id.quota_remaining_2, R.id.quota_reset_2
    ),
    RowIds(
      R.id.quota_row_3, R.id.quota_icon_3, R.id.quota_name_3,
      R.id.quota_plan_3, R.id.quota_bar_3, R.id.quota_remaining_3, R.id.quota_reset_3
    ),
    RowIds(
      R.id.quota_row_4, R.id.quota_icon_4, R.id.quota_name_4,
      R.id.quota_plan_4, R.id.quota_bar_4, R.id.quota_remaining_4, R.id.quota_reset_4
    )
  )

  private val dashboardRowIds = arrayOf(
    RowIds(
      R.id.dash_row_1, R.id.dash_icon_1, R.id.dash_name_1,
      R.id.dash_plan_1, R.id.dash_bar_1, R.id.dash_remaining_1, R.id.dash_reset_1
    ),
    RowIds(
      R.id.dash_row_2, R.id.dash_icon_2, R.id.dash_name_2,
      R.id.dash_plan_2, R.id.dash_bar_2, R.id.dash_remaining_2, R.id.dash_reset_2
    )
  )

  private fun RemoteViews.text(viewId: Int, value: String?, color: Int, visible: Boolean = true) {
    if (!visible || value.isNullOrEmpty()) {
      setViewVisibility(viewId, View.GONE)
      return
    }
    setViewVisibility(viewId, View.VISIBLE)
    setTextViewText(viewId, value)
    setInt(viewId, "setTextColor", color)
  }

  private fun RemoteViews.image(viewId: Int, bitmap: android.graphics.Bitmap, visible: Boolean = true) {
    if (!visible) {
      setViewVisibility(viewId, View.GONE)
      return
    }
    setViewVisibility(viewId, View.VISIBLE)
    setImageViewBitmap(viewId, bitmap)
  }
}
