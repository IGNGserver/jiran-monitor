package com.igng.tokenmonitor.android.widget

import com.igng.tokenmonitor.android.ui.components.formatMoney
import com.igng.tokenmonitor.android.ui.components.formatMoneyAmount
import com.igng.tokenmonitor.android.ui.components.formatTokensShort
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt

enum class WidgetDataState { Fresh, Stale, Offline, Unconfigured, Empty }

enum class WidgetSeverity { Normal, Warning, Danger }

enum class WidgetTone { Neutral, Brand, Success, Warning, Danger }

data class QuotaRowModel(
  val accountId: String,
  val provider: String,
  val providerName: String,
  val planLine: String,
  val remainingText: String,
  val resetText: String,
  val fraction: Double?,
  val severity: WidgetSeverity,
  val statusWord: String?
)

data class QuotaSummaryModel(
  val rows: List<QuotaRowModel>,
  val badgeText: String,
  val badgeTone: WidgetTone,
  val stateLine: String,
  val state: WidgetDataState,
  val mostUrgent: QuotaRowModel?
)

data class TodayCopy(
  val tokensText: String,
  val exactTokensText: String,
  val costText: String,
  val deltaText: String,
  val monthText: String,
  val allTimeText: String,
  val freshness: String,
  val stateLine: String,
  val state: WidgetDataState,
  val hasData: Boolean
)

data class TrendPoint(val label: String, val value: Double, val date: String)

data class TrendCopy(
  val points: List<TrendPoint>,
  val totalText: String,
  val averageText: String,
  val peakText: String,
  val stateLine: String,
  val state: WidgetDataState,
  val metric: WidgetTrendMetric
)

data class DashboardCopy(
  val today: TodayCopy,
  val trend: TrendCopy,
  val quota: QuotaSummaryModel,
  val onlineText: String
)

/**
 * Widget copy and small numeric decisions, deliberately free of Android types.
 *
 * Keeping these out of the renderer means the JVM suite can pin the things that
 * silently go wrong in a widget: a "today" snapshot captured yesterday, a quota
 * percentage that came from an expired credential, a delta against an empty
 * yesterday, and a currency with no rate.
 */
object WidgetCopy {
  private val timeFormat = DateTimeFormatter.ofPattern("HH:mm", Locale.getDefault())
  private val monthDayFormat = DateTimeFormatter.ofPattern("M月d日", Locale.SIMPLIFIED_CHINESE)

  private val providerNames = mapOf(
    "claude" to "Claude",
    "codex" to "Codex",
    "cursor" to "Cursor",
    "antigravity" to "Antigravity",
    "opencode" to "OpenCode",
    "deepseek" to "DeepSeek",
    "minimax" to "MiniMax",
    "mimo" to "MiMo",
    "grok" to "Grok",
    "copilot" to "Copilot",
    "kiro" to "Kiro",
    "zai" to "Z.ai",
    "zaiteam" to "Z.ai Team",
    "volcengine" to "Volcengine",
    "qoder" to "Qoder",
    "openrouter" to "OpenRouter",
    "kimi" to "Kimi",
    "ollama" to "Ollama"
  )

  fun providerName(provider: String): String =
    providerNames[provider.lowercase(Locale.US)] ?: provider.replaceFirstChar {
      if (it.isLowerCase()) it.titlecase(Locale.getDefault()) else it.toString()
    }

  private fun windowKindLabel(kind: String): String = when (kind.lowercase(Locale.US)) {
    "session" -> "会话"
    "weekly" -> "每周"
    "billing" -> "账期"
    "named" -> "额度"
    "credits" -> "积分"
    else -> kind
  }

  fun today(
    snapshot: WidgetSnapshot?,
    nowMs: Long,
    refreshMinutes: Int,
    hideCost: Boolean,
    connected: Boolean,
    zone: ZoneId = ZoneId.systemDefault()
  ): TodayCopy {
    if (snapshot == null || !snapshot.hasData) {
      return TodayCopy(
        tokensText = "—",
        exactTokensText = "",
        costText = if (hideCost) "••••" else "—",
        deltaText = "",
        monthText = "",
        allTimeText = "",
        freshness = "",
        stateLine = if (connected) "正在等待首次同步" else "尚未连接 Hub",
        state = if (connected) WidgetDataState.Empty else WidgetDataState.Unconfigured,
        hasData = false
      )
    }
    val state = if (!connected) WidgetDataState.Unconfigured
    else stateOf(snapshot, nowMs, refreshMinutes, zone)
    val today = snapshot.today
    val cost = if (hideCost) "••••" else formatMoney(
      today.costUsd,
      snapshot.currency,
      snapshot.rate
    )
    return TodayCopy(
      tokensText = estimatedValue(formatTokensShort(today.tokens), today.estimated),
      exactTokensText = estimatedValue(formatThousands(today.tokens), today.estimated),
      costText = cost,
      deltaText = deltaText(today, snapshot.yesterday),
      monthText = estimatedValue(formatTokensShort(snapshot.month.tokens), snapshot.month.estimated),
      allTimeText = estimatedValue(formatTokensShort(snapshot.allTime.tokens), snapshot.allTime.estimated),
      freshness = age(nowMs, snapshot.capturedAtMs),
      stateLine = stateLine(snapshot, nowMs, refreshMinutes, connected, zone),
      state = state,
      hasData = true
    )
  }

  fun quota(
    snapshot: WidgetSnapshot?,
    nowMs: Long,
    refreshMinutes: Int,
    connected: Boolean,
    zone: ZoneId = ZoneId.systemDefault(),
    selectedIds: Set<String>? = null
  ): QuotaSummaryModel {
    if (snapshot == null || !snapshot.hasData) {
      return QuotaSummaryModel(
        rows = emptyList(),
        badgeText = if (connected) "等待同步" else "未连接",
        badgeTone = WidgetTone.Neutral,
        stateLine = if (connected) "正在等待首次同步" else "尚未连接 Hub",
        state = if (connected) WidgetDataState.Empty else WidgetDataState.Unconfigured,
        mostUrgent = null
      )
    }
    val filtered = if (selectedIds.isNullOrEmpty()) {
      snapshot.accounts
    } else {
      val picked = snapshot.accounts.filter { it.id in selectedIds }
      // A selected account that the Hub no longer reports must not leave the
      // widget blank; fall back to the urgency order the document already has.
      picked.ifEmpty { snapshot.accounts }
    }
    val ordered = WidgetQuotaOrdering.sorted(filtered)
    val rows = ordered.map { row(it, nowMs, zone) }
    val unauthorized = ordered.count { it.isUnauthorized }
    val fetchErrors = ordered.count { it.isFetchError }
    val low = ordered.count {
      it.remainingPercent != null && it.remainingPercent <= 25.0
    }
    val unknown = ordered.count {
      it.remainingPercent == null && !it.isBalanceOnly && !it.isUnauthorized && !it.isFetchError
    }
    val (badge, tone) = when {
      ordered.isEmpty() -> "无额度" to WidgetTone.Neutral
      unauthorized > 0 -> "$unauthorized 个凭证过期" to WidgetTone.Danger
      fetchErrors > 0 -> "$fetchErrors 个获取异常" to WidgetTone.Warning
      low > 0 -> "$low 项告急" to WidgetTone.Warning
      unknown > 0 -> "$unknown 项无数据" to WidgetTone.Neutral
      else -> "额度正常" to WidgetTone.Success
    }
    return QuotaSummaryModel(
      rows = rows,
      badgeText = badge,
      badgeTone = tone,
      stateLine = stateLine(snapshot, nowMs, refreshMinutes, connected, zone),
      state = if (!connected) WidgetDataState.Unconfigured
      else stateOf(snapshot, nowMs, refreshMinutes, zone),
      mostUrgent = rows.firstOrNull()
    )
  }

  fun trend(
    snapshot: WidgetSnapshot?,
    nowMs: Long,
    refreshMinutes: Int,
    connected: Boolean,
    metric: WidgetTrendMetric,
    zone: ZoneId = ZoneId.systemDefault()
  ): TrendCopy {
    if (snapshot == null || !snapshot.hasData) {
      return TrendCopy(
        points = emptyList(),
        totalText = "—",
        averageText = "—",
        peakText = "",
        stateLine = if (connected) "正在等待首次同步" else "尚未连接 Hub",
        state = if (connected) WidgetDataState.Empty else WidgetDataState.Unconfigured,
        metric = metric
      )
    }
    val days = snapshot.days
    val values = days.map { if (metric == WidgetTrendMetric.Cost) it.costUsd else it.tokens.toDouble() }
    val total = values.sum()
    val peakIndex = values.indices.maxByOrNull { values[it] }
    val peak = peakIndex?.let { values[it] } ?: 0.0
    val totalText = if (metric == WidgetTrendMetric.Cost) {
      formatMoney(total, snapshot.currency, snapshot.rate, compact = total >= 1000)
    } else {
      // HistoryDayDto carries no day-level estimate flag; a "~" here would be a
      // provenance claim the document cannot support.
      formatTokensShort(total.toLong())
    }
    val average = if (values.isEmpty()) 0.0 else total / values.size
    val averageText = if (metric == WidgetTrendMetric.Cost) {
      formatMoney(average, snapshot.currency, snapshot.rate, compact = true)
    } else {
      formatTokensShort(average.roundToInt().toLong())
    }
    val peakText = if (peakIndex == null || peak <= 0.0 || days.isEmpty()) {
      ""
    } else {
      val day = runCatching { LocalDate.parse(days[peakIndex].date) }.getOrNull()
      val label = day?.dayOfWeek?.getDisplayName(java.time.format.TextStyle.SHORT, Locale.SIMPLIFIED_CHINESE)
      val value = if (metric == WidgetTrendMetric.Cost) {
        formatMoney(peak, snapshot.currency, snapshot.rate, compact = true)
      } else {
        formatTokensShort(peak.roundToInt().toLong())
      }
      "峰值 $value" + if (label != null) " · $label" else ""
    }
    return TrendCopy(
      points = days.mapIndexed { index, day ->
        TrendPoint(
          label = runCatching { LocalDate.parse(day.date) }.getOrNull()
            ?.dayOfWeek
            ?.getDisplayName(java.time.format.TextStyle.NARROW, Locale.SIMPLIFIED_CHINESE)
            .orEmpty(),
          value = values.getOrElse(index) { 0.0 },
          date = day.date
        )
      },
      totalText = totalText,
      averageText = averageText,
      peakText = peakText,
      stateLine = stateLine(snapshot, nowMs, refreshMinutes, connected, zone),
      state = if (!connected) WidgetDataState.Unconfigured
      else stateOf(snapshot, nowMs, refreshMinutes, zone),
      metric = metric
    )
  }

  fun dashboard(
    snapshot: WidgetSnapshot?,
    nowMs: Long,
    refreshMinutes: Int,
    hideCost: Boolean,
    connected: Boolean,
    metric: WidgetTrendMetric,
    selectedIds: Set<String>? = null,
    zone: ZoneId = ZoneId.systemDefault()
  ): DashboardCopy = DashboardCopy(
    today = today(snapshot, nowMs, refreshMinutes, hideCost, connected, zone),
    trend = trend(snapshot, nowMs, refreshMinutes, connected, metric, zone),
    quota = quota(snapshot, nowMs, refreshMinutes, connected, zone, selectedIds),
    onlineText = when {
      snapshot == null || snapshot.totalDevices == 0 -> "暂无设备"
      else -> "${snapshot.onlineDevices}/${snapshot.totalDevices} 台在线"
    }
  )

  fun row(account: WidgetQuotaAccount, nowMs: Long, zone: ZoneId): QuotaRowModel {
    val severity = when {
      account.isUnauthorized || (account.remainingPercent ?: 100.0) <= 10.0 -> WidgetSeverity.Danger
      account.isFetchError || (account.remainingPercent ?: 100.0) <= 25.0 -> WidgetSeverity.Warning
      else -> WidgetSeverity.Normal
    }
    val statusWord = when {
      account.isUnauthorized -> "凭证过期"
      account.status?.trim()?.lowercase(Locale.US) in setOf("ratelimited", "sourceratelimited") -> "服务商限流"
      account.isFetchError -> "获取失败"
      else -> null
    }
    val remainingText = statusWord ?: when {
      account.remainingPercent != null -> "剩余 ${percent(account.remainingPercent)}"
      account.isBalanceOnly -> "余额 ${formatMoneyAmount(account.balanceAmount, account.balanceCurrency)}"
      else -> "无额度数据"
    }
    val window = account.windowLabel?.takeIf { it.isNotBlank() }
      ?: account.windowKind?.let(::windowKindLabel)
    val plan = buildList {
      account.accountLabel?.takeIf { it.isNotBlank() }?.let(::add)
      account.planLabel?.takeIf { it.isNotBlank() }?.let(::add)
      window?.takeIf { it.isNotBlank() }?.let(::add)
    }.joinToString(" · ").ifBlank { "额度账号" }
    return QuotaRowModel(
      accountId = account.id,
      provider = account.provider,
      providerName = providerName(account.provider),
      planLine = plan,
      remainingText = remainingText,
      resetText = resetText(account, nowMs, zone),
      fraction = account.remainingPercent?.div(100.0)?.coerceIn(0.0, 1.0),
      severity = severity,
      statusWord = statusWord
    )
  }

  fun stateOf(
    snapshot: WidgetSnapshot,
    nowMs: Long,
    refreshMinutes: Int,
    zone: ZoneId
  ): WidgetDataState {
    // A failed latest attempt is offline even if a good document is on screen:
    // the numbers are still readable, but the connection is not healthy.
    if (snapshot.lastError != null) return WidgetDataState.Offline
    val ageMs = nowMs - snapshot.capturedAtMs
    val staleAfter = refreshMinutes.coerceAtLeast(15) * 60_000L * 2
    if (ageMs > staleAfter) return WidgetDataState.Stale
    val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate().toString()
    return if (snapshot.capturedLocalDate.isNotBlank() && snapshot.capturedLocalDate != today) {
      WidgetDataState.Stale
    } else {
      WidgetDataState.Fresh
    }
  }

  fun stateLine(
    snapshot: WidgetSnapshot,
    nowMs: Long,
    refreshMinutes: Int,
    connected: Boolean,
    zone: ZoneId
  ): String {
    if (!connected) return "尚未连接 Hub"
    if (snapshot.lastError != null) {
      val hasData = snapshot.capturedAtMs > 0L
      val suffix = if (hasData) " · 上次更新 ${age(nowMs, snapshot.capturedAtMs)}" else ""
      return when (snapshot.lastErrorKind) {
        "NotConfigured" -> "尚未连接 Hub"
        "Unauthorized" -> "密钥无效 · 打开应用检查"
        "Network" -> if (hasData) "离线$suffix" else "连接失败 · 点按重试"
        else -> if (hasData) "连接异常$suffix" else "连接异常 · 点按重试"
      }
    }
    return when {
      snapshot.capturedLocalDate.isNotBlank() &&
        snapshot.capturedLocalDate != Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate().toString() ->
        "昨日数据 · 更新于 ${age(nowMs, snapshot.capturedAtMs)}"
      stateOf(snapshot, nowMs, refreshMinutes, zone) == WidgetDataState.Stale ->
        "数据陈旧 · 更新于 ${age(nowMs, snapshot.capturedAtMs)}"
      else -> "更新于 ${age(nowMs, snapshot.capturedAtMs)}"
    }
  }

  fun deltaText(today: WidgetPeriodTotals, yesterday: WidgetPeriodTotals?): String {
    val previous = yesterday?.tokens ?: 0L
    if (previous <= 0L) return "昨日无数据"
    val delta = (today.tokens - previous).toDouble() / previous * 100.0
    if (abs(delta) < 0.05) return "持平"
    val arrow = if (delta > 0) "↑" else "↓"
    val value = if (abs(delta) < 10) {
      String.format(Locale.US, "%.1f%%", abs(delta))
    } else {
      String.format(Locale.US, "%.0f%%", abs(delta))
    }
    return "$arrow $value 较昨日"
  }

  /**
   * Quota is Hub-owned and refreshes on its own cadence; the snapshot capture time
   * is not the same fact as the quota's `updatedAt`. When the Hub supplied it,
   * say so instead of implying the percentages were measured just now.
   */
  fun quotaSyncLine(snapshot: WidgetSnapshot, nowMs: Long, zone: ZoneId): String? {
    val raw = snapshot.limitsUpdatedAt?.takeIf { it.isNotBlank() } ?: return null
    val instant = parseInstant(raw, zone) ?: return null
    return "额度同步于 ${age(nowMs, instant.toEpochMilli())}"
  }

  fun resetText(account: WidgetQuotaAccount, nowMs: Long, zone: ZoneId): String {
    val raw = account.resetsAt?.takeIf { it.isNotBlank() }
    if (raw != null) {
      val instant = parseInstant(raw, zone)
      if (instant != null) {
        val now = Instant.ofEpochMilli(nowMs)
        if (instant.isAfter(now)) return formatReset(instant, now, zone)
        return "已到重置时间"
      }
    }
    return account.resetDescription?.takeIf { it.isNotBlank() } ?: "—"
  }

  fun age(nowMs: Long, atMs: Long): String {
    if (atMs <= 0L) return "从未"
    val seconds = ((nowMs - atMs) / 1000L).coerceAtLeast(0L)
    return when {
      seconds < 45 -> "刚刚"
      seconds < 90 -> "1 分钟前"
      seconds < 3600 -> "${seconds / 60} 分钟前"
      seconds < 5400 -> "1 小时前"
      seconds < 86_400 -> "${seconds / 3600} 小时前"
      seconds < 172_800 -> "昨天"
      else -> Instant.ofEpochMilli(atMs).atZone(ZoneId.systemDefault()).toLocalDate()
        .format(monthDayFormat)
    }
  }

  private fun formatReset(reset: Instant, now: Instant, zone: ZoneId): String {
    val resetLocal = reset.atZone(zone)
    val nowLocal = now.atZone(zone)
    val days = java.time.temporal.ChronoUnit.DAYS.between(nowLocal.toLocalDate(), resetLocal.toLocalDate())
    return when {
      days == 0L -> timeFormat.format(resetLocal)
      days == 1L -> "明天 ${timeFormat.format(resetLocal)}"
      days in 2L..6L -> resetLocal.dayOfWeek.getDisplayName(
        java.time.format.TextStyle.SHORT,
        Locale.SIMPLIFIED_CHINESE
      ) + " " + timeFormat.format(resetLocal)
      else -> "${resetLocal.monthValue}月${resetLocal.dayOfMonth}日 ${timeFormat.format(resetLocal)}"
    }
  }

  private fun parseInstant(raw: String, zone: ZoneId): Instant? =
    runCatching { Instant.parse(raw) }.getOrNull()
      ?: runCatching { OffsetDateTime.parse(raw).toInstant() }.getOrNull()
      ?: runCatching { java.time.LocalDateTime.parse(raw).atZone(zone).toInstant() }.getOrNull()

  private fun formatThousands(value: Long): String =
    String.format(Locale.US, "%,d", value)

  private fun percent(value: Double): String {
    val rounded = value.roundToInt()
    return if (abs(value - rounded) < 0.05 || value >= 10.0 || value <= 0.0) {
      String.format(Locale.US, "%d%%", rounded)
    } else {
      String.format(Locale.US, "%.1f%%", value)
    }
  }

  private fun estimatedValue(text: String, estimated: Boolean): String =
    if (estimated) "~$text" else text
}
