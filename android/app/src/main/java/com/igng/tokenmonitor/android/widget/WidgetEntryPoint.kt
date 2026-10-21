package com.igng.tokenmonitor.android.widget

import android.content.Context
import com.igng.tokenmonitor.android.data.local.ConnectionStorage
import com.igng.tokenmonitor.android.data.local.UserPreferencesStore
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent

/**
 * Widget receivers and workers are created by the Android framework or
 * WorkManager, not by Hilt, so this is the one bridge back into the app graph.
 * It deliberately exposes only the widget-facing singletons; a broadcast
 * receiver has no business reaching an AuthViewModel.
 */
@EntryPoint
@InstallIn(SingletonComponent::class)
interface WidgetEntryPoint {
  fun snapshotStore(): WidgetSnapshotStore
  fun preferences(): UserPreferencesStore
  fun connection(): ConnectionStorage
  fun widgetPreferences(): WidgetPreferencesStore
  fun updater(): WidgetUpdater
}

fun Context.widgetEntryPoint(): WidgetEntryPoint =
  EntryPointAccessors.fromApplication(applicationContext, WidgetEntryPoint::class.java)
