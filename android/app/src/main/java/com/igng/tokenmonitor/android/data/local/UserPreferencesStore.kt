package com.igng.tokenmonitor.android.data.local

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class ThemeSeedId(val storageKey: String, val labelZh: String) {
  System("system", "系统"),
  Blue("blue", "蓝色"),
  Green("green", "绿色"),
  Purple("purple", "紫色"),
  Teal("teal", "青色"),
  Orange("orange", "橙色"),
  Rose("rose", "玫红");

  companion object {
    fun fromStorage(value: String?): ThemeSeedId =
      entries.firstOrNull { it.storageKey == value } ?: System
  }
}

/**
 * Light / dark choice, independent of the accent seed.  The web and desktop shared
 * UI offers system · light · dark (`settings.theme`); the client previously had only
 * "follow the system", which is why `ThemeSeedId.System` doubled as both a hue and a
 * mode.  Keeping them separate is also what lets a user pin dark while still
 * following the wallpaper accent.
 */
enum class ThemeMode(val storageKey: String, val labelZh: String) {
  System("system", "跟随系统"),
  Light("light", "浅色"),
  Dark("dark", "深色");

  companion object {
    fun fromStorage(value: String?): ThemeMode =
      entries.firstOrNull { it.storageKey == value } ?: System
  }
}

enum class HapticsMode(val storageKey: String, val labelZh: String) {
  Off("off", "关闭"),
  Standard("standard", "标准"),
  Enhanced("enhanced", "增强");

  companion object {
    fun fromStorage(value: String?): HapticsMode =
      entries.firstOrNull { it.storageKey == value } ?: Standard
  }
}

/**
 * Display currency for cost figures.  The Hub's `/api/rates` block supplies the
 * conversion, so this is a display choice and never a re-pricing of the data — the
 * stored record always stays USD.
 */
enum class DisplayCurrency(val storageKey: String, val code: String) {
  Usd("USD", "USD"),
  Cny("CNY", "CNY"),
  Twd("TWD", "TWD"),
  Hkd("HKD", "HKD");

  companion object {
    fun fromStorage(value: String?): DisplayCurrency =
      entries.firstOrNull { it.storageKey == value } ?: Usd
  }
}

data class UserPreferences(
  val themeSeed: ThemeSeedId = ThemeSeedId.System,
  val currency: DisplayCurrency = DisplayCurrency.Usd,
  val themeMode: ThemeMode = ThemeMode.System,
  val hapticsMode: HapticsMode = HapticsMode.Standard,
  val homeLimitAccountCount: Int = 3,
  /**
   * WorkManager's floor is 15 minutes. The widget scheduler reads this value and
   * reschedules on change; the platform may still defer a run under Doze, which
   * is why every widget states how old its snapshot is instead of pretending to
   * be a live clock.
   */
  val widgetRefreshMinutes: Int = 30,
  /** Privacy switch for every widget: hide costs, keep token counts. */
  val widgetHideCost: Boolean = false
)

@Singleton
class UserPreferencesStore @Inject constructor(
  @ApplicationContext context: Context
) {
  private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
  private val _preferences = MutableStateFlow(read())
  val preferences: StateFlow<UserPreferences> = _preferences.asStateFlow()

  fun read(): UserPreferences = UserPreferences(
    themeSeed = ThemeSeedId.fromStorage(prefs.getString(KEY_THEME_SEED, ThemeSeedId.System.storageKey)),
    currency = DisplayCurrency.fromStorage(prefs.getString(KEY_CURRENCY, DisplayCurrency.Usd.storageKey)),
    themeMode = ThemeMode.fromStorage(prefs.getString(KEY_THEME_MODE, ThemeMode.System.storageKey)),
    hapticsMode = HapticsMode.fromStorage(prefs.getString(KEY_HAPTICS, HapticsMode.Standard.storageKey)),
    homeLimitAccountCount = clampHomeLimitAccountCount(prefs.getInt(KEY_HOME_LIMIT_ACCOUNT_COUNT, 3)),
    widgetRefreshMinutes = clampWidgetRefreshMinutes(prefs.getInt(KEY_WIDGET_REFRESH_MINUTES, 30)),
    widgetHideCost = prefs.getBoolean(KEY_WIDGET_HIDE_COST, false)
  )

  fun setThemeSeed(seed: ThemeSeedId) {
    prefs.edit().putString(KEY_THEME_SEED, seed.storageKey).apply()
    _preferences.value = _preferences.value.copy(themeSeed = seed)
  }

  fun setCurrency(currency: DisplayCurrency) {
    prefs.edit().putString(KEY_CURRENCY, currency.storageKey).apply()
    _preferences.value = _preferences.value.copy(currency = currency)
  }

  fun setThemeMode(mode: ThemeMode) {
    prefs.edit().putString(KEY_THEME_MODE, mode.storageKey).apply()
    _preferences.value = _preferences.value.copy(themeMode = mode)
  }

  fun setHapticsMode(mode: HapticsMode) {
    prefs.edit().putString(KEY_HAPTICS, mode.storageKey).apply()
    _preferences.value = _preferences.value.copy(hapticsMode = mode)
  }

  fun setHomeLimitAccountCount(count: Int) {
    val next = clampHomeLimitAccountCount(count)
    prefs.edit().putInt(KEY_HOME_LIMIT_ACCOUNT_COUNT, next).apply()
    _preferences.value = _preferences.value.copy(homeLimitAccountCount = next)
  }

  fun setWidgetRefreshMinutes(minutes: Int) {
    val next = clampWidgetRefreshMinutes(minutes)
    prefs.edit().putInt(KEY_WIDGET_REFRESH_MINUTES, next).apply()
    _preferences.value = _preferences.value.copy(widgetRefreshMinutes = next)
  }

  fun setWidgetHideCost(hidden: Boolean) {
    prefs.edit().putBoolean(KEY_WIDGET_HIDE_COST, hidden).apply()
    _preferences.value = _preferences.value.copy(widgetHideCost = hidden)
  }

  private companion object {
    const val PREFS_NAME = "token_monitor_prefs"
    const val KEY_THEME_SEED = "theme_seed"
    const val KEY_CURRENCY = "display_currency"
    const val KEY_THEME_MODE = "theme_mode"
    const val KEY_HAPTICS = "haptics_mode"
    const val KEY_HOME_LIMIT_ACCOUNT_COUNT = "home_limit_account_count"
    const val KEY_WIDGET_REFRESH_MINUTES = "widget_refresh_minutes"
    const val KEY_WIDGET_HIDE_COST = "widget_hide_cost"
  }
}

fun clampHomeLimitAccountCount(value: Int): Int = value.coerceIn(1, 12)

fun clampWidgetRefreshMinutes(value: Int): Int = value.coerceIn(15, 180)

