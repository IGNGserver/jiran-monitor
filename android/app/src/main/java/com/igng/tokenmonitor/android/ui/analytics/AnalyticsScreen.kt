package com.igng.tokenmonitor.android.ui.analytics

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.foundation.layout.Box
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import com.igng.tokenmonitor.android.ui.theme.FluentMotion
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import com.igng.tokenmonitor.android.data.model.PeriodDto
import com.igng.tokenmonitor.android.ui.ScopePeriod
import com.igng.tokenmonitor.android.ui.AnalyticsPeriodKind
import com.igng.tokenmonitor.android.ui.HubUiState
import com.igng.tokenmonitor.android.ui.HubViewModel
import com.igng.tokenmonitor.android.ui.NormalizedSessionRow
import com.igng.tokenmonitor.android.ui.components.FluentIcons
import com.igng.tokenmonitor.android.ui.components.FluentListRow
import com.igng.tokenmonitor.android.ui.components.rememberCostFormatter
import com.igng.tokenmonitor.android.ui.components.AppCard
import com.igng.tokenmonitor.android.ui.components.ClientBranding
import com.igng.tokenmonitor.android.ui.components.ClientMonogram
import com.igng.tokenmonitor.android.ui.components.ContributionHeatmap
import com.igng.tokenmonitor.android.ui.components.DailyTrendChart
import com.igng.tokenmonitor.android.ui.components.DateTimeRangePickerDialog
import com.igng.tokenmonitor.android.ui.components.DonutChart
import com.igng.tokenmonitor.android.ui.components.EmptyState
import com.igng.tokenmonitor.android.ui.components.FluentPageHeader
import com.igng.tokenmonitor.android.ui.components.FluentProgressRing
import com.igng.tokenmonitor.android.ui.components.FluentTabStrip
import com.igng.tokenmonitor.android.ui.components.FluentTopBar
import com.igng.tokenmonitor.android.ui.components.HeatmapMetric
import com.igng.tokenmonitor.android.ui.components.LimitsSection
import com.igng.tokenmonitor.android.ui.components.MonthlyTrendChart
import com.igng.tokenmonitor.android.ui.components.SectionHeader
import com.igng.tokenmonitor.android.ui.components.ScopeRangeNotice
import com.igng.tokenmonitor.android.ui.components.ShareBarList
import com.igng.tokenmonitor.android.ui.components.ShareEntry
import com.igng.tokenmonitor.android.ui.components.StackedDailyTrendChart
import com.igng.tokenmonitor.android.ui.components.TrendMetric
import com.igng.tokenmonitor.android.ui.components.TrendRange
import com.igng.tokenmonitor.android.ui.components.TrendStackMode
import com.igng.tokenmonitor.android.ui.components.countActiveDays
import com.igng.tokenmonitor.android.ui.components.formatTokensShort
import com.igng.tokenmonitor.android.ui.components.formatUsd
import com.igng.tokenmonitor.android.ui.components.rememberScrolledFlag
import com.igng.tokenmonitor.android.ui.components.takeMonths
import com.igng.tokenmonitor.android.ui.components.takeRange
import com.igng.tokenmonitor.android.ui.components.topShareEntries
import com.igng.tokenmonitor.android.data.model.parseHistoryDate
import com.igng.tokenmonitor.android.ui.haptics.HapticEvent
import com.igng.tokenmonitor.android.ui.haptics.rememberAppHaptics
import com.igng.tokenmonitor.android.ui.theme.FluentShapeDefaults
import com.igng.tokenmonitor.android.ui.theme.FluentSpacingDefaults
import com.igng.tokenmonitor.android.ui.theme.FluentTypeRamp
import com.igng.tokenmonitor.android.ui.theme.LocalFluentColors
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

// ─── Fluent 2 analytics shell ───────────────────────────────────────────────
//
// The three analytical lenses (客户端 / 模型 / 趋势) stay as first-level tabs, but
// every period / metric / window / stack switcher now renders inside the card
// whose contents it drives.  Previously a segmented button plus four FilterChip
// rows floated above the content, so it was not recoverable which selector fed
// which chart.

private val analyticsTabLabels = listOf("客户端", "模型", "趋势")

@Composable
fun AnalyticsScreen(
  state: HubUiState,
  viewModel: HubViewModel,
  navController: NavHostController,
  initialTab: Int = 0
) {
  var tabIndex by rememberSaveable(initialTab) { mutableIntStateOf(initialTab.coerceIn(0, analyticsTabLabels.lastIndex)) }
  val haptics = rememberAppHaptics()
  // One entrance per lens, keyed on the tab index, so changing tab replays it (a new view
  // arrived) while a stream frame, a retry or a re-scroll inside the selected lens does
  // not.  A `remember(tabIndex)` value rather than a `rememberSaveable` one: the tab is
  // saveable, so the index survives recreation and the entrance is not silently skipped.
  var entrancePlayed by rememberSaveable(tabIndex) { mutableStateOf(false) }
  LaunchedEffect(tabIndex) { entrancePlayed = true }
  val entrance by animateFloatAsState(
    targetValue = if (entrancePlayed) 1f else 0f,
    animationSpec = tween(FluentMotion.normal, easing = FluentMotion.decelerate),
    label = "analyticsEntrance"
  )
  val entranceLayer = Modifier.graphicsLayer { alpha = entrance }

  Column(Modifier.fillMaxSize()) {
    FluentPageHeader(
      title = "分析",
      subtitle = "份额、构成与趋势"
    )
    FluentTabStrip(
      options = analyticsTabLabels,
      selectedIndex = tabIndex,
      onSelect = { index ->
        haptics.perform(HapticEvent.Selection)
        tabIndex = index
      },
      modifier = Modifier.padding(bottom = FluentSpacingDefaults.xs),
      contentPadding = FluentSpacingDefaults.l,
    )

    // `graphicsLayer` rather than a container fade so the switch costs one layer and does
    // not re-measure the lens below it.
    Box(entranceLayer.fillMaxSize()) {
      when (tabIndex) {
        0 -> ShareAnalyticsTab(
          state = state,
          viewModel = viewModel,
          clients = true,
          onOpenDetail = { id ->
            navController.navigate("client/${encode(id)}")
          }
        )
        1 -> ShareAnalyticsTab(
          state = state,
          viewModel = viewModel,
          clients = false,
          onOpenDetail = { id ->
            navController.navigate("model/${encode(id)}")
          }
        )
        else -> TrendAnalyticsTab(state, onEnsureHistory = { viewModel.refreshHistory() })
      }
    }
  }
}

private fun modelSessions(state: HubUiState): List<NormalizedSessionRow> {
  if (state.analyticsPeriod.needsRange) return emptyList()
  val capabilities = state.authorization?.capabilities
  val fromSnapshot = capabilities?.sessionList != true ||
    (state.deviceFilter != null && capabilities.sessionQuery != true)
  return if (fromSnapshot || state.sessionsPeriod == state.analyticsPeriod.name.lowercase()) {
    state.normalizedSessionRows()
  } else emptyList()
}

@Composable
private fun ShareAnalyticsTab(
  state: HubUiState,
  viewModel: HubViewModel,
  clients: Boolean,
  onOpenDetail: (String) -> Unit
) {
  val colors = LocalFluentColors.current
  val haptics = rememberAppHaptics()
  var showPicker by rememberSaveable { mutableStateOf(false) }
  val customSupported = state.authorization?.capabilities?.usageRange == true
  LaunchedEffect(clients, state.analyticsPeriod, state.deviceFilter) {
    if (!clients && !state.analyticsPeriod.needsRange) viewModel.refreshSessions()
  }
  // Same tab order as the shared web UI's `PERIOD_TABS`: the two wire periods first,
  // then the calendar presets, then the picked range.  A host without `usageRange`
  // hides the presets and the custom tab rather than showing tabs that could only
  // resolve to zeros.
  val periodOptions = if (customSupported) {
    listOf("今日", "昨日", "本周", "本月", "全部", "自定义")
  } else {
    listOf("今日", "本月", "全部")
  }
  val selectedIndex = when (state.analyticsPeriod) {
    AnalyticsPeriodKind.Today -> 0
    AnalyticsPeriodKind.Month -> if (customSupported) 3 else 1
    AnalyticsPeriodKind.AllTime -> if (customSupported) 4 else 2
    AnalyticsPeriodKind.Yesterday -> 1
    AnalyticsPeriodKind.Week -> 2
    AnalyticsPeriodKind.Custom -> 5
  }
  val period: PeriodDto? = resolvePeriod(state)
  val shares = if (clients) {
    topShareEntries(
      period?.clients.orEmpty(),
      period?.clientCosts.orEmpty(),
      // Client axis only: `docs/API.md` says model and project rows carry no
      // provenance of their own, because either axis can mix an exact client's
      // tokens with an estimated one.
      period?.clientEstimated.orEmpty(),
      period?.clientCredits.orEmpty(),
      period?.clientMeasurements.orEmpty(),
      limit = 8
    )
  } else {
    topShareEntries(period?.models.orEmpty(), period?.modelCosts.orEmpty(), limit = 8)
  }
  val emptyText = when {
    state.analyticsPeriod.needsRange && state.customRangeLoading -> "正在加载所选范围…"
    state.analyticsPeriod == AnalyticsPeriodKind.Custom && state.customRange == null -> "点「自定义」选择起止时间。"
    // No answer for a range tab is not the same statement as "this window is empty":
    // the request failed, or the cached window stopped matching after midnight.
    state.analyticsPeriod.needsRange && period == null -> "该范围目前没有可用数据，可在上方重试。"
    clients -> "这个周期没有客户端用量。"
    else -> "这个周期没有模型用量。"
  }

  Column(Modifier.fillMaxSize()) {
    FluentTabStrip(
      options = periodOptions,
      selectedIndex = selectedIndex,
      onSelect = { index ->
        haptics.perform(HapticEvent.Selection)
        val kinds = if (customSupported) {
          listOf(
            AnalyticsPeriodKind.Today,
            AnalyticsPeriodKind.Yesterday,
            AnalyticsPeriodKind.Week,
            AnalyticsPeriodKind.Month,
            AnalyticsPeriodKind.AllTime,
            AnalyticsPeriodKind.Custom
          )
        } else {
          listOf(AnalyticsPeriodKind.Today, AnalyticsPeriodKind.Month, AnalyticsPeriodKind.AllTime)
        }
        val kind = kinds.getOrElse(index) { AnalyticsPeriodKind.Today }
        // A preset resolves itself; only the picked range opens the dialog.
        if (kind == AnalyticsPeriodKind.Custom) showPicker = true
        viewModel.setAnalyticsPeriod(kind)
      },
      contentPadding = FluentSpacingDefaults.l,
    )

    if (state.analyticsPeriod.needsRange) {
      Row(
        Modifier
          .fillMaxWidth()
          .padding(
            horizontal = FluentSpacingDefaults.l,
            vertical = FluentSpacingDefaults.xs
          ),
        horizontalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.s),
        verticalAlignment = Alignment.CenterVertically
      ) {
        // Presets get the same window-and-source read-out as a picked range: they are the
        // same kind of answer (a calendar span resolved through `/api/usage/range`), and a
        // day-rounded daily history is not the same measurement as an hour-precision
        // event ledger even when both print the same token figure.
        ScopeRangeNotice(
          windowLabel = state.customRange?.label ?: "未选择范围",
          sourceLabel = ScopePeriod.rangeSourceLabel(state.customRangeResult?.source),
          loading = state.customRangeLoading,
          unavailable = !state.customRangeLoading && resolvePeriod(state) == null,
          onRetry = { viewModel.retryScopeRange() },
          modifier = Modifier.weight(1f)
        )
        if (state.analyticsPeriod == AnalyticsPeriodKind.Custom) {
          FluentTextButton(label = "调整", onClick = { showPicker = true })
        }
      }
    }

    Spacer(Modifier.height(FluentSpacingDefaults.s))

    when {
      state.analyticsPeriod == AnalyticsPeriodKind.Custom && state.customRangeLoading -> {
        Column(
          Modifier.fillMaxSize(),
          verticalArrangement = Arrangement.Center,
          horizontalAlignment = Alignment.CenterHorizontally
        ) {
          FluentProgressRing(color = colors.brandForeground1)
          Spacer(Modifier.height(FluentSpacingDefaults.m))
          Text(
            "加载自定义范围…",
            style = FluentTypeRamp.caption1,
            color = colors.neutralForeground2
          )
        }
      }
      shares.isEmpty() -> EmptyState(
        title = "暂无图表",
        text = emptyText,
        icon = FluentIcons.ChartMultiple
      )
      else -> LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(
          start = FluentSpacingDefaults.l,
          end = FluentSpacingDefaults.l,
          bottom = FluentSpacingDefaults.xxxl
        ),
        verticalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.m)
      ) {
        item(key = "share-donut") {
          AppCard {
            Text(
              if (clients) "客户端份额" else "模型份额",
              style = FluentTypeRamp.title3,
              color = colors.neutralForeground1
            )
            Text(
              "${formatTokensShort(period?.totalTokens ?: 0L)} · ${formatUsd(period?.costUsd ?: 0.0)}",
              style = FluentTypeRamp.caption1,
              color = colors.neutralForeground2
            )
            Spacer(Modifier.height(FluentSpacingDefaults.m))
            DonutChart(
              entries = shares,
              centerPrimary = formatTokensShort(period?.totalTokens ?: 0L),
              centerSecondary = formatUsd(period?.costUsd ?: 0.0, compact = true)
            )
          }
        }
        if (clients) {
          item(key = "share-detail") {
            AppCard {
              SectionHeader(title = "明细", subtitle = "点击客户端查看详情")
              Spacer(Modifier.height(FluentSpacingDefaults.m))
              ShareBarList(
                shares,
                brandClients = true,
                onEntryClick = { entry ->
                  haptics.perform(HapticEvent.Tap)
                  onOpenDetail(entry.key)
                }
              )
            }
          }
        } else {
          item(key = "model-workspace") {
            ModelWorkspacePanel(
              period = period,
              sessions = modelSessions(state),
              selectedModels = state.comparisonModels,
              onToggleComparison = viewModel::toggleModelComparison,
              onClearComparison = viewModel::clearModelComparison,
              onOpenDetail = { name ->
                haptics.perform(HapticEvent.Tap)
                onOpenDetail(name)
              }
            )
          }
        }
      }
    }
  }

  if (showPicker && customSupported) {
    DateTimeRangePickerDialog(
      onDismiss = { showPicker = false },
      onConfirm = { startDate, endDate, startHour, endHour ->
        showPicker = false
        viewModel.loadCustomRange(startDate.toString(), endDate.toString(), startHour, endHour)
      },
      initialStartDate = state.customRange?.startDate?.let { parseHistoryDate(it) },
      initialEndDate = state.customRange?.endDate?.let { parseHistoryDate(it) },
      initialStartHour = state.customRange?.startHour,
      initialEndHour = state.customRange?.endHour
    )
  }
}

/** Fluent hyperlink-style text button: no container, brand foreground. */
@Composable
private fun FluentTextButton(
  label: String,
  onClick: () -> Unit
) {
  val colors = LocalFluentColors.current
  val interaction = remember { MutableInteractionSource() }
  Text(
    label,
    style = FluentTypeRamp.caption1,
    fontWeight = FontWeight.SemiBold,
    color = colors.brandForeground1,
    modifier = Modifier
      .clip(FluentShapeDefaults.controlCorner)
      .clickable(interactionSource = interaction, indication = null, onClick = onClick)
      .padding(
        horizontal = FluentSpacingDefaults.s,
        vertical = FluentSpacingDefaults.xs
      )
  )
}

private fun modelsFromSessions(period: PeriodDto?, clientId: String?): Pair<Map<String, Long>, Map<String, Double>> {
  val tokens = linkedMapOf<String, Long>()
  val costs = linkedMapOf<String, Double>()
  val unknownCosts = mutableSetOf<String>()
  val sessions = period?.sessions.orEmpty().values
  for (session in sessions) {
    if (clientId != null && session.client != clientId) continue
    if (session.models.isEmpty()) continue
    for ((model, modelTokens) in session.models) {
      val t = modelTokens.coerceAtLeast(0L)
      tokens[model] = (tokens[model] ?: 0L) + t
      val exact = session.modelCosts[model]
      val allocated = if (exact == null && session.modelCosts.isEmpty() && session.totalTokens > 0L) {
        session.costUsd * t.toDouble() / session.totalTokens.toDouble()
      } else null
      val attributed = exact ?: allocated
      if (attributed != null && model !in unknownCosts) costs[model] = (costs[model] ?: 0.0) + attributed
      else if (attributed == null) unknownCosts += model
    }
  }
  unknownCosts.forEach(costs::remove)
  return tokens to costs
}

/** Inverse of `period.clientModels` — the client split of one model, as attributed. */
private fun clientsFromPeriod(period: PeriodDto?, modelId: String): Pair<Map<String, Long>, Map<String, Double>> {
  val tokens = linkedMapOf<String, Long>()
  val costs = linkedMapOf<String, Double>()
  for ((client, models) in period?.clientModels.orEmpty()) {
    val value = models[modelId] ?: continue
    tokens[client] = value
    period?.clientModelCosts?.get(client)?.get(modelId)?.let { costs[client] = it }
  }
  return tokens to costs
}

private fun clientsFromSessions(period: PeriodDto?, modelId: String): Pair<Map<String, Long>, Map<String, Double>> {
  val tokens = linkedMapOf<String, Long>()
  val costs = linkedMapOf<String, Double>()
  val unknownCosts = mutableSetOf<String>()
  for (session in period?.sessions.orEmpty().values) {
    val modelTokens = session.models[modelId] ?: continue
    val client = session.client?.takeIf { it.isNotBlank() } ?: "unknown"
    val tokensForModel = modelTokens.coerceAtLeast(0L)
    tokens[client] = (tokens[client] ?: 0L) + tokensForModel
    val exact = session.modelCosts[modelId]
    val allocated = if (exact == null && session.modelCosts.isEmpty() && session.totalTokens > 0L) {
      session.costUsd * tokensForModel.toDouble() / session.totalTokens.toDouble()
    } else null
    val attributed = exact ?: allocated
    if (attributed != null && client !in unknownCosts) costs[client] = (costs[client] ?: 0.0) + attributed
    else if (attributed == null) unknownCosts += client
  }
  unknownCosts.forEach(costs::remove)
  return tokens to costs
}

@Composable
fun ClientDetailScreen(
  clientId: String,
  state: HubUiState,
  onBack: () -> Unit,
  onHome: (() -> Unit)? = null
) {
  val periodLabel = periodCaption(state)
  val period = resolvePeriod(state)
  val tokens = period?.clients?.get(clientId) ?: 0L
  val cost = period?.clientCosts?.get(clientId)
  // One rule for every scope tab: prefer the attribution the period carries, and fall
  // back to session rows only where it has none.  The presets used to read the raw range
  // payload here while the snapshot tabs read the folded period, which is how a tab could
  // show a client's total and then claim it had no models at all.
  val attributed = period?.clientModels?.get(clientId).orEmpty()
  val (modelTokens, modelCosts) = if (attributed.isNotEmpty()) {
    attributed to period?.clientModelCosts?.get(clientId).orEmpty()
  } else {
    modelsFromSessions(period, clientId)
  }
  val shares = topShareEntries(modelTokens, modelCosts, limit = 12)
  val sessionCostAllocated = attributed.isEmpty() && period?.sessions.orEmpty().values.any { session ->
    session.client == clientId && session.models.isNotEmpty() &&
      session.modelCosts.isEmpty() && session.totalTokens > 0L
  }
  val title = ClientBranding.label(clientId)

  DetailScaffold(
    title = title,
    subtitle = periodLabel,
    onBack = onBack,
    heroTokens = tokens,
    heroCost = cost,
    leading = { ClientMonogram(clientId, size = 36.dp) },
    emptyText = when {
      period == null && state.analyticsPeriod.needsRange -> "该范围目前没有可用数据。"
      ScopePeriod.rangeLacksModelSplit(state) -> "该范围由每日历史答复，它按天汇总客户端与模型，不含客户端×模型拆分。"
      else -> "该客户端在此范围内没有模型拆分。"
    },
    shares = shares,
    brandClients = false,
    sessionCostAllocated = sessionCostAllocated,
    onHome = onHome
  )
}

@Composable
fun ModelDetailScreen(
  modelId: String,
  state: HubUiState,
  onBack: () -> Unit,
  onOpenSession: (String) -> Unit,
  onHome: (() -> Unit)? = null
) {
  val periodLabel = periodCaption(state)
  val period = resolvePeriod(state)
  val tokens = period?.models?.get(modelId) ?: 0L
  val cost = period?.modelCosts?.get(modelId)
  // Prefer the same `clientModels` attribution the client-detail screen uses, so the two
  // directions of the same split cannot disagree.  The session-derived fallback apportioned
  // a session's cost across its models by token share, which is a different measurement and
  // is only used where the period carries no client×model map at all.
  val attributed = clientsFromPeriod(period, modelId)
  val (clientTokens, clientCosts) = if (attributed.first.isNotEmpty()) {
    attributed
  } else {
    clientsFromSessions(period, modelId)
  }
  val shares = topShareEntries(clientTokens, clientCosts, limit = 12)
  val sessionCostAllocated = attributed.first.isEmpty() && period?.sessions.orEmpty().values.any { session ->
    modelId in session.models && session.modelCosts.isEmpty() && session.totalTokens > 0L
  }
  val modelRow = buildModelRows(period, modelSessions(state)).firstOrNull { it.name == modelId }
  val costFormatter = rememberCostFormatter()

  DetailScaffold(
    title = modelId,
    subtitle = periodLabel,
    onBack = onBack,
    heroTokens = tokens,
    heroCost = cost,
    leading = null,
    emptyText = when {
      period == null && state.analyticsPeriod.needsRange -> "该范围目前没有可用数据。"
      ScopePeriod.rangeLacksModelSplit(state) -> "该范围由每日历史答复，它按天汇总客户端与模型，不含模型×客户端拆分。"
      else -> "该模型在此范围内没有客户端拆分。"
    },
    shares = shares,
    brandClients = true,
    sessionCostAllocated = sessionCostAllocated,
    additionalContent = {
      if (modelRow != null) {
        item(key = "model-token-mix") {
          AppCard {
            Text("Token 类型", style = FluentTypeRamp.title3)
            Spacer(Modifier.height(FluentSpacingDefaults.s))
            ModelTokenMix(modelRow)
            if (modelRow.sessionCostEstimated) {
              Text("会话成本按 Token 比例分摊，非模型精确计价。", style = FluentTypeRamp.caption1)
            }
          }
        }
        if (modelRow.projects.isNotEmpty()) {
          item(key = "model-projects") {
            AppCard {
              Text("关联项目", style = FluentTypeRamp.title3)
              modelRow.projects.take(20).forEach { project ->
                FluentListRow(primary = project.label, secondary = project.id, trailingPrimary = formatTokensShort(project.tokens))
              }
            }
          }
        }
        if (modelRow.sessions.isNotEmpty()) {
          item(key = "model-sessions") {
            AppCard {
              Text("关联会话（已加载）", style = FluentTypeRamp.title3)
              modelRow.sessions.take(20).forEach { session ->
                FluentListRow(
                  primary = session.label,
                  secondary = session.key,
                  trailingPrimary = formatTokensShort(session.tokens),
                  trailingSecondary = session.costUsd?.let { "${if (session.costEstimated) "~" else ""}${costFormatter.format(it)}" } ?: "—",
                  onClick = { onOpenSession(session.key) },
                  disclosure = true
                )
              }
            }
          }
        }
      }
    },
    onHome = onHome
  )
}

@Composable
private fun DetailScaffold(
  title: String,
  subtitle: String,
  onBack: () -> Unit,
  heroTokens: Long,
  heroCost: Double?,
  leading: (@Composable () -> Unit)?,
  emptyText: String,
  shares: List<ShareEntry>,
  brandClients: Boolean,
  sessionCostAllocated: Boolean = false,
  additionalContent: LazyListScope.() -> Unit = {},
  onHome: (() -> Unit)? = null
) {
  val colors = LocalFluentColors.current
  val costFormatter = rememberCostFormatter()
  val listState = rememberLazyListState()
  val scrolled = rememberScrolledFlag(listState)

  Column(Modifier.fillMaxSize()) {
    FluentTopBar(title = title, onBack = onBack, onHome = onHome, scrolled = scrolled)
    LazyColumn(
      state = listState,
      contentPadding = PaddingValues(
        start = FluentSpacingDefaults.l,
        end = FluentSpacingDefaults.l,
        top = FluentSpacingDefaults.m,
        bottom = FluentSpacingDefaults.xxxl
      ),
      verticalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.m)
    ) {
      item {
        AppCard(contentPadding = FluentSpacingDefaults.xl) {
          Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.m)
          ) {
            leading?.invoke()
            Column(Modifier.weight(1f)) {
              Text(
                title,
                style = FluentTypeRamp.title1,
                color = colors.neutralForeground1,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
              )
              Text(
                subtitle,
                style = FluentTypeRamp.caption1,
                color = colors.neutralForeground3
              )
            }
          }
          Spacer(Modifier.height(FluentSpacingDefaults.l))
          Text(
            formatTokensShort(heroTokens),
            style = FluentTypeRamp.display,
            color = colors.neutralForeground1
          )
          Text(
            heroCost?.let { costFormatter.format(it) } ?: "费用未知",
            style = FluentTypeRamp.body2,
            color = colors.neutralForeground2
          )
        }
      }
      additionalContent()
      item {
        AppCard {
          Text(
            if (brandClients) "客户端拆分" else "模型拆分",
            style = FluentTypeRamp.title3,
            color = colors.neutralForeground1
          )
          Spacer(Modifier.height(FluentSpacingDefaults.m))
          if (shares.isEmpty()) {
            Text(
              emptyText,
              style = FluentTypeRamp.caption1,
              color = colors.neutralForeground3
            )
          } else {
            ShareBarList(entries = shares, brandClients = brandClients)
            if (sessionCostAllocated) {
              Text(
                "会话来源成本按 Token 比例分摊，非精确模型账单；无法归因的成本显示为 —。",
                style = FluentTypeRamp.caption1,
                color = colors.neutralForeground2
              )
            }
            if (shares.size >= 2) {
              Spacer(Modifier.height(FluentSpacingDefaults.xl))
              DonutChart(
                entries = shares,
                centerPrimary = formatTokensShort(shares.sumOf { it.tokens }),
                centerSecondary = shares.map { it.costUsd }.takeIf { values -> values.all { it != null } }
                  ?.sumOf { it ?: 0.0 }?.let { formatUsd(it, compact = true) } ?: "费用未知"
              )
            }
          }
        }
      }
    }
  }
}

/**
 * The one place a scope tab becomes a [PeriodDto].
 *
 * This was the analytics screen's private copy of a rule the overview also needed, and it
 * had already diverged twice: an inline version dropped `clientModels`, and the overview
 * preferred the cached range answer for *every* tab, so 今日/本月/全部 silently showed the
 * last range's numbers while this screen gated them on `needsRange`.  Both surfaces now
 * call [ScopePeriod.resolve], and the JVM suite asserts the rule there.
 */
private fun resolvePeriod(state: HubUiState): PeriodDto? = ScopePeriod.resolve(state)

/**
 * Names the *window*, not just the tab.  "今日" is a collector-defined period whose
 * boundary the device chose; a preset or picked range has explicit days, and printing
 * them is what lets a user tell "本周" apart from "近 7 天" — the two are different
 * windows and the old caption could not express the difference.
 */
private fun periodCaption(state: HubUiState): String = when (state.analyticsPeriod) {
  AnalyticsPeriodKind.Today -> "周期：今日"
  AnalyticsPeriodKind.Month -> "周期：本月"
  AnalyticsPeriodKind.AllTime -> "周期：全部"
  AnalyticsPeriodKind.Yesterday,
  AnalyticsPeriodKind.Week,
  AnalyticsPeriodKind.Custom -> "周期：${state.customRange?.label ?: "未选择"}"
}

private fun encode(value: String): String =
  URLEncoder.encode(value, StandardCharsets.UTF_8.toString())

@Composable
private fun TrendAnalyticsTab(state: HubUiState, onEnsureHistory: () -> Unit) {
  val colors = LocalFluentColors.current
  val haptics = rememberAppHaptics()
  var rangeIndex by rememberSaveable { mutableIntStateOf(1) }
  var metricIndex by rememberSaveable { mutableIntStateOf(0) }
  var trendsStack by rememberSaveable { mutableStateOf("client") }
  var activeDaysWindow by rememberSaveable { mutableStateOf("all") }
  var heatmapMetric by rememberSaveable { mutableStateOf("cost") }
  // Re-ask for the fleet history whenever this lens is entered — the first composition
  // of this tab is the only moment its charts can be missing data, and `refreshHistory`
  // is the documented retry for a failed `/api/history`.
  LaunchedEffect(Unit) { onEnsureHistory() }
  val rangeLabels = listOf("7 日", "30 日", "12 月")
  val metricLabels = listOf("Token", "费用", "对比", "活跃")
  val history = state.history ?: state.stats?.historyPreview
  val metric = when (metricIndex) {
    1 -> TrendMetric.Cost
    2 -> TrendMetric.Dual
    3 -> TrendMetric.ActiveTime
    else -> TrendMetric.Tokens
  }
  val heatMetric = if (heatmapMetric == "tokens") HeatmapMetric.Tokens else HeatmapMetric.Cost
  val summary = history?.summary
  val daily = history?.daily.orEmpty()
  val monthly = history?.monthly.orEmpty().takeMonths(12)
  val displayActiveDays = countActiveDays(daily, activeDaysWindow)
  val activeDaysValue = if (activeDaysWindow == "year") {
    displayActiveDays.toString()
  } else if (summary != null) {
    summary.activeDays.toLong().toString()
  } else {
    displayActiveDays.toString()
  }

  if (history == null || (daily.isEmpty() && monthly.isEmpty())) {
    EmptyState(
      // Distinguish "the Hub has no history yet" from "the request failed":
      // /api/history carries the per-client/per-model stacks and 370 days of
      // detail, while the fallback preview has neither and is capped at 30 days,
      // so a swallowed failure silently degrades every chart below. Offer a retry
      // instead of reporting an empty Hub.
      text = state.historyError?.let { "无法加载历史数据（$it）。下拉或点击重试。" }
        ?: "Hub 暂无历史预览。设备上报历史后，这里会显示 7/30 日与 12 月趋势。",
      icon = FluentIcons.Timeline
    )
    return
  }

  LazyColumn(
    modifier = Modifier.fillMaxSize(),
    contentPadding = PaddingValues(
      start = FluentSpacingDefaults.l,
      end = FluentSpacingDefaults.l,
      top = FluentSpacingDefaults.m,
      bottom = FluentSpacingDefaults.xxxl
    ),
    verticalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.m)
  ) {
    if (summary != null) {
      item(key = "trend-summary") {
        AppCard {
          SectionHeader(title = "历史摘要", subtitle = "全量上报窗口")
          Spacer(Modifier.height(FluentSpacingDefaults.s))
          // The window control sits with the figure it changes.
          FluentTabStrip(
            options = listOf("全部活跃天", "近一年"),
            selectedIndex = if (activeDaysWindow == "year") 1 else 0,
            onSelect = { index ->
              haptics.perform(HapticEvent.Selection)
              activeDaysWindow = if (index == 1) "year" else "all"
            }
          )
          Spacer(Modifier.height(FluentSpacingDefaults.s))
          SummaryGrid(
            listOf(
              "活跃天" to activeDaysValue,
              "连胜" to "${summary.currentStreak.toLong()} 天",
              "最长连胜" to "${summary.longestStreak.toLong()} 天",
              "峰值日" to formatTokensShort(summary.peakDayTokens.toLong()),
              "累计" to formatTokensShort(summary.totalTokens.toLong()),
              "费用" to formatUsd(summary.totalCost, compact = true)
            )
          )
          summary.favoriteModel?.takeIf { it.isNotBlank() }?.let {
            Spacer(Modifier.height(FluentSpacingDefaults.s))
            Text(
              "常用模型 $it",
              style = FluentTypeRamp.caption1,
              color = colors.neutralForeground2
            )
          }
        }
      }
    }

    if (daily.isNotEmpty()) {
      item(key = "trend-heatmap") {
        AppCard {
          SectionHeader(title = "贡献热力图", subtitle = "近 90 天")
          Spacer(Modifier.height(FluentSpacingDefaults.s))
          ContributionHeatmap(
            daily = daily,
            metric = heatMetric,
            onMetricChange = { next ->
              haptics.perform(HapticEvent.Selection)
              heatmapMetric = if (next == HeatmapMetric.Tokens) "tokens" else "cost"
            }
          )
        }
      }
    }

    item(key = "trend-charts") {
      AppCard {
        val windowTitle = when (rangeIndex) {
          0 -> "近 7 日"
          1 -> "近 30 日"
          else -> "近 12 月"
        }
        SectionHeader(
          title = "${windowTitle}趋势",
          subtitle = when (metric) {
            TrendMetric.Cost -> "费用"
            TrendMetric.Dual -> "Token + 费用"
            TrendMetric.ActiveTime -> "活跃时长"
            else -> "Token"
          }
        )
        Spacer(Modifier.height(FluentSpacingDefaults.s))
        FluentTabStrip(
          options = rangeLabels,
          selectedIndex = rangeIndex,
          onSelect = { rangeIndex = it }
        )
        FluentTabStrip(
          options = metricLabels,
          selectedIndex = metricIndex,
          onSelect = { metricIndex = it }
        )
        Spacer(Modifier.height(FluentSpacingDefaults.m))
        if (rangeIndex == 2) {
          if (monthly.isEmpty()) {
            Text(
              "暂无月度数据",
              style = FluentTypeRamp.caption1,
              color = colors.neutralForeground3
            )
          } else {
            MonthlyTrendChart(months = monthly, metric = metric)
          }
        } else {
          val range = if (rangeIndex == 0) TrendRange.Days7 else TrendRange.Days30
          val days = daily.takeRange(range)
          if (days.isEmpty()) {
            Text(
              "暂无日度数据",
              style = FluentTypeRamp.caption1,
              color = colors.neutralForeground3
            )
          } else {
            DailyTrendChart(days = days, metric = metric, useLine = rangeIndex == 1)
            Spacer(Modifier.height(FluentSpacingDefaults.l))
            SectionHeader(
              title = "堆叠构成",
              subtitle = if (trendsStack == "model") "按模型" else "按客户端"
            )
            Spacer(Modifier.height(FluentSpacingDefaults.xs))
            FluentTabStrip(
              options = listOf("按客户端", "按模型"),
              selectedIndex = if (trendsStack == "model") 1 else 0,
              onSelect = { index ->
                haptics.perform(HapticEvent.Selection)
                trendsStack = if (index == 1) "model" else "client"
              }
            )
            Spacer(Modifier.height(FluentSpacingDefaults.s))
            StackedDailyTrendChart(
              days = days,
              stackMode = if (trendsStack == "model") TrendStackMode.Model else TrendStackMode.Client
            )
          }
        }
      }
    }

    item(key = "trend-limits") { LimitsSection(state.stats?.limits, title = "限额状态") }
  }
}

/** Fluent stat tile grid: two per row, quiet bg3 tiles under a micro-label. */
@Composable
private fun SummaryGrid(items: List<Pair<String, String>>) {
  val colors = LocalFluentColors.current
  Column(verticalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.s)) {
    items.chunked(2).forEach { row ->
      Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.s)
      ) {
        row.forEach { (label, value) ->
          Column(
            Modifier
              .weight(1f)
              .clip(FluentShapeDefaults.controlCorner)
              .background(colors.neutralLayerInner)
              .padding(
                horizontal = FluentSpacingDefaults.m,
                vertical = FluentSpacingDefaults.s
              )
          ) {
            Text(
              label.uppercase(),
              style = FluentTypeRamp.caption2,
              color = colors.neutralForeground3,
              maxLines = 1,
              overflow = TextOverflow.Ellipsis
            )
            Spacer(Modifier.height(FluentSpacingDefaults.xxs))
            Text(
              value,
              style = FluentTypeRamp.title3,
              color = colors.neutralForeground1,
              maxLines = 1,
              overflow = TextOverflow.Ellipsis
            )
          }
        }
        if (row.size == 1) Spacer(Modifier.weight(1f))
      }
    }
  }
}
