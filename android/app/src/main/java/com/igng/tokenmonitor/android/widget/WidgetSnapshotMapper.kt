package com.igng.tokenmonitor.android.widget

import com.igng.tokenmonitor.android.data.model.HistoryDayDto
import com.igng.tokenmonitor.android.data.model.HistoryDto
import com.igng.tokenmonitor.android.data.model.LimitProviderDto
import com.igng.tokenmonitor.android.data.model.LimitWindowDto
import com.igng.tokenmonitor.android.data.model.PeriodDto
import com.igng.tokenmonitor.android.data.model.StatsDto
import com.igng.tokenmonitor.android.ui.components.fleetOnlineCount
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale
import kotlin.math.min

/**
 * Pure DTO → widget document mapping.
 *
 * No Android or Compose type appears here on purpose: the Android JVM suite
 * cannot load Compose runtime classes, and every number a widget renders should
 * be testable without a device. The renderer only turns these fields into text
 * and RemoteViews.
 */
object WidgetSnapshotMapper {
  fun build(
    stats: StatsDto,
    history: HistoryDto?,
    rates: Map<String, Double>,
    currency: String,
    now: Instant,
    zone: ZoneId,
    lastError: String? = null,
    lastErrorKind: String? = null
  ): WidgetSnapshot {
    val today = now.atZone(zone).toLocalDate()
    val historyDocument = history ?: stats.historyPreview
    val daily = historyDocument?.daily.orEmpty()
    val byDate = daily.mapNotNull { day ->
      runCatching { LocalDate.parse(day.date) }.getOrNull()?.let { it to day }
    }.toMap()

    return WidgetSnapshot(
      capturedAtMs = now.toEpochMilli(),
      capturedLocalDate = today.toString(),
      currency = currency,
      rate = if (currency == "USD") 1.0 else rates[currency],
      today = totals(stats.periods.today),
      month = totals(stats.periods.month),
      allTime = totals(stats.periods.allTime),
      yesterday = byDate[today.minusDays(1)]?.let { dayTotals(it) },
      days = (6L downTo 0L).map { offset ->
        val date = today.minusDays(offset)
        val day = byDate[date]
        WidgetDay(
          date = date.toString(),
          tokens = day?.tokens?.toLong() ?: 0L,
          costUsd = day?.cost ?: 0.0
        )
      },
      accounts = WidgetQuotaOrdering.sorted(
        stats.limits?.providers.orEmpty().mapIndexedNotNull { index, provider ->
          provider.toWidgetAccount(index)
        }
      ),
      limitsAuthority = stats.limitsAuthority,
      limitsUpdatedAt = stats.limits?.updatedAt,
      onlineDevices = fleetOnlineCount(stats.devices),
      totalDevices = stats.devices.size,
      lastAttemptMs = now.toEpochMilli(),
      lastError = lastError,
      lastErrorKind = lastErrorKind
    )
  }

  /**
   * A failed poll keeps the previous document. Without a previous document the
   * widget still gets a timestamped failure so its empty state can say why it has
   * no numbers rather than pretending the Hub returned zero.
   */
  fun failure(
    existing: WidgetSnapshot?,
    message: String,
    kind: String,
    now: Instant,
    currency: String,
    rate: Double? = null
  ): WidgetSnapshot {
    val base = existing ?: WidgetSnapshot(
      capturedLocalDate = now.atZone(ZoneId.systemDefault()).toLocalDate().toString(),
      currency = currency,
      rate = rate
    )
    return base.copy(currency = currency, rate = rate).withFailure(message, kind, now.toEpochMilli())
  }

  private fun totals(period: PeriodDto): WidgetPeriodTotals = WidgetPeriodTotals(
    tokens = period.totalTokens,
    costUsd = period.costUsd,
    estimated = period.estimated || period.clientEstimated.values.any { it }
  )

  private fun dayTotals(day: HistoryDayDto): WidgetPeriodTotals = WidgetPeriodTotals(
    tokens = day.tokens.toLong(),
    costUsd = day.cost,
    // HistoryDayDto has no period-level estimate flag. Per-client provenance is
    // still available on the app's full history document, but a widget number
    // that says "estimated" without a day-level flag would be a guess of a guess.
    estimated = false
  )

  private fun LimitProviderDto.toWidgetAccount(index: Int): WidgetQuotaAccount? {
    if (provider.isBlank()) return null
    val headline = windows
      .filter { it.showMeter }
      .mapNotNull { window -> window.usedPercentOrNull()?.let { window to it } }
      .maxByOrNull { it.second }
    val used = headline?.second
    val remaining = used?.let { (100.0 - it).coerceIn(0.0, 100.0) }
    val balanceAmount = balance?.amount ?: balanceUsd
    val balanceCurrency = balance?.currency ?: if (balanceUsd != null) "USD" else null

    return WidgetQuotaAccount(
      id = identity(this, index),
      provider = provider.trim().lowercase(Locale.US),
      accountLabel = accountLabel?.takeIf { it.isNotBlank() }
        ?: accountName?.takeIf { it.isNotBlank() }
        ?: accountEmail?.takeIf { it.isNotBlank() },
      planLabel = planLabel?.takeIf { it.isNotBlank() }
        ?: planType?.takeIf { it.isNotBlank() }
        ?: plan?.takeIf { it.isNotBlank() },
      status = status?.takeIf { it.isNotBlank() },
      windowKind = headline?.first?.kind?.takeIf { it.isNotBlank() },
      windowLabel = headline?.first?.label?.takeIf { it.isNotBlank() },
      usedPercent = used,
      remainingPercent = remaining,
      resetsAt = headline?.first?.resetsAt?.takeIf { it.isNotBlank() },
      resetDescription = headline?.first?.resetDescription?.takeIf { it.isNotBlank() },
      balanceAmount = balanceAmount,
      balanceCurrency = balanceCurrency,
      updatedAt = updatedAt?.takeIf { it.isNotBlank() }
    )
  }

  /**
   * `accountKey` is the Hub's stable identity. When it is absent, every field
   * that distinguishes two accounts of the same provider is folded in; the list
   * index is only a last resort and is deliberately excluded from the stable
   * part, so a refresh that reorders rows cannot silently change a selection.
   */
  private fun identity(provider: LimitProviderDto, index: Int): String {
    val key = provider.accountKey?.takeIf { it.isNotBlank() }
    if (key != null) return "${provider.provider}|key:$key"
    val fields = listOf(
      provider.accountEmail,
      provider.accountLabel,
      provider.accountName,
      provider.workspaceKind,
      provider.plan
    ).mapNotNull { it?.takeIf { value -> value.isNotBlank() } }
    return if (fields.isEmpty()) {
      "${provider.provider}|row:$index"
    } else {
      "${provider.provider}|" + fields.joinToString("|")
    }
  }

  /** Mirrors the in-app `windowUsedPercent` rule, including remaining-only windows. */
  private fun LimitWindowDto.usedPercentOrNull(): Double? {
    usedPercent?.let { return it.coerceIn(0.0, 100.0) }
    used?.let { usedValue ->
      limit?.let { limitValue ->
        if (limitValue > 0.0) return min(100.0, (usedValue / limitValue) * 100.0)
      }
    }
    remainingPercent?.let { return (100.0 - it).coerceIn(0.0, 100.0) }
    return null
  }
}
