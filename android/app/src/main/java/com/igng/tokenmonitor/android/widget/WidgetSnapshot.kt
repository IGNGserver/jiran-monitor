package com.igng.tokenmonitor.android.widget

import java.util.Locale
import kotlinx.serialization.Serializable

/**
 * The only data a widget is allowed to render.
 *
 * A widget must survive its process being killed, a launcher restart and an
 * unreachable Hub, so it never reads a ViewModel or the live SSE state. The
 * refresh worker (and the foreground app) write this small document to internal
 * storage; every RemoteViews build reads it back. Keeping the shape flat and
 * serializable also means every number a widget shows has one mapper behind it,
 * which is what the JVM tests pin.
 *
 * Costs are always stored in USD. [currency] and [rate] describe the display
 * conversion at capture time; a missing rate intentionally falls back to USD in
 * the shared formatter instead of inventing a number.
 */
@Serializable
data class WidgetSnapshot(
  val schemaVersion: Int = SCHEMA_VERSION,
  val capturedAtMs: Long = 0L,
  val capturedLocalDate: String = "",
  val currency: String = "USD",
  val rate: Double? = null,
  val today: WidgetPeriodTotals = WidgetPeriodTotals(),
  val month: WidgetPeriodTotals = WidgetPeriodTotals(),
  val allTime: WidgetPeriodTotals = WidgetPeriodTotals(),
  val yesterday: WidgetPeriodTotals? = null,
  val days: List<WidgetDay> = emptyList(),
  val accounts: List<WidgetQuotaAccount> = emptyList(),
  val limitsAuthority: String? = null,
  val limitsUpdatedAt: String? = null,
  val onlineDevices: Int = 0,
  val totalDevices: Int = 0,
  val lastAttemptMs: Long = 0L,
  val lastError: String? = null,
  val lastErrorKind: String? = null
) {
  val hasData: Boolean get() = capturedAtMs > 0L

  /** A failed attempt keeps the last good numbers and only records the failure. */
  fun withFailure(message: String, kind: String, nowMs: Long): WidgetSnapshot = copy(
    lastAttemptMs = nowMs,
    lastError = message,
    lastErrorKind = kind
  )

  companion object {
    const val SCHEMA_VERSION = 1
    const val FILE_NAME = "widget-snapshot.json"
  }
}

@Serializable
data class WidgetPeriodTotals(
  val tokens: Long = 0L,
  val costUsd: Double = 0.0,
  // Retained so an existing `widget-snapshot.json` keeps its shape. Widgets no
  // longer render a marker from it; provenance stays available to callers.
  val estimated: Boolean = false
)

@Serializable
data class WidgetDay(
  val date: String = "",
  val tokens: Long = 0L,
  val costUsd: Double = 0.0
)

/**
 * One quota row, already reduced to the single window the widget shows.
 *
 * The Hub can report several windows per account (session / weekly / billing).
 * A widget has room for one bar, so the mapper picks the window with the highest
 * used percentage — the same choice [com.igng.tokenmonitor.android.ui.components.findUrgentLimit]
 * makes for the in-app alert. The full window list stays in the app.
 */
@Serializable
data class WidgetQuotaAccount(
  val id: String = "",
  val provider: String = "",
  val accountLabel: String? = null,
  val planLabel: String? = null,
  val status: String? = null,
  val windowKind: String? = null,
  val windowLabel: String? = null,
  val usedPercent: Double? = null,
  val remainingPercent: Double? = null,
  val resetsAt: String? = null,
  val resetDescription: String? = null,
  val balanceAmount: Double? = null,
  val balanceCurrency: String? = null,
  val updatedAt: String? = null
) {
  val isUnauthorized: Boolean
    get() = status?.trim()?.lowercase(Locale.US) == "unauthorized"

  val isFetchError: Boolean
    get() = status?.trim()?.lowercase(Locale.US) in FETCH_ERROR_STATUS

  val isBalanceOnly: Boolean
    get() = remainingPercent == null && balanceAmount != null

  /** Lower is more urgent. Mirrors the order the quota widget renders. */
  val urgency: Int
    get() = when {
      isUnauthorized -> 0
      isFetchError -> 1
      remainingPercent != null && remainingPercent <= 10.0 -> 2
      remainingPercent != null && remainingPercent <= 25.0 -> 3
      remainingPercent != null -> 4
      isBalanceOnly -> 5
      else -> 6
    }

  private companion object {
    val FETCH_ERROR_STATUS = setOf("unavailable", "error", "ratelimited", "sourceratelimited")
  }
}

object WidgetQuotaOrdering {
  /**
   * Unauthorized and fetch-window failures come before low percentages: an
   * expired credential means the percentage is not a fact any more.
   */
  fun sorted(accounts: List<WidgetQuotaAccount>): List<WidgetQuotaAccount> =
    accounts.sortedWith(
      compareBy<WidgetQuotaAccount> { it.urgency }
        .thenBy { it.remainingPercent ?: Double.MAX_VALUE }
        .thenBy { it.id }
    )
}
