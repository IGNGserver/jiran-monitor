package com.igng.tokenmonitor.android.widget

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.igng.tokenmonitor.android.data.local.ThemeMode
import com.igng.tokenmonitor.android.data.local.UserPreferencesStore
import com.igng.tokenmonitor.android.ui.components.AppCard
import com.igng.tokenmonitor.android.ui.components.FluentButton
import com.igng.tokenmonitor.android.ui.components.FluentCardList
import com.igng.tokenmonitor.android.ui.components.FluentChoiceRow
import com.igng.tokenmonitor.android.ui.components.FluentSection
import com.igng.tokenmonitor.android.ui.components.FluentToggle
import com.igng.tokenmonitor.android.ui.components.FluentTopBar
import com.igng.tokenmonitor.android.ui.components.providerDisplayName
import com.igng.tokenmonitor.android.ui.theme.FluentSpacingDefaults
import com.igng.tokenmonitor.android.ui.theme.FluentTypeRamp
import com.igng.tokenmonitor.android.ui.theme.LocalFluentColors
import com.igng.tokenmonitor.android.ui.theme.TokenMonitorTheme
import dagger.hilt.android.AndroidEntryPoint
import java.time.ZoneId
import javax.inject.Inject

/**
 * Shared configure screen for all four providers. The launcher launches it
 * explicitly on first placement and (on Android 12+) from "Edit"; it must return
 * the appWidgetId in RESULT_OK or the host discards the card.
 */
@AndroidEntryPoint
class WidgetConfigActivity : ComponentActivity() {
  @Inject lateinit var preferences: UserPreferencesStore
  @Inject lateinit var widgetPreferences: WidgetPreferencesStore
  @Inject lateinit var snapshotStore: WidgetSnapshotStore

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()
    val widgetId = intent?.extras?.getInt(
      AppWidgetManager.EXTRA_APPWIDGET_ID,
      AppWidgetManager.INVALID_APPWIDGET_ID
    ) ?: AppWidgetManager.INVALID_APPWIDGET_ID
    val kind = if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
      null
    } else {
      WidgetRegistry.kindForWidget(this, widgetId)
    }
    if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID || kind == null) {
      setResult(RESULT_CANCELED)
      finish()
      return
    }

    // Android's contract: until the user presses 完成, a back/cancel must not
    // leave an unconfigured card behind.
    setResult(RESULT_CANCELED)

    setContent {
      val prefs by preferences.preferences.collectAsStateWithLifecycle()
      val dark = when (prefs.themeMode) {
        ThemeMode.Light -> false
        ThemeMode.Dark -> true
        ThemeMode.System -> isSystemInDarkTheme()
      }
      LaunchedEffect(dark) {
        enableEdgeToEdge(
          statusBarStyle = if (dark) SystemBarStyle.dark(android.graphics.Color.TRANSPARENT)
          else SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
          navigationBarStyle = if (dark) SystemBarStyle.dark(android.graphics.Color.TRANSPARENT)
          else SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT)
        )
      }
      TokenMonitorTheme(themeSeed = prefs.themeSeed, themeMode = prefs.themeMode) {
        WidgetConfigContent(
          kind = kind,
          prefs = prefs,
          snapshot = remember { snapshotStore.read() },
          initialMetric = remember(widgetId) { widgetPreferences.trendMetric(widgetId) },
          initialAccounts = remember(widgetId) { widgetPreferences.selectedAccountIds(widgetId) },
          onSaveMetric = { widgetPreferences.setTrendMetric(widgetId, it) },
          onSaveAccounts = { widgetPreferences.setSelectedAccountIds(widgetId, it) },
          onHideCost = {
            preferences.setWidgetHideCost(it)
            runCatching { WidgetRenderer.updateAll(this) }
          },
          onCancel = { finish() },
          onDone = {
            runCatching { WidgetRenderer.updateWidget(this, widgetId) }
            // The host normally follows configure with onUpdate, but a launcher is
            // not required to; scheduling here is what guarantees the first poll.
            WidgetRefreshScheduler.ensureScheduled(this)
            WidgetRefreshScheduler.refreshNow(this)
            setResult(
              RESULT_OK,
              Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
            )
            finish()
          }
        )
      }
    }
  }
}

@Composable
private fun WidgetConfigContent(
  kind: WidgetKind,
  prefs: com.igng.tokenmonitor.android.data.local.UserPreferences,
  snapshot: WidgetSnapshot?,
  initialMetric: WidgetTrendMetric,
  initialAccounts: Set<String>,
  onSaveMetric: (WidgetTrendMetric) -> Unit,
  onSaveAccounts: (Set<String>) -> Unit,
  onHideCost: (Boolean) -> Unit,
  onCancel: () -> Unit,
  onDone: () -> Unit
) {
  val colors = LocalFluentColors.current
  var metric by remember { mutableStateOf(initialMetric) }
  var accounts by remember { mutableStateOf(initialAccounts) }
  val scroll = rememberScrollState()

  // The platform window is light or dark by *system* mode; the in-app appearance
  // can be pinned the other way, so this page paints its own Fluent surface.
  Column(Modifier.fillMaxSize().background(colors.neutralBackground1)) {
    FluentTopBar(
      title = "配置小组件",
      subtitle = when (kind) {
        WidgetKind.Today -> "今日"
        WidgetKind.Quota -> "额度"
        WidgetKind.Trend -> "趋势"
        WidgetKind.Dashboard -> "仪表盘"
      },
      onBack = onCancel
    )
    Column(
      Modifier
        .fillMaxSize()
        .verticalScroll(scroll)
        .navigationBarsPadding()
        .padding(
          start = FluentSpacingDefaults.l,
          end = FluentSpacingDefaults.l,
          top = FluentSpacingDefaults.s,
          bottom = FluentSpacingDefaults.xxxl
        ),
      verticalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.m)
    ) {
      if (kind == WidgetKind.Trend || kind == WidgetKind.Dashboard) {
        FluentSection(
          title = "默认指标",
          subtitle = if (kind == WidgetKind.Trend) {
            "点按组件上的两个标签也可以随时切换"
          } else {
            "仪表盘的趋势图使用这个指标"
          }
        ) {
          FluentCardList {
            FluentChoiceRow(
              selected = metric == WidgetTrendMetric.Tokens,
              onSelect = {
                metric = WidgetTrendMetric.Tokens
                onSaveMetric(metric)
              },
              label = "Token",
              role = androidx.compose.ui.semantics.Role.RadioButton
            )
            FluentChoiceRow(
              selected = metric == WidgetTrendMetric.Cost,
              onSelect = {
                metric = WidgetTrendMetric.Cost
                onSaveMetric(metric)
              },
              label = "费用",
              role = androidx.compose.ui.semantics.Role.RadioButton
            )
          }
        }
      }

      if (kind == WidgetKind.Quota || kind == WidgetKind.Dashboard) {
        FluentSection(
          title = "展示账号",
          subtitle = "按紧迫度排序，最多展示 4 个"
        ) {
          val available = snapshot?.accounts.orEmpty()
          if (available.isEmpty()) {
            AppCard {
              Text(
                "还没有额度快照，先打开计然刷新一次再配置。",
                style = FluentTypeRamp.body2,
                color = colors.neutralForeground2
              )
            }
          } else {
            FluentCardList {
              available.forEach { account ->
                val row = WidgetCopy.row(account, System.currentTimeMillis(), ZoneId.systemDefault())
                FluentChoiceRow(
                  selected = account.id in accounts,
                  onSelect = {
                    accounts = if (account.id in accounts) {
                      accounts - account.id
                    } else {
                      accounts + account.id
                    }
                    onSaveAccounts(accounts)
                  },
                  label = buildString {
                    append(providerDisplayName(account.provider))
                    account.accountLabel?.takeIf { it.isNotBlank() }?.let {
                      append(" · ")
                      append(it)
                    }
                  },
                  description = "${row.planLine} · ${row.remainingText}",
                  role = androidx.compose.ui.semantics.Role.Checkbox
                )
              }
            }
            Text(
              "不选择任何账号时自动展示最紧急的几个。",
              style = FluentTypeRamp.caption2,
              color = colors.neutralForeground3
            )
          }
        }
      }

      FluentSection(
        title = "隐私",
        subtitle = "对所有计然小组件生效"
      ) {
        AppCard {
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
              onCheckedChange = onHideCost,
              label = "隐藏费用"
            )
          }
        }
      }

      Text(
        "桌面上的卡片可以拖动改变尺寸；尺寸变化后内容会自动调整。",
        style = FluentTypeRamp.caption2,
        color = colors.neutralForeground3
      )
      Spacer(Modifier.height(FluentSpacingDefaults.s))
      FluentButton(
        label = "完成",
        filledWidth = true,
        onClick = onDone
      )
    }
  }
}
