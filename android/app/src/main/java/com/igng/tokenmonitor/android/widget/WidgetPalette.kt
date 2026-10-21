package com.igng.tokenmonitor.android.widget

import android.content.Context
import android.content.res.Configuration
import androidx.compose.ui.graphics.toArgb
import com.igng.tokenmonitor.android.data.local.ThemeMode
import com.igng.tokenmonitor.android.data.local.ThemeSeedId
import com.igng.tokenmonitor.android.data.local.UserPreferences
import com.igng.tokenmonitor.android.ui.theme.FluentBrandSeeds
import com.igng.tokenmonitor.android.ui.theme.FluentDarkColors
import com.igng.tokenmonitor.android.ui.theme.FluentLightColors
import com.igng.tokenmonitor.android.ui.theme.brandTokensForSeed

/**
 * ARGB form of the same Fluent aliases the Compose tree paints with. There is no
 * second palette in XML: the app's `Color.kt` remains the only measured source,
 * and this object only converts the resolved alias set for Canvas/RemoteViews.
 *
 * `ThemeSeedId.System` uses the default Fluent ramp rather than the Android 12
 * wallpaper accent. A wallpaper-derived hue cannot be contrast-checked by
 * `verify-android-fluent-contrast`, so the widget deliberately stays on the
 * measured ramp instead of shipping an unmeasured colour.
 */
data class WidgetPalette(
  val isDark: Boolean,
  val surfaceTop: Int,
  val surfaceBottom: Int,
  val hairline: Int,
  val specular: Int,
  val fg1: Int,
  val fg2: Int,
  val fg3: Int,
  val fg4: Int,
  val brand: Int,
  val brandFill: Int,
  val brandTint: Int,
  val brandTintFg: Int,
  val track: Int,
  val trackInner: Int,
  val success: Int,
  val successBg: Int,
  val successOnSubtle: Int,
  val warning: Int,
  val warningBg: Int,
  val warningOnSubtle: Int,
  val danger: Int,
  val dangerBg: Int,
  val dangerOnSubtle: Int
) {
  fun toneForeground(tone: WidgetTone): Int = when (tone) {
    WidgetTone.Neutral -> fg3
    WidgetTone.Brand -> brandTintFg
    // Badge text sits on the tinted background, so it must use the pair the
    // contrast guard measures for that surface, not the page-surface hue.
    WidgetTone.Success -> successOnSubtle
    WidgetTone.Warning -> warningOnSubtle
    WidgetTone.Danger -> dangerOnSubtle
  }

  fun toneBackground(tone: WidgetTone): Int = when (tone) {
    WidgetTone.Neutral -> track
    WidgetTone.Brand -> brandTint
    WidgetTone.Success -> successBg
    WidgetTone.Warning -> warningBg
    WidgetTone.Danger -> dangerBg
  }

  fun severityColor(severity: WidgetSeverity): Int = when (severity) {
    WidgetSeverity.Normal -> brand
    WidgetSeverity.Warning -> warning
    WidgetSeverity.Danger -> danger
  }
}

object WidgetPalettes {
  fun resolve(context: Context, preferences: UserPreferences): WidgetPalette {
    val systemDark = (context.resources.configuration.uiMode and
      Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    val dark = when (preferences.themeMode) {
      ThemeMode.Light -> false
      ThemeMode.Dark -> true
      ThemeMode.System -> systemDark
    }
    val seed = when (preferences.themeSeed) {
      ThemeSeedId.System -> null
      else -> FluentBrandSeeds.firstOrNull {
        it.id == preferences.themeSeed.name.lowercase()
      }
    }
    val tokens = seed?.let { brandTokensForSeed(it, dark) }
      ?: if (dark) FluentDarkColors else FluentLightColors

    return WidgetPalette(
      isDark = dark,
      surfaceTop = tokens.surfaceCard.toArgb(),
      surfaceBottom = (if (dark) tokens.neutralBackground1 else tokens.neutralBackground2).toArgb(),
      hairline = tokens.neutralStroke3.toArgb(),
      specular = if (dark) 0x14FFFFFF else 0xCCFFFFFF.toInt(),
      fg1 = tokens.neutralForeground1.toArgb(),
      fg2 = tokens.neutralForeground2.toArgb(),
      fg3 = tokens.neutralForeground3.toArgb(),
      fg4 = tokens.neutralForeground4.toArgb(),
      brand = tokens.brandForeground1.toArgb(),
      brandFill = tokens.brandBackground.toArgb(),
      brandTint = tokens.brandContainer.toArgb(),
      brandTintFg = tokens.brandContainerForeground.toArgb(),
      track = tokens.neutralLayerInner.toArgb(),
      trackInner = tokens.brandContainer.toArgb(),
      success = tokens.successForeground.toArgb(),
      successBg = tokens.successBackground.toArgb(),
      successOnSubtle = tokens.successForegroundOnSubtle.toArgb(),
      warning = tokens.warningForeground.toArgb(),
      warningBg = tokens.warningBackground.toArgb(),
      warningOnSubtle = tokens.warningForegroundOnSubtle.toArgb(),
      danger = tokens.errorForeground.toArgb(),
      dangerBg = tokens.errorBackground.toArgb(),
      dangerOnSubtle = tokens.errorForegroundOnSubtle.toArgb()
    )
  }
}
