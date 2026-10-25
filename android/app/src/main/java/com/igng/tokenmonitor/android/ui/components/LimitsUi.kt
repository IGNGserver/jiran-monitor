package com.igng.tokenmonitor.android.ui.components

import com.igng.tokenmonitor.android.ui.components.FluentIcons
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.ui.res.painterResource
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.igng.tokenmonitor.android.data.model.LimitProviderDto
import com.igng.tokenmonitor.android.data.model.LimitWindowDto
import com.igng.tokenmonitor.android.data.model.LimitsDto
import com.igng.tokenmonitor.android.ui.theme.FluentMotion
import com.igng.tokenmonitor.android.ui.theme.FluentShapeDefaults
import com.igng.tokenmonitor.android.ui.theme.FluentSpacingDefaults
import com.igng.tokenmonitor.android.ui.theme.FluentTypeRamp
import com.igng.tokenmonitor.android.ui.theme.LocalFluentColors
import java.util.Locale
import kotlin.math.min

private val providerLabels = mapOf(
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

fun providerDisplayName(id: String): String =
  providerLabels[id.lowercase(Locale.US)] ?: id.replaceFirstChar {
    if (it.isLowerCase()) it.titlecase(Locale.getDefault()) else it.toString()
  }

/**
 * `rememberSaveable` saver for the set of expanded limit rows.
 *
 * A `Set<String>` is not one of the types the default saver can bundle, so the
 * screen's "which rows are open" state would be lost on rotation without this.
 * The value round-trips as a plain list.
 *
 * Deliberately a *local* value built inside the composable rather than a
 * top-level `val`: a top-level Compose-typed property would run in this file's
 * class initializer, and the JVM unit tests (which cannot load
 * `androidx.compose.*` — see `docs/design/android-fluent2-contract.md`) reach
 * `limitRowIdentity` in this same file. A local keeps the file's `<clinit>`
 * Compose-free.
 */
@Composable
private fun rememberExpandedKeysSaver(): androidx.compose.runtime.saveable.Saver<Set<String>, Any> =
  remember {
    androidx.compose.runtime.saveable.listSaver<Set<String>, String>(
      save = { it.toList() },
      restore = { it.toSet() }
    )
  }
fun windowKindLabel(kind: String): String = when (kind.lowercase(Locale.US)) {
  "session" -> "会话"
  "weekly" -> "每周"
  "billing" -> "账期"
  // The shared schema also has `named` (a labelled allowance) and `credits`;
  // without these the row printed the raw English enum token.
  "named" -> "额度"
  "credits" -> "积分"
  else -> kind
}

/**
 * The identity of one limit-account row.
 *
 * `accountKey` is the Hub's stable identity and is preferred. When an account
 * has none, every identity field it *does* carry is folded in; only as a last
 * resort is the row's index used, and that index is deliberately kept out of the
 * stable part so a reorder does not change the row's identity. The old fallback
 * put the index in the middle of the string, so a refresh that inserted, removed
 * or reordered an account renamed every row after it and silently collapsed the
 * one the user had expanded.
 *
 * Pure and free of Compose types, so the JVM suite can pin it.
 */
internal fun limitRowIdentity(provider: LimitProviderDto, index: Int): String {
  val accountKey = provider.accountKey?.takeIf { it.isNotBlank() }
  if (accountKey != null) return "key:$accountKey"
  val providerId = provider.provider.trim().lowercase(Locale.US)
  // Fields that actually distinguish two accounts of the same provider. When one
  // exists the index is deliberately excluded, so a reorder cannot rename the row.
  val fields = listOf(
    provider.accountEmail,
    provider.accountLabel,
    provider.accountName,
    provider.workspaceKind,
    provider.plan
  ).mapNotNull { it?.takeIf { value -> value.isNotBlank() } }
  if (fields.isEmpty()) return "row:$providerId#$index"
  return "row:$providerId|" + fields.joinToString("|")
}

/**
 * Every metered window of one account, in the order the Hub sent it.
 *
 * Deliberately unbounded: an account can carry more than the three cadences the
 * old row showed (Antigravity bills several models, each with a session and a
 * weekly window). Truncating here hides quota the user is about to run out of,
 * so the list length follows the payload rather than the layout.
 *
 * Pure and Compose-free so the JVM suite can pin the "no truncation" property.
 */
internal fun meteredLimitWindows(provider: LimitProviderDto): List<LimitWindowDto> =
  provider.windows.filter { window -> window.showMeter && windowUsedPercent(window) != null }

internal data class LimitWindowGroup(val title: String, val items: List<LimitWindowDto>)

internal data class GroupedLimitWindows(
  val groups: List<LimitWindowGroup>,
  val ungrouped: List<LimitWindowDto>
)

private val antigravityCadenceSuffix = Regex("""\s+(?:5-hour|weekly)$""", RegexOption.IGNORE_CASE)

/**
 * Antigravity reports one session + one weekly window per model, so a flat list
 * reads as six identical bars. The desktop renderer groups them by the label
 * prefix ("Gemini 3 Pro", "Claude Sonnet", …); this is the same rule, so both
 * surfaces describe the same account the same way. Returns `null` when nothing
 * carries a cadence suffix, which keeps every other provider on the flat layout.
 */
internal fun groupAntigravityWindows(windows: List<LimitWindowDto>): GroupedLimitWindows? {
  val groups = linkedMapOf<String, MutableList<LimitWindowDto>>()
  val ungrouped = mutableListOf<LimitWindowDto>()
  for (window in windows) {
    val label = window.label?.trim().orEmpty()
    val match = antigravityCadenceSuffix.find(label)
    val kind = window.kind.lowercase(Locale.US)
    if ((kind == "session" || kind == "weekly") && match != null) {
      val title = label.removeRange(match.range).trim().ifBlank { "General" }
      // The cadence moves into the group header, so the bar itself only needs to
      // say which window it is — the same substitution the desktop renderer makes.
      groups.getOrPut(title) { mutableListOf() } += window.copy(label = windowKindLabel(kind))
    } else {
      ungrouped += window
    }
  }
  if (groups.isEmpty()) return null
  return GroupedLimitWindows(
    groups = groups.map { (title, items) -> LimitWindowGroup(title, items.toList()) },
    ungrouped = ungrouped.toList()
  )
}

fun findUrgentLimit(limits: LimitsDto?): Pair<LimitProviderDto, Double>? {
  val providers = limits?.providers.orEmpty()
  // First priority: check for abnormal account/credential statuses
  for (provider in providers) {
    val status = provider.status?.trim()?.lowercase(Locale.US)
    if (status == "unauthorized") {
      return Pair(provider, -1.0)
    }
  }
  for (provider in providers) {
    val status = provider.status?.trim()?.lowercase(Locale.US)
    if (status == "unavailable" || status == "error" || status == "ratelimited" || status == "sourceratelimited") {
      return Pair(provider, -2.0)
    }
  }

  // Second priority: check for low/exhausted quota
  var mostUrgent: Pair<LimitProviderDto, Double>? = null
  for (provider in providers) {
    val meterWindows = meteredLimitWindows(provider)
    val headlineUsed = meterWindows.mapNotNull { windowUsedPercent(it) }.maxOrNull() ?: continue
    val remaining = (100.0 - headlineUsed).coerceIn(0.0, 100.0)
    if (remaining <= 25.0) {
      if (mostUrgent == null || remaining < mostUrgent.second) {
        mostUrgent = Pair(provider, remaining)
      }
    }
  }
  return mostUrgent
}

@Composable
fun UrgentLimitAlertBar(
  provider: LimitProviderDto,
  remainingPercent: Double,
  onClick: () -> Unit,
  modifier: Modifier = Modifier
) {
  val colors = LocalFluentColors.current
  val isUnauthorized = remainingPercent == -1.0
  val isFetchError = remainingPercent == -2.0
  val isExhausted = remainingPercent == 0.0
  val isDanger = isUnauthorized || isExhausted
  val bg = if (isDanger) colors.errorBackground else colors.warningBackground
  val fg = if (isDanger) colors.errorForeground else colors.warningForeground
  val text = when {
    isUnauthorized -> "${providerDisplayName(provider.provider)} 凭证已过期，无法获取额度"
    isFetchError -> {
      val status = provider.status?.trim()?.lowercase(Locale.US)
      if (status == "ratelimited" || status == "sourceratelimited") {
        "${providerDisplayName(provider.provider)} 服务商正在限流"
      } else {
        "${providerDisplayName(provider.provider)} 额度获取失败，无法连接服务商"
      }
    }
    isExhausted -> "${providerDisplayName(provider.provider)} 额度已用尽"
    else -> "${providerDisplayName(provider.provider)} 额度告急，仅剩 ${String.format(Locale.US, "%.0f%%", remainingPercent)}"
  }

  Row(
    modifier
      .fillMaxWidth()
      .clip(FluentShapeDefaults.cardCorner)
      .background(bg)
      .border(0.5.dp, fg.copy(alpha = 0.35f), FluentShapeDefaults.cardCorner)
      .clickable(onClick = onClick)
      .padding(horizontal = FluentSpacingDefaults.l, vertical = FluentSpacingDefaults.s),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.SpaceBetween
  ) {
    Row(
      Modifier.weight(1f),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.s)
    ) {
      Icon(
        painter = painterResource(FluentIcons.AlertBadge),
        contentDescription = null,
        tint = fg,
        modifier = Modifier.size(16.dp)
      )
      Text(
        text,
        style = FluentTypeRamp.caption1,
        fontWeight = FontWeight.SemiBold,
        color = fg,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis
      )
    }
    Text(
      "查看",
      style = FluentTypeRamp.caption2,
      fontWeight = FontWeight.SemiBold,
      color = fg
    )
  }
}

// ─── Section ────────────────────────────────────────────────────────────────
//
// Fluent treats a limit as *utilisation*, so every account row carries a real
// progress bar plus a text status label — colour alone never states the fact
// (WCAG 1.4.1).  Homogeneous accounts share one card surface (`FluentCardList`)
// separated by hairlines instead of each getting its own Material card, and the
// per-window detail expands in place on Fluent's standard curve.

@Composable
fun LimitsSection(
  limits: LimitsDto?,
  modifier: Modifier = Modifier,
  title: String = "AI 工具限额",
  includeAllProviders: Boolean = false,
  maxAccounts: Int? = null
) {
  val raw = limits?.providers.orEmpty()
  val filtered = if (includeAllProviders) {
    raw
  } else {
    raw.filter { provider ->
      provider.windows.any { it.showMeter && windowUsedPercent(it) != null } ||
        provider.balanceUsd != null ||
        provider.balance?.amount != null ||
        provider.resetCredits != null ||
        !provider.status.isNullOrBlank()
    }
  }
  val providers = if (maxAccounts != null) filtered.take(maxAccounts.coerceIn(1, 12)) else filtered
  if (providers.isEmpty()) return

  // Row expansion is presentation-only state, so it survives refresh frames.  A lone
  // account opens itself: with nothing to scan against, a collapsed row would hide the
  // entire payload of the section.
  //
  // `identityContent` names the *identity* of the provider list, not its instance: a
  // stats frame decodes a brand-new list every few seconds, and keying the effect on the
  // list object would re-run (and, via the effect below, close) the expanded rows on
  // every tick.
  val providerKeys = providers.mapIndexed { index, provider -> limitRowKey(provider, index) }
  val identityContent = providerKeys.joinToString("\u0000")
  // What the user has opened, kept across refresh frames *and* rotation: it is a
  // per-visit UI state, so it is saveable rather than merely remembered.
  var expandedKeys by rememberSaveable(stateSaver = rememberExpandedKeysSaver()) {
    mutableStateOf(
      if (providerKeys.size == 1) setOf(providerKeys.first()) else emptySet<String>()
    )
  }
  // Intersected, not reset, when the account set changes: a refresh that adds or drops a
  // provider closes the expanded rows that are *gone* while leaving the ones still on
  // screen open. With a stable identity a row that merely moved keeps its open state.
  LaunchedEffect(identityContent) {
    expandedKeys = expandedKeys.intersect(providerKeys.toSet())
  }

  FluentCardList(modifier = modifier) {
    Column(
      Modifier
        .fillMaxWidth()
        .padding(
          start = FluentSpacingDefaults.l,
          end = FluentSpacingDefaults.l,
          top = FluentSpacingDefaults.m,
          bottom = FluentSpacingDefaults.s
        )
    ) {
      SectionHeader(
        title = title,
        subtitle = limits?.updatedAt?.let { "更新 ${formatRelativeTime(it)}" } ?: "来自 Hub 聚合"
      )
    }
    providers.forEachIndexed { index, provider ->
      val key = limitRowKey(provider, index)
      val peers = providers.filter {
        it.provider.trim().equals(provider.provider.trim(), ignoreCase = true)
      }
      // index + 1 so the first account is also separated from the header block.
      LimitAccountRow(
        provider = provider,
        peers = peers,
        expanded = key in expandedKeys,
        dividerAbove = true,
        onToggle = {
          expandedKeys = if (key in expandedKeys) expandedKeys - key else expandedKeys + key
        }
      )
    }
  }
}

private fun limitRowKey(provider: LimitProviderDto, index: Int): String =
  limitRowIdentity(provider, index)

@Composable
private fun LimitAccountRow(
  provider: LimitProviderDto,
  peers: List<LimitProviderDto>,
  expanded: Boolean,
  dividerAbove: Boolean,
  onToggle: () -> Unit
) {
  val colors = LocalFluentColors.current
  val displayName = limitAccountDisplayName(provider, peers)
  val meta = buildList {
    add(providerDisplayName(provider.provider))
    limitPlanLabel(provider).takeIf { it.isNotBlank() }?.let { add(it) }
    provider.source?.takeIf { it.isNotBlank() }?.let { add(it.uppercase(Locale.US)) }
    provider.accountEmail
      ?.takeIf { it.isNotBlank() && it != displayName }
      ?.let { add(it) }
    provider.status?.takeIf { it.isNotBlank() }?.let { add(it) }
  }.joinToString(" · ")

  // `showMeter == false` means the account deliberately hides the window;
  // `windowUsedPercent == null` means the provider never told us.  Those are
  // different facts and stay different here.
  val meterWindows = meteredLimitWindows(provider)
  val unavailableWindows = provider.windows.filter { it.showMeter && windowUsedPercent(it) == null }
  val headlineUsed = meterWindows.mapNotNull { windowUsedPercent(it) }.maxOrNull()
  val headlineRemaining = headlineUsed?.let { (100.0 - it).coerceIn(0.0, 100.0) }
  val status = limitStatus(headlineRemaining, provider.status)
  val balanceLines = limitBalanceLines(provider)

  Column(Modifier.fillMaxWidth()) {
    FluentListRow(
      primary = displayName,
      secondary = meta.ifBlank { null },
      tertiary = balanceLines.firstOrNull(),
      leading = { ClientMonogram(provider.provider, size = 32.dp) },
      dividerAbove = dividerAbove,
      trailingPrimary = headlineRemaining?.let { String.format(Locale.US, "%.0f%%", it) },
      trailingSecondary = if (headlineRemaining != null) "剩余" else null,
      trailing = {
        Row(
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.xs)
        ) {
          LimitStatusChip(status)
          LimitExpander(expanded)
        }
      },
      onClick = onToggle
    )
    AnimatedVisibility(
      visible = expanded,
      enter = expandVertically(
        animationSpec = tween(FluentMotion.normal, easing = FluentMotion.standard)
      ) + fadeIn(tween(FluentMotion.normal, easing = FluentMotion.standard)),
      exit = shrinkVertically(
        animationSpec = tween(FluentMotion.normal, easing = FluentMotion.standard)
      ) + fadeOut(tween(FluentMotion.fast, easing = FluentMotion.accelerate))
    ) {
      Column(
        Modifier
          .fillMaxWidth()
          .background(colors.neutralLayerInner)
          .padding(
            start = FluentSpacingDefaults.l,
            end = FluentSpacingDefaults.l,
            top = FluentSpacingDefaults.s,
            bottom = FluentSpacingDefaults.m
          ),
        verticalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.m)
      ) {
        balanceLines.forEach { line ->
          Text(
            line,
            style = FluentTypeRamp.caption1,
            color = colors.neutralForeground2
          )
        }

        // Every metered window is rendered, not just the first three: an account
        // with more cadences than that used to hide the rest behind the fold.
        val groupedWindows = if (provider.provider.trim().equals("antigravity", ignoreCase = true)) {
          groupAntigravityWindows(meterWindows)
        } else {
          null
        }
        if (groupedWindows != null) {
          groupedWindows.groups.forEach { group ->
            LimitWindowGroupBlock(group.title, group.items)
          }
          groupedWindows.ungrouped.forEach { window ->
            LimitWindowBar(window)
          }
        } else {
          meterWindows.forEach { window ->
            LimitWindowBar(window)
          }
        }

        val unavailableLabels = unavailableWindows
          .map { window -> window.label?.takeIf { it.isNotBlank() } ?: windowKindLabel(window.kind) }
          .distinct()
          .joinToString("、")
        if (unavailableLabels.isNotBlank()) {
          Text(
            "$unavailableLabels · 未知",
            style = FluentTypeRamp.caption1,
            color = colors.neutralForeground3
          )
        }

        provider.windows
          .mapNotNull { window -> window.detail?.takeIf { it.isNotBlank() } }
          .distinct()
          .forEach { detail ->
            Text(
              detail,
              style = FluentTypeRamp.caption2,
              color = colors.neutralForeground2,
              maxLines = 2,
              overflow = TextOverflow.Ellipsis
            )
          }
      }
    }
  }
}

/**
 * One model's cadence pair (session + weekly) under its own caption. Antigravity
 * accounts report these per model; without the caption the bars are anonymous.
 */
@Composable
private fun LimitWindowGroupBlock(
  title: String,
  windows: List<LimitWindowDto>
) {
  val colors = LocalFluentColors.current
  Column(verticalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.s)) {
    Text(
      title,
      style = FluentTypeRamp.caption1,
      fontWeight = FontWeight.SemiBold,
      color = colors.neutralForeground2
    )
    Column(verticalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.m)) {
      windows.forEach { window ->
        LimitWindowBar(window)
      }
    }
  }
}

private fun limitBalanceLines(provider: LimitProviderDto): List<String> = buildList {
  provider.balanceUsd?.let { add("USD 余额 " + formatMoneyAmount(it, "USD")) }
  provider.balance?.let { balance ->
    balance.amount?.let { amount ->
      add("余额 " + formatMoneyAmount(amount, balance.currency))
    }
    balance.todaySpend?.let { spend ->
      add("今日消耗 " + formatMoneyAmount(spend, balance.currency))
    }
    balance.weekSpend?.let { spend ->
      add("本周消耗 " + formatMoneyAmount(spend, balance.currency))
    }
    balance.monthSpend?.let { spend ->
      add("本月消耗 " + formatMoneyAmount(spend, balance.currency))
    }
    balance.allTimeSpend?.let { spend ->
      add("累计消耗 " + formatMoneyAmount(spend, balance.currency))
    }
  }
  val credits = provider.resetCredits
  if (credits != null) {
    val available = credits.availableCount ?: credits.available ?: credits.remaining
    val total = credits.totalCount ?: credits.total ?: credits.limit
    if (available != null || total != null) {
      val body = buildString {
        if (available != null) append(available.toInt())
        if (total != null) {
          if (isNotEmpty()) append(" / ")
          append(total.toInt())
        }
      }
      add("重置额度 $body")
    }
  }
}

// ─── Utilisation ────────────────────────────────────────────────────────────

/**
 * One limit window as a Fluent progress row: label and reset hint on the lead,
 * the remaining figure and its text status on the trail, a 4dp bar underneath.
 */
@Composable
private fun LimitWindowBar(
  window: LimitWindowDto,
  modifier: Modifier = Modifier
) {
  val colors = LocalFluentColors.current
  val used = windowUsedPercent(window) ?: return
  val remaining = (100.0 - used).coerceIn(0.0, 100.0)
  val status = limitStatus(remaining)
  val fill by animateColorAsState(
    targetValue = status.accent,
    animationSpec = tween(FluentMotion.normal, easing = FluentMotion.standard),
    label = "limitBarFill"
  )
  val fraction = animateGrowFraction(
    target = (used / 100f).toFloat(),
    durationMillis = FluentMotion.slow
  )

  Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.xs)) {
    Row(
      Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically
    ) {
      Column(Modifier.weight(1f)) {
        Text(
          buildString {
            append(window.label?.takeIf { it.isNotBlank() } ?: windowKindLabel(window.kind))
            if (window.metric?.equals("credits", ignoreCase = true) == true) append(" · 积分")
          },
          style = FluentTypeRamp.body2,
          color = colors.neutralForeground1,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis
        )
        window.resetsAt?.let {
          Text(
            "重置 ${formatRelativeTime(it)}",
            style = FluentTypeRamp.caption2,
            color = colors.neutralForeground3,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
          )
        }
      }
      Spacer(Modifier.width(FluentSpacingDefaults.m))
      Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.xs)
      ) {
        Text(
          "剩余 " + String.format(Locale.US, "%.0f%%", remaining),
          style = FluentTypeRamp.body2,
          fontWeight = FontWeight.SemiBold,
          color = status.accent,
          maxLines = 1
        )
        Text(
          status.label,
          style = FluentTypeRamp.caption2,
          color = status.accent,
          maxLines = 1
        )
      }
    }
    QuotaBar(fraction = fraction, color = fill)
  }
}

/**
 * Fluent progress: a 4dp track on `neutralBackground3` with squared
 * (`controlCorner`) ends — Material's full pill reads as decoration here, while
 * Fluent's bar is a measurement.
 */
@Composable
private fun QuotaBar(
  fraction: Float,
  color: Color,
  modifier: Modifier = Modifier
) {
  val colors = LocalFluentColors.current
  Box(
    modifier
      .fillMaxWidth()
      .height(4.dp)
      .clip(FluentShapeDefaults.controlCorner)
      .background(colors.neutralForeground3.copy(alpha = 0.18f))
  ) {
    Box(
      Modifier
        .fillMaxWidth(fraction.coerceIn(0f, 1f))
        .height(4.dp)
        .background(color, FluentShapeDefaults.controlCorner)
    )
  }
}

/**
 * Status alias resolution.  `errorForeground` is reserved for a spent quota;
 * "approaching the limit" is a warning, which is Fluent's own mapping and keeps
 * red meaningful in a list that is otherwise red/green for good/bad.
 */
@Composable
private fun limitStatus(remainingPercent: Double?, providerStatus: String? = null): LimitStatus {
  val colors = LocalFluentColors.current
  val normalizedStatus = providerStatus?.trim()?.lowercase(Locale.US)
  if (normalizedStatus == "unauthorized") {
    return LimitStatus(
      label = "凭证失效",
      accent = colors.errorForeground,
      tint = colors.errorBackground
    )
  }
  if (normalizedStatus == "ratelimited" || normalizedStatus == "sourceratelimited") {
    return LimitStatus(
      label = "限流中",
      accent = colors.warningForeground,
      tint = colors.warningBackground
    )
  }
  if (normalizedStatus == "unavailable" || normalizedStatus == "error") {
    return LimitStatus(
      label = "获取失败",
      accent = colors.warningForeground,
      tint = colors.warningBackground
    )
  }
  if (normalizedStatus == "notconfigured") {
    return LimitStatus(
      label = "未配置",
      accent = colors.neutralForeground3,
      tint = colors.neutralForeground3.copy(alpha = 0.18f)
    )
  }
  return when (limitRemainingTone(remainingPercent)) {
    LimitRemainingTone.Unknown -> LimitStatus(
      label = "未知",
      accent = colors.neutralForeground3,
      tint = colors.neutralForeground3.copy(alpha = 0.18f)
    )
    LimitRemainingTone.Ok -> LimitStatus(
      label = "充裕",
      accent = colors.successForeground,
      tint = colors.successBackground
    )
    LimitRemainingTone.Warn -> LimitStatus(
      label = "接近上限",
      accent = colors.warningForeground,
      tint = colors.warningBackground
    )
    LimitRemainingTone.Critical -> if ((remainingPercent ?: 0.0) <= 0.0) {
      LimitStatus(
        label = "已用尽",
        accent = colors.errorForeground,
        tint = colors.errorBackground
      )
    } else {
      LimitStatus(
        label = "即将用尽",
        accent = colors.warningForeground,
        tint = colors.warningBackground
      )
    }
  }
}

private class LimitStatus(
  val label: String,
  val accent: Color,
  val tint: Color
)

/** Tinted badge carrying the status *word* next to its colour. */
@Composable
private fun LimitStatusChip(status: LimitStatus, modifier: Modifier = Modifier) {
  val accent by animateColorAsState(
    targetValue = status.accent,
    animationSpec = tween(FluentMotion.normal, easing = FluentMotion.standard),
    label = "limitChipAccent"
  )
  val tint by animateColorAsState(
    targetValue = status.tint,
    animationSpec = tween(FluentMotion.normal, easing = FluentMotion.standard),
    label = "limitChipTint"
  )
  Row(
    modifier
      .clip(FluentShapeDefaults.controlCorner)
      .background(tint)
      .border(0.5.dp, accent.copy(alpha = 0.35f), FluentShapeDefaults.controlCorner)
      .padding(horizontal = FluentSpacingDefaults.s, vertical = FluentSpacingDefaults.xxs),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.xs)
  ) {
    Box(
      Modifier
        .size(6.dp)
        .clip(FluentShapeDefaults.smallCorner)
        .background(accent)
    )
    Text(
      status.label,
      style = FluentTypeRamp.caption2,
      fontWeight = FontWeight.SemiBold,
      color = accent,
      maxLines = 1
    )
  }
}

@Composable
private fun LimitExpander(expanded: Boolean, modifier: Modifier = Modifier) {
  val colors = LocalFluentColors.current
  val rotation by animateFloatAsState(
    targetValue = if (expanded) 180f else 0f,
    animationSpec = tween(FluentMotion.normal, easing = FluentMotion.standard),
    label = "limitExpander"
  )
  Icon(
        painter = painterResource(FluentIcons.ChevronDown),
    contentDescription = if (expanded) "收起账户明细" else "展开账户明细",
    modifier = modifier
      .size(20.dp)
      .rotate(rotation),
    tint = colors.neutralForeground3
  )
}

/**
 * Ring variant of the utilisation read-out.  The section itself now uses
 * [QuotaBar]; this stays published for surfaces that need a compact radial
 * gauge, retokenised to the Fluent aliases.
 */

enum class LimitRemainingTone { Ok, Warn, Critical, Unknown }

/** Desktop-aligned remaining thresholds: <20 critical, <50 warn. */
fun limitRemainingTone(remainingPercent: Double?): LimitRemainingTone {
  if (remainingPercent == null || remainingPercent.isNaN()) return LimitRemainingTone.Unknown
  val value = remainingPercent
  return when {
    value < 20.0 -> LimitRemainingTone.Critical
    value < 50.0 -> LimitRemainingTone.Warn
    else -> LimitRemainingTone.Ok
  }
}

fun windowUsedPercent(window: LimitWindowDto): Double? {
  window.usedPercent?.let { return it.coerceIn(0.0, 100.0) }
  val used = window.used
  val limit = window.limit
  if (used != null && limit != null && limit > 0) {
    return min(100.0, (used / limit) * 100.0)
  }
  window.remainingPercent?.let { return (100.0 - it).coerceIn(0.0, 100.0) }
  return null
}
