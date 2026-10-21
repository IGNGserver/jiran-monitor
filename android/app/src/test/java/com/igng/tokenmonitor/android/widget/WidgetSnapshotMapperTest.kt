package com.igng.tokenmonitor.android.widget

import com.igng.tokenmonitor.android.data.model.HistoryDayDto
import com.igng.tokenmonitor.android.data.model.HistoryDto
import com.igng.tokenmonitor.android.data.model.LimitProviderDto
import com.igng.tokenmonitor.android.data.model.LimitWindowDto
import com.igng.tokenmonitor.android.data.model.LimitsDto
import com.igng.tokenmonitor.android.data.model.PeriodDto
import com.igng.tokenmonitor.android.data.model.PeriodsDto
import com.igng.tokenmonitor.android.data.model.StatsDto
import java.time.Instant
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WidgetSnapshotMapperTest {
  private val zone = ZoneId.of("Asia/Shanghai")
  private val now = Instant.parse("2026-10-21T02:00:00Z") // 10:00 in Shanghai

  @Test
  fun `maps periods history yesterday and currency`() {
    val stats = StatsDto(
      periods = PeriodsDto(
        today = PeriodDto(totalTokens = 2_000, costUsd = 1.5, estimated = true),
        month = PeriodDto(totalTokens = 20_000, costUsd = 15.0),
        allTime = PeriodDto(totalTokens = 200_000, costUsd = 150.0)
      )
    )
    val history = HistoryDto(
      daily = listOf(
        HistoryDayDto(date = "2026-10-19", tokens = 800.0, cost = 0.8),
        HistoryDayDto(date = "2026-10-20", tokens = 1_000.0, cost = 1.0),
        HistoryDayDto(date = "2026-10-21", tokens = 2_000.0, cost = 1.5)
      )
    )

    val snapshot = WidgetSnapshotMapper.build(
      stats = stats,
      history = history,
      rates = mapOf("CNY" to 7.1),
      currency = "CNY",
      now = now,
      zone = zone
    )

    assertEquals("2026-10-21", snapshot.capturedLocalDate)
    assertEquals(2_000L, snapshot.today.tokens)
    assertTrue(snapshot.today.estimated)
    assertEquals(7.1, snapshot.rate)
    assertEquals(1_000L, snapshot.yesterday?.tokens)
    assertEquals(7, snapshot.days.size)
    assertEquals("2026-10-15", snapshot.days.first().date)
    assertEquals(0L, snapshot.days.first().tokens)
    assertEquals(2_000L, snapshot.days.last().tokens)
    assertTrue(snapshot.hasData)
  }

  @Test
  fun `missing history leaves yesterday null and days zero-filled`() {
    val snapshot = WidgetSnapshotMapper.build(
      stats = StatsDto(periods = PeriodsDto(today = PeriodDto(totalTokens = 500))),
      history = null,
      rates = emptyMap(),
      currency = "USD",
      now = now,
      zone = zone
    )

    assertNull(snapshot.yesterday)
    assertEquals(7, snapshot.days.size)
    assertTrue(snapshot.days.all { it.tokens == 0L })
  }

  @Test
  fun `quota chooses the most used window and sorts expired first`() {
    val stats = StatsDto(
      limits = LimitsDto(
        updatedAt = "2026-10-21T01:55:00Z",
        providers = listOf(
          LimitProviderDto(
            provider = "claude",
            accountKey = "claude-a",
            planLabel = "Max",
            windows = listOf(
              LimitWindowDto(kind = "session", usedPercent = 20.0),
              LimitWindowDto(kind = "weekly", label = "每周", usedPercent = 62.0)
            )
          ),
          LimitProviderDto(
            provider = "cursor",
            accountKey = "cursor-expired",
            status = "unauthorized",
            windows = listOf(LimitWindowDto(kind = "monthly", usedPercent = 8.0))
          ),
          LimitProviderDto(
            provider = "codex",
            accountKey = "codex-limited",
            status = "ratelimited",
            windows = listOf(LimitWindowDto(kind = "weekly", usedPercent = 40.0))
          )
        )
      )
    )

    val snapshot = WidgetSnapshotMapper.build(
      stats = stats,
      history = null,
      rates = emptyMap(),
      currency = "USD",
      now = now,
      zone = zone
    )

    assertEquals(listOf("cursor", "codex", "claude"), snapshot.accounts.map { it.provider })
    val claude = snapshot.accounts.first { it.provider == "claude" }
    assertEquals(62.0, claude.usedPercent!!, 0.001)
    assertEquals(38.0, claude.remainingPercent!!, 0.001)
    assertEquals("weekly", claude.windowKind)
    assertEquals("每周", claude.windowLabel)
    assertTrue(snapshot.accounts.first().isUnauthorized)
    assertEquals("2026-10-21T01:55:00Z", snapshot.limitsUpdatedAt)
  }

  @Test
  fun `failure keeps the last good snapshot but records the attempt`() {
    val previous = WidgetSnapshot(
      capturedAtMs = now.toEpochMilli(),
      capturedLocalDate = "2026-10-21",
      today = WidgetPeriodTotals(tokens = 900),
      currency = "USD"
    )

    val failed = WidgetSnapshotMapper.failure(
      existing = previous,
      message = "timeout",
      kind = "Network",
      now = now.plusSeconds(60),
      currency = "USD"
    )

    assertEquals(900L, failed.today.tokens)
    assertEquals(now.toEpochMilli(), failed.capturedAtMs)
    assertEquals(now.plusSeconds(60).toEpochMilli(), failed.lastAttemptMs)
    assertEquals("timeout", failed.lastError)
    assertTrue(failed.hasData)
  }

  @Test
  fun `failure without a previous snapshot is still explicit`() {
    val failed = WidgetSnapshotMapper.failure(
      existing = null,
      message = "unauthorized",
      kind = "Unauthorized",
      now = now,
      currency = "CNY",
      rate = 7.1
    )

    assertFalse(failed.hasData)
    assertEquals("CNY", failed.currency)
    assertEquals(7.1, failed.rate)
    assertEquals("unauthorized", failed.lastError)
  }

  @Test
  fun `quota copy distinguishes expiry from a low percentage`() {
    val expired = WidgetQuotaAccount(
      id = "cursor-expired",
      provider = "cursor",
      status = "unauthorized",
      remainingPercent = 80.0
    )
    val low = WidgetQuotaAccount(
      id = "codex-low",
      provider = "codex",
      remainingPercent = 8.0
    )

    val expiredRow = WidgetCopy.row(expired, now.toEpochMilli(), zone)
    val lowRow = WidgetCopy.row(low, now.toEpochMilli(), zone)

    assertEquals("凭证过期", expiredRow.remainingText)
    assertEquals(WidgetSeverity.Danger, expiredRow.severity)
    assertEquals("剩余 8%", lowRow.remainingText)
    assertEquals(0.08, lowRow.fraction!!, 0.001)
  }

  @Test
  fun `a failed latest attempt is offline even with cached numbers`() {
    val snapshot = WidgetSnapshot(
      capturedAtMs = now.toEpochMilli(),
      capturedLocalDate = "2026-10-21",
      today = WidgetPeriodTotals(tokens = 2_000, costUsd = 1.5),
      lastError = "timeout",
      lastErrorKind = "Network"
    )

    val copy = WidgetCopy.today(snapshot, now.toEpochMilli(), 30, false, true, zone)

    assertEquals(WidgetDataState.Offline, copy.state)
    assertTrue(copy.stateLine.contains("离线"))
  }

  @Test
  fun `an account with no meter is not called healthy`() {
    val snapshot = WidgetSnapshot(
      capturedAtMs = now.toEpochMilli(),
      capturedLocalDate = "2026-10-21",
      accounts = listOf(
        WidgetQuotaAccount(id = "no-meter", provider = "claude")
      )
    )

    val copy = WidgetCopy.quota(snapshot, now.toEpochMilli(), 30, true, zone)

    assertEquals("1 项无数据", copy.badgeText)
    assertEquals(WidgetTone.Neutral, copy.badgeTone)
  }

  @Test
  fun `today copy is honest about an empty yesterday and a stale snapshot`() {
    val snapshot = WidgetSnapshot(
      capturedAtMs = now.toEpochMilli(),
      capturedLocalDate = "2026-10-21",
      today = WidgetPeriodTotals(tokens = 2_000, costUsd = 1.5),
      month = WidgetPeriodTotals(tokens = 20_000),
      allTime = WidgetPeriodTotals(tokens = 200_000)
    )

    val fresh = WidgetCopy.today(snapshot, now.toEpochMilli(), 30, false, true, zone)
    assertEquals("2.0K", fresh.tokensText)
    assertEquals("昨日无数据", fresh.deltaText)
    assertEquals(WidgetDataState.Fresh, fresh.state)

    val staleNow = now.plusSeconds(3 * 3600).toEpochMilli()
    val stale = WidgetCopy.today(snapshot, staleNow, 30, false, true, zone)
    assertEquals(WidgetDataState.Stale, stale.state)
    assertTrue(stale.stateLine.contains("陈旧"))
  }

  @Test
  fun `layout breakpoints follow the host size not the device`() {
    assertEquals(WidgetLayout.TodaySmall, WidgetSizing.today(110))
    assertEquals(WidgetLayout.TodayMedium, WidgetSizing.today(250))
    assertEquals(WidgetLayout.QuotaSmall, WidgetSizing.quota(140))
    assertEquals(WidgetLayout.QuotaMedium, WidgetSizing.quota(250))
    assertEquals(2, WidgetSizing.quotaRowCount(120))
    assertEquals(3, WidgetSizing.quotaRowCount(180))
    assertEquals(4, WidgetSizing.quotaRowCount(240))
    assertEquals(0, WidgetSizing.dashboardQuotaRows(200))
    assertEquals(2, WidgetSizing.dashboardQuotaRows(250))
    assertEquals(2, WidgetSizing.dashboardQuotaRows(300))
  }
}
