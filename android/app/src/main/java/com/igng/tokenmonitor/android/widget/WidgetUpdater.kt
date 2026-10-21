package com.igng.tokenmonitor.android.widget

import android.content.Context
import com.igng.tokenmonitor.android.data.local.UserPreferencesStore
import com.igng.tokenmonitor.android.data.model.HistoryDto
import com.igng.tokenmonitor.android.data.model.StatsDto
import com.igng.tokenmonitor.android.data.repository.HubError
import com.igng.tokenmonitor.android.data.repository.HubRepository
import com.igng.tokenmonitor.android.data.repository.HubResult
import dagger.hilt.android.qualifiers.ApplicationContext
import java.time.Instant
import java.time.ZoneId
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The one writer of widget data.
 *
 * There are two producers: the WorkManager poll (when the app is not open) and
 * the foreground HubViewModel (when it is). Both go through the same mapper, so
 * a widget cannot show a number the app would disagree with. The app path is
 * what makes a fresh pull-to-refresh visible on the home screen immediately
 * instead of waiting for the next 30-minute tick.
 */
@Singleton
class WidgetUpdater @Inject constructor(
  @ApplicationContext private val context: Context,
  private val repository: HubRepository,
  private val snapshotStore: WidgetSnapshotStore,
  private val userPreferences: UserPreferencesStore
) {
  suspend fun refreshFromNetwork(): WidgetRefreshOutcome {
    val preferences = userPreferences.read()
    val currency = preferences.currency.code
    val connection = repository.connection()
    if (!connection.isComplete) {
      snapshotStore.write(
        WidgetSnapshotMapper.failure(
          existing = snapshotStore.read(),
          message = "请先连接 Hub",
          kind = HubError.Kind.NotConfigured.name,
          now = Instant.now(),
          currency = currency
        )
      )
      withContext(Dispatchers.IO) { WidgetRenderer.updateAll(context) }
      return WidgetRefreshOutcome(ok = false, retry = false)
    }

    val rates = if (currency == "USD") {
      emptyMap()
    } else {
      when (val result = repository.rates()) {
        is HubResult.Success -> result.value.rates
        is HubResult.Failure -> emptyMap()
      }
    }

    val stats = fetchStats()
    val error = stats.second
    val document = stats.first
    if (document == null) {
      val failure = error ?: HubError("无法获取 Hub 数据", HubError.Kind.Api)
      snapshotStore.write(
        WidgetSnapshotMapper.failure(
          existing = snapshotStore.read(),
          message = failure.message.take(120),
          kind = failure.kind.name,
          now = Instant.now(),
          currency = currency,
          rate = rates[currency]
        )
      )
      withContext(Dispatchers.IO) { WidgetRenderer.updateAll(context) }
      return WidgetRefreshOutcome(
        ok = false,
        retry = failure.kind == HubError.Kind.Network ||
          failure.kind == HubError.Kind.Api ||
          failure.kind == HubError.Kind.MalformedResponse
      )
    }

    val history = document.historyPreview ?: run {
      when (val result = repository.history()) {
        is HubResult.Success -> result.value
        is HubResult.Failure -> null
      }
    }
    commit(document, history, rates, currency)
    return WidgetRefreshOutcome(ok = true, retry = false)
  }

  /**
   * Foreground path. The ViewModel has already paid for these documents; asking
   * the Hub again would double the request and, worse, could store an older
   * response than the screen the user is looking at.
   */
  suspend fun publish(stats: StatsDto, history: HistoryDto?, rates: Map<String, Double>) {
    val preferences = userPreferences.read()
    commit(stats, history, rates, preferences.currency.code)
  }

  /**
   * A new Hub URL/secret must not leave the previous deployment's numbers on the
   * home screen. Clearing the document makes every card fall back to its
   * "waiting for first sync" state until the next poll answers.
   */
  suspend fun clearForConnectionChange() {
    snapshotStore.clear()
    withContext(Dispatchers.IO) { WidgetRenderer.updateAll(context) }
  }

  private suspend fun commit(
    stats: StatsDto,
    history: HistoryDto?,
    rates: Map<String, Double>,
    currency: String
  ) {
    val snapshot = WidgetSnapshotMapper.build(
      stats = stats,
      history = history,
      rates = rates,
      currency = currency,
      now = Instant.now(),
      zone = ZoneId.systemDefault()
    )
    snapshotStore.write(snapshot)
    withContext(Dispatchers.IO) { WidgetRenderer.updateAll(context) }
  }

  /**
   * Prefer the staged summary, fall back only when the Hub does not advertise it
   * (the endpoint 404s, which `safeCall` surfaces as Kind.Api). A 401 must not be
   * hidden behind a second request with the same invalid key.
   */
  private suspend fun fetchStats(): Pair<StatsDto?, HubError?> {
    return when (val staged = repository.stats(true)) {
      is HubResult.Success -> staged.value to null
      is HubResult.Failure -> {
        if (staged.error.kind == HubError.Kind.Api) {
          when (val full = repository.stats(false)) {
            is HubResult.Success -> full.value to null
            is HubResult.Failure -> null to full.error
          }
        } else {
          null to staged.error
        }
      }
    }
  }
}
