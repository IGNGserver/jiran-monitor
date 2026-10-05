package com.igng.tokenmonitor.android.ui.core

import java.time.DayOfWeek
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.TemporalAdjusters
import java.util.Locale

/**
 * Calendar windows for the scope presets that are *not* periods on the wire.
 *
 * Day / month / total ship with every stats snapshot because the collector scans
 * exactly those three windows.  "Yesterday" and "this week" are calendar ranges in the
 * same sense as a hand-picked custom range, so they resolve through
 * `GET /api/usage/range` — the same rule the shared web UI uses
 * (`src/shared-ui/core/dateRanges.js`), which is what keeps the two clients reporting
 * the same number for the same tab.  A port that invents its own week boundary would
 * be a second measurement, not a second rendering of one.
 *
 * Bounds are whole local days and inclusive, matching the endpoint's
 * `startDate` / `endDate` / `startHour` / `endHour` vocabulary: the final day is asked
 * for with `endHour = 23`, which is how the desktop host reads "include that whole
 * hour".  `docs/API.md` notes the totals are day-rounded on the Hub side either way.
 */
object DateRanges {
  /** Presets resolved through the range endpoint rather than the snapshot. */
  val PRESET_RANGE_PERIODS = listOf("yesterday", "week")

  /**
   * The 本周 window always starts on ISO 8601 Monday, on every device and in every
   * locale.
   *
   * This is a *measurement* rule, not a display preference: the web scope bar computes
   * the same Monday (`Intl.Locale#weekInfo` is absent in the Chromium builds both hosts
   * run on, and the port pins it deliberately now), so one "本周" label cannot answer two
   * different totals depending on which client asked.  A CLDR-following port was exactly
   * the second measurement the note above warns about — under a US locale its window
   * started a day earlier and the same tab showed a bigger number than the browser.
   *
   * [firstDayOfWeek] stays locale-driven on purpose: the heatmap grid and the date
   * picker's calendar are presentation, and neither one produces a reported figure.
   */
  val SCOPE_WEEK_FIRST_DAY = DayOfWeek.MONDAY

  /**
   * The day a *grid* starts on, from CLDR via [Locale].
   *
   * Display only — see [SCOPE_WEEK_FIRST_DAY] for why the 本周 window ignores this.
   */
  fun firstDayOfWeek(locale: Locale = Locale.getDefault()): DayOfWeek {
    // `WeekFields` is the CLDR-backed accessor; an unsupported locale still yields
    // the ISO minimum, which is the documented fallback rather than a surprise.
    return runCatching {
      java.time.temporal.WeekFields.of(locale).firstDayOfWeek
    }.getOrDefault(SCOPE_WEEK_FIRST_DAY)
  }

  /** The ISO Monday that starts [date]'s week. */
  fun scopeWeekStart(date: LocalDate = LocalDate.now()): LocalDate {
    val back = (date.dayOfWeek.value - SCOPE_WEEK_FIRST_DAY.value + 7) % 7
    return date.minusDays(back.toLong())
  }

  /**
   * @return the inclusive calendar window for a preset name, or null when [period] is
   *   not a preset range (those come from the snapshot's `periods`).
   */
  fun presetRangeWindow(
    period: String?,
    today: LocalDate = LocalDate.now()
  ): PresetRangeWindow? {
    return when (period?.lowercase()) {
      // Yesterday is a closed window; the current week always runs up to today.
      "yesterday" -> PresetRangeWindow(
        period = "yesterday",
        startDate = today.minusDays(1),
        endDate = today.minusDays(1)
      )
      "week" -> PresetRangeWindow(
        period = "week",
        startDate = scopeWeekStart(today),
        endDate = today
      )
      else -> null
    }
  }

  fun isPresetRangePeriod(period: String?): Boolean =
    period?.lowercase() in PRESET_RANGE_PERIODS

  /**
   * The absolute instants a local calendar window names, for the Hub's event-ledger
   * fallback.
   *
   * The Hub is told both the day keys (which it aggregates `history_daily` on) and these
   * instants (which filter `usage_events`). Without the instants the Hub would derive
   * them from its *own* clock, shifting the ledger window by the zone difference — the
   * same class of bug the day labels exist to prevent. The end instant is the last
   * millisecond of [endHour] so the whole final hour is included.
   */
  fun windowInstants(
    startDate: LocalDate,
    endDate: LocalDate,
    startHour: Int = 0,
    endHour: Int = 23,
    zone: ZoneId = ZoneId.systemDefault()
  ): WindowInstants {
    val from = startDate.atTime(startHour.coerceIn(0, 23), 0).atZone(zone).toInstant()
    val to = endDate.atTime(endHour.coerceIn(0, 23), 59, 59, 999_000_000).atZone(zone).toInstant()
    return WindowInstants(from.toString(), to.toString())
  }
}

/** Inclusive local window expressed as ISO-8601 instants. */
data class WindowInstants(val from: String, val to: String)

data class PresetRangeWindow(
  val period: String,
  val startDate: LocalDate,
  val endDate: LocalDate
) {
  /** The `startHour` the range endpoint is called with. */
  val startHour: Int get() = 0

  /** The `endHour` the range endpoint is called with — the last hour of the window. */
  val endHour: Int get() = 23

  /** True while a fetched window still answers the same question it was asked for. */
  fun stillMatches(other: PresetRangeWindow?): Boolean =
    other != null && other.period == period &&
      other.startDate == startDate && other.endDate == endDate

  /**
   * Label for the scope chip.  Both ends are printed even when they are the same day:
   * a single date would hide that "yesterday" is a one-day window, which is the fact
   * a user comparing it against "today" needs.
   */
  fun label(now: LocalDate = LocalDate.now()): String {
    val formatter = DateTimeFormatter.ofPattern("MM-dd")
    return if (startDate == endDate) {
      startDate.format(formatter)
    } else {
      "${startDate.format(formatter)} → ${endDate.format(formatter)}"
    }
  }
}
