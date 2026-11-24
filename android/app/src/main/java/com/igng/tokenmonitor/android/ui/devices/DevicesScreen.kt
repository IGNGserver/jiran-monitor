package com.igng.tokenmonitor.android.ui.devices

import androidx.compose.runtime.mutableStateOf
import com.igng.tokenmonitor.android.ui.HubUiState
import com.igng.tokenmonitor.android.ui.components.FluentButtonVariant
import com.igng.tokenmonitor.android.ui.components.FluentButton
import com.igng.tokenmonitor.android.ui.components.TrendMetric
import com.igng.tokenmonitor.android.ui.components.DailyTrendChart
import com.igng.tokenmonitor.android.ui.components.FluentTextField
import com.igng.tokenmonitor.android.ui.components.FluentIcons
import android.net.Uri
import androidx.compose.foundation.border
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import com.igng.tokenmonitor.android.data.model.DeviceDto
import com.igng.tokenmonitor.android.data.model.PeriodDto
import com.igng.tokenmonitor.android.data.model.StatsDto
import com.igng.tokenmonitor.android.ui.components.AppCard
import com.igng.tokenmonitor.android.ui.components.ClientBranding
import com.igng.tokenmonitor.android.ui.components.CompactMetricCard
import com.igng.tokenmonitor.android.ui.components.DeviceComparisonChart
import com.igng.tokenmonitor.android.ui.components.DevicesSkeleton
import com.igng.tokenmonitor.android.ui.components.EmptyState
import com.igng.tokenmonitor.android.ui.components.FluentListRow
import com.igng.tokenmonitor.android.ui.components.FluentPageHeader
import com.igng.tokenmonitor.android.ui.components.FluentProgressRing
import com.igng.tokenmonitor.android.ui.components.FluentTabStrip
import com.igng.tokenmonitor.android.ui.components.FluentTopBar
import com.igng.tokenmonitor.android.ui.components.LimitsSection
import com.igng.tokenmonitor.android.ui.components.MetricHeroCard
import com.igng.tokenmonitor.android.ui.components.PlatformOsIcon
import com.igng.tokenmonitor.android.ui.components.SectionHeader
import com.igng.tokenmonitor.android.ui.components.ShareBarList
import com.igng.tokenmonitor.android.ui.components.StatusDot
import com.igng.tokenmonitor.android.ui.components.agentRuntimeLabel
import com.igng.tokenmonitor.android.ui.components.clientStatusLabel
import com.igng.tokenmonitor.android.ui.components.deviceConnectionLabel
import com.igng.tokenmonitor.android.ui.components.deviceCountsAsOnline
import com.igng.tokenmonitor.android.ui.components.fleetOnlineCount
import com.igng.tokenmonitor.android.ui.components.fleetSorted
import com.igng.tokenmonitor.android.ui.components.devicePlatformLabel
import com.igng.tokenmonitor.android.ui.components.formatRelativeTime
import com.igng.tokenmonitor.android.ui.components.formatTokensShort
import com.igng.tokenmonitor.android.ui.components.formatUsd
import com.igng.tokenmonitor.android.ui.components.keyedDevices
import com.igng.tokenmonitor.android.ui.components.rememberScrolledFlag
import com.igng.tokenmonitor.android.ui.components.topShareEntries
import com.igng.tokenmonitor.android.ui.components.wslStatusLabel
import com.igng.tokenmonitor.android.ui.components.listGroupShape
import com.igng.tokenmonitor.android.ui.haptics.HapticEvent
import com.igng.tokenmonitor.android.ui.haptics.rememberAppHaptics
import com.igng.tokenmonitor.android.ui.theme.FluentShapeDefaults
import com.igng.tokenmonitor.android.ui.theme.FluentSpacingDefaults
import com.igng.tokenmonitor.android.ui.theme.FluentTypeRamp
import com.igng.tokenmonitor.android.ui.theme.LocalFluentColors

private val periodOptions = listOf("今日", "本月", "全部")
private val periodKeys = listOf("today", "month", "allTime")

@Composable
fun DevicesScreen(
  devices: List<DeviceDto>,
  navController: NavHostController,
  isLoading: Boolean = false
) {
  val colors = LocalFluentColors.current
  val haptics = rememberAppHaptics()
  // No top bar on this screen (it uses the page header), so there is no scroll flag to
  // derive; `rememberScrolledFlag` was computing one nothing read.
  val listState = rememberLazyListState()
  val sorted = fleetSorted(devices)
  val keyed = remember(sorted) { keyedDevices(sorted) }
  val activeDevices = sorted.filterNot { it.stale }
  val onlineCount = fleetOnlineCount(devices)

  Column(Modifier.fillMaxSize()) {
    FluentPageHeader(
      title = "设备",
      subtitle = if (devices.isEmpty()) "暂无上报设备" else "$onlineCount 在线 · ${devices.size} 台合计"
    )
    when {
      isLoading && devices.isEmpty() -> DevicesSkeleton()
      sorted.isEmpty() -> EmptyState(
        title = "无设备",
        text = "还没有设备上报到 Hub。",
        icon = FluentIcons.PhoneLaptop
      )
      else -> LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(
          start = FluentSpacingDefaults.l,
          end = FluentSpacingDefaults.l,
          top = FluentSpacingDefaults.xs,
          bottom = FluentSpacingDefaults.xxxl
        ),
        // Rows of one group touch: the group is a single surface separated by
        // hairlines, not N stacked cards.  External gaps are applied per item below,
        // which is also what lets the device rows stay virtualized.
        verticalArrangement = Arrangement.spacedBy(0.dp)
      ) {
        item(key = "devices-comparison") {
          AppCard(modifier = Modifier.padding(bottom = FluentSpacingDefaults.m)) {
            SectionHeader(
              title = "今日对比",
              subtitle = "按设备 Token 用量"
            )
            Spacer(Modifier.height(FluentSpacingDefaults.m))
            DeviceComparisonChart(devices = activeDevices, limit = 10, showCost = true)
          }
        }

        // One row per lazy item, so the fleet stays virtualized: a few hundred machines
        // used to compose inside a single `item`, which is why this page was the one that
        // scrolled badly. `listGroupShape` keeps the grouped Fluent look while the rows
        // are virtualized — the first and last carry the rounded, outlined edges and the
        // ones between them stay square. `dividerAbove` asks whether a predecessor exists
        // rather than trusting the loop index, which is not stable across a keyed list.
        itemsIndexed(
          items = keyed,
          key = { _, item -> item.key }
        ) { index, item ->
          val device = item.device
          val deviceId = device.deviceId?.trim().orEmpty()
          DeviceRow(
            device = device,
            dividerAbove = index > 0,
            groupShape = listGroupShape(index, keyed.size),
            onClick = deviceId.takeIf { it.isNotBlank() }?.let { id ->
              {
                haptics.perform(HapticEvent.Tap)
                navController.navigate("device/${Uri.encode(id)}")
              }
            }
          )
        }
      }
    }
  }
}

@Composable
private fun DeviceRow(
  device: DeviceDto,
  dividerAbove: Boolean,
  groupShape: androidx.compose.ui.graphics.Shape = FluentShapeDefaults.cardCorner,
  onClick: (() -> Unit)?
) {
  val colors = LocalFluentColors.current
  FluentListRow(
    primary = device.hostname ?: device.deviceId.orEmpty(),
    secondary = buildString {
      append(devicePlatformLabel(device.platform, device.osName, device.osVersion))
      append(" · ")
      append(deviceConnectionLabel(device.stale, device.clientStatus))
      agentRuntimeLabel(device.agentRuntime).takeIf { it.isNotBlank() }?.let {
        append(" · ")
        append(it)
      }
    },
    tertiary = "上次上报 ${formatRelativeTime(device.receivedAt)}",
    leading = {
      Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.xs)
      ) {
        StatusDot(active = !device.stale, size = 8.dp)
        PlatformOsIcon(platform = device.platform ?: device.osName, size = 16.dp)
      }
    },
    trailingPrimary = formatTokensShort(device.periods.today.totalTokens),
    trailingSecondary = formatUsd(device.periods.today.costUsd, compact = true),
    disclosure = onClick != null,
    dividerAbove = dividerAbove,
    containerShape = groupShape,
    // Only the caps carry the outline: interior rows are separated by the hairline
    // `dividerAbove` already draws, and a border on every row would stack two strokes
    // on every interior edge.
    containerBorder = !dividerAbove,
    onClick = onClick
  )
}

@Composable
fun DeviceDetailScreen(
  device: DeviceDto?,
  onBack: () -> Unit,
  onHome: (() -> Unit)? = null,
  hubState: HubUiState? = null,
  canManage: Boolean = false,
  onRenameDevice: (String, String) -> Unit = { _, _ -> },
  onDeleteDevice: (String) -> Unit = {},
  /** Full periods (session archive + client×model grain) from `/api/devices/{id}`. */
  detail: DeviceDto? = null,
  detailLoading: Boolean = false,
  detailError: String? = null,
  /** Whether the Hub serves the on-demand detail endpoint at all. */
  detailSupported: Boolean = false,
  onRetryDetail: () -> Unit = {}
) {
  val colors = LocalFluentColors.current
  var periodIndex by rememberSaveable { mutableIntStateOf(0) }
  val safePeriodIndex = periodIndex.coerceIn(periodOptions.indices)
  val scrollState = rememberScrollState()
  val scrolled = rememberScrolledFlag(scrollState)
  // The fleet summary drops each device's session archive and client×model grain,
  // so the on-demand detail is what the period blocks below actually read. Prefer
  // it, and fall back to the snapshot entry so staleness/identity render instantly.
  val resolved = detail ?: device
  val shown = resolved

  Column(Modifier.fillMaxSize()) {
    FluentTopBar(
      title = resolved?.hostname ?: "设备详情",
      onBack = onBack,
      onHome = onHome,
      scrolled = scrolled,
      subtitle = resolved?.let {
        devicePlatformLabel(it.platform, it.osName, it.osVersion)
      }
    )
    if (shown == null) {
      if (detailLoading) {
        Row(
          Modifier.padding(FluentSpacingDefaults.l),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.s)
        ) {
          FluentProgressRing(size = 16.dp, strokeWidth = 2.dp)
          Text("正在获取本设备明细…", style = FluentTypeRamp.caption1, color = colors.neutralForeground2)
        }
      } else if (detailError != null) {
        Column(Modifier.padding(FluentSpacingDefaults.l)) {
          Text(detailError, style = FluentTypeRamp.body2, color = colors.neutralForeground2)
          Spacer(Modifier.height(FluentSpacingDefaults.s))
          FluentButton(label = "重试", onClick = onRetryDetail, variant = FluentButtonVariant.Outline)
        }
      } else {
        EmptyState(text = "设备已从当前 Hub 快照中移除。")
      }
      return@Column
    }
    val selectedPeriod: PeriodDto = when (safePeriodIndex) {
      1 -> shown.periods.month
      2 -> shown.periods.allTime
      else -> shown.periods.today
    }
    val periodLabel = periodOptions[safePeriodIndex]

    Column(
      Modifier
        .fillMaxSize()
        .verticalScroll(scrollState)
        .padding(horizontal = FluentSpacingDefaults.l, vertical = FluentSpacingDefaults.m),
      verticalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.m)
    ) {
      // Identity block
      Row(verticalAlignment = Alignment.CenterVertically) {
        StatusDot(active = !shown.stale, size = 10.dp)
        Spacer(Modifier.width(FluentSpacingDefaults.m))
        Column {
          Text(
            shown.hostname ?: shown.deviceId.orEmpty(),
            style = FluentTypeRamp.title1,
            color = colors.neutralForeground1
          )
          Text(
            buildString {
              append(devicePlatformLabel(shown.platform, shown.osName, shown.osVersion))
              append(" · ")
              append(deviceConnectionLabel(shown.stale, shown.clientStatus))
              agentRuntimeLabel(shown.agentRuntime).takeIf { it.isNotBlank() }?.let {
                append(" · ")
                append(it)
              }
            },
            style = FluentTypeRamp.caption1,
            color = colors.neutralForeground2
          )
          Text(
            "上次上报 ${formatRelativeTime(shown.receivedAt)}",
            style = FluentTypeRamp.caption2,
            color = colors.neutralForeground3
          )
        }
      }

      if (shown.clientStatus.isNotEmpty()) {
        AppCard {
          SectionHeader(title = "工具状态", subtitle = "来自采集端 clientStatus")
          Spacer(Modifier.height(FluentSpacingDefaults.s))
          shown.clientStatus.entries
            .sortedBy { it.key }
            .forEach { (client, state) ->
              Row(
                Modifier
                  .fillMaxWidth()
                  .semantics {
                    contentDescription =
                      "${ClientBranding.label(client)} ${clientStatusLabel(state)}"
                  }
                  .padding(vertical = FluentSpacingDefaults.xs),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
              ) {
                Text(
                  ClientBranding.label(client),
                  style = FluentTypeRamp.body2,
                  color = colors.neutralForeground1
                )
                Text(
                  clientStatusLabel(state),
                  style = FluentTypeRamp.caption1,
                  color = colors.neutralForeground2
                )
              }
            }
        }
      }

      shown.wslStatus?.state?.takeIf { it.isNotBlank() }?.let { state ->
        AppCard {
          SectionHeader(title = "WSL 状态", subtitle = wslStatusLabel(state))
          Spacer(Modifier.height(FluentSpacingDefaults.s))
          val detected = shown.wslStatus?.detected.orEmpty()
          val withData = shown.wslStatus?.withData.orEmpty()
          if (detected.isNotEmpty()) {
            Text(
              "已检测：" + detected.joinToString { ClientBranding.label(it) },
              style = FluentTypeRamp.caption1,
              color = colors.neutralForeground2
            )
          }
          if (withData.isNotEmpty()) {
            Spacer(Modifier.height(FluentSpacingDefaults.xxs))
            Text(
              "有数据：" + withData.joinToString { ClientBranding.label(it) },
              style = FluentTypeRamp.caption1,
              color = colors.neutralForeground2
            )
          }
        }
      }

      // Period selection drives every block below it, so it sits above them.
      FluentTabStrip(
        options = periodOptions,
        selectedIndex = safePeriodIndex,
        onSelect = { periodIndex = it },
        modifier = Modifier.fillMaxWidth()
      )

      MetricHeroCard(title = periodLabel, period = selectedPeriod)

      // A summary-only snapshot has headline totals for this device but no
      // client×model grain; say so and offer the pull rather than rendering empty
      // breakdowns that look like "no usage".
      if (detail == null && detailLoading) {
        Row(
          Modifier.fillMaxWidth(),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.s)
        ) {
          FluentProgressRing(size = 16.dp, strokeWidth = 2.dp)
          Text("正在获取本设备明细…", style = FluentTypeRamp.caption1, color = colors.neutralForeground2)
        }
      } else if (detail == null && detailError != null) {
        AppCard {
          Text(detailError, style = FluentTypeRamp.body2, color = colors.neutralForeground2)
          Spacer(Modifier.height(FluentSpacingDefaults.s))
          FluentButton(label = "重试", onClick = onRetryDetail, variant = FluentButtonVariant.Outline)
        }
      } else if (detail == null && detailSupported) {
        FluentButton(
          label = "加载本设备明细",
          onClick = onRetryDetail,
          variant = FluentButtonVariant.Outline
        )
      }

      Row(horizontalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.s)) {
        CompactMetricCard(
          title = "本月",
          period = shown.periods.month,
          modifier = Modifier.weight(1f)
        )
        CompactMetricCard(
          title = "全部时间",
          period = shown.periods.allTime,
          modifier = Modifier.weight(1f)
        )
      }

      val clients = topShareEntries(
        selectedPeriod.clients,
        selectedPeriod.clientCosts,
        selectedPeriod.clientEstimated,
        selectedPeriod.clientCredits,
        selectedPeriod.clientMeasurements,
        limit = 6
      )
      if (clients.isNotEmpty()) {
        AppCard {
          SectionHeader(title = "${periodLabel}客户端", subtitle = "本设备 · 可展开模型")
          clients.forEach { entry ->
            Spacer(Modifier.height(FluentSpacingDefaults.m))
            ShareBarList(listOf(entry))
            if (entry.key != "其他") {
              val nested = selectedPeriod.clientModels[entry.key].orEmpty()
              val nestedCosts = selectedPeriod.clientModelCosts[entry.key].orEmpty()
              val modelEntries = topShareEntries(nested, nestedCosts, limit = 6)
              if (modelEntries.isNotEmpty()) {
                Spacer(Modifier.height(FluentSpacingDefaults.s))
                Text(
                  "${ClientBranding.label(entry.key)} 模型",
                  style = FluentTypeRamp.caption2,
                  fontWeight = FontWeight.SemiBold,
                  color = colors.neutralForeground3
                )
                Spacer(Modifier.height(FluentSpacingDefaults.xs))
                ShareBarList(modelEntries, brandClients = false)
              }
            }
          }
        }
      }

      val models = topShareEntries(
        selectedPeriod.models,
        selectedPeriod.modelCosts,
        limit = 6
      )
      if (models.isNotEmpty()) {
        AppCard {
          SectionHeader(title = "${periodLabel}模型", subtitle = "本设备汇总")
          Spacer(Modifier.height(FluentSpacingDefaults.m))
          ShareBarList(models, brandClients = false)
        }
      }

      // The device's own trend.  Without `deviceId` the history document is the whole
      // fleet aggregated, so this page previously had no answer to "what did *this*
      // machine do".
      hubState?.let { snapshot ->
        val own = snapshot.deviceHistories[shown.deviceId]
        if (own != null && own.daily.isNotEmpty()) {
          AppCard {
            SectionHeader(
              title = "本机历史",
              subtitle = "近 ${own.daily.size} 天，按本机上报聚合"
            )
            Spacer(Modifier.height(FluentSpacingDefaults.m))
            DailyTrendChart(
              days = own.daily.takeLast(30),
              metric = TrendMetric.Tokens
            )
          }
        }
      }

      DeviceAdminRow(
        device = resolved,
        canRename = canManage && hubState?.authorization?.capabilities?.deviceRename != false,
        canDelete = canManage && hubState?.authorization?.capabilities?.deviceDelete != false,
        onRename = { name -> shown.deviceId?.let { onRenameDevice(it, name) } },
        onDelete = { shown.deviceId?.let { onDeleteDevice(it) } }
      )

      // No per-device limits block here, deliberately: the Hub deletes `limits` from
      // every device record (`delete device.limits` in src/hub/server.js) because quota
      // is Hub-owned account state, so a device section could only ever render empty.
      // The fleet-wide `LimitsSection` on 服务状态 is the real surface.
    }
  }
}

/**
 * Rename / delete, gated the same way the web gates them: the Hub advertises
 * `deviceRename` / `deviceDelete`; the connected owner performs the write.
 *
 * Deleting asks for confirmation *in place* — a second tap on the same control —
 * rather than a system dialog, because the destructive target is right there on
 * screen and a generic "are you sure" that does not name the device is noise.
 */
@Composable
private fun DeviceAdminRow(
  device: DeviceDto,
  canRename: Boolean,
  canDelete: Boolean,
  onRename: (String) -> Unit,
  onDelete: () -> Unit
) {
  if (!canRename && !canDelete) return
  val colors = LocalFluentColors.current
  var hostname by remember(device.deviceId) { mutableStateOf(device.hostname.orEmpty()) }
  var confirmingDelete by remember(device.deviceId) { mutableStateOf(false) }
  AppCard {
    SectionHeader(
      title = "设备管理",
      subtitle = "重命名或从 Hub 移除这台设备；移除后它的历史与当前快照都会删除。"
    )
    Spacer(Modifier.height(FluentSpacingDefaults.m))
    if (canRename) {
      FluentTextField(
        value = hostname,
        onValueChange = { hostname = it },
        label = "显示名称",
        supportingText = "只影响展示，不影响设备 ID。"
      )
      Spacer(Modifier.height(FluentSpacingDefaults.m))
      FluentButton(
        label = "保存名称",
        onClick = { onRename(hostname.trim()) },
        enabled = hostname.isNotBlank()
      )
    }
    if (canDelete) {
      Spacer(Modifier.height(FluentSpacingDefaults.m))
      FluentButton(
        label = if (confirmingDelete) "确认删除这台设备" else "删除设备",
        onClick = {
          if (confirmingDelete) onDelete() else confirmingDelete = true
        },
        variant = if (confirmingDelete) FluentButtonVariant.Filled else FluentButtonVariant.Outline
      )
      if (confirmingDelete) {
        Spacer(Modifier.height(FluentSpacingDefaults.xs))
        Text(
          "删除不可撤销：这台设备的历史记录会一并移除，需要它重新上报才会回来。",
          style = FluentTypeRamp.caption2,
          color = colors.errorForeground
        )
      }
    }
  }
}
