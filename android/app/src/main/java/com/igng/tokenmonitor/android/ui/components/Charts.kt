package com.igng.tokenmonitor.android.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.igng.tokenmonitor.android.ui.theme.FluentChartPalette
import com.igng.tokenmonitor.android.ui.theme.FluentMotion
import com.igng.tokenmonitor.android.ui.theme.FluentShapeDefaults
import com.igng.tokenmonitor.android.ui.theme.FluentSpacingDefaults
import com.igng.tokenmonitor.android.ui.theme.FluentTypeRamp
import com.igng.tokenmonitor.android.ui.theme.LocalFluentColors

// ─── Fluent 2 data visualisation ────────────────────────────────────────────
//
// Three deliberate departures from the previous Material-flavoured charts:
//
//   1. Marks are squared, not pill-rounded.  Fluent's bar grammar uses a small
//      control radius (2dp) — a full pill makes thin bars look like capsules and
//      destroys the linear reading of length.
//   2. Bars are 4dp, not 8–12dp.  A thinner mark keeps the *label* as the
//      dominant element and lets more rows fit without the chart shouting.
//   3. Adjacent segments are separated by a real gap rather than abutting,
//      so a donut's slice count is readable without consulting the legend.

@Composable
fun DonutChart(
  entries: List<ShareEntry>,
  modifier: Modifier = Modifier,
  chartSize: Dp = 148.dp,
  strokeWidth: Dp = 18.dp,
  centerPrimary: String? = null,
  centerSecondary: String? = null,
  showLegend: Boolean = true,
  brandClients: Boolean = true
) {
  val colors = LocalFluentColors.current
  val total = entries.sumOf { it.tokens }.coerceAtLeast(1L)
  val palette = FluentChartPalette
  // Fluent's "empty track" is a stroke-coloured ring, not a tinted surface.
  val track = colors.neutralStroke3
  // The reveal is keyed on which slices exist, never on their magnitudes: an SSE
  // frame that only moves a number must interpolate, not replay 0→1 (which read as
  // the chart blinking on every refresh).
  val resetKey = shareSeriesKey(entries)
  val grow = animateGrowProgress(resetKey = resetKey, durationMillis = FluentMotion.slower)

  fun sliceColor(index: Int, key: String): Color =
    if (brandClients) ClientBranding.color(key) else palette[index % palette.size]

  val rowModifier = if (showLegend) modifier.fillMaxWidth() else modifier

  Row(
    modifier = rowModifier,
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = if (showLegend) {
      Arrangement.spacedBy(FluentSpacingDefaults.l)
    } else {
      Arrangement.Center
    }
  ) {
    Box(contentAlignment = Alignment.Center, modifier = Modifier.size(chartSize)) {
      Canvas(Modifier.size(chartSize)) {
        val stroke = strokeWidth.toPx()
        val diameter = this.size.minDimension - stroke
        val topLeft = Offset(stroke / 2f, stroke / 2f)
        val arcSize = Size(diameter, diameter)
        drawArc(
          color = track,
          startAngle = -90f,
          sweepAngle = 360f,
          useCenter = false,
          topLeft = topLeft,
          size = arcSize,
          style = Stroke(width = stroke, cap = StrokeCap.Butt)
        )
        if (entries.isEmpty() || grow <= 0f) return@Canvas
        // One gap per boundary, expressed in degrees and clamped so a slice can
        // never be eaten entirely on a many-way split.
        val gap = if (entries.size > 1) 2f else 0f
        var start = -90f
        entries.forEachIndexed { index, entry ->
          val fullSweep = (entry.tokens.toFloat() / total.toFloat()) * 360f
          val sweep = (fullSweep - gap).coerceAtLeast(0.6f) * grow
          if (sweep > 0f) {
            drawArc(
              color = sliceColor(index, entry.key),
              startAngle = start + gap / 2f,
              sweepAngle = sweep,
              useCenter = false,
              topLeft = topLeft,
              size = arcSize,
              style = Stroke(width = stroke, cap = StrokeCap.Butt)
            )
          }
          start += fullSweep * grow
        }
      }
      Column(horizontalAlignment = Alignment.CenterHorizontally) {
        if (centerPrimary != null) {
          Text(
            centerPrimary,
            style = FluentTypeRamp.title2,
            color = colors.neutralForeground1,
            maxLines = 1
          )
        }
        if (centerSecondary != null) {
          Spacer(Modifier.height(FluentSpacingDefaults.xxs))
          Text(
            centerSecondary,
            style = FluentTypeRamp.caption2,
            color = colors.neutralForeground3,
            maxLines = 1
          )
        }
      }
    }

    if (showLegend) {
      Column(
        modifier = Modifier.weight(1f),
        verticalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.xs)
      ) {
        entries.forEachIndexed { index, entry ->
          Row(verticalAlignment = Alignment.CenterVertically) {
            if (brandClients) {
              ClientMonogram(entry.key, size = 18.dp)
            } else {
              // Fluent legend keys are small rounded squares, matching the
              // squared mark geometry rather than introducing a new shape.
              Box(
                Modifier
                  .size(10.dp)
                  .clip(FluentShapeDefaults.smallCorner)
                  .background(sliceColor(index, entry.key))
              )
            }
            Spacer(Modifier.width(FluentSpacingDefaults.s))
            Text(
              if (brandClients) ClientBranding.label(entry.key) else entry.key,
              style = FluentTypeRamp.caption1,
              color = colors.neutralForeground1,
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
              modifier = Modifier.weight(1f)
            )
            Text(
              formatPercent(entry.tokens, total),
              style = FluentTypeRamp.caption1,
              fontWeight = FontWeight.SemiBold,
              color = colors.neutralForeground2
            )
          }
        }
      }
    }
  }
}

@Composable
fun ShareBarList(
  entries: List<ShareEntry>,
  modifier: Modifier = Modifier,
  showCost: Boolean = true,
  brandClients: Boolean = true,
  onEntryClick: ((ShareEntry) -> Unit)? = null
) {
  val total = entries.sumOf { it.tokens }.coerceAtLeast(1L)
  val palette = FluentChartPalette
  Column(
    modifier = modifier.fillMaxWidth(),
    verticalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.m)
  ) {
    entries.forEachIndexed { index, entry ->
      val color =
        if (brandClients) ClientBranding.color(entry.key) else palette[index % palette.size]
      val clickable = onEntryClick != null && entry.key != "其他"
      ShareBarRow(
        name = if (brandClients) ClientBranding.label(entry.key) else entry.key,
        tokens = entry.tokens,
        costUsd = entry.costUsd,
        credits = entry.credits,
        fraction = entry.tokens.toFloat() / total.toFloat(),
        color = color,
        showCost = showCost,
        leading = if (brandClients) {
          { ClientMonogram(entry.key, size = 22.dp) }
        } else {
          null
        },
        onClick = if (clickable) ({ onEntryClick?.invoke(entry) }) else null
      )
    }
  }
}

@Composable
fun ShareBarRow(
  name: String,
  tokens: Long,
  costUsd: Double,
  fraction: Float,
  color: Color,
  credits: Double? = null,
  showCost: Boolean = true,
  leading: (@Composable () -> Unit)? = null,
  onClick: (() -> Unit)? = null
) {
  val colors = LocalFluentColors.current
  val cost = rememberCostFormatter()
  val interaction = remember { MutableInteractionSource() }
  val pressed by interaction.collectIsPressedAsState()

  val body: @Composable () -> Unit = {
    Column(
      Modifier
        .fillMaxWidth()
        .background(if (onClick != null && pressed) colors.subtleBackgroundPressed else Color.Transparent)
        .padding(vertical = FluentSpacingDefaults.xs),
      verticalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.xs)
    ) {
      Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
      ) {
        Row(
          verticalAlignment = Alignment.CenterVertically,
          modifier = Modifier.weight(1f)
        ) {
          if (leading != null) {
            leading()
            Spacer(Modifier.width(FluentSpacingDefaults.s))
          } else {
            Box(
              Modifier
                .size(8.dp)
                .clip(FluentShapeDefaults.smallCorner)
                .background(color)
            )
            Spacer(Modifier.width(FluentSpacingDefaults.s))
          }
          Text(
            name,
            style = FluentTypeRamp.body2,
            color = colors.neutralForeground1,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false)
          )
        }
        Spacer(Modifier.width(FluentSpacingDefaults.s))
        // A credits-only row (Qoder) has no token figure to show, and printing `0`
        // there states a falsehood.  The unit is named in the text itself, never by
        // a symbol borrowed from currency.
        Text(
          if (credits != null && credits > 0.0 && tokens == 0L) {
            formatCredits(credits)
          } else {
            formatTokensShort(tokens)
          },
          style = FluentTypeRamp.body2,
          fontWeight = FontWeight.SemiBold,
          color = colors.neutralForeground1
        )
        if (showCost && !(credits != null && credits > 0.0 && tokens == 0L)) {
          Spacer(Modifier.width(FluentSpacingDefaults.s))
          Text(
            cost.format(costUsd, compact = true),
            style = FluentTypeRamp.caption1,
            color = colors.neutralForeground3
          )
        }
      }
      ShareProgressBar(fraction = fraction, color = color)
    }
  }

  Box(
    if (onClick != null) {
      Modifier
        .fillMaxWidth()
        .heightIn(min = FluentTouchMin)
        .clip(FluentShapeDefaults.controlCorner)
        .clickable(
          interactionSource = interaction,
          indication = null,
          role = Role.Button,
          onClick = onClick
        )
    } else {
      Modifier.fillMaxWidth()
    }
  ) { body() }
}

/**
 * Fluent progress bar: 4dp thick with a 2dp end radius.  The previous 8dp pill
 * read as a capsule at list-row widths and overstated small fractions.
 */
@Composable
fun ShareProgressBar(
  fraction: Float,
  color: Color,
  modifier: Modifier = Modifier,
  height: Dp = 4.dp
) {
  val colors = LocalFluentColors.current
  val track = colors.neutralForeground3.copy(alpha = 0.18f)
  val animated = animateGrowFraction(fraction, durationMillis = FluentMotion.slow)
  Canvas(
    modifier
      .fillMaxWidth()
      .height(height)
  ) {
    val h = size.height
    val r = CornerRadius(2.dp.toPx(), 2.dp.toPx())
    drawRoundRect(color = track, cornerRadius = r)
    if (animated > 0f) {
      // Fluent never renders a zero-length mark as nothing: clamp to the full
      // cap so a 0.3% share stays visible and countable.
      drawRoundRect(
        color = color,
        size = Size((size.width * animated).coerceAtLeast(h), h),
        cornerRadius = r
      )
    }
  }
}

@Composable
fun SegmentedTokenBar(
  segments: List<Pair<String, Long>>,
  modifier: Modifier = Modifier,
  height: Dp = 10.dp
) {
  val colors = LocalFluentColors.current
  val total = segments.sumOf { it.second }.coerceAtLeast(1L)
  val palette = FluentChartPalette
  // Same rule as the donut: the set identifies the reveal, the counts do not.
  val resetKey = segments.joinToString("|") { it.first }
  val grow = animateGrowProgress(resetKey = resetKey, durationMillis = FluentMotion.slower)
  Column(
    modifier = modifier.fillMaxWidth(),
    verticalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.s)
  ) {
    Canvas(Modifier.fillMaxWidth().height(height)) {
      val r = CornerRadius(2.dp.toPx(), 2.dp.toPx())
      val gap = if (segments.count { it.second > 0L } > 1) 2f else 0f
      var x = 0f
      segments.forEachIndexed { index, (_, value) ->
        val fraction = value.toFloat() / total.toFloat()
        val w: Float = (size.width * fraction * grow) - gap
        if (w > 0f) {
          drawRoundRect(
            color = palette[index % palette.size],
            topLeft = Offset(x, 0f),
            size = Size(w, size.height),
            cornerRadius = r
          )
        }
        x += size.width * fraction * grow
      }
    }
    Column(verticalArrangement = Arrangement.spacedBy(FluentSpacingDefaults.xs)) {
      segments.forEachIndexed { index, (name, value) ->
        if (value <= 0L) return@forEachIndexed
        Row(
          Modifier.fillMaxWidth(),
          horizontalArrangement = Arrangement.SpaceBetween,
          verticalAlignment = Alignment.CenterVertically
        ) {
          Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
              Modifier
                .size(8.dp)
                .clip(FluentShapeDefaults.smallCorner)
                .background(palette[index % palette.size])
            )
            Spacer(Modifier.width(FluentSpacingDefaults.s))
            Text(
              name,
              style = FluentTypeRamp.caption1,
              color = colors.neutralForeground2
            )
          }
          Text(
            formatTokensShort(value),
            style = FluentTypeRamp.caption1,
            fontWeight = FontWeight.SemiBold,
            color = colors.neutralForeground1
          )
        }
      }
    }
  }
}
