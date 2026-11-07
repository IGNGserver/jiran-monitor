package com.igng.tokenmonitor.android.ui

import com.igng.tokenmonitor.android.data.model.FleetCalendar
import com.igng.tokenmonitor.android.data.model.PeriodDto
import com.igng.tokenmonitor.android.data.model.PeriodsDto
import com.igng.tokenmonitor.android.data.model.UsageRangeDto
import com.igng.tokenmonitor.android.ui.core.DateRanges
import com.igng.tokenmonitor.android.ui.core.PresetRangeWindow
import java.time.LocalDate

/**
 * The one rule that turns a scope selection into a number.
 *
 * Both surfaces used to own a copy: the analytics screen gated the cached range answer
 * on [AnalyticsPeriodKind.needsRange] while the overview screen preferred
 * `customRangeResult` for *every* tab.  A cached range therefore kept rendering under
 * 今日/本月/全部, which showed up as "the overview and the analytics page disagree" plus
 * two groups of tabs printing the identical figure.  One shared resolver makes that
 * class of bug structurally impossible, and it is a plain function so the JVM suite can
 * assert it (the module's Compose runtime is not loadable there — see `DisplayFx.kt`).
 *
 * The invariant: **a range answer belongs only to the selection that asked for it.**
 * A snapshot period is never replaced by a cached range, and a preset tab never accepts
 * a result fetched for a different window — including the same preset from yesterday.
 */
object ScopePeriod {
  /** The three windows the collector puts on the wire, read straight off the snapshot. */
  fun snapshotPeriod(periods: PeriodsDto?, kind: AnalyticsPeriodKind): PeriodDto? = when (kind) {
    AnalyticsPeriodKind.Today -> periods?.today
    AnalyticsPeriodKind.Month -> periods?.month
    AnalyticsPeriodKind.AllTime -> periods?.allTime
    else -> null
  }

  /**
   * True when the cached range answer still belongs to the current selection.
   *
   * `activePresetWindow` is written together with the result it describes, so a preset
   * tab is satisfied only by its own window; a picked range is satisfied only while the
   * selection is still the transient custom one (`activePresetWindow == null`).  The
   * day keys on [HubUiState.customRange] are cross-checked as well, so a half-written
   * state can never present one window's number under another window's label.
   */
  fun rangeAnswerIsCurrent(
    state: HubUiState,
    today: LocalDate = FleetCalendar.today(state.fleetTimeZone)
  ): Boolean {
    val kind = state.analyticsPeriod
    if (!kind.needsRange) return false
    val answer = state.customRangeResult ?: return false
    val range = state.customRange ?: return false
    // A zone change re-keys the calendar even when every date label stays identical.
    if (state.customRangeZoneId != FleetCalendar.zoneId(state.fleetTimeZone)) return false
    return when (kind) {
      AnalyticsPeriodKind.Yesterday, AnalyticsPeriodKind.Week -> {
        val window = DateRanges.presetRangeWindow(kind.presetPeriodName(), today) ?: return false
        val active = state.activePresetWindow ?: return false
        window.stillMatches(active) &&
          range.startDate == window.startDate.toString() &&
          range.endDate == window.endDate.toString() &&
          answerMatchesWindow(answer, window)
      }
      AnalyticsPeriodKind.Custom -> state.activePresetWindow == null &&
        answerMatchesWindow(answer, range.startDate, range.endDate)
      else -> false
    }
  }

  /**
   * True unless the payload itself denies describing the window it is filed under.
   *
   * The Hub echoes `startDate` / `endDate` back, so a response that was routed to the
   * wrong tab — or that answers a span the client never asked for — is rejected instead of
   * rendered.  Absent fields are trusted: the legacy `from`/`to` shape carries only
   * instants, and the day keys come from the request the client already holds.
   */
  private fun answerMatchesWindow(answer: UsageRangeDto, window: PresetRangeWindow): Boolean =
    answerMatchesWindow(answer, window.startDate.toString(), window.endDate.toString())

  private fun answerMatchesWindow(
    answer: UsageRangeDto,
    startDate: String,
    endDate: String
  ): Boolean {
    if (answer.startDate != null && answer.startDate != startDate) return false
    if (answer.endDate != null && answer.endDate != endDate) return false
    return true
  }

  /**
   * The period the selected scope tab may render, or null when it has no honest answer.
   *
   * Null is the point: a range tab that is loading, failed, or has gone stale across
   * midnight renders a loading or retry affordance instead of the snapshot period that
   * the *previous* tab was showing.
   */
  fun resolve(
    state: HubUiState,
    today: LocalDate = FleetCalendar.today(state.fleetTimeZone)
  ): PeriodDto? {
    val kind = state.analyticsPeriod
    if (!kind.needsRange) {
      val selectedId = state.deviceFilter
      if (selectedId == null) return snapshotPeriod(state.stats?.periods, kind)
      // A capable staged Hub must answer from the full device document. Falling back to
      // its slim row would silently drop client×model/session grain and fake a filter.
      val device = if (state.authorization?.capabilities?.deviceDetail == true) {
        state.deviceDetails[selectedId]
      } else {
        state.devices.firstOrNull { it.deviceId == selectedId }
      }
      return snapshotPeriod(device?.periods, kind)
    }
    val result = state.customRangeResult ?: return null
    if (!rangeAnswerIsCurrent(state, today)) return null
    return result.toPeriodDto()
  }

  /**
   * The calendar window the current selection asks for but does not have, or null.
   *
   * This is the client's copy of the shared UI's `pendingPresetRangeWindow()`: cheap to
   * evaluate on a stream frame because it only turns non-null when the window actually
   * stopped matching (i.e. after local midnight), which is what keeps a preset from
   * re-requesting the Hub on every tick.  A hand-picked range has a fixed window and is
   * never pending.
   */
  fun pendingRangeWindow(
    state: HubUiState,
    today: LocalDate = FleetCalendar.today(state.fleetTimeZone)
  ): PresetRangeWindow? {
    val kind = state.analyticsPeriod
    if (!kind.needsRange) return null
    val window = DateRanges.presetRangeWindow(kind.presetPeriodName(), today) ?: return null
    return if (rangeAnswerIsCurrent(state, today)) null else window
  }

  /**
   * True when the current scope's answer came from a source that has no client×model
   * grain.
   *
   * `history_daily` sums whole days per client and per model, so a range it answers has
   * no `clientModels` map and no session rows — the detail screen would otherwise say
   * "该客户端在此范围内没有模型拆分", which reads as *no usage* rather than *no
   * attribution at this grain*.  The event ledger and the live windows do carry the
   * split, so only these sources downgrade the message.
   */
  fun rangeLacksModelSplit(
    state: HubUiState,
    today: LocalDate = FleetCalendar.today(state.fleetTimeZone)
  ): Boolean {
    if (!state.analyticsPeriod.needsRange) return false
    if (!rangeAnswerIsCurrent(state, today)) return false
    return when (state.customRangeResult?.source) {
      "history_daily", "history_daily+usage_events" -> true
      else -> false
    }
  }

  /**
   * Names the source that answered a range, so a range tab can say what it is showing.
   *
   * Provenance matters here: `history_daily` has no credit concept and no estimate flag,
   * while `usage_events` and the live windows do, so the same client can legitimately
   * carry a different unit set on two tabs.  Hiding that behind a bare number would
   * present a day-rounded aggregate with the same weight as an event-ledger total.
   */
  fun rangeSourceLabel(source: String?): String? = when ((source ?: "").trim()) {
    "" -> null
    "usage_events" -> "数据来源：事件账本（小时精度）"
    "history_daily" -> "数据来源：每日历史（天精度）"
    "history_daily+usage_events" -> "数据来源：每日历史 + 事件账本补齐更早窗口"
    "live_today" -> "数据来源：设备实时今日窗口"
    "live_month" -> "数据来源：设备实时本月窗口"
    "live_periods" -> "数据来源：设备实时窗口"
    "live_range" -> "数据来源：设备本地解析"
    else -> "数据来源：${source?.trim()}"
  }
}

/**
 * The preset vocabulary name of a scope tab, shared with the web UI's `PERIOD_TABS`
 * (`today` / `yesterday` / `week` / `month` / `allTime`).  Only `yesterday` and `week`
 * ever resolve through the range endpoint; every other name yields no window.
 */
internal fun AnalyticsPeriodKind.presetPeriodName(): String = name.lowercase()
