package com.igng.tokenmonitor.android.ui.widgets

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.igng.tokenmonitor.android.ui.PreferencesViewModel
import com.igng.tokenmonitor.android.ui.components.AppCard
import com.igng.tokenmonitor.android.ui.components.FluentButton
import com.igng.tokenmonitor.android.ui.components.FluentButtonVariant
import com.igng.tokenmonitor.android.ui.components.FluentChoiceRow
import com.igng.tokenmonitor.android.ui.components.FluentIcons
import com.igng.tokenmonitor.android.ui.components.FluentSection
import com.igng.tokenmonitor.android.ui.components.FluentToggle
import com.igng.tokenmonitor.android.ui.components.FluentTopBar
import com.igng.tokenmonitor.android.ui.components.rememberScrolledFlag
import com.igng.tokenmonitor.android.ui.haptics.HapticEvent
import com.igng.tokenmonitor.android.ui.haptics.rememberAppHaptics
import com.igng.tokenmonitor.android.ui.theme.FluentSpacingDefaults
import com.igng.tokenmonitor.android.ui.theme.FluentTypeRamp
import com.igng.tokenmonitor.android.ui.theme.LocalFluentColors
import com.igng.tokenmonitor.android.widget.WidgetKind
import com.igng.tokenmonitor.android.widget.WidgetRegistry

private data class WidgetCard(
  val kind: WidgetKind,
  val title: String,
  val subtitle: String,
  val sizes: String,
  val icon: Int
)

private val widgetCards = listOf(
  WidgetCard(
    WidgetKind.Today,
    "今日",
    "今日 token、费用与最近七日迷你趋势。",
    "2×2 / 4×2",
    FluentIcons.Home
  ),
  WidgetCard(
    WidgetKind.Quota,
    "额度",
    "按紧迫度排列的账号额度、重置时间与异常状态。",
    "2×2 / 4×2",
    FluentIcons.Wallet
  ),
  WidgetCard(
    WidgetKind.Trend,
    "趋势",
    "最近七日的 token 或费用走势，点按切换指标。",
    "4×2",
    FluentIcons.Poll
  ),
  WidgetCard(
    WidgetKind.Dashboard,
    "仪表盘",
    "今日用量、趋势、额度和在线设备一屏全览。",
    "4×4",
    FluentIcons.BoardSplit
  )
)

@Composable
fun WidgetsScreen(
  onBack: () -> Unit,
  onHome: (() -> Unit)? = null,
  preferencesViewModel: PreferencesViewModel = hiltViewModel()
) {
  val prefs by preferencesViewModel.preferences.collectAsStateWithLifecycle()
  val context = LocalContext.current
  val haptics = rememberAppHaptics()
  val colors = LocalFluentColors.current
  val listState = rememberLazyListState()
  val scrolled = rememberScrolledFlag(listState)
  var message by remember { mutableStateOf<String?>(null) }

  Column(Modifier.fillMaxSize()) {
    FluentTopBar(
      title = "小组件",
      onBack = {
        haptics.perform(HapticEvent.Tap)
        onBack()
      },
      onHome = onHome,
      scrolled = scrolled
    )
    LazyColumn(
      state = listState,
      modifier = Modifier.fillMaxSize(),
      contentPadding = androidx.compose.foundation.layout.PaddingValues(
        start = FluentSpacingDefaults.l,
        end = FluentSpacingDefaults.l,
        top = FluentSpacingDefaults.s,
        bottom = FluentSpacingDefaults.xxxl
      ),
      verticalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.m)
    ) {
      item {
        Text(
          "把计然放到桌面。数字按设定的间隔更新；打开应用刷新时也会立即同步。离线时保留上次快照并标明时间。",
          style = FluentTypeRamp.body2,
          color = colors.neutralForeground2
        )
      }
      message?.let { text ->
        item {
          Text(
            text,
            style = FluentTypeRamp.caption1,
            color = colors.warningForeground
          )
        }
      }
      items(widgetCards.size) { index ->
        val card = widgetCards[index]
        AppCard {
          Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.m)
          ) {
            Icon(
              painter = painterResource(card.icon),
              contentDescription = null,
              tint = colors.brandForeground1,
              modifier = Modifier.size(24.dp)
            )
            Column(Modifier.weight(1f)) {
              Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                  card.title,
                  style = FluentTypeRamp.title3,
                  fontWeight = FontWeight.SemiBold,
                  color = colors.neutralForeground1
                )
                Spacer(Modifier.width(FluentSpacingDefaults.s))
                Text(
                  card.sizes,
                  style = FluentTypeRamp.caption2,
                  color = colors.neutralForeground3
                )
              }
              Spacer(Modifier.height(FluentSpacingDefaults.xs))
              Text(
                card.subtitle,
                style = FluentTypeRamp.body2,
                color = colors.neutralForeground2
              )
            }
          }
          Spacer(Modifier.height(FluentSpacingDefaults.m))
          FluentButton(
            label = "添加到桌面",
            variant = FluentButtonVariant.Subtle,
            onClick = {
              haptics.perform(HapticEvent.Tap)
              message = requestPin(context, card.kind)
            }
          )
        }
      }
      item {
        Spacer(Modifier.height(FluentSpacingDefaults.s))
        FluentSection(
          title = "刷新与隐私",
          subtitle = "对所有计然小组件生效"
        ) {
          AppCard {
            Text(
              "刷新间隔",
              style = FluentTypeRamp.body1,
              fontWeight = FontWeight.SemiBold,
              color = colors.neutralForeground1
            )
            Spacer(Modifier.height(FluentSpacingDefaults.xs))
            listOf(15, 30, 60, 180).forEach { minutes ->
              FluentChoiceRow(
                selected = prefs.widgetRefreshMinutes == minutes,
                onSelect = {
                  haptics.perform(HapticEvent.Tap)
                  preferencesViewModel.setWidgetRefreshMinutes(minutes)
                },
                label = when (minutes) {
                  15 -> "15 分钟"
                  30 -> "30 分钟（推荐）"
                  60 -> "1 小时"
                  else -> "3 小时"
                },
                role = androidx.compose.ui.semantics.Role.RadioButton
              )
            }
            Text(
              "Android 会把后台任务合并或在省电模式下延后；组件上的“更新于”始终是真实时间。",
              style = FluentTypeRamp.caption2,
              color = colors.neutralForeground3
            )
            Spacer(Modifier.height(FluentSpacingDefaults.l))
            Row(
              Modifier.fillMaxWidth(),
              verticalAlignment = Alignment.CenterVertically
            ) {
              Column(Modifier.weight(1f)) {
                Text(
                  "隐藏费用",
                  style = FluentTypeRamp.body1,
                  fontWeight = FontWeight.SemiBold,
                  color = colors.neutralForeground1
                )
                Text(
                  "只显示 token，金额显示为 ••••。",
                  style = FluentTypeRamp.caption2,
                  color = colors.neutralForeground3
                )
              }
              FluentToggle(
                checked = prefs.widgetHideCost,
                onCheckedChange = {
                  haptics.perform(HapticEvent.Tap)
                  preferencesViewModel.setWidgetHideCost(it)
                },
                label = "隐藏费用"
              )
            }
          }
        }
      }
    }
  }
}

private fun requestPin(context: android.content.Context, kind: WidgetKind): String {
  val manager = AppWidgetManager.getInstance(context)
  if (!manager.isRequestPinAppWidgetSupported) {
    return "当前启动器不支持直接添加。请长按桌面 → 小组件 → 计然。"
  }
  val spec = WidgetRegistry.specs.first { it.kind == kind }
  val provider = ComponentName(context, spec.provider)
  val requested = manager.requestPinAppWidget(provider, null, null)
  return if (requested) {
    "已向启动器发送添加请求。"
  } else {
    "启动器没有接受请求。请长按桌面 → 小组件 → 计然。"
  }
}
