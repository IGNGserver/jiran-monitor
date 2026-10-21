package com.igng.tokenmonitor.android.widget

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.os.Build
import android.util.TypedValue
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Small Canvas drawings used by the RemoteViews layer.
 *
 * Native widget layouts cannot draw a sparkline, a ring or a rounded gradient
 * surface, and nesting twenty Views to fake one is both heavier and uglier than
 * a single bitmap. Text stays native (so font scaling and TalkBack still work);
 * only the marks that have no View equivalent are drawn here.
 */
class WidgetBitmaps(private val context: Context) {
  private val density = context.resources.displayMetrics.density
  private val textTypeface = Typeface.create("sans-serif", Typeface.NORMAL)
  private val mediumTypeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)

  fun px(dp: Float): Int = max(1, (dp * density).roundToInt())

  fun sp(value: Float): Float = TypedValue.applyDimension(
    TypedValue.COMPLEX_UNIT_SP,
    value,
    context.resources.displayMetrics
  )

  fun surface(widthDp: Float, heightDp: Float, palette: WidgetPalette): Bitmap {
    val width = px(widthDp)
    val height = px(heightDp)
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val radius = widgetRadius()
    val bounds = RectF(0f, 0f, width.toFloat(), height.toFloat())

    val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      shader = LinearGradient(
        0f, 0f, 0f, height.toFloat(),
        palette.surfaceTop,
        palette.surfaceBottom,
        Shader.TileMode.CLAMP
      )
    }
    canvas.drawRoundRect(bounds, radius, radius, fill)

    // A quiet top sheen is what keeps a flat two-colour gradient from reading as
    // a grey rectangle; it is a single alpha gradient, not a picture layer.
    val sheen = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      shader = LinearGradient(
        0f, 0f, 0f, height * 0.42f,
        palette.specular,
        0x00FFFFFF,
        Shader.TileMode.CLAMP
      )
    }
    canvas.drawRoundRect(bounds, radius, radius, sheen)

    val border = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = palette.hairline
      style = Paint.Style.STROKE
      strokeWidth = px(0.75f).toFloat()
    }
    canvas.drawRoundRect(
      RectF(0.5f, 0.5f, width - 0.5f, height - 0.5f),
      radius,
      radius,
      border
    )
    return bitmap
  }

  fun chart(
    widthDp: Float,
    heightDp: Float,
    values: List<Double>,
    labels: List<String>,
    activeIndex: Int,
    palette: WidgetPalette,
    showLabels: Boolean,
    activeColor: Int = palette.brand
  ): Bitmap {
    val width = px(widthDp)
    val height = px(heightDp)
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val labelHeight = if (showLabels && labels.isNotEmpty()) px(9f) else 0
    val top = px(1.5f).toFloat()
    val bottom = (height - labelHeight - px(1f)).toFloat().coerceAtLeast(top + 1f)
    val maxValue = values.maxOrNull()?.coerceAtLeast(0.0) ?: 0.0

    if (values.isEmpty() || maxValue <= 0.0) {
      val baseline = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = withAlpha(palette.fg4, 70)
        strokeWidth = px(0.75f).toFloat()
      }
      canvas.drawLine(0f, bottom, width.toFloat(), bottom, baseline)
      return bitmap
    }

    val count = values.size
    val gap = px(3f).toFloat()
    val barWidth = ((width - gap * (count - 1)) / count).coerceAtLeast(px(2f).toFloat())
    val radius = px(2f).toFloat()
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    values.forEachIndexed { index, raw ->
      val value = raw.coerceAtLeast(0.0)
      val barHeight = if (value <= 0.0) {
        0f
      } else {
        max(px(2f).toFloat(), ((value / maxValue) * (bottom - top)).toFloat())
      }
      if (barHeight > 0f) {
        paint.color = if (index == activeIndex) {
          activeColor
        } else {
          withAlpha(palette.fg3, if (palette.isDark) 135 else 95)
        }
        val left = index * (barWidth + gap)
        canvas.drawRoundRect(
          RectF(left, bottom - barHeight, left + barWidth, bottom),
          radius,
          radius,
          paint
        )
      }
    }

    if (showLabels) {
      val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = palette.fg4
        textSize = sp(6.8f)
        textAlign = Paint.Align.CENTER
        typeface = textTypeface
      }
      val baseline = height - px(0.5f).toFloat()
      labels.take(count).forEachIndexed { index, label ->
        val left = index * (barWidth + gap)
        canvas.drawText(label, left + barWidth / 2f, baseline, labelPaint)
      }
    }
    return bitmap
  }

  fun ring(
    sizeDp: Float,
    fraction: Double?,
    color: Int,
    trackColor: Int,
    strokeDp: Float = 4.5f
  ): Bitmap {
    val size = px(sizeDp)
    val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val stroke = px(strokeDp).toFloat()
    val inset = stroke / 2f + px(1f)
    val bounds = RectF(inset, inset, size - inset, size - inset)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeWidth = stroke
      strokeCap = Paint.Cap.ROUND
      this.color = trackColor
    }
    canvas.drawArc(bounds, 0f, 360f, false, paint)
    val value = fraction?.coerceIn(0.0, 1.0) ?: 0.0
    if (value > 0.0) {
      paint.color = color
      canvas.drawArc(bounds, -90f, (360f * value).toFloat(), false, paint)
    }
    return bitmap
  }

  fun bar(
    widthDp: Float,
    heightDp: Float,
    fraction: Double?,
    fillColor: Int,
    trackColor: Int
  ): Bitmap {
    val width = px(widthDp)
    val height = px(heightDp)
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val radius = height / 2f
    val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = trackColor }
    canvas.drawRoundRect(RectF(0f, 0f, width.toFloat(), height.toFloat()), radius, radius, track)
    val value = fraction?.coerceIn(0.0, 1.0) ?: 0.0
    if (value > 0.0) {
      val fillWidth = max(height.toFloat(), (width * value).toFloat())
      val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = fillColor }
      canvas.drawRoundRect(
        RectF(0f, 0f, fillWidth.coerceAtMost(width.toFloat()), height.toFloat()),
        radius,
        radius,
        fill
      )
    }
    return bitmap
  }

  fun pill(widthDp: Float, heightDp: Float, fillColor: Int): Bitmap {
    val width = px(widthDp)
    val height = px(heightDp)
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val radius = height / 2f
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = fillColor }
    canvas.drawRoundRect(RectF(0f, 0f, width.toFloat(), height.toFloat()), radius, radius, paint)
    return bitmap
  }

  fun refresh(sizeDp: Float, color: Int): Bitmap {
    val size = px(sizeDp)
    val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val stroke = px(1.6f).toFloat()
    val inset = stroke * 1.6f
    val bounds = RectF(inset, inset, size - inset, size - inset)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      this.color = color
      style = Paint.Style.STROKE
      strokeWidth = stroke
      strokeCap = Paint.Cap.ROUND
    }
    canvas.drawArc(bounds, -55f, 270f, false, paint)

    // Arrow head at the open end of the arc: two short strokes are enough at
    // widget scale and avoid a filled triangle that reads as a play button.
    val angle = Math.toRadians(215.0)
    val centerX = bounds.centerX()
    val centerY = bounds.centerY()
    val radius = bounds.width() / 2f
    val endX = centerX + (radius * Math.cos(angle)).toFloat()
    val endY = centerY + (radius * Math.sin(angle)).toFloat()
    val head = px(3.5f).toFloat()
    canvas.drawLine(endX, endY, endX - head, endY - head * 0.3f, paint)
    canvas.drawLine(endX, endY, endX - head * 0.2f, endY - head, paint)
    return bitmap
  }

  fun dot(sizeDp: Float, dotColor: Int): Bitmap {
    val size = px(sizeDp)
    val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = dotColor }
    canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint)
    return bitmap
  }

  fun mark(sizeDp: Float, palette: WidgetPalette): Bitmap {
    val size = px(sizeDp)
    val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val radius = size * 0.28f
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = palette.brandFill }
    canvas.drawRoundRect(RectF(0f, 0f, size.toFloat(), size.toFloat()), radius, radius, paint)
    drawCenteredText(canvas, "计", size / 2f, size / 2f, size * 0.56f, 0xFFFFFFFF.toInt())
    return bitmap
  }

  fun monogram(sizeDp: Float, text: String, palette: WidgetPalette): Bitmap {
    val size = px(sizeDp)
    val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val radius = size * 0.3f
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = palette.brandTint }
    canvas.drawRoundRect(RectF(0f, 0f, size.toFloat(), size.toFloat()), radius, radius, paint)
    val label = text.trim().take(2).uppercase().ifBlank { "?" }
    drawCenteredText(
      canvas,
      label,
      size / 2f,
      size / 2f,
      if (label.length > 1) size * 0.34f else size * 0.44f,
      palette.brandTintFg
    )
    return bitmap
  }

  private fun drawCenteredText(
    canvas: Canvas,
    text: String,
    centerX: Float,
    centerY: Float,
    sizePx: Float,
    textColor: Int
  ) {
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      this.color = textColor
      this.textSize = sizePx
      textAlign = Paint.Align.CENTER
      typeface = mediumTypeface
    }
    val metrics = paint.fontMetrics
    val baseline = centerY - (metrics.ascent + metrics.descent) / 2f
    canvas.drawText(text, centerX, baseline, paint)
  }

  private fun widgetRadius(): Float {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      runCatching {
        context.resources.getDimensionPixelSize(android.R.dimen.system_app_widget_background_radius)
      }.getOrNull()?.let { return it.toFloat() }
    }
    return px(16f).toFloat()
  }

  private fun withAlpha(color: Int, alpha: Int): Int =
    (color and 0x00FFFFFF) or ((alpha.coerceIn(0, 255)) shl 24)
}
