package com.igng.tokenmonitor.android.ui.more
import com.igng.tokenmonitor.android.ui.components.FluentIcons
import com.igng.tokenmonitor.android.ui.components.FluentSection
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.selection.selectable
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.semantics.Role
import com.igng.tokenmonitor.android.ui.components.FluentButton
import com.igng.tokenmonitor.android.ui.components.FluentButtonVariant
import com.igng.tokenmonitor.android.ui.components.FluentCardList
import com.igng.tokenmonitor.android.ui.components.FluentDialog
import com.igng.tokenmonitor.android.ui.components.FluentIconButton
import com.igng.tokenmonitor.android.ui.components.FluentTextField
import com.igng.tokenmonitor.android.ui.components.FluentToggle
import com.igng.tokenmonitor.android.ui.components.fluentFocusRing
import com.igng.tokenmonitor.android.ui.components.FluentListRow
import com.igng.tokenmonitor.android.ui.components.FluentPageHeader
import com.igng.tokenmonitor.android.ui.components.FluentTabStrip
import com.igng.tokenmonitor.android.ui.components.FluentTopBar
import com.igng.tokenmonitor.android.ui.components.listGroupShape
import com.igng.tokenmonitor.android.ui.components.rememberScrolledFlag
import com.igng.tokenmonitor.android.ui.theme.FluentElevationDefaults
import com.igng.tokenmonitor.android.ui.theme.FluentMotion
import com.igng.tokenmonitor.android.ui.theme.FluentShapeDefaults
import com.igng.tokenmonitor.android.ui.theme.FluentSpacingDefaults
import com.igng.tokenmonitor.android.ui.theme.FluentTypeRamp
import com.igng.tokenmonitor.android.ui.theme.LocalFluentColors
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.heightIn
import androidx.compose.ui.text.font.FontWeight
import com.igng.tokenmonitor.android.ui.components.LimitsSection
import com.igng.tokenmonitor.android.ui.components.formatRelativeTime
import com.igng.tokenmonitor.android.ui.components.wslStatusLabel
import com.igng.tokenmonitor.android.ui.components.devicePlatformLabel
import com.igng.tokenmonitor.android.ui.components.agentRuntimeLabel
import com.igng.tokenmonitor.android.ui.components.keyedDevices
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.draw.clip
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.igng.tokenmonitor.android.data.local.DisplayCurrency
import com.igng.tokenmonitor.android.data.local.HapticsMode
import com.igng.tokenmonitor.android.data.local.ThemeMode
import com.igng.tokenmonitor.android.data.local.ThemeSeedId
import com.igng.tokenmonitor.android.ui.PreferencesViewModel
import com.igng.tokenmonitor.android.ui.haptics.HapticEvent
import com.igng.tokenmonitor.android.ui.haptics.rememberAppHaptics
import com.igng.tokenmonitor.android.ui.theme.themeSeedSwatch
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.ui.res.painterResource
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import com.igng.tokenmonitor.android.ui.components.FluentProgressBar
import com.igng.tokenmonitor.android.ui.components.FluentProgressRing
import androidx.compose.ui.Modifier
import androidx.annotation.DrawableRes
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import com.igng.tokenmonitor.android.BuildConfig
import com.igng.tokenmonitor.android.data.model.AppUpdateDto
import com.igng.tokenmonitor.android.data.model.BatchPricingResultDto
import com.igng.tokenmonitor.android.data.model.PeriodDto
import com.igng.tokenmonitor.android.data.model.ProjectDto
import com.igng.tokenmonitor.android.data.model.PricingDto
import com.igng.tokenmonitor.android.data.model.PricingRequestDto
import com.igng.tokenmonitor.android.data.model.SessionDto
import com.igng.tokenmonitor.android.data.model.SessionRowDto
import com.igng.tokenmonitor.android.data.model.StatsDto
import com.igng.tokenmonitor.android.ui.ConnectionUiState
import com.igng.tokenmonitor.android.ui.ConnectionViewModel
import com.igng.tokenmonitor.android.ui.HubUiState
import com.igng.tokenmonitor.android.ui.HubViewModel
import com.igng.tokenmonitor.android.ui.UpdateUiState
import com.igng.tokenmonitor.android.ui.UpdateViewModel
import com.igng.tokenmonitor.android.ui.update.openInstallPermissionSettings
import com.igng.tokenmonitor.android.ui.components.AppCard
import com.igng.tokenmonitor.android.ui.components.ShareEntry
import com.igng.tokenmonitor.android.ui.components.ShareBarList
import com.igng.tokenmonitor.android.ui.components.SectionHeader
import com.igng.tokenmonitor.android.ui.components.ClientMonogram
import com.igng.tokenmonitor.android.ui.components.ClientBranding
import com.igng.tokenmonitor.android.ui.components.EmptyState
import com.igng.tokenmonitor.android.ui.components.MetricHeroCard
import com.igng.tokenmonitor.android.ui.components.SegmentedTokenBar
import com.igng.tokenmonitor.android.ui.components.formatIsoCompact
import com.igng.tokenmonitor.android.ui.components.formatTokens
import com.igng.tokenmonitor.android.ui.components.formatTokensShort
import com.igng.tokenmonitor.android.ui.components.formatUsd
import java.util.Locale

@Composable
fun MoreHubScreen(
  navController: NavHostController,
  state: HubUiState,
  viewModel: HubViewModel = hiltViewModel()
) {
  val haptics = rememberAppHaptics()
  val scrollState = rememberScrollState()

  Column(
    Modifier
      .fillMaxSize()
      .verticalScroll(scrollState)
      .padding(bottom = FluentSpacingDefaults.xxxl)
  ) {
    FluentPageHeader(
      title = "更多",
      subtitle = "会话、项目、配额账号、订阅、定价、小组件与连接设置"
    )

    Spacer(Modifier.height(FluentSpacingDefaults.s))

    // Group 1: 监控与分析 (Monitoring & Analytics)
    FluentSection(
      title = "监控与分析",
      subtitle = "会话详情、工作区项目与配额健康"
    ) {
      FluentCardList(modifier = Modifier.padding(horizontal = FluentSpacingDefaults.l)) {
        MoreNavRow(
          title = "服务状态",
          subtitle = "各账号额度与健康状态",
          icon = FluentIcons.Heart,
          dividerAbove = false,
          onClick = {
            haptics.perform(HapticEvent.Tap)
            navController.navigate("status")
          }
        )
        MoreNavRow(
          title = "对话",
          subtitle = "查看会话快照与 token 拆解",
          icon = FluentIcons.Chat,
          dividerAbove = true,
          onClick = {
            haptics.perform(HapticEvent.Tap)
            navController.navigate("sessions")
          }
        )
        MoreNavRow(
          title = "项目",
          subtitle = "按工作区汇总 token / 费用",
          icon = FluentIcons.Folder,
          dividerAbove = true,
          onClick = {
            haptics.perform(HapticEvent.Tap)
            navController.navigate("projects")
          }
        )
      }
    }

    Spacer(Modifier.height(FluentSpacingDefaults.l))

    // Group 2: 资产与订购 (Assets & Subscriptions)
    FluentSection(
      title = "资产与订购",
      subtitle = "托管凭据与手工订阅账本"
    ) {
      FluentCardList(modifier = Modifier.padding(horizontal = FluentSpacingDefaults.l)) {
        MoreNavRow(
          title = "配额账号",
          subtitle = "Hub 托管的凭据、启用状态与立即刷新",
          icon = FluentIcons.Wallet,
          dividerAbove = false,
          onClick = {
            haptics.perform(HapticEvent.Tap)
            navController.navigate("accounts")
          }
        )
        if (state.authorization?.capabilities?.subscriptions != false) {
          MoreNavRow(
              title = "订阅",
            subtitle = "手工记账的计划价与月度折算",
            icon = FluentIcons.Timeline,
            dividerAbove = true,
            onClick = {
              haptics.perform(HapticEvent.Tap)
              viewModel.refreshSubscriptions()
              navController.navigate("subscriptions")
            }
          )
        }
      }
    }

    Spacer(Modifier.height(FluentSpacingDefaults.l))

    // Group 3: 系统与配置 (System & Configuration)
    FluentSection(
      title = "系统与配置",
      subtitle = "定价同步、小组件与应用设置"
    ) {
      FluentCardList(modifier = Modifier.padding(horizontal = FluentSpacingDefaults.l)) {
        // `dividerAbove` is decided from what is actually above the row, not from a
        // counter mutated during composition: that counter re-initialised on every
        // recomposition, so the hairlines depended on evaluation order rather than on
        // the list they separate.
        val showPricing = state.authorization?.capabilities?.pricing == true &&
          state.authorization.authenticated
        if (showPricing) {
          MoreNavRow(
            title = "定价",
            subtitle = "管理模型单价与上游同步",
            icon = FluentIcons.ArrowExport,
            dividerAbove = false,
            onClick = {
              haptics.perform(HapticEvent.Tap)
              navController.navigate("pricing")
            }
          )
        }
        MoreNavRow(
          title = "小组件",
          subtitle = "桌面卡片、刷新间隔与费用隐私",
          icon = FluentIcons.BoardSplit,
          dividerAbove = showPricing,
          onClick = {
            haptics.perform(HapticEvent.Tap)
            navController.navigate("widgets")
          }
        )
        MoreNavRow(
          title = "设置",
          subtitle = "外观、触感、币种与 Hub 连接",
          icon = FluentIcons.Settings,
          dividerAbove = true,
          onClick = {
            haptics.perform(HapticEvent.Tap)
            navController.navigate("settings")
          }
        )
      }
    }
  }
}

@Composable
private fun MoreNavRow(
  title: String,
  subtitle: String,
  @DrawableRes icon: Int,
  dividerAbove: Boolean = false,
  onClick: () -> Unit
) {
  val colors = LocalFluentColors.current
  FluentListRow(
    primary = title,
    secondary = subtitle,
    dividerAbove = dividerAbove,
    leading = {
      Box(
        Modifier
          .size(32.dp)
          .clip(FluentShapeDefaults.controlCorner)
          .background(colors.neutralLayerInner),
        contentAlignment = Alignment.Center
      ) {
        Icon(
          painter = painterResource(icon),
          contentDescription = null,
          modifier = Modifier.size(18.dp),
          tint = colors.brandForeground1
        )
      }
    },
    disclosure = true,
    onClick = onClick
  )
}

private const val MAX_SESSION_ROWS = 200
@Composable
fun SessionsScreen(
  stats: StatsDto?,
  navController: NavHostController,
  onHome: (() -> Unit)? = null,
  /**
   * Session rows fetched from `/api/sessions`. The fleet summary no longer carries
   * the aggregate session archive, so this is the primary source; the snapshot is
   * only a fallback for a Hub that does not stage it.
   */
  stagedSessions: List<SessionRowDto> = emptyList(),
  stagedTotal: Int = 0,
  stagedLoading: Boolean = false,
  stagedError: String? = null,
  stagedSupported: Boolean = false,
  onEnsureSessions: () -> Unit = {},
  onRetrySessions: () -> Unit = {}
) {
  val haptics = rememberAppHaptics()
  val listState = rememberLazyListState()
  val scrolled = rememberScrolledFlag(listState)
  // One row shape for both sources: the staged response is keyed by period, so
  // fall back to the snapshot key when it is absent.
  val allSessions: List<Pair<String, SessionDto>> = when {
    stagedSupported && stagedSessions.isNotEmpty() -> stagedSessions.map { row ->
      (row.sessionId?.takeIf { it.isNotBlank() } ?: "${row.client.orEmpty()}:${row.period.orEmpty()}") to row.toSessionDto()
    }
    else -> availableSessions(stats)
  }
  val totalSessions = if (stagedSupported && stagedSessions.isNotEmpty()) stagedTotal else allSessions.size
  val sessions = if (stagedSupported && stagedSessions.isNotEmpty()) allSessions else allSessions.take(MAX_SESSION_ROWS)
  val sessionsTruncated = totalSessions > sessions.size
  // The Hub's list is already capped; without re-asking there is no fuller list to
  // show, only the stale flag. Refresh on open the first time it is empty.
  LaunchedEffect(stagedSupported) {
    if (stagedSupported && stagedSessions.isEmpty()) onEnsureSessions()
  }
  val costRank = allSessions
    .sortedByDescending { it.second.costUsd }
    .take(8)
    .map { (key, session) ->
      val label = buildString {
        val client = session.client?.let { ClientBranding.label(it) }.orEmpty()
        if (client.isNotBlank()) append(client)
        session.projectLabel?.takeIf { it.isNotBlank() }?.let {
          if (isNotEmpty()) append(" · ")
          append(it)
        }
        val sid = session.sessionId.orEmpty().ifBlank { key }
        val short = if (sid.length > 18) sid.take(16) + "…" else sid
        if (isNotEmpty()) append(" · ")
        append(short)
      }
      ShareEntry(
        key = label,
        tokens = session.totalTokens.coerceAtLeast(0L),
        costUsd = session.costUsd
      )
    }
  Column(Modifier.fillMaxSize()) {
    FluentTopBar(
      title = "对话",
      onBack = { haptics.perform(HapticEvent.Tap); navController.popBackStack() },
      onHome = onHome,
      scrolled = scrolled
    )
    if (sessions.isEmpty() && stagedLoading) {
      Row(
        Modifier.padding(FluentSpacingDefaults.l),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.s)
      ) {
        FluentProgressRing(size = 16.dp, strokeWidth = 2.dp)
        Text("正在获取会话…", style = FluentTypeRamp.caption1, color = LocalFluentColors.current.neutralForeground2)
      }
    } else if (sessions.isEmpty() && stagedError != null) {
      Column(Modifier.padding(FluentSpacingDefaults.l)) {
        Text(stagedError, style = FluentTypeRamp.body2, color = LocalFluentColors.current.neutralForeground2)
        Spacer(Modifier.height(FluentSpacingDefaults.s))
        FluentButton(label = "重试", onClick = onRetrySessions, variant = FluentButtonVariant.Outline)
      }
    } else if (sessions.isEmpty()) {
      EmptyState(title = "暂无对话", text = "Hub 当前没有可用的会话快照。")
    } else {
      LazyColumn(
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
      ) {
        if (sessionsTruncated) {
          item {
            AppCard {
              Text(
                "显示 ${sessions.size}/$totalSessions 个会话（已截断以提升性能）。",
                style = FluentTypeRamp.body2,
                color = LocalFluentColors.current.neutralForeground2
              )
            }
          }
        }
        if (costRank.isNotEmpty()) {
          item {
            AppCard {
              SectionHeader(
                title = "费用排行",
                subtitle = "按会话费用 Top ${costRank.size}"
              )
              Spacer(Modifier.height(12.dp))
              ShareBarList(entries = costRank, brandClients = false, showCost = true)
            }
          }
        }
        items(sessions, key = { it.first }) { (key, session) ->
          val clientId = session.client.orEmpty()
          AppCard(onClick = {
          haptics.perform(HapticEvent.Tap)
          navController.navigate("session/${Uri.encode(key)}")
        }) {
            Row(verticalAlignment = Alignment.CenterVertically) {
              if (clientId.isNotBlank()) {
                ClientMonogram(clientId, size = 28.dp)
                Spacer(Modifier.width(FluentSpacingDefaults.m))
              }
              Column(Modifier.weight(1f)) {
                Text(
                  if (clientId.isBlank()) "未知客户端" else ClientBranding.label(clientId),
                  style = FluentTypeRamp.caption1,
                  color = LocalFluentColors.current.brandForeground1
                )
                Text(
                  session.sessionId.orEmpty().ifBlank { key },
                  style = FluentTypeRamp.title3,
                  maxLines = 1,
                  overflow = TextOverflow.Ellipsis
                )
              }
            }
            Spacer(Modifier.height(8.dp))
            Row(
              Modifier.fillMaxWidth(),
              horizontalArrangement = Arrangement.SpaceBetween
            ) {
              Text(formatTokensShort(session.totalTokens), style = FluentTypeRamp.subtitle)
              Text(
                formatUsd(session.costUsd, compact = true),
                style = FluentTypeRamp.subtitle,
                color = LocalFluentColors.current.neutralForeground2
              )
            }
            Spacer(Modifier.height(4.dp))
            Text(
              "消息 ${session.messageCount} · 最后使用 ${session.lastUsedAt ?: "未知"}",
              style = FluentTypeRamp.caption1,
              color = LocalFluentColors.current.neutralForeground2
            )
          }
        }
      }
    }
  }
}
@Composable
fun SessionDetailScreen(stats: StatsDto?, key: String, onBack: () -> Unit, onHome: (() -> Unit)? = null) {
  val haptics = rememberAppHaptics()
  val scrollState = rememberScrollState()
  val scrolled = rememberScrolledFlag(scrollState)
  val session = availableSessions(stats).firstOrNull { it.first == key }?.second
  Column(Modifier.fillMaxSize()) {
    FluentTopBar(
      title = "对话详情",
      onBack = { haptics.perform(HapticEvent.Tap); onBack() },
      onHome = onHome,
      scrolled = scrolled
    )
    if (session == null) {
      EmptyState(text = "会话不在当前 Hub 快照中。")
      return
    }
    Column(
      Modifier
        .fillMaxSize()
        .verticalScroll(scrollState)
        .padding(16.dp),
      verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        val clientId = session.client.orEmpty()
        if (clientId.isNotBlank()) {
          ClientMonogram(clientId, size = 36.dp)
          Spacer(Modifier.width(12.dp))
        }
        Column {
          Text(
            if (clientId.isBlank()) "未知客户端" else ClientBranding.label(clientId),
            style = FluentTypeRamp.caption1,
            color = LocalFluentColors.current.brandForeground1
          )
          Text(
            session.sessionId.orEmpty().ifBlank { key },
            style = FluentTypeRamp.title1
          )
        }
      }
      session.projectLabel?.takeIf { it.isNotBlank() }?.let { projectLabel ->
        Text(
          "项目 " + projectLabel,
          style = FluentTypeRamp.body2,
          color = LocalFluentColors.current.neutralForeground2
        )
      }
      MetricHeroCard(
        title = "累计用量",
        period = PeriodDto(totalTokens = session.totalTokens, costUsd = session.costUsd)
      )
      AppCard {
        Text("Token 类型", style = FluentTypeRamp.title3)
        Spacer(Modifier.height(12.dp))
        SegmentedTokenBar(
          listOf(
            "输入" to session.inputTokens,
            "输出" to session.outputTokens,
            "缓存读取" to session.cacheReadTokens,
            "缓存写入" to session.cacheWriteTokens,
            "推理" to session.reasoningTokens
          )
        )
        Spacer(Modifier.height(FluentSpacingDefaults.m))
        Text(
          "消息 ${session.messageCount} · 开始 ${session.startedAt ?: "未知"} · 最后使用 ${session.lastUsedAt ?: "未知"}",
          style = FluentTypeRamp.caption1,
          color = LocalFluentColors.current.neutralForeground2
        )
      }
      if (session.models.isNotEmpty()) {
        AppCard {
          Text("模型", style = FluentTypeRamp.title3)
          Spacer(Modifier.height(8.dp))
          session.models.entries.sortedByDescending { it.value }.forEach { (model, tokens) ->
            Row(
              Modifier
                .fillMaxWidth()
                .padding(vertical = FluentSpacingDefaults.s),
              horizontalArrangement = Arrangement.SpaceBetween
            ) {
              Text(
                model,
                style = FluentTypeRamp.body2,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f)
              )
              Spacer(Modifier.width(8.dp))
              Text(formatTokens(tokens), style = FluentTypeRamp.body2)
            }
          }
        }
      }
      Text(
        "当前 Hub 未提供按会话和时间范围查询事件流水的接口；此页展示已有 stats 快照，不会虚构历史趋势。",
        style = FluentTypeRamp.caption1,
        color = LocalFluentColors.current.neutralForeground2
      )
    }
  }
}
@Composable
fun ProjectsScreen(stats: StatsDto?, onBack: () -> Unit, onHome: (() -> Unit)? = null) {
  val haptics = rememberAppHaptics()
  val listState = rememberLazyListState()
  val scrolled = rememberScrolledFlag(listState)
  var periodKey by remember { mutableStateOf("today") }
  val period = when (periodKey) {
    "month" -> stats?.periods?.month
    "allTime" -> stats?.periods?.allTime
    else -> stats?.periods?.today
  }
  val projects = period?.projects.orEmpty().entries
    .map { (key, project) -> key to project }
    .filter { (_, project) -> project.tokens > 0L || project.costUsd > 0.0 }
    .sortedByDescending { it.second.tokens }
  Column(Modifier.fillMaxSize()) {
    FluentTopBar(
      title = "项目",
      onBack = { haptics.perform(HapticEvent.Tap); onBack() },
      onHome = onHome,
      scrolled = scrolled
    )
    val periodKeys = listOf("today", "month", "allTime")
    FluentTabStrip(
      options = listOf("今日", "本月", "全部"),
      selectedIndex = periodKeys.indexOf(periodKey).coerceAtLeast(0),
      onSelect = { index ->
        haptics.perform(HapticEvent.Selection)
        periodKey = periodKeys[index]
      },
      contentPadding = FluentSpacingDefaults.l,
    )
    Spacer(Modifier.height(8.dp))
    val showIncomplete = periodKey == "allTime" && stats?.projectsIncomplete == true
    if (projects.isEmpty()) {
      if (showIncomplete) {
        AppCard(modifier = Modifier.padding(horizontal = 16.dp)) {
          Text(
            "部分设备未上报全部时间的项目汇总，统计可能不完整。",
            style = FluentTypeRamp.body2,
            color = LocalFluentColors.current.neutralForeground2
          )
        }
        Spacer(Modifier.height(12.dp))
      }
      EmptyState(text = "当前周期暂无项目数据。")
      return
    }
    LazyColumn(
      state = listState,
      contentPadding = PaddingValues(16.dp),
      verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
      if (showIncomplete) {
        item {
          AppCard {
            Text(
              "部分设备未上报全部时间的项目汇总，统计可能不完整。",
              style = FluentTypeRamp.body2,
              color = LocalFluentColors.current.neutralForeground2
            )
          }
        }
      }
      items(projects, key = { it.first }) { (key, project) ->
        AppCard {
          Text(
            project.label?.takeIf { it.isNotBlank() } ?: key,
            style = FluentTypeRamp.title3
          )
          Spacer(Modifier.height(FluentSpacingDefaults.s))
          Text(
            buildString {
              append(formatTokens(project.tokens))
              append(" · ")
              append(formatUsd(project.costUsd, compact = true))
              val clients = project.clients.keys.map { ClientBranding.label(it) }
              if (clients.isNotEmpty()) {
                append(" · ")
                append(clients.joinToString(" / "))
              }
            },
            style = FluentTypeRamp.caption1,
            color = LocalFluentColors.current.neutralForeground2
          )
          if (project.clients.isNotEmpty()) {
            Spacer(Modifier.height(FluentSpacingDefaults.m))
            ShareBarList(
              project.clients.entries
                .sortedByDescending { it.value }
                .take(6)
                .map { (client, tokens) ->
                  ShareEntry(
                    key = ClientBranding.label(client),
                    tokens = tokens.coerceAtLeast(0L),
                    costUsd = 0.0
                  )
                }
            )
          }
        }
      }
    }
  }
}
@Composable
fun PricingScreen(state: HubUiState, viewModel: HubViewModel, onBack: () -> Unit, onHome: (() -> Unit)? = null) {
  LaunchedEffect(state.authorization?.capabilities?.pricing) {
    if (state.authorization?.capabilities?.pricing == true) viewModel.refreshPricing()
  }
  val haptics = rememberAppHaptics()
  val colors = LocalFluentColors.current
  val listState = rememberLazyListState()
  val scrolled = rememberScrolledFlag(listState)
  var editing by remember { mutableStateOf<PricingDto?>(null) }
  var showNew by remember { mutableStateOf(false) }

  Box(Modifier.fillMaxSize()) {
    Column(Modifier.fillMaxSize()) {
      FluentTopBar(
        title = "定价",
        onBack = {
          haptics.perform(HapticEvent.Tap)
          onBack()
        },
        onHome = onHome,
        scrolled = scrolled,
        actions = {
          FluentIconButton(
            icon = FluentIcons.ArrowSync,
            contentDescription = "刷新定价",
            onClick = {
              haptics.perform(HapticEvent.Refresh)
              viewModel.refreshPricing()
            },
            tint = colors.neutralForeground1
          )
        }
      )
      LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(
          start = FluentSpacingDefaults.l,
          end = FluentSpacingDefaults.l,
          top = FluentSpacingDefaults.m,
          bottom = FluentSpacingDefaults.xl
        ),
        verticalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.m)
      ) {
        item {
          Text(
            "修改价格只影响未来产生的用量记录；已写入历史事件的费用快照不会重算。",
            style = FluentTypeRamp.caption1,
            color = colors.neutralForeground2
          )
        }
        // Fluent has no floating action button: a persistent circular surface that
        // floats over content is Material's affordance.  The two admin actions
        // belong in the command row at the top of the list, where the screen's
        // primary and secondary verb sit next to each other.
        item {
          Row(horizontalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.s)) {
            FluentButton(
              label = "新增模型",
              onClick = {
                haptics.perform(HapticEvent.Tap)
                showNew = true
              },
              leadingIcon = FluentIcons.Add
            )
            FluentButton(
              label = "批量从上游拉取全部",
              onClick = {
                haptics.perform(HapticEvent.Confirm)
                viewModel.fetchAllUpstream()
              },
              variant = FluentButtonVariant.Outline
            )
          }
        }
        if (state.pricing.isEmpty()) {
          item {
            EmptyState(text = "Hub 尚未配置任何模型定价。可手动新增，或在设备有模型记录后批量拉取。")
          }
        } else {
          // One lazy item per model, keyed by its name: a refresh that reorders or
          // adds a row must not recycle the *editing* row's composition onto a
          // different model, and a long catalogue must stay virtualized. Each row
          // draws its own grouped caps (the DevicesScreen pattern), because a
          // virtualized list cannot hand the whole catalogue to one `FluentCardList`.
          itemsIndexed(
            items = state.pricing,
            key = { _, pricing -> pricing.model }
          ) { index, pricing ->
            PricingRow(
              pricing = pricing,
              dividerAbove = index > 0,
              groupShape = listGroupShape(index, state.pricing.size),
              onEdit = {
                haptics.perform(HapticEvent.Tap)
                editing = pricing
              },
              onFetch = {
                haptics.perform(HapticEvent.Refresh)
                viewModel.fetchUpstream(pricing.model)
              }
            )
          }
        }
      }
    }
  }

  if (showNew || editing != null) {
    PricingEditorDialog(
      existing = editing,
      onDismiss = { showNew = false; editing = null },
      onSave = { model, request ->
        viewModel.savePricing(model, request)
        showNew = false
        editing = null
      }
    )
  }
  state.batchResult?.let { result ->
    BatchResultDialog(result.results) { viewModel.clearBatchResult() }
  }
}

@Composable
private fun PricingRow(
  pricing: PricingDto,
  dividerAbove: Boolean,
  groupShape: androidx.compose.ui.graphics.Shape = FluentShapeDefaults.cardCorner,
  onEdit: () -> Unit,
  onFetch: () -> Unit
) {
  val colors = LocalFluentColors.current
  FluentListRow(
    primary = pricing.model,
    secondary = "${pricing.source} · ${pricing.updatedAt ?: "未知时间"}",
    tertiary = "输入 ${pricing.inputPricePerMillion} · 输出 ${pricing.outputPricePerMillion} · " +
      "缓存读 ${pricing.cacheReadPricePerMillion} · 缓存写 ${pricing.cacheWritePricePerMillion} / 百万 token",
    disclosure = true,
    dividerAbove = dividerAbove,
    containerShape = groupShape,
    // Interior rows are separated by the hairline `dividerAbove` already draws;
    // only the caps carry the outline or every interior edge stacks two strokes.
    containerBorder = !dividerAbove,
    trailing = {
      FluentIconButton(
        icon = FluentIcons.ArrowSync,
        contentDescription = "从上游拉取 ${pricing.model}",
        onClick = onFetch,
        tint = colors.brandForeground1,
        targetSize = 40.dp,
        iconSize = 18.dp
      )
    },
    onClick = onEdit
  )
}



@Composable
private fun PricingEditorDialog(
  existing: PricingDto?,
  onDismiss: () -> Unit,
  onSave: (String, PricingRequestDto) -> Unit
) {
  val haptics = rememberAppHaptics()
  var model by remember(existing) { mutableStateOf(existing?.model.orEmpty()) }
  var input by remember(existing) { mutableStateOf(existing?.inputPricePerMillion?.toString().orEmpty()) }
  var output by remember(existing) { mutableStateOf(existing?.outputPricePerMillion?.toString().orEmpty()) }
  var cacheRead by remember(existing) { mutableStateOf(existing?.cacheReadPricePerMillion?.toString().orEmpty()) }
  var cacheWrite by remember(existing) { mutableStateOf(existing?.cacheWritePricePerMillion?.toString().orEmpty()) }
  val values = listOf(input, output, cacheRead, cacheWrite).map { it.toDoubleOrNull() }
  val valid = model.isNotBlank() && values.all { it != null && it >= 0.0 }
  val error = if (valid) null else "模型不能为空，四项价格必须是非负数字。"
  FluentDialog(
    onDismissRequest = {
      haptics.perform(HapticEvent.Tap)
      onDismiss()
    },
    title = if (existing == null) "新增模型定价" else "编辑模型定价",
    subtitle = "价格单位：美元 / 百万 token。",
    confirmText = "保存",
    onConfirm = if (valid) {
      {
        haptics.perform(HapticEvent.Confirm)
        onSave(
          model.trim(),
          PricingRequestDto(values[0]!!, values[1]!!, values[2]!!, values[3]!!)
        )
      }
    } else {
      null
    },
    dismissText = "取消"
  ) {
    // Five fields plus a keyboard is more than a short phone has: the body
    // scrolls inside a capped panel rather than pushing the buttons off-screen.
    Column(
      Modifier
        .heightIn(max = 420.dp)
        .verticalScroll(rememberScrollState()),
      verticalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.m)
    ) {
      FluentTextField(
        value = model,
        onValueChange = { model = it },
        label = "模型",
        enabled = existing == null,
        errorText = error
      )
      PriceField("输入 / 百万", input, { input = it })
      PriceField("输出 / 百万", output, { output = it })
      PriceField("缓存读取 / 百万", cacheRead, { cacheRead = it })
      PriceField("缓存写入 / 百万", cacheWrite, { cacheWrite = it })
    }
  }
}

@Composable
private fun PriceField(label: String, value: String, onChange: (String) -> Unit) {
  FluentTextField(
    value = value,
    onValueChange = onChange,
    label = label,
    keyboardType = KeyboardType.Decimal,
    placeholder = "0.00"
  )
}

@Composable
private fun BatchResultDialog(results: List<BatchPricingResultDto>, dismiss: () -> Unit) {
  val haptics = rememberAppHaptics()
  FluentDialog(
    onDismissRequest = {
      haptics.perform(HapticEvent.Tap)
      dismiss()
    },
    title = "批量拉取结果",
    subtitle = "${results.count { it.ok }} / ${results.size} 个模型更新成功",
    confirmText = "关闭"
  ) {
    Column(
      Modifier
        .heightIn(max = 420.dp)
        .verticalScroll(rememberScrollState()),
      verticalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.xs)
    ) {
      results.forEach { result ->
        // ok / failure is carried by a word, not only by the row's colour.
        val outcome = if (result.ok) "成功" else result.message ?: result.error ?: "失败"
        FluentListRow(
          primary = result.model,
          secondary = outcome,
          dividerAbove = result != results.first(),
          contentPadding = 0.dp
        )
      }
    }
  }
}
@Composable
fun SettingsScreen(
  state: ConnectionUiState,
  viewModel: ConnectionViewModel,
  restartRealtime: () -> Unit,
  onBack: () -> Unit, onHome: (() -> Unit)? = null,
  hubRates: Map<String, Double> = emptyMap(),
  hubRatesDate: String? = null,
  updateViewModel: UpdateViewModel,
  preferencesViewModel: PreferencesViewModel = hiltViewModel()
) {
  if (state.loading) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
      Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.s)
      ) {
        FluentProgressRing(size = 20.dp, strokeWidth = 2.dp)
        Text("正在读取连接设置…", style = FluentTypeRamp.body2)
      }
    }
    return
  }
  val uriHandler = LocalUriHandler.current
  val context = LocalContext.current
  val prefs by preferencesViewModel.preferences.collectAsStateWithLifecycle()
  val updateState by updateViewModel.state.collectAsStateWithLifecycle()
  val haptics = rememberAppHaptics()
  val scrollState = rememberScrollState()
  val scrolled = rememberScrolledFlag(scrollState)
  Column(Modifier.fillMaxSize()) {
    FluentTopBar(
      title = "设置",
      onBack = { haptics.perform(HapticEvent.Tap); onBack() },
      onHome = onHome,
      scrolled = scrolled
    )
    Column(
      Modifier
        .fillMaxSize()
        .verticalScroll(scrollState)
        .padding(16.dp),
      verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
      AppCard {
        SectionHeader(
          title = "外观",
          subtitle = "主题色会应用到按钮、导航与强调色。选择「系统」时，Android 12+ 会跟随壁纸取色。"
        )
        Spacer(Modifier.height(FluentSpacingDefaults.m))
        // Light / dark / system, which the web and desktop settings both expose and
        // the client did not: `isSystemInDarkTheme()` was the only rule, so a user on
        // a light-system-but-dark-app preference had no way to say so, and the accent
        // seed had been doing double duty as the mode.
        Text(
          "外观模式",
          style = FluentTypeRamp.caption1,
          fontWeight = FontWeight.SemiBold,
          color = LocalFluentColors.current.neutralForeground2
        )
        Spacer(Modifier.height(FluentSpacingDefaults.xs))
        val themeModes = ThemeMode.entries
        FluentTabStrip(
          options = themeModes.map { it.labelZh },
          selectedIndex = themeModes.indexOf(prefs.themeMode).coerceAtLeast(0),
          onSelect = { index ->
            preferencesViewModel.setThemeMode(themeModes[index])
            haptics.perform(HapticEvent.Selection)
          }
        )
        Spacer(Modifier.height(FluentSpacingDefaults.l))
        Text(
          "主题色",
          style = FluentTypeRamp.caption1,
          fontWeight = FontWeight.SemiBold,
          color = LocalFluentColors.current.neutralForeground2
        )
        Spacer(Modifier.height(FluentSpacingDefaults.xs))
        Column(verticalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.s)) {
          listOf(
            listOf(ThemeSeedId.System, ThemeSeedId.Blue, ThemeSeedId.Green, ThemeSeedId.Purple),
            listOf(ThemeSeedId.Teal, ThemeSeedId.Orange, ThemeSeedId.Rose)
          ).forEach { rowSeeds ->
            Row(
              Modifier.fillMaxWidth(),
              horizontalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.m)
            ) {
              rowSeeds.forEach { seed ->
                val selected = prefs.themeSeed == seed
                val swatch = themeSeedSwatch(seed)
                val colors = LocalFluentColors.current
                val interaction = remember { MutableInteractionSource() }
                val pressed by interaction.collectIsPressedAsState()
                // `selectable(role = RadioButton)` is the point of this widget: the
                // old version carried selection in ring weight and tint only, so a
                // screen reader heard a plain row.  The ring, the ✓ glyph and the
                // label colour all still encode it for sighted use (WCAG 1.4.1).
                Column(
                  horizontalAlignment = Alignment.CenterHorizontally,
                  modifier = Modifier
                    .weight(1f)
                    .clip(FluentShapeDefaults.controlCorner)
                    .background(
                      if (pressed) colors.subtleBackgroundPressed else Color.Transparent
                    )
                    .selectable(
                      selected = selected,
                      role = Role.RadioButton,
                      interactionSource = interaction,
                      indication = null
                    ) {
                      preferencesViewModel.setThemeSeed(seed)
                      haptics.perform(HapticEvent.Selection)
                    }
                    .then(
                      Modifier.fluentFocusRing(interaction, FluentShapeDefaults.controlCorner)
                    )
                    .padding(vertical = FluentSpacingDefaults.xs)
                ) {
                  Box(
                    Modifier
                      .size(44.dp)
                      .clip(CircleShape)
                      .background(swatch)
                      .border(
                        width = if (selected) 2.5.dp else 1.dp,
                        color = if (selected) colors.brandForeground1 else colors.neutralStroke1,
                        shape = CircleShape
                      ),
                    contentAlignment = Alignment.Center
                  ) {
                    if (selected) {
                      Icon(
                                                painter = painterResource(FluentIcons.Checkmark),
                        contentDescription = null,
                        modifier = Modifier.size(20.dp),
                        tint = Color.White
                      )
                    }
                  }
                  Spacer(Modifier.height(FluentSpacingDefaults.xs))
                  Text(
                    seed.labelZh,
                    style = FluentTypeRamp.caption2,
                    fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (selected) colors.brandForeground1 else colors.neutralForeground2,
                    maxLines = 1
                  )
                }
              }
              // Balance the second row so seven seeds still read as one grid.
              if (rowSeeds.size < 4) {
                repeat(4 - rowSeeds.size) { Spacer(Modifier.weight(1f)) }
              }
            }
          }
        }
      }
      AppCard {
        SectionHeader(
          title = "首页额度账号数",
          subtitle = "总览页最多展示多少个额度账号（1–12）"
        )
        Spacer(Modifier.height(FluentSpacingDefaults.m))
        Row(
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.m)
        ) {
          FluentButton(
            label = "减少",
            onClick = {
              preferencesViewModel.setHomeLimitAccountCount(prefs.homeLimitAccountCount - 1)
              haptics.perform(HapticEvent.Selection)
            },
            variant = FluentButtonVariant.Outline,
            enabled = prefs.homeLimitAccountCount > 1,
            contentDescription = "减少首页额度账号数"
          )
          Text(
            prefs.homeLimitAccountCount.toString(),
            style = FluentTypeRamp.title2,
            fontWeight = FontWeight.SemiBold,
            color = LocalFluentColors.current.neutralForeground1
          )
          FluentButton(
            label = "增加",
            onClick = {
              preferencesViewModel.setHomeLimitAccountCount(prefs.homeLimitAccountCount + 1)
              haptics.perform(HapticEvent.Selection)
            },
            variant = FluentButtonVariant.Outline,
            enabled = prefs.homeLimitAccountCount < 12,
            contentDescription = "增加首页额度账号数"
          )
        }
      }
      AppCard {
        SectionHeader(
          title = "显示币种",
          subtitle = "费用按 Hub 提供的展示汇率折算；汇率缺失时回退为美元。"
        )
        Spacer(Modifier.height(FluentSpacingDefaults.s))
        val currencies = DisplayCurrency.entries
        FluentTabStrip(
          options = currencies.map { it.code },
          selectedIndex = currencies.indexOf(prefs.currency).coerceAtLeast(0),
          onSelect = { index ->
            preferencesViewModel.setCurrency(currencies[index])
            haptics.perform(HapticEvent.Selection)
          }
        )
        Spacer(Modifier.height(FluentSpacingDefaults.xs))
        Text(
          if (hubRates.isEmpty()) "尚未取得汇率，费用以 US$ 显示。"
          else "汇率日期 ${hubRatesDate ?: "未知"} · 可用币种 ${hubRates.keys.joinToString()}",
          style = FluentTypeRamp.caption2,
          color = LocalFluentColors.current.neutralForeground3
        )
      }
      AppCard {
        SectionHeader(
          title = "触感反馈",
          subtitle = "标准：按钮轻触反馈。增强：切换、成功、错误等使用更丰富的震动模式。"
        )
        Spacer(Modifier.height(FluentSpacingDefaults.s))
        val hapticsModes = HapticsMode.entries
        FluentTabStrip(
          options = hapticsModes.map { it.labelZh },
          selectedIndex = hapticsModes.indexOf(prefs.hapticsMode).coerceAtLeast(0),
          onSelect = { index ->
            val mode = hapticsModes[index]
            preferencesViewModel.setHapticsMode(mode)
            if (mode != HapticsMode.Off) {
              haptics.perform(
                if (mode == HapticsMode.Enhanced) HapticEvent.Confirm else HapticEvent.Tap,
                forceMode = mode
              )
            }
          }
        )
        if (prefs.hapticsMode == HapticsMode.Enhanced) {
          Spacer(Modifier.height(FluentSpacingDefaults.l))
          Row(horizontalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.s)) {
            FluentButton(
              label = "试听成功",
              onClick = { haptics.perform(HapticEvent.Success) },
              variant = FluentButtonVariant.Outline
            )
            FluentButton(
              label = "试听错误",
              onClick = { haptics.perform(HapticEvent.Error) },
              variant = FluentButtonVariant.Outline
            )
            FluentButton(
              label = "试听刷新",
              onClick = { haptics.perform(HapticEvent.Refresh) },
              variant = FluentButtonVariant.Outline
            )
          }
        }
      }
      AppCard {
        SectionHeader(
          title = "Hub 连接",
          subtitle = "只读连到一台 Docker Compose Hub；密钥以系统加密存储保存在本机。"
        )
        Spacer(Modifier.height(FluentSpacingDefaults.m))
        FluentTextField(
          value = state.hubUrl,
          onValueChange = viewModel::updateUrl,
          label = "Hub URL",
          placeholder = "https://hub.example.com",
          keyboardType = KeyboardType.Uri
        )
        Spacer(Modifier.height(FluentSpacingDefaults.l))
        // `isPassword` only once a secret exists: masking an empty field reads as
        // a broken input, which is what the previous conditional did here.
        FluentTextField(
          value = state.secret,
          onValueChange = viewModel::updateSecret,
          label = "共享密钥",
          isPassword = state.secret.isNotEmpty(),
          supportingText = "用于 Hub 的 Bearer 鉴权；保存后不会回显。"
        )
        Spacer(Modifier.height(FluentSpacingDefaults.l))
        // The row is a `FluentListRow` with no `onClick`, so the toggle is the only
        // owner of the value.  The previous version put a `clickable` on the row
        // *and* an `onCheckedChange` on the switch, which is two writers to one
        // setting on a 48 dp boundary between them.
        FluentListRow(
          primary = "允许远程 HTTP 连接",
          secondary = "用于无 TLS 的外网穿透或局域网；数据在传输中不会加密。",
          trailing = {
            FluentToggle(
              checked = state.allowInsecureHttp,
              onCheckedChange = { checked ->
                haptics.perform(HapticEvent.Selection)
                viewModel.updateAllowInsecureHttp(checked)
              },
              label = "允许远程 HTTP 连接"
            )
          },
          contentPadding = 0.dp
        )
        Spacer(Modifier.height(FluentSpacingDefaults.l))
        Row(horizontalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.s)) {
          FluentButton(
            label = if (state.testing) "测试中" else "测试连接",
            onClick = {
              haptics.perform(HapticEvent.Confirm)
              viewModel.testConnection()
            },
            enabled = !state.testing
          )
          FluentButton(
            label = "加密保存",
            onClick = {
              haptics.perform(HapticEvent.Success)
              viewModel.save(onSaved = restartRealtime)
            },
            variant = FluentButtonVariant.Outline
          )
        }
        Spacer(Modifier.height(FluentSpacingDefaults.s))
        FluentButton(
          label = "清除本机连接",
          onClick = {
            haptics.perform(HapticEvent.Error)
            viewModel.clear(onCleared = restartRealtime)
          },
          variant = FluentButtonVariant.Quiet
        )
      }
      UpdateCard(
        state = updateState,
        onCheck = {
          haptics.perform(HapticEvent.Refresh)
          updateViewModel.checkForUpdate()
        },
        onDownload = {
          haptics.perform(HapticEvent.Confirm)
          updateViewModel.downloadUpdate()
        },
        onCancelDownload = {
          haptics.perform(HapticEvent.Tap)
          updateViewModel.cancelDownload()
        },
        onInstall = {
          haptics.perform(HapticEvent.Confirm)
          updateViewModel.requestInstall()
        },
        onOpenPermissionSettings = {
          haptics.perform(HapticEvent.Tap)
          if (!openInstallPermissionSettings(context)) {
            updateViewModel.onInstallSettingsUnavailable()
          }
        },
        onOpenRelease = { url ->
          haptics.perform(HapticEvent.Tap)
          uriHandler.openUri(url)
        }
      )
      AppCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
          Icon(
                        painter = painterResource(FluentIcons.Info),
            contentDescription = null,
            tint = LocalFluentColors.current.brandForeground1
          )
          Spacer(Modifier.width(FluentSpacingDefaults.s))
          Text(
            "关于",
            style = FluentTypeRamp.title3,
            color = LocalFluentColors.current.neutralForeground1
          )
        }
        Spacer(Modifier.height(FluentSpacingDefaults.s))
        Text(
          "本软件遵循 MIT License 开源协议。",
          style = FluentTypeRamp.body2,
          color = LocalFluentColors.current.neutralForeground1
        )
        state.health?.version?.let {
          Spacer(Modifier.height(FluentSpacingDefaults.xs))
          Text(
            "当前连接 Hub 版本：$it",
            style = FluentTypeRamp.caption1,
            color = LocalFluentColors.current.neutralForeground2
          )
        }
      }
    }
  }
}

@Composable
private fun UpdateCard(
  state: UpdateUiState,
  onCheck: () -> Unit,
  onDownload: () -> Unit,
  onCancelDownload: () -> Unit,
  onInstall: () -> Unit,
  onOpenPermissionSettings: () -> Unit,
  onOpenRelease: (String) -> Unit
) {
  val colors = LocalFluentColors.current
  val info = state.info
  AppCard {
    SectionHeader(
      title = "版本与更新",
      subtitle = "通过当前 Hub 检查并下载 Android 安装包；安装由系统确认。"
    )
    Spacer(Modifier.height(FluentSpacingDefaults.m))
    FluentListRow(
      primary = "当前版本",
      secondary = buildString {
        append("v")
        append(state.currentVersion)
        info?.currentChannel?.let {
          append(" · ")
          append(channelLabel(it))
        }
      },
      trailing = {
        FluentButton(
          label = if (state.checking) "检查中" else "检查更新",
          onClick = onCheck,
          enabled = !state.checking && !state.downloading,
          variant = FluentButtonVariant.Outline,
          contentDescription = "检查 Android 应用更新"
        )
      },
      contentPadding = 0.dp
    )
    if (info?.available == true) {
      Spacer(Modifier.height(FluentSpacingDefaults.l))
      Text(
        "发现新版本 v${info.latestVersion.orEmpty()}",
        style = FluentTypeRamp.title3,
        color = colors.neutralForeground1
      )
      Spacer(Modifier.height(FluentSpacingDefaults.xxs))
      Text(
        updateMetaLine(info),
        style = FluentTypeRamp.caption1,
        color = colors.neutralForeground2
      )
      if (!info.installable) {
        Spacer(Modifier.height(FluentSpacingDefaults.s))
        Text(
          when (info.message) {
            "asset_missing" -> "该版本没有 Android 安装包，请打开 Releases 页面查看其他资产。"
            "checksum_missing" -> "该版本缺少 SHA-256 校验信息，无法在应用内安全安装。"
            else -> "该版本暂时无法在应用内安装。"
          },
          style = FluentTypeRamp.body2,
          color = colors.errorForeground
        )
      }
      if (info.installable) {
        Spacer(Modifier.height(FluentSpacingDefaults.m))
        when {
          state.downloading -> {
            val progress = state.progress
            if (progress != null) {
              FluentProgressBar(fraction = progress)
            } else {
              FluentProgressRing(size = 20.dp, strokeWidth = 2.dp)
            }
            Spacer(Modifier.height(FluentSpacingDefaults.xs))
            Text(
              downloadLine(state),
              style = FluentTypeRamp.caption1,
              color = colors.neutralForeground2
            )
            Spacer(Modifier.height(FluentSpacingDefaults.s))
            FluentButton(
              label = "取消下载",
              onClick = onCancelDownload,
              variant = FluentButtonVariant.Quiet
            )
          }
          state.downloadedUri != null -> {
            FluentButton(
              label = if (state.needsInstallPermission) "等待安装授权" else "安装已下载版本",
              onClick = onInstall,
              enabled = !state.needsInstallPermission,
              filledWidth = true
            )
          }
          else -> {
            FluentButton(
              label = "下载并安装",
              onClick = onDownload,
              filledWidth = true
            )
          }
        }
      }
      if (state.needsInstallPermission) {
        Spacer(Modifier.height(FluentSpacingDefaults.m))
        Text(
          "系统尚未允许计然安装未知应用。授权后返回即可继续安装，无需重新下载。",
          style = FluentTypeRamp.body2,
          color = colors.warningForeground
        )
        Spacer(Modifier.height(FluentSpacingDefaults.xs))
        FluentButton(
          label = "去允许安装",
          onClick = onOpenPermissionSettings,
          variant = FluentButtonVariant.Outline
        )
      }
    }
    state.message?.let { message ->
      Spacer(Modifier.height(FluentSpacingDefaults.m))
      Text(
        message,
        style = FluentTypeRamp.body2,
        color = if (state.isError) colors.errorForeground else colors.neutralForeground2
      )
    }
    // This stays available on an old Hub or a failed check, which would
    // otherwise leave the user with a message and no way to reach the APK.
    val releaseUrl = info?.notesUrl
      ?: info?.releaseUrl
      ?: "https://github.com/IGNGserver/jiran-monitor/releases"
    Spacer(Modifier.height(FluentSpacingDefaults.xs))
    FluentButton(
      label = if (info?.available == true) "查看更新说明" else "打开 Releases 页面",
      onClick = { onOpenRelease(releaseUrl) },
      variant = FluentButtonVariant.Quiet
    )
  }
}

private fun updateMetaLine(info: AppUpdateDto): String = buildString {
  info.publishedAt?.takeIf { it.isNotBlank() }?.let {
    append("发布 ")
    append(formatIsoCompact(it))
    append(" · ")
  }
  info.assetSize?.takeIf { it > 0 }?.let {
    append(formatUpdateBytes(it))
    append(" · ")
  }
  append(channelLabel(info.latestChannel))
  append(" · 下载后由系统安装器确认")
}

private fun downloadLine(state: UpdateUiState): String {
  val percent = state.progress?.let { "${(it * 100).toInt()}% · " }.orEmpty()
  val total = state.totalBytes
  return if (total != null && total > 0) {
    "$percent${formatUpdateBytes(state.downloadedBytes)} / ${formatUpdateBytes(total)}"
  } else {
    "$percent${formatUpdateBytes(state.downloadedBytes)}"
  }
}

private fun formatUpdateBytes(bytes: Long): String = when {
  bytes >= 1024L * 1024L -> String.format(Locale.getDefault(), "%.1f MB", bytes / 1024.0 / 1024.0)
  bytes >= 1024L -> String.format(Locale.getDefault(), "%.0f KB", bytes / 1024.0)
  else -> "$bytes B"
}

private fun channelLabel(channel: String?): String = when (channel) {
  "test" -> "预发布渠道"
  "stable" -> "正式渠道"
  else -> "未知渠道"
}

fun availableSessions(stats: StatsDto?): List<Pair<String, SessionDto>> {
  val periods = listOf(stats?.periods?.today, stats?.periods?.month, stats?.periods?.allTime)
  return periods
    .firstOrNull { !it?.sessions.isNullOrEmpty() }
    ?.sessions
    .orEmpty()
    .toList()
    .sortedByDescending { it.second.lastUsedAt.orEmpty() }
}

/** Fold the staged `/api/sessions` row onto the snapshot [SessionDto] shape. */
internal fun SessionRowDto.toSessionDto(): SessionDto = SessionDto(
  client = client,
  sessionId = sessionId,
  projectId = projectId,
  projectLabel = projectLabel,
  totalTokens = totalTokens,
  costUsd = costUsd,
  messageCount = messageCount,
  inputTokens = inputTokens,
  outputTokens = outputTokens,
  cacheReadTokens = cacheReadTokens,
  cacheWriteTokens = cacheWriteTokens,
  reasoningTokens = reasoningTokens,
  startedAt = startedAt,
  lastUsedAt = lastUsedAt,
  models = models,
  credits = credits,
  modelCredits = modelCredits
)
@Composable
fun StatusScreen(stats: StatsDto?, onBack: () -> Unit, onHome: (() -> Unit)? = null) {
  val haptics = rememberAppHaptics()
  val listState = rememberLazyListState()
  val scrolled = rememberScrolledFlag(listState)
  val providers = stats?.limits?.providers.orEmpty()
  val devices = stats?.devices.orEmpty()
  val keyed = remember(devices) { keyedDevices(devices) }
  val okCount = providers.count { !it.status.isNullOrBlank() && it.status.equals("ok", ignoreCase = true) }
  val warnCount = providers.size - okCount
  val staleCount = devices.count { it.stale == true }
  Column(Modifier.fillMaxSize()) {
    FluentTopBar(
      title = "服务状态",
      onBack = { haptics.perform(HapticEvent.Tap); onBack() },
      onHome = onHome,
      scrolled = scrolled
    )
    if (providers.isEmpty() && devices.isEmpty()) {
      EmptyState(text = "暂无服务状态数据。")
      return
    }
    LazyColumn(
      state = listState,
      contentPadding = PaddingValues(16.dp),
      verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
      item {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
          SummaryChip(label = "账户", value = providers.size.toString(), modifier = Modifier.weight(1f))
          SummaryChip(label = "正常", value = okCount.toString(), modifier = Modifier.weight(1f))
          SummaryChip(label = "需关注", value = warnCount.toString(), modifier = Modifier.weight(1f))
        }
      }
      if (devices.isNotEmpty()) {
        item {
          Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
            SummaryChip(label = "设备", value = devices.size.toString(), modifier = Modifier.weight(1f))
            SummaryChip(label = "过期", value = staleCount.toString(), modifier = Modifier.weight(1f))
          }
        }
        items(keyed, key = { it.key }) { item ->
          val device = item.device
          AppCard {
            Text(
              device.hostname?.takeIf { it.isNotBlank() } ?: device.deviceId.orEmpty().ifBlank { "设备" },
              style = FluentTypeRamp.title3,
              fontWeight = FontWeight.SemiBold
            )
            Spacer(Modifier.height(FluentSpacingDefaults.s))
            val bits = buildList {
              devicePlatformLabel(device.platform, device.osName, device.osVersion)
                .takeIf { it.isNotBlank() && it != "—" }
                ?.let { add(it) }
              agentRuntimeLabel(device.agentRuntime).takeIf { it.isNotBlank() }?.let { add(it) }
              if (device.stale == true) add("已过期")
              device.updatedAt?.takeIf { it.isNotBlank() }?.let { add(formatRelativeTime(it)) }
              device.wslStatus?.state?.takeIf { it.isNotBlank() }?.let { add("WSL " + wslStatusLabel(it)) }
            }
            if (bits.isNotEmpty()) {
              Text(
                bits.joinToString(" · "),
                style = FluentTypeRamp.caption1,
                color = LocalFluentColors.current.neutralForeground2
              )
            }
          }
        }
      }
      if (providers.isNotEmpty()) {
        item {
          LimitsSection(
            limits = stats?.limits,
            title = "账户额度与状态",
            includeAllProviders = true
          )
        }
      }
    }
  }
}

@Composable
private fun SummaryChip(label: String, value: String, modifier: Modifier = Modifier) {
  AppCard(modifier = modifier) {
    Text(label, style = FluentTypeRamp.caption1, color = LocalFluentColors.current.neutralForeground2)
    Spacer(Modifier.height(4.dp))
    Text(value, style = FluentTypeRamp.title2, fontWeight = FontWeight.SemiBold)
  }
}
