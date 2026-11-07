package com.igng.tokenmonitor.android.ui.analytics

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.igng.tokenmonitor.android.R
import com.igng.tokenmonitor.android.data.model.PeriodDto
import com.igng.tokenmonitor.android.ui.NormalizedSessionRow
import com.igng.tokenmonitor.android.ui.components.AppCard
import com.igng.tokenmonitor.android.ui.components.FluentButton
import com.igng.tokenmonitor.android.ui.components.FluentButtonVariant
import com.igng.tokenmonitor.android.ui.components.FluentListRow
import com.igng.tokenmonitor.android.ui.components.FluentTabStrip
import com.igng.tokenmonitor.android.ui.components.FluentTextField
import com.igng.tokenmonitor.android.ui.components.SegmentedTokenBar
import com.igng.tokenmonitor.android.ui.components.formatTokensShort
import com.igng.tokenmonitor.android.ui.components.rememberCostFormatter
import com.igng.tokenmonitor.android.ui.theme.FluentShapeDefaults
import com.igng.tokenmonitor.android.ui.theme.FluentSpacingDefaults
import com.igng.tokenmonitor.android.ui.theme.FluentTypeRamp
import com.igng.tokenmonitor.android.ui.theme.LocalFluentColors

@Composable
fun ModelWorkspacePanel(
  period: PeriodDto?,
  sessions: List<NormalizedSessionRow>,
  selectedModels: Set<String>,
  onToggleComparison: (String) -> Unit,
  onClearComparison: () -> Unit,
  onOpenDetail: (String) -> Unit
) {
  var query by rememberSaveable { mutableStateOf("") }
  var sort by rememberSaveable { mutableStateOf(ModelSort.Tokens) }
  val allRows = buildModelRows(period, sessions)
  val rows = queryModelRows(allRows, query, sort)
  val compared = selectedModels.mapNotNull { name -> allRows.firstOrNull { it.name == name } }
  val cost = rememberCostFormatter()
  val colors = LocalFluentColors.current

  AppCard {
    FluentTextField(
      value = query,
      onValueChange = { query = it.take(256) },
      label = stringResource(R.string.model_search)
    )
    Spacer(Modifier.height(FluentSpacingDefaults.s))
    FluentTabStrip(
      options = listOf(
        stringResource(R.string.sort_tokens), stringResource(R.string.sort_cost),
        stringResource(R.string.model_input), stringResource(R.string.model_output),
        stringResource(R.string.sort_name)
      ),
      selectedIndex = sort.ordinal,
      onSelect = { sort = ModelSort.entries[it] }
    )
    Spacer(Modifier.height(FluentSpacingDefaults.s))
    Text(
      stringResource(R.string.model_compare_hint, selectedModels.size),
      style = FluentTypeRamp.caption1,
      color = colors.neutralForeground2
    )
    if (selectedModels.isNotEmpty()) {
      FluentButton(
        label = stringResource(R.string.model_compare_clear),
        onClick = onClearComparison,
        variant = FluentButtonVariant.Subtle
      )
    }
  }

  if (compared.size >= 2) {
    Spacer(Modifier.height(FluentSpacingDefaults.m))
    ModelComparisonTable(compared)
  }

  Spacer(Modifier.height(FluentSpacingDefaults.m))
  AppCard {
    Text(stringResource(R.string.model_results, rows.size), style = FluentTypeRamp.title3)
    rows.take(100).forEach { row ->
      val selected = row.name in selectedModels
      FluentListRow(
        primary = row.name,
        secondary = stringResource(R.string.model_client_device_count, row.clients.size, row.devices.size),
        tertiary = row.outputTokens?.let { stringResource(R.string.model_output_value, formatTokensShort(it)) }
          ?: stringResource(R.string.model_components_unknown),
        trailingPrimary = formatTokensShort(row.tokens),
        trailingSecondary = row.costUsd?.let { cost.format(it) } ?: "—",
        onClick = { onOpenDetail(row.name) },
        disclosure = true
      )
      Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.End,
        verticalAlignment = Alignment.CenterVertically
      ) {
        FluentButton(
          label = stringResource(if (selected) R.string.model_compare_remove else R.string.model_compare_add),
          onClick = { onToggleComparison(row.name) },
          variant = if (selected) FluentButtonVariant.Outline else FluentButtonVariant.Subtle,
          enabled = selected || selectedModels.size < 4
        )
      }
    }
    if (rows.size > 100) {
      Text(stringResource(R.string.model_results_capped), style = FluentTypeRamp.caption1)
    }
    if (rows.isEmpty()) {
      Text(stringResource(R.string.model_no_results), color = colors.neutralForeground2)
    }
  }
}

@Composable
private fun ModelComparisonTable(rows: List<ModelAnalyticsRow>) {
  val cost = rememberCostFormatter()
  val colors = LocalFluentColors.current
  AppCard {
    Text(stringResource(R.string.model_compare_title), style = FluentTypeRamp.title3)
    Spacer(Modifier.height(FluentSpacingDefaults.s))
    Column(Modifier.horizontalScroll(rememberScrollState())) {
      Row {
        Text(stringResource(R.string.model_metric), Modifier.width(112.dp), fontWeight = FontWeight.SemiBold)
        rows.forEach { row -> Text(row.name, Modifier.width(144.dp), fontWeight = FontWeight.SemiBold, maxLines = 1) }
      }
      val metrics = listOf<(ModelAnalyticsRow) -> String>(
        { formatTokensShort(it.tokens) },
        { row -> row.costUsd?.let { value -> cost.format(value) } ?: "—" },
        { it.inputTokens?.let(::formatTokensShort) ?: "—" },
        { it.outputTokens?.let(::formatTokensShort) ?: "—" },
        { it.cacheReadTokens?.let(::formatTokensShort) ?: "—" },
        { it.cacheWriteTokens?.let(::formatTokensShort) ?: "—" },
        { it.clients.size.toString() },
        { it.sessions.size.toString() }
      )
      val labels = listOf(
        R.string.sort_tokens, R.string.sort_cost, R.string.model_input, R.string.model_output,
        R.string.model_cache_read, R.string.model_cache_write, R.string.model_clients, R.string.model_sessions
      )
      labels.forEachIndexed { index, label ->
        Row {
          Text(stringResource(label), Modifier.width(112.dp), color = colors.neutralForeground2)
          rows.forEach { row -> Text(metrics[index](row), Modifier.width(144.dp)) }
        }
      }
    }
  }
}

@Composable
fun ModelTokenMix(row: ModelAnalyticsRow) {
  val parts = listOfNotNull(
    row.inputTokens?.let { "输入" to it },
    row.outputTokens?.let { "输出" to it },
    row.cacheReadTokens?.let { "缓存读取" to it },
    row.cacheWriteTokens?.let { "缓存写入" to it }
  )
  if (parts.isNotEmpty()) SegmentedTokenBar(parts)
  if (parts.size < 4) Text(stringResource(R.string.model_components_unknown), style = FluentTypeRamp.caption1)
}
