package com.igng.tokenmonitor.android.ui

import com.igng.tokenmonitor.android.data.model.HistoryDayDto
import com.igng.tokenmonitor.android.data.model.PeriodDto
import com.igng.tokenmonitor.android.data.model.PeriodsDto
import com.igng.tokenmonitor.android.data.model.StatsDto
import com.igng.tokenmonitor.android.data.model.SubscriptionDto
import com.igng.tokenmonitor.android.data.model.UsageRangeDto
import com.igng.tokenmonitor.android.ui.components.heatmapWeekdayLabels
import com.igng.tokenmonitor.android.ui.components.topShareEntries
import com.igng.tokenmonitor.android.ui.core.DateRanges
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.DayOfWeek
import java.time.LocalDate
import java.util.Locale

/**
 * The pure logic the Fluent 2 client migration added.
 *
 * JVM-only on purpose: the Android test runner in this module cannot load the Compose
 * runtime (see the note in `DisplayFx.kt`), so every helper exercised here is kept free
 * of Compose types, and the ones that render are asserted by the Node guards instead.
 */
class ScopeAndProvenanceTest {
  private val monday = LocalDate.of(2026, 9, 21) // a Monday
  private val wednesday = LocalDate.of(2026, 9, 23)

  @Test
  fun yesterdayIsAClosedOneDayWindow() {
    val window = DateRanges.presetRangeWindow("yesterday", monday)!!
    assertEquals(monday.minusDays(1), window.startDate)
    assertEquals(monday.minusDays(1), window.endDate)
    // Day boundaries are inclusive end-to-start so a preset and a hand-picked range
    // over the same days cannot answer with different totals.
    assertEquals(0, window.startHour)
    assertEquals(23, window.endHour)
  }

  @Test
  fun theWeekWindowIsIsoMondayWhateverTheDeviceLocaleIs() {
    val week = DateRanges.presetRangeWindow("week", wednesday)!!
    assertEquals(wednesday, week.endDate)
    // A Wednesday inside a Monday-start week sits two days in.
    assertEquals(wednesday.minusDays(2), week.startDate)

    // A US locale's CLDR week starts on Sunday, and the grid still shows that
    // (`firstDayOfWeek` is display).  The *window* must not follow it: the web scope bar
    // answers Monday-through-today, so a locale-driven port would report a different
    // figure for the same 本周 label — a second measurement, not a second rendering.
    assertEquals(DayOfWeek.SUNDAY, DateRanges.firstDayOfWeek(Locale.US))
    assertEquals(wednesday.minusDays(2), DateRanges.scopeWeekStart(wednesday))
    assertEquals(monday, DateRanges.scopeWeekStart(monday))
    // Sunday is the last day of the ISO week that started the previous Monday.
    assertEquals(
      LocalDate.of(2026, 9, 21),
      DateRanges.presetRangeWindow("week", LocalDate.of(2026, 9, 27))!!.startDate
    )
  }

  @Test
  fun aWindowStopsMatchingWhenTheDateRollsOver() {
    val morning = DateRanges.presetRangeWindow("week", monday)!!
    assertTrue(morning.stillMatches(morning))
    val nextDay = DateRanges.presetRangeWindow("week", monday.plusDays(1))!!
    assertTrue(
      "the fetched window must be re-resolved after midnight, not kept",
      !morning.stillMatches(nextDay)
    )
    assertNull(DateRanges.presetRangeWindow("today", monday))
    assertNull(DateRanges.presetRangeWindow("month", monday))
  }

  @Test
  fun aSnapshotTabNeverRendersTheCachedRangeAnswer() {
    // The regression the overview shipped: it preferred `customRangeResult` for every tab,
    // so one fetched 昨日 range silently replaced 今日/本月/全部 — two groups of tabs
    // printing the identical figure while the analytics page showed something else.
    val yesterday = DateRanges.presetRangeWindow("yesterday", wednesday)!!
    val state = rangeState(
      AnalyticsPeriodKind.Yesterday,
      yesterday,
      UsageRangeDto(startDate = yesterday.startDate.toString(), endDate = yesterday.endDate.toString(), totalTokens = 500)
    )
    for ((kind, expected) in listOf(
      AnalyticsPeriodKind.Today to 100L,
      AnalyticsPeriodKind.Month to 2000L,
      AnalyticsPeriodKind.AllTime to 9000L
    )) {
      val resolved = ScopePeriod.resolve(state.copy(analyticsPeriod = kind), today = wednesday)
      assertEquals("$kind reads the snapshot", expected, resolved?.totalTokens)
    }
    assertEquals(500L, ScopePeriod.resolve(state, today = wednesday)?.totalTokens)
  }

  @Test
  fun aRangeTabRefusesAnotherWindowsAnswerAndASnapshotPeriod() {
    val yesterday = DateRanges.presetRangeWindow("yesterday", wednesday)!!
    val week = DateRanges.presetRangeWindow("week", wednesday)!!
    val yesterdayAnswer = UsageRangeDto(
      startDate = yesterday.startDate.toString(),
      endDate = yesterday.endDate.toString(),
      totalTokens = 500
    )
    val weekAnswer = UsageRangeDto(
      startDate = week.startDate.toString(),
      endDate = week.endDate.toString(),
      totalTokens = 4000
    )
    // Mid-transition the week tab is still holding the yesterday selection: it must not
    // borrow that answer.
    assertNull(ScopePeriod.resolve(rangeState(AnalyticsPeriodKind.Week, yesterday, yesterdayAnswer), today = wednesday))
    // A payload whose own day keys do not describe the window is refused as well, so a
    // misrouted response cannot be rendered under the wrong label.
    assertNull(ScopePeriod.resolve(rangeState(AnalyticsPeriodKind.Week, week, yesterdayAnswer), today = wednesday))
    // Nor may a range tab fall back to the snapshot, which is how 昨日 used to print the
    // same figure as 今日.
    assertNull(ScopePeriod.resolve(rangeState(AnalyticsPeriodKind.Week, week, null), today = wednesday))
    assertEquals(
      4000L,
      ScopePeriod.resolve(rangeState(AnalyticsPeriodKind.Week, week, weekAnswer), today = wednesday)?.totalTokens
    )
  }

  @Test
  fun aPresetGoesPendingOnlyAfterTheWindowActuallyMoves() {
    val week = DateRanges.presetRangeWindow("week", wednesday)!!
    val fetched = UsageRangeDto(
      startDate = week.startDate.toString(),
      endDate = week.endDate.toString(),
      totalTokens = 4000
    )
    val state = rangeState(AnalyticsPeriodKind.Week, week, fetched)
    // Same day: nothing to do, so a stream frame costs a date comparison, not a request.
    assertNull(ScopePeriod.pendingRangeWindow(state, wednesday))
    // Past midnight the week grew, so the cached number no longer names the tab.
    assertEquals(
      DateRanges.presetRangeWindow("week", wednesday.plusDays(1))!!,
      ScopePeriod.pendingRangeWindow(state, wednesday.plusDays(1))
    )
    // A snapshot tab has no window to re-resolve, and a picked range is fixed.
    assertNull(ScopePeriod.pendingRangeWindow(state.copy(analyticsPeriod = AnalyticsPeriodKind.Month)))
    assertNull(
      ScopePeriod.pendingRangeWindow(
        state.copy(
          analyticsPeriod = AnalyticsPeriodKind.Custom,
          activePresetWindow = null
        )
      )
    )
  }

  @Test
  fun aCustomTabNeedsItsOwnSelectionAndNoPresetWindow() {
    val selection = CustomRangeSelection("2026-09-01", "2026-09-20", 0, 23, "09-01 → 09-20")
    val fetched = UsageRangeDto(startDate = "2026-09-01", endDate = "2026-09-20", totalTokens = 777)
    val picked = HubUiState(
      stats = statsState(),
      analyticsPeriod = AnalyticsPeriodKind.Custom,
      customRange = selection,
      customRangeResult = fetched
    )
    assertEquals(777L, ScopePeriod.resolve(picked)?.totalTokens)
    // A leftover preset window means this result belongs to a preset, not to Custom.
    assertNull(
      ScopePeriod.resolve(
        picked.copy(activePresetWindow = DateRanges.presetRangeWindow("week", wednesday))
      )
    )
    // Custom with no selection yet renders no figure at all rather than someone else's.
    assertNull(ScopePeriod.resolve(picked.copy(customRange = null, customRangeResult = null)))
  }

  @Test
  fun everyRangeSourceIsNamedOnScreen() {
    // Provenance matters: only some sources carry credits or the estimate flag, so a tab
    // that hides which one answered is free to present a day-rounded aggregate as if it
    // were an event-precision total.
    assertEquals("数据来源：事件账本（小时精度）", ScopePeriod.rangeSourceLabel("usage_events"))
    assertEquals("数据来源：每日历史（天精度）", ScopePeriod.rangeSourceLabel("history_daily"))
    assertNull(ScopePeriod.rangeSourceLabel(null))
    assertNull(ScopePeriod.rangeSourceLabel(""))
    assertTrue(ScopePeriod.rangeSourceLabel("some_future_source")!!.startsWith("数据来源："))
    val week = DateRanges.presetRangeWindow("week", wednesday)!!
    assertTrue(
      ScopePeriod.rangeLacksModelSplit(
        rangeState(
          AnalyticsPeriodKind.Week,
          week,
          UsageRangeDto(
            startDate = week.startDate.toString(),
            endDate = week.endDate.toString(),
            source = "history_daily"
          )
        ),
        today = wednesday
      )
    )
    assertFalse(
      "the event ledger does carry the client×model split",
      ScopePeriod.rangeLacksModelSplit(
        rangeState(
          AnalyticsPeriodKind.Week,
          week,
          UsageRangeDto(
            startDate = week.startDate.toString(),
            endDate = week.endDate.toString(),
            source = "usage_events"
          )
        ),
        today = wednesday
      )
    )
  }

  private fun statsState() = StatsDto(
    periods = PeriodsDto(
      today = PeriodDto(totalTokens = 100),
      month = PeriodDto(totalTokens = 2000),
      allTime = PeriodDto(totalTokens = 9000)
    )
  )

  /** A state as the ViewModel would leave it after one range request for [window]. */
  private fun rangeState(
    kind: AnalyticsPeriodKind,
    window: com.igng.tokenmonitor.android.ui.core.PresetRangeWindow,
    result: UsageRangeDto?
  ) = HubUiState(
    stats = statsState(),
    analyticsPeriod = kind,
    customRange = CustomRangeSelection(
      startDate = window.startDate.toString(),
      endDate = window.endDate.toString(),
      startHour = window.startHour,
      endHour = window.endHour,
      label = window.label()
    ),
    customRangeResult = result,
    activePresetWindow = window
  )

  @Test
  fun windowInstantsBoundTheWindowInTheRequestingZone() {
    // The Hub filters its event ledger on these instants; deriving them from the Hub's
    // clock would shift the window by the zone difference the day labels exist to avoid.
    val zone = java.time.ZoneId.of("Asia/Shanghai")
    val instants = DateRanges.windowInstants(
      LocalDate.of(2026, 10, 4), LocalDate.of(2026, 10, 4), 0, 23, zone
    )
    // 2026-10-04 00:00 +08 == 2026-10-03T16:00:00Z
    assertEquals("2026-10-03T16:00:00Z", instants.from)
    // The whole final hour is included: 23:59:59.999 +08 == 15:59:59.999Z.
    assertEquals("2026-10-04T15:59:59.999Z", instants.to)
  }

  @Test
  fun creditsOnlyClientsStillProduceAShareRow() {
    // Qoder reports credits and zero tokens.  Ranking on tokens alone used to drop the
    // row entirely, which rendered as "Qoder used nothing".
    val entries = topShareEntries(
      tokens = mapOf("claude" to 500L, "qoder" to 0L),
      costs = mapOf("claude" to 1.0),
      estimated = mapOf("claude" to true),
      credits = mapOf("qoder" to 42.0),
      limit = 6
    )
    assertEquals(2, entries.size)
    val qoder = entries.first { it.key == "qoder" }
    assertEquals(42.0, qoder.credits!!, 0.0001)
    assertTrue(qoder.creditsOnly)
    assertTrue(entries.first { it.key == "claude" }.estimated)
  }

  @Test
  fun anAggregatedTailIsNeverPresentedAsExact() {
    val entries = topShareEntries(
      tokens = (1..8).associate { "client$it" to (100L - it) },
      estimated = mapOf("client8" to true),
      limit = 4
    )
    val other = entries.last()
    assertEquals("其他", other.key)
    assertTrue(
      "one estimated member makes the summed row estimated — OR semantics, as docs/API.md states",
      other.estimated
    )
  }

  @Test
  fun subscriptionMonthlyEquivalentKeepsTopupsUnamortised() {
    val monthly = com.igng.tokenmonitor.android.ui.more.monthlyEquivalent(
      listOf(
        SubscriptionDto(id = "a", plan = "pro", amount = 120.0, currency = "USD", interval = "year"),
        SubscriptionDto(id = "b", plan = "max", amount = 20.0, currency = "USD", interval = "month"),
        SubscriptionDto(id = "c", plan = "topup", amount = 5.0, currency = "USD", recordType = "topup")
      )
    )
    // 120/12 + 20 + 5.  The top-up is spent this month and is not divided by anything.
    assertEquals(35.0, monthly["USD"]!!, 0.0001)
  }

  @Test
  fun intervalCountStretchesModulelyEquivalence() {
    val monthly = com.igng.tokenmonitor.android.ui.more.monthlyEquivalent(
      listOf(
        SubscriptionDto(id = "q", amount = 30.0, currency = "CNY", interval = "month", intervalCount = 3)
      )
    )
    assertEquals(10.0, monthly["CNY"]!!, 0.0001)
  }

  @Test
  fun heatmapRowLabelsFollowTheWeekStart() {
    // Rows 1/3/5 of a Sunday-first grid are Tue/Thu/Sat; of a Monday-first grid they
    // are Wed/Fri/Sun.  The old constant claimed "一 三 五" for a Sunday-first grid,
    // which labelled every row with the wrong day.
    // Sun-first: row 0 is Sunday, so rows 1/3/5 are Mon/Wed/Fri.
    val sundayFirst = heatmapWeekdayLabels(DayOfWeek.SUNDAY)
    assertEquals("一", sundayFirst[1])
    assertEquals("三", sundayFirst[3])
    assertEquals("五", sundayFirst[5])
    // Mon-first: the same row numbers shift by one day.
    val mondayFirst = heatmapWeekdayLabels(DayOfWeek.MONDAY)
    assertEquals("二", mondayFirst[1])
    assertEquals("四", mondayFirst[3])
    assertEquals("六", mondayFirst[5])
  }

  @Test
  fun historyDayRowsStillCarryTheZeroFilledGapContract() {
    // Regression guard: the heatmap relies on contiguous days, so a helper that stops
    // filling gaps would silently shift every column.
    val days = listOf(
      HistoryDayDto(date = "2026-09-20", tokens = 5.0),
      HistoryDayDto(date = "2026-09-23", tokens = 7.0)
    )
    val filled = com.igng.tokenmonitor.android.ui.components.historyDailyForHeatmap(days, 4)
    assertEquals(4, filled.size)
    // Contiguity is the contract: the two reported days are kept and the two missing
    // ones become explicit zeros, so a column cannot drift out of its weekday row.
    assertEquals("2026-09-20", filled.first().date)
    assertEquals(5.0, filled.first().tokens, 0.0001)
    assertEquals("2026-09-23", filled.last().date)
    assertEquals(7.0, filled.last().tokens, 0.0001)
    assertEquals(0.0, filled[1].tokens, 0.0001)
    assertEquals(0.0, filled[2].tokens, 0.0001)
  }
}
