package com.igng.tokenmonitor.android.ui.components

import com.igng.tokenmonitor.android.data.model.ClientMeasurementDto
import com.igng.tokenmonitor.android.data.model.HistoryDayDto
import com.igng.tokenmonitor.android.data.model.parseHistoryDate
import com.igng.tokenmonitor.android.data.model.parseHistoryMonth
import java.text.NumberFormat
import java.time.Duration
import java.time.Instant
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.abs

private val integerFormat: NumberFormat = NumberFormat.getIntegerInstance(Locale.getDefault())
private val shortDateTime: DateTimeFormatter =
  DateTimeFormatter.ofPattern("MM-dd HH:mm", Locale.getDefault())

fun formatTokens(value: Long, compact: Boolean = false): String {
  if (!compact) return integerFormat.format(value) + " token"
  val abs = abs(value.toDouble())
  val formatted = when {
    abs >= 1_000_000_000 -> String.format(Locale.US, "%.1fB", value / 1_000_000_000.0)
    abs >= 1_000_000 -> String.format(Locale.US, "%.1fM", value / 1_000_000.0)
    abs >= 10_000 -> String.format(Locale.US, "%.1fK", value / 1_000.0)
    else -> integerFormat.format(value)
  }
  return "$formatted token"
}

fun formatTokensShort(value: Long): String {
  val abs = abs(value.toDouble())
  return when {
    abs >= 1_000_000_000 -> String.format(Locale.US, "%.1fB", value / 1_000_000_000.0)
    abs >= 1_000_000 -> String.format(Locale.US, "%.1fM", value / 1_000_000.0)
    abs >= 1_000 -> String.format(Locale.US, "%.1fK", value / 1_000.0)
    else -> integerFormat.format(value)
  }
}

/**
 * A cost figure in the user's display currency.
 *
 * `formatUsd` hard-codes `US$`, which was the only currency the client could speak
 * even though the Hub serves display rates for four.  [convert] is the USD→display
 * multiplier and 1.0 when the target is USD or no rate block has arrived yet — a
 * missing rate must not silently print a converted-looking number, so callers pass
 * `null` and get USD back with the symbol to match.
 */
fun formatMoney(
  value: Double,
  currency: String = "USD",
  rate: Double? = null,
  compact: Boolean = false
): String {
  if (currency == "USD" || rate == null || rate <= 0.0) return formatUsd(value, compact)
  val symbol = currencySymbols[currency] ?: "$currency "
  val converted = value * rate
  val magnitude = abs(converted)
  if (compact && magnitude >= 1_000) {
    return symbol + String.format(Locale.US, "%,.0f", converted)
  }
  val decimals = if (magnitude < 1 && currency != "TWD" && currency != "HKD") 4 else 2
  return symbol + String.format(Locale.US, "%,.${decimals}f", converted)
}

private val currencySymbols = mapOf(
  "USD" to "US$",
  "CNY" to "¥",
  "TWD" to "NT$",
  "HKD" to "HK$"
)

fun formatUsd(value: Double, compact: Boolean = false): String {
  if (compact && abs(value) >= 1000) {
    return "US$" + String.format(Locale.US, "%.1fK", value / 1000.0)
  }
  val decimals = when {
    abs(value) >= 100 -> 2
    abs(value) >= 1 -> 3
    else -> 4
  }
  return "US$" + String.format(Locale.US, "%.${decimals}f", value)
}

/**
 * Credits in the provider's own unit — no currency symbol and no conversion.
 * Qoder has never published a credit-to-USD or credit-to-token rate, so folding
 * credits into a cost would invent one.
 */
fun formatCredits(value: Double): String =
  if (value >= 100) String.format(Locale.US, "%.0f 积分", value)
  else String.format(Locale.US, "%.1f 积分", value)

fun formatPercent(part: Long, total: Long): String {
  if (total <= 0L) return "0%"
  val pct = part.toDouble() / total.toDouble() * 100.0
  return if (pct >= 10) String.format(Locale.US, "%.0f%%", pct)
  else String.format(Locale.US, "%.1f%%", pct)
}

/** Best-effort parse of hub ISO timestamps (with or without zone). */
fun parseInstant(raw: String?): Instant? {
  if (raw.isNullOrBlank()) return null
  val text = raw.trim()
  return try {
    Instant.parse(text)
  } catch (_: Exception) {
    try {
      OffsetDateTime.parse(text).toInstant()
    } catch (_: Exception) {
      try {
        LocalDateTime.parse(text).atZone(ZoneId.systemDefault()).toInstant()
      } catch (_: Exception) {
        null
      }
    }
  }
}

/** Relative label like "3 分钟前" / "2 小时后"; falls back to compact local time. */
fun formatRelativeTime(raw: String?, now: Instant = Instant.now()): String {
  val instant = parseInstant(raw) ?: return raw?.takeIf { it.isNotBlank() } ?: "未知"
  val seconds = Duration.between(instant, now).seconds
  val absSec = abs(seconds)
  val future = seconds < 0
  val label = when {
    absSec < 45 -> "刚刚"
    absSec < 90 -> "1 分钟"
    absSec < 3600 -> "${absSec / 60} 分钟"
    absSec < 5400 -> "1 小时"
    absSec < 86400 -> "${absSec / 3600} 小时"
    absSec < 172800 -> "1 天"
    absSec < 86400 * 30 -> "${absSec / 86400} 天"
    else -> {
      return LocalDateTime.ofInstant(instant, ZoneId.systemDefault()).format(shortDateTime)
    }
  }
  if (label == "刚刚") return label
  return if (future) "${label}后" else "${label}前"
}

fun formatIsoCompact(raw: String?): String {
  val instant = parseInstant(raw) ?: return raw?.takeIf { it.isNotBlank() } ?: "未知"
  return LocalDateTime.ofInstant(instant, ZoneId.systemDefault()).format(shortDateTime)
}

/** A chart label that remains total even when a legacy Hub sends an invalid date. */
fun formatHistoryDayLabel(raw: String?): String =
  parseHistoryDate(raw)?.let { "${it.monthValue}/${it.dayOfMonth}" } ?: "—"

/** A chart label for `YYYY-MM` keys and timestamp-shaped legacy month values. */
fun formatHistoryMonthLabel(raw: String?): String =
  parseHistoryMonth(raw)?.let { "${it.year.toString().takeLast(2)}/${it.monthValue.toString().padStart(2, '0')}" }
    ?: "—"

data class ShareEntry(
  val key: String,
  val tokens: Long,
  val costUsd: Double = 0.0,
  /**
   * Some or all of [tokens] were reconstructed from message content rather than
   * read from an exact provider meter. The flag is retained for callers that
   * rank or annotate rows; no surface prefixes the number with a marker anymore.
   */
  val estimated: Boolean = false,
  /**
   * Credits in the provider's own unit. Qoder bills in credits, and the adapter
   * reconstructs its token total from content, so for Qoder this is the only
   * provider-exact figure.
   */
  val credits: Double? = null
) {
  /** True when this row has nothing to show in tokens but does have credits. */
  val creditsOnly: Boolean
    get() = credits != null && credits > 0.0 && tokens == 0L
}

fun topShareEntries(
  tokens: Map<String, Long>,
  costs: Map<String, Double> = emptyMap(),
  estimated: Map<String, Boolean> = emptyMap(),
  credits: Map<String, Double> = emptyMap(),
  measurements: Map<String, ClientMeasurementDto> = emptyMap(),
  limit: Int = 6
): List<ShareEntry> {
  // Qoder is in `credits` and not in `tokens`, so a tokens-only map is not empty
  // usage — it is usage the old code threw away.  Seed the key set from both.
  val keys = (tokens.keys + credits.keys).toSet()
  if (keys.isEmpty()) return emptyList()
  val sorted = keys.sortedByDescending { key ->
    // A credits-only row sorts by its credit magnitude converted to nothing useful
    // against tokens, so rank credits-only rows behind every counted row rather than
    // pretending 0 tokens means "least used" in the middle of the list.
    tokens[key] ?: 0L
  }
  fun entryFor(key: String) = ShareEntry(
    key = key,
    tokens = tokens[key] ?: 0L,
    costUsd = costs[key] ?: 0.0,
    estimated = measurements[key]?.tokens == "estimated" || estimated[key] == true,
    credits = credits[key] ?: measurements[key]?.meters?.get("credits")?.value
  )
  if (sorted.size <= limit) return sorted.map(::entryFor)
  val head = sorted.take(limit - 1)
  val rest = sorted.drop(limit - 1)
  val otherTokens = rest.sumOf { tokens[it] ?: 0L }
  val otherCost = rest.sumOf { costs[it] ?: 0.0 }
  val otherCredits = rest.mapNotNull { credits[it] }.takeIf { it.isNotEmpty() }?.sum()
  return head.map(::entryFor) +
    ShareEntry(
      key = "其他",
      tokens = otherTokens,
      costUsd = otherCost,
      // The aggregate of a mixed set is never presented as exact.
      estimated = rest.any { estimated[it] == true },
      credits = otherCredits
    )
}


fun devicePlatformLabel(
  platform: String?,
  osName: String? = null,
  osVersion: String? = null
): String {
  val base = when {
    platform.isNullOrBlank() -> ""
    platform.contains("darwin", true) || platform.contains("mac", true) -> "macOS"
    platform.contains("win", true) -> "Windows"
    platform.contains("linux", true) -> "Linux"
    else -> platform
  }
  val name = osName?.trim().orEmpty().ifBlank { base }
  val version = osVersion?.trim().orEmpty()
  return listOf(name, version).filter { it.isNotBlank() }.joinToString(" ").ifBlank { "—" }
}

fun countActiveDays(
  daily: List<HistoryDayDto>,
  window: String = "all"
): Int {
  var days = daily
  if (window == "year" && days.isNotEmpty()) {
    val cutoff = java.time.LocalDate.now().minusDays(365).toString()
    days = days.filter { it.date >= cutoff }
  }
  return days.count { it.tokens > 0.0 || it.cost > 0.0 }
}

fun heatmapValue(day: HistoryDayDto, metric: String = "tokens"): Double {
  return if (metric == "cost") kotlin.math.max(0.0, day.cost) else kotlin.math.max(0.0, day.tokens)
}

fun agentRuntimeLabel(runtime: String?): String {
  val raw = runtime?.trim().orEmpty()
  if (raw.isEmpty()) return ""
  val value = raw.lowercase()
  return when {
    value == "widget" || value.contains("electron") || value.contains("widget") -> "widget"
    value.contains("headless") || value == "agent" -> "headless-agent"
    value.contains("embedded") -> "legacy"
    else -> raw
  }
}

fun clientStatusLabel(state: String?): String = when (state?.trim()?.lowercase()) {
  "active" -> "活跃"
  "waiting" -> "等待"
  "missing" -> "未发现"
  else -> state.orEmpty()
}

fun wslStatusLabel(state: String?): String = when (state?.trim()?.lowercase()) {
  "active" -> "活跃"
  "no-data" -> "无数据"
  "not-running" -> "未运行"
  "not-installed" -> "未安装"
  "disabled" -> "已禁用"
  else -> state.orEmpty()
}

fun formatMoneyAmount(amount: Double?, currency: String? = null): String {
  if (amount == null || !amount.isFinite()) return "—"
  val cur = currency?.trim().orEmpty()
  val body = if (kotlin.math.abs(amount) >= 100) {
    String.format(java.util.Locale.US, "%.0f", amount)
  } else {
    String.format(java.util.Locale.US, "%.2f", amount)
  }
  return if (cur.isBlank()) body else "$body $cur"
}

fun limitPlanLabel(provider: com.igng.tokenmonitor.android.data.model.LimitProviderDto): String {
  val planLabel = provider.planLabel?.trim().orEmpty()
  if (planLabel.isNotEmpty()) return planLabel
  val plan = provider.plan?.trim().orEmpty().ifEmpty { provider.planType?.trim().orEmpty() }
  if (plan.isNotEmpty()) return plan
  val email = provider.accountEmail?.trim().orEmpty()
  val label = provider.accountLabel?.trim().orEmpty()
  if (email.isNotEmpty() && label.isNotEmpty() && !label.equals(email, ignoreCase = true)) return label
  return ""
}

fun limitAccountDisplayName(
  provider: com.igng.tokenmonitor.android.data.model.LimitProviderDto,
  peers: List<com.igng.tokenmonitor.android.data.model.LimitProviderDto> = emptyList()
): String {
  val id = provider.provider.trim().lowercase()
  val email = provider.accountEmail?.trim().orEmpty()
  val accountName = provider.accountName?.trim().orEmpty()
  val accountLabel = provider.accountLabel?.trim().orEmpty()
  val workspace = accountName.ifEmpty {
    if (provider.workspaceKind?.trim().equals("personal", ignoreCase = true)) "个人" else ""
  }
  if (id == "codex") {
    if (email.isNotEmpty() && workspace.isNotEmpty()) {
      val sameEmail = peers.count {
        it.accountEmail?.trim().orEmpty().equals(email, ignoreCase = true)
      } > 1
      return if (sameEmail) "$email · $workspace" else email
    }
    return email.ifEmpty { workspace.ifEmpty { accountLabel.ifEmpty { "Codex" } } }
  }
  return accountName.ifEmpty {
    accountLabel.ifEmpty {
      email.ifEmpty { id.ifEmpty { "账户" } }
    }
  }
}

/**
 * Connection label for a device row.
 *
 * `stale` alone is not enough: the Hub keeps a snapshot for `staleAfterMs`
 * (10 minutes by default), so a device that stopped reporting still reads "在线"
 * for that whole window, and a device whose every client reports `missing` reads
 * online too. The backend already publishes the per-client truth in
 * `clientStatus`, so use it.
 */
fun deviceConnectionLabel(stale: Boolean, clientStatus: Map<String, String>?): String {
  if (stale) return "离线"
  val states = clientStatus.orEmpty().values.map { it.trim().lowercase() }.filter { it.isNotEmpty() }
  return when {
    states.isEmpty() -> "在线"
    states.all { it == "missing" } -> "未发现客户端"
    states.any { it == "active" } -> "在线"
    states.any { it == "waiting" } -> "等待活动"
    else -> "在线"
  }
}

/** True when a device should count as online in the fleet summary. */
/**
 * The one definition of "this fleet row counts as online".
 *
 * The overview previously used `!stale` while the device page used
 * [deviceCountsAsOnline], so two screens on the same data could print different
 * online counts, and a device that is reporting but has every tracked client missing
 * was "online" in one place and not in the other.  There is now one predicate.
 */
fun fleetOnlineCount(devices: List<com.igng.tokenmonitor.android.data.model.DeviceDto>): Int =
  devices.count { deviceCountsAsOnline(it.stale, it.clientStatus) }

/** Stale last, then busiest first — shared so both fleet lists order identically. */
fun fleetSorted(devices: List<com.igng.tokenmonitor.android.data.model.DeviceDto>): List<com.igng.tokenmonitor.android.data.model.DeviceDto> =
  devices.sortedWith(
    compareBy<com.igng.tokenmonitor.android.data.model.DeviceDto> { it.stale }
      .thenByDescending { it.periods.today.totalTokens }
  )

fun deviceCountsAsOnline(stale: Boolean, clientStatus: Map<String, String>?): Boolean =
  !stale && deviceConnectionLabel(stale, clientStatus) == "在线"
