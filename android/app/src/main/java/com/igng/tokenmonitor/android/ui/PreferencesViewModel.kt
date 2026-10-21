package com.igng.tokenmonitor.android.ui

import androidx.lifecycle.ViewModel
import com.igng.tokenmonitor.android.data.local.DisplayCurrency
import com.igng.tokenmonitor.android.data.local.HapticsMode
import com.igng.tokenmonitor.android.data.local.ThemeMode
import com.igng.tokenmonitor.android.data.local.ThemeSeedId
import com.igng.tokenmonitor.android.data.local.UserPreferencesStore
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject

@HiltViewModel
class PreferencesViewModel @Inject constructor(
  private val store: UserPreferencesStore
) : ViewModel() {
  val preferences = store.preferences

  fun setThemeSeed(seed: ThemeSeedId) = store.setThemeSeed(seed)
  fun setCurrency(currency: DisplayCurrency) = store.setCurrency(currency)
  fun setThemeMode(mode: ThemeMode) = store.setThemeMode(mode)
  fun setHapticsMode(mode: HapticsMode) = store.setHapticsMode(mode)
  fun setHomeLimitAccountCount(count: Int) = store.setHomeLimitAccountCount(count)
  fun setWidgetRefreshMinutes(minutes: Int) = store.setWidgetRefreshMinutes(minutes)
  fun setWidgetHideCost(hidden: Boolean) = store.setWidgetHideCost(hidden)
}
