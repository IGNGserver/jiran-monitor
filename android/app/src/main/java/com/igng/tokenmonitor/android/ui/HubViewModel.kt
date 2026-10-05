package com.igng.tokenmonitor.android.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.igng.tokenmonitor.android.data.model.BatchPricingResponseDto
import com.igng.tokenmonitor.android.data.model.DeviceDto
import com.igng.tokenmonitor.android.data.model.AccountRequestDto
import com.igng.tokenmonitor.android.data.model.HubAccountDto
import com.igng.tokenmonitor.android.data.model.OAuthExchangeRequestDto
import com.igng.tokenmonitor.android.data.model.OAuthStartDto
import com.igng.tokenmonitor.android.data.model.SubscriptionDto
import com.igng.tokenmonitor.android.data.model.SubscriptionsRequestDto
import com.igng.tokenmonitor.android.data.model.HistoryDto
import com.igng.tokenmonitor.android.data.model.HubAuthorizationDto
import com.igng.tokenmonitor.android.data.model.PeriodDto
import com.igng.tokenmonitor.android.data.model.PricingDto
import com.igng.tokenmonitor.android.data.model.PricingRequestDto
import com.igng.tokenmonitor.android.data.model.SessionRowDto
import com.igng.tokenmonitor.android.data.model.StatsDto
import com.igng.tokenmonitor.android.data.model.UsageRangeDto
import com.igng.tokenmonitor.android.data.repository.HubRepository
import com.igng.tokenmonitor.android.data.repository.HubResult
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class RealtimeStatus { Live, Reconnecting, Disconnected }

/**
 * How long a failed range window stays quiet before a snapshot frame may ask again.
 *
 * The retry has to exist (a preset that failed once must recover on its own after
 * midnight), but it must not turn into a poll: in the desktop's local mode a range
 * request runs a full tokscale scan, and the same window will keep failing for the same
 * reason.  The shared UI backs off for the same interval (`PRESET_RANGE_RETRY_MS`).
 */
private const val RANGE_RETRY_MS = 30_000L

/**
 * Scope tabs in the analytics screen.
 *
 * `Today` / `Month` / `AllTime` are the three windows the collector puts on the wire,
 * read straight off the snapshot.  `Yesterday` and `Week` are *calendar* windows the
 * client computes (see `ui/core/DateRanges.kt`) and resolves through
 * `/api/usage/range`, exactly like a hand-picked range does — which is why they land in
 * `customRangeResult` rather than widening the wire shape.  `Custom` is the picked
 * range itself.  The set mirrors the shared web UI's `PERIOD_TABS`.
 */
enum class AnalyticsPeriodKind {
  Today, Yesterday, Week, Month, AllTime, Custom;

  /** Resolved through the range endpoint instead of the snapshot. */
  val needsRange: Boolean get() = this == Yesterday || this == Week || this == Custom
}

data class CustomRangeSelection(
  val startDate: String,
  val endDate: String,
  val startHour: Int,
  val endHour: Int,
  val label: String
)

data class HubUiState(
  val stats: StatsDto? = null,
  val history: HistoryDto? = null,
  val devices: List<DeviceDto> = emptyList(),
  val authorization: HubAuthorizationDto? = null,
  val pricing: List<PricingDto> = emptyList(),
  val isLoading: Boolean = false,
  val isRefreshing: Boolean = false,
  val error: String? = null,
  val realtime: RealtimeStatus = RealtimeStatus.Disconnected,
  val batchResult: BatchPricingResponseDto? = null,
  val analyticsPeriod: AnalyticsPeriodKind = AnalyticsPeriodKind.Today,
  val customRange: CustomRangeSelection? = null,
  val customRangeResult: UsageRangeDto? = null,
  val customRangeLoading: Boolean = false,
  /**
   * The calendar window a `Yesterday` / `Week` tab last resolved.  Kept separately
   * from [customRange] because a preset must be *re-resolved* when the date rolls
   * over — yesterday becomes today's yesterday — whereas a picked range is fixed and
   * stays whatever the user chose.
   */
  val activePresetWindow: com.igng.tokenmonitor.android.ui.core.PresetRangeWindow? = null,
  /** Hub-owned quota accounts.  Read scope is enough to list them; admin is needed to
    * change them, and the UI gates on the authenticated owner connection. */
  val accounts: List<HubAccountDto> = emptyList(),
  val accountsLoading: Boolean = false,
  val accountsError: String? = null,
  /** Pending OAuth sign-in started on the Hub; the user finishes it in a browser. */
  val oauthSession: OAuthStartDto? = null,
  val subscriptions: List<SubscriptionDto> = emptyList(),
  val subscriptionsUpdatedAt: String? = null,
  val subscriptionsError: String? = null,
  /** Display rates from the Hub, so a non-USD currency is the Hub's number, not ours. */
  val rates: Map<String, Double> = emptyMap(),
  val ratesDate: String? = null,
  /**
   * Per-device history from `/api/history?deviceId=`, keyed by device id.  The fleet
   * aggregate in [history] is a different document, so the device detail cannot reuse
   * it; without this the trend the device page could draw was every machine's total.
   */
  val deviceHistories: Map<String, HistoryDto> = emptyMap(),
  /** Set when /api/history failed: trends and model splits fall back to the
   *  narrower historyPreview until it succeeds, so the UI can offer a retry. */
  val historyError: String? = null,
  /**
   * Per-device full periods from `/api/devices/{id}`, keyed by device id.
   *
   * The first-paint summary deliberately drops each device's session archive and
   * client×model grain, so the fleet snapshot in [devices] cannot answer a device
   * detail page. Pulling one device's detail on demand is the whole point of the
   * split; the detail page merges this over its snapshot entry.
   */
  val deviceDetails: Map<String, DeviceDto> = emptyMap(),
  /** Set when a device detail request failed, so the page can offer a retry. */
  val deviceDetailError: String? = null,
  val deviceDetailLoading: Boolean = false,
  /** Aggregate session list from `/api/sessions`, independent of the snapshot. */
  val sessions: List<SessionRowDto> = emptyList(),
  val sessionsTotal: Int = 0,
  val sessionsShown: Int = 0,
  val sessionsLoading: Boolean = false,
  val sessionsError: String? = null
)

@HiltViewModel
class HubViewModel @Inject constructor(private val repository: HubRepository) : ViewModel() {
  private val _state = MutableStateFlow(HubUiState())
  val state = _state.asStateFlow()
  private var sseJob: Job? = null
  private var rangeJob: Job? = null
  private var refreshJob: Job? = null
  private var hasObservedForeground = false
  private var statsFrameVersion = 0L

  /**
   * Only the newest range reply may land.  A cancelled job already cannot resume, but
   * the sequence also protects the state write from a response that was already being
   * decoded when the user moved to another scope tab.
   */
  private var rangeSequence = 0
  private var rangeFailedKey = ""
  private var rangeRetryAfterMs = 0L
  private val requestJobs = mutableSetOf<Job>()
  private var connectionGeneration = 0L
  /** Validator for the fleet history document, so a repeat read can be a 304. */
  private var historyEtag: String? = null
  /** Last `historyRevision` seen on the stream; a change is the only reason to re-ask. */
  private var historyRevisionSeen: String? = null
  /** Whether a history document has been fetched at least once this session. */
  private var hasObservedHistory = false

  private fun isCurrent(generation: Long) = generation == connectionGeneration

  private fun launchRequest(block: suspend (Long) -> Unit): Job {
    val generation = connectionGeneration
    val job = viewModelScope.launch {
      block(generation)
    }
    requestJobs += job
    job.invokeOnCompletion { requestJobs.remove(job) }
    return job
  }

  private fun cancelRequests() {
    requestJobs.toList().forEach { it.cancel() }
    requestJobs.clear()
  }

  init {
    val generation = connectionGeneration
    // Show the dashboard as soon as its snapshot arrives. Capabilities are useful
    // for optional sections, but a slow capabilities endpoint must not hold up stats.
    refreshAll()
    startRealtime(generation)
    viewModelScope.launch {
      when (val result = repository.capabilities()) {
        is HubResult.Success -> if (isCurrent(generation)) {
          _state.value = _state.value.copy(authorization = result.value)
          if (result.value.capabilities.pricing) refreshPricing()
          if (result.value.capabilities.hubAccounts != false) refreshAccounts()
        }
        is HubResult.Failure -> if (isCurrent(generation)) {
          _state.value = _state.value.copy(error = result.error.message)
        }
      }
    }
  }

  fun refreshAll() {
    if (refreshJob?.isActive == true) return
    val generation = connectionGeneration
    _state.value = _state.value.copy(isLoading = _state.value.stats == null, isRefreshing = true)
    // First paint is the snapshot alone. `/api/stats` (full) and
    // `/api/stats/summary` (staged) both carry every headline number the
    // dashboard draws, so the history and rates fetches are no longer raced
    // against it: the trend tab re-asks for history when it opens, and the
    // currency block tolerates a beat of latency. Racing them used to mean the
    // slowest of three requests decided when the spinner stopped.
    val jobs = mutableListOf(refreshStats())
    if (_state.value.authorization?.capabilities?.pricing == true) jobs += refreshPricing()
    if (_state.value.authorization?.capabilities?.hubAccounts != false && _state.value.authorization != null) jobs += refreshAccounts()
    refreshJob = viewModelScope.launch {
      jobs.forEach { it.join() }
      if (isCurrent(generation)) _state.value = _state.value.copy(isRefreshing = false)
    }
    // Secondary documents load behind the first paint rather than in front of it.
    launchRequest { generation ->
      refreshRates().join()
      if (isCurrent(generation) && _state.value.stats != null) refreshHistory()
    }
    val current = _state.value
    if (current.analyticsPeriod == AnalyticsPeriodKind.Custom && current.customRange != null) {
      val range = current.customRange
      loadCustomRange(range.startDate, range.endDate, range.startHour, range.endHour, range.label)
    } else {
      // A preset is a window, not a stored period: coming back to the app after midnight
      // must re-resolve it, or 昨日/本周 keep answering a span they no longer name.
      refreshPendingRangeWindow()
    }
  }

  fun refreshHistory() = launchRequest { generation ->
    if (!isCurrent(generation)) return@launchRequest
    // Conditional: the Hub answers 304 when the document has not moved, so the
    // repeated "re-ask for history" a stream frame triggers costs headers, not a
    // body. A Hub without the revision-based validator simply answers 200.
    when (val result = repository.historyIfChanged(etag = historyEtag)) {
      is HubResult.Success -> if (isCurrent(generation)) {
        result.value.etag?.let { historyEtag = it }
        val document = result.value.document
        if (document != null) {
          hasObservedHistory = true
          _state.value = _state.value.copy(history = document, historyError = null)
        }
      }
      is HubResult.Failure -> if (isCurrent(generation)) {
        // Not fatal to the dashboard, but the fallback (historyPreview) carries no
        // per-client/per-model stacks and is capped at 30 days, so trends and the
        // client model split stay degraded until this succeeds. Record it so the
        // UI can offer a retry instead of silently showing less.
        _state.value = _state.value.copy(historyError = result.error.message)
      }
    }
  }

  fun refreshStats() = launchRequest { generation ->
    if (!isCurrent(generation)) return@launchRequest
    val frameVersion = statsFrameVersion
    // `isLoading` is the cold-start spinner, not a per-tick flag: setting it on
    // every refresh made the devices screen flicker into its skeleton while the
    // list it was replacing was still on screen.
    val coldStart = _state.value.stats == null
    _state.value = _state.value.copy(isLoading = coldStart, error = null)
    val staged = _state.value.authorization?.capabilities?.statsSummary == true
    when (val result = repository.stats(staged)) {
      is HubResult.Success -> if (isCurrent(generation)) {
        if (frameVersion == statsFrameVersion) {
          _state.value = _state.value.copy(
            stats = result.value,
            devices = result.value.devices,
            isLoading = false
          )
        } else {
          _state.value = _state.value.copy(isLoading = false)
        }
      }
      is HubResult.Failure -> if (isCurrent(generation)) {
        _state.value = _state.value.copy(
          isLoading = false,
          error = if (frameVersion == statsFrameVersion) result.error.message else _state.value.error
        )
      }
    }
  }

  /**
   * Pull one device's full periods (session archive + client×model grain).
   *
   * The first-paint summary omits them on purpose, so this is what a device detail
   * page calls on open. It is a separate cache keyed by id rather than an overwrite
   * of the fleet list: the summary's entry stays authoritative for staleness.
   */
  fun refreshDeviceDetail(deviceId: String) = launchRequest { generation ->
    if (deviceId.isBlank()) return@launchRequest
    if (_state.value.authorization?.capabilities?.deviceDetail != true) return@launchRequest
    _state.value = _state.value.copy(deviceDetailLoading = true, deviceDetailError = null)
    when (val result = repository.device(deviceId)) {
      is HubResult.Success -> if (isCurrent(generation)) {
        val device = result.value.device
        _state.value = _state.value.copy(
          deviceDetails = if (device != null) _state.value.deviceDetails + (deviceId to device) else _state.value.deviceDetails,
          deviceDetailLoading = false,
          deviceDetailError = if (device == null) "设备已从当前 Hub 快照中移除。" else null
        )
      }
      is HubResult.Failure -> if (isCurrent(generation)) {
        _state.value = _state.value.copy(deviceDetailLoading = false, deviceDetailError = result.error.message)
      }
    }
  }

  /** Load the aggregate session list from `/api/sessions`, independent of the snapshot. */
  fun refreshSessions(period: String? = null) = launchRequest { generation ->
    if (_state.value.authorization?.capabilities?.sessionList != true) return@launchRequest
    _state.value = _state.value.copy(sessionsLoading = true, sessionsError = null)
    when (val result = repository.sessions(period)) {
      is HubResult.Success -> if (isCurrent(generation)) {
        _state.value = _state.value.copy(
          sessions = result.value.sessions,
          sessionsTotal = result.value.total,
          sessionsShown = result.value.shown,
          sessionsLoading = false
        )
      }
      is HubResult.Failure -> if (isCurrent(generation)) {
        _state.value = _state.value.copy(sessionsLoading = false, sessionsError = result.error.message)
      }
    }
  }

  fun refreshDevices() = launchRequest { generation ->
    when (val result = repository.devices()) {
      is HubResult.Success -> if (isCurrent(generation)) {
        _state.value = _state.value.copy(devices = result.value.devices)
      }
      is HubResult.Failure -> if (isCurrent(generation)) {
        _state.value = _state.value.copy(error = result.error.message)
      }
    }
  }

  fun refreshPricing() = launchRequest { generation ->
    if (_state.value.authorization?.capabilities?.pricing != true) return@launchRequest
    when (val result = repository.pricing()) {
      is HubResult.Success -> if (isCurrent(generation)) {
        _state.value = _state.value.copy(pricing = result.value.pricing, error = null)
      }
      is HubResult.Failure -> if (isCurrent(generation)) {
        _state.value = _state.value.copy(error = result.error.message)
      }
    }
  }

  fun savePricing(model: String, request: PricingRequestDto) = launchRequest { generation ->
    if (_state.value.authorization?.authenticated != true) return@launchRequest
    when (val result = repository.putPricing(model, request)) {
      is HubResult.Success -> if (isCurrent(generation)) refreshPricing()
      is HubResult.Failure -> if (isCurrent(generation)) _state.value = _state.value.copy(error = result.error.message)
    }
  }

  fun fetchUpstream(model: String) = launchRequest { generation ->
    if (_state.value.authorization?.authenticated != true) return@launchRequest
    when (val result = repository.fetchUpstream(model)) {
      is HubResult.Success -> if (isCurrent(generation)) refreshPricing()
      is HubResult.Failure -> if (isCurrent(generation)) _state.value = _state.value.copy(error = result.error.message)
    }
  }

  fun fetchAllUpstream() = launchRequest { generation ->
    if (_state.value.authorization?.authenticated != true) return@launchRequest
    when (val result = repository.fetchAllUpstream()) {
      is HubResult.Success -> if (isCurrent(generation)) {
        _state.value = _state.value.copy(batchResult = result.value)
        refreshPricing()
      }
      is HubResult.Failure -> if (isCurrent(generation)) _state.value = _state.value.copy(error = result.error.message)
    }
  }

  /** Reset every Hub-derived field when the connection target changes.
   *
   *  Without this, saving a different Hub URL/secret left the previous Hub's
   *  stats, devices and history on screen (with a live-looking status) until the
   *  new Hub happened to answer — presenting one deployment's numbers as another's.
   */
  fun onConnectionChanged() {
    connectionGeneration += 1
    val generation = connectionGeneration
    rangeJob?.cancel()
    rangeJob = null
    // A different deployment can answer the same window, so a backoff recorded against
    // the previous Hub must not silence the retry on this one.
    rangeSequence += 1
    rangeFailedKey = ""
    rangeRetryAfterMs = 0L
    sseJob?.cancel()
    sseJob = null
    refreshJob?.cancel()
    refreshJob = null
    cancelRequests()
    _state.value = HubUiState(isLoading = true, realtime = RealtimeStatus.Reconnecting)
    refreshAll()
    startRealtime(generation)
    viewModelScope.launch {
      when (val result = repository.capabilities()) {
        is HubResult.Success -> if (isCurrent(generation)) {
          _state.value = _state.value.copy(authorization = result.value)
          if (result.value.capabilities.pricing) refreshPricing()
          if (result.value.capabilities.hubAccounts != false) refreshAccounts()
        }
        is HubResult.Failure -> if (isCurrent(generation)) _state.value = _state.value.copy(error = result.error.message)
      }
    }
  }

  fun clearBatchResult() { _state.value = _state.value.copy(batchResult = null) }
  fun dismissError() { _state.value = _state.value.copy(error = null) }

  fun setAnalyticsPeriod(kind: AnalyticsPeriodKind) {
    if (kind == AnalyticsPeriodKind.Yesterday || kind == AnalyticsPeriodKind.Week) {
      if (_state.value.authorization?.capabilities?.usageRange != true) {
        _state.value = _state.value.copy(error = "当前 Hub 不支持日历预设范围。")
        return
      }
      // Re-selecting a preset that already answers this exact window must not spend a
      // second range request; the window is the identity, not the tab.
      if (ScopePeriod.rangeAnswerIsCurrent(_state.value.copy(analyticsPeriod = kind))) {
        _state.value = _state.value.copy(analyticsPeriod = kind, customRangeLoading = false)
        return
      }
      // Select first, then ask: `retryScopeRange()` derives the window from the kind, so
      // the tab the user chose and the span that answers it cannot drift apart.
      _state.value = _state.value.copy(analyticsPeriod = kind)
      retryScopeRange()
      return
    }
    if (kind == AnalyticsPeriodKind.Custom) {
      if (_state.value.authorization?.capabilities?.usageRange != true) {
        _state.value = _state.value.copy(error = "当前 Hub 不支持自定义时间范围。")
        return
      }
      // Clear any previous range result: the tab renders customRangeResult
      // whenever the period is Custom, so keeping it would show the old range's
      // numbers under the new selection.
      rangeJob?.cancel()
      _state.value = _state.value.copy(
        analyticsPeriod = AnalyticsPeriodKind.Custom,
        customRange = null,
        customRangeResult = null,
        customRangeLoading = false,
        activePresetWindow = null
      )
      return
    }
    rangeJob?.cancel()
    // A snapshot period is *never* answered by a range payload.  Dropping the cached
    // answer here is what stops 今日/本月/全部 from keeping the number of whatever
    // preset was selected last — the overview used to prefer the cache for every tab,
    // so one fetched range silently replaced the whole scope bar.
    _state.value = _state.value.copy(
      analyticsPeriod = kind,
      customRange = null,
      customRangeResult = null,
      customRangeLoading = false,
      activePresetWindow = null
    )
  }

  /**
   * Ask the current scope tab's window again, after a failure or a manual retry.
   *
   * Both surfaces need the same rule, and it has to be the rule that *selected* the
   * window in the first place: a preset re-derives its calendar span (so a retry after
   * midnight asks for today's week), while a picked range re-sends the days the user
   * chose.  Reusing [setAnalyticsPeriod] would not work for `Custom`, which clears the
   * selection and waits for the picker.
   */
  fun retryScopeRange() {
    val current = _state.value
    val kind = current.analyticsPeriod
    if (!kind.needsRange) return
    if (kind == AnalyticsPeriodKind.Custom) {
      val range = current.customRange ?: return
      loadCustomRange(range.startDate, range.endDate, range.startHour, range.endHour, range.label)
      return
    }
    val window = com.igng.tokenmonitor.android.ui.core.DateRanges.presetRangeWindow(kind.presetPeriodName())
      ?: return
    // Tapping the tab that is already being fetched must not spend a second request: the
    // in-flight call already describes this exact window.
    if (_state.value.customRangeLoading && window.stillMatches(_state.value.activePresetWindow)) return
    loadCustomRange(
      startDate = window.startDate.toString(),
      endDate = window.endDate.toString(),
      startHour = window.startHour,
      endHour = window.endHour,
      label = window.label(),
      period = kind,
      presetWindow = window
    )
  }

  /**
   * Re-resolve a preset whose calendar window has moved, and retry one that failed.
   *
   * `Yesterday` and `Week` are windows, not stored periods: after local midnight the
   * cached answer describes a different span, and keeping it would show last week's
   * total under 本周.  [ScopePeriod.pendingRangeWindow] only turns non-null when the
   * window genuinely stopped matching, so calling this on every stream frame costs a
   * date comparison rather than a request — the same rule the shared UI uses
   * (`pendingPresetRangeWindow()` in `src/shared-ui/app.js`), and the reason a preset
   * never re-scans tokscale per tick in local mode.
   */
  private fun refreshPendingRangeWindow(today: java.time.LocalDate = java.time.LocalDate.now()) {
    if (_state.value.authorization?.capabilities?.usageRange != true) return
    if (_state.value.customRangeLoading) return
    val window = ScopePeriod.pendingRangeWindow(_state.value, today) ?: return
    val key = rangeKey(window.startDate.toString(), window.endDate.toString(), window.startHour, window.endHour)
    if (key == rangeFailedKey && System.currentTimeMillis() < rangeRetryAfterMs) return
    retryScopeRange()
  }

  private fun rangeKey(startDate: String, endDate: String, startHour: Int, endHour: Int): String =
    "$startDate:$endDate:$startHour:$endHour"

  fun loadCustomRange(
    startDate: String,
    endDate: String,
    startHour: Int = 0,
    endHour: Int = 23,
    label: String? = null,
    period: AnalyticsPeriodKind = AnalyticsPeriodKind.Custom,
    presetWindow: com.igng.tokenmonitor.android.ui.core.PresetRangeWindow? = null
  ) {
    if (_state.value.authorization?.capabilities?.usageRange != true) {
      _state.value = _state.value.copy(error = "当前 Hub 不支持自定义时间范围。")
      return
    }
    val rangeLabel = label ?: formatRangeLabel(startDate, endDate, startHour, endHour)
    val selection = CustomRangeSelection(startDate, endDate, startHour, endHour, rangeLabel)
    val key = rangeKey(startDate, endDate, startHour, endHour)
    // Send the local window's absolute instants alongside the day labels: the Hub
    // aggregates history on the labels but filters the event ledger on the instants, and
    // without them it would derive them from its own clock (see `windowInstants`).
    val instants = runCatching {
      com.igng.tokenmonitor.android.ui.core.DateRanges.windowInstants(
        java.time.LocalDate.parse(startDate),
        java.time.LocalDate.parse(endDate),
        startHour,
        endHour
      )
    }.getOrNull()
    val sequence = ++rangeSequence
    rangeJob?.cancel()
    val generation = connectionGeneration
    // Drop the previous window's answer *before* the request: while this is in flight the
    // tab must render a loading state, not the numbers of the scope the user just left.
    _state.value = _state.value.copy(
      analyticsPeriod = period,
      customRange = selection,
      customRangeResult = null,
      customRangeLoading = true,
      activePresetWindow = presetWindow,
      error = null
    )
    rangeJob = viewModelScope.launch {
      if (!isCurrent(generation)) return@launch
      when (val result = repository.usageRange(startDate, endDate, startHour, endHour, instants?.from, instants?.to)) {
        is HubResult.Success -> if (isCurrent(generation) && sequence == rangeSequence) {
          _state.value = _state.value.copy(
            customRangeResult = result.value,
            customRangeLoading = false
          )
          rangeFailedKey = ""
        }
        is HubResult.Failure -> if (isCurrent(generation) && sequence == rangeSequence) {
          // Keep the failure honest: no result, so the tab shows a retry affordance
          // instead of a number it never obtained.
          _state.value = _state.value.copy(
            customRangeResult = null,
            customRangeLoading = false,
            error = result.error.message
          )
          rangeFailedKey = key
          rangeRetryAfterMs = System.currentTimeMillis() + RANGE_RETRY_MS
        }
      }
    }
  }

  /** Restart the live stream, e.g. after the secret or the Hub target changed. */
  fun restartRealtime() { sseJob?.cancel(); sseJob = null; startRealtime() }

  /** Start or stop the live stream as the app moves between foreground and background.
   *
   *  viewModelScope outlives onStop, so the SSE loop used to keep an authenticated
   *  connection open, answer 15s pings and re-dial on a 1-30s backoff forever while
   *  the app was backgrounded — battery/radio drain and Hub-side connection churn
   *  for a client the user believes is idle.
   */
  fun setForeground(foreground: Boolean) {
    if (foreground) {
      if (hasObservedForeground && sseJob?.isActive != true) refreshAll()
      hasObservedForeground = true
      startRealtime()
    } else {
      sseJob?.cancel()
      sseJob = null
      _state.value = _state.value.copy(realtime = RealtimeStatus.Disconnected)
    }
  }

  private fun startRealtime(generation: Long = connectionGeneration) {
    if (!isCurrent(generation) || sseJob?.isActive == true) return
    sseJob = viewModelScope.launch {
      val configured = try {
        withContext(Dispatchers.IO) { repository.connection().isComplete }
      } catch (error: CancellationException) {
        throw error
      } catch (_: Exception) {
        if (isCurrent(generation)) {
          _state.value = _state.value.copy(
            realtime = RealtimeStatus.Disconnected,
            error = "无法读取本机连接设置，请重新保存连接信息。"
          )
        }
        return@launch
      }
      if (!configured) {
        _state.value = _state.value.copy(realtime = RealtimeStatus.Disconnected)
        return@launch
      }
      var backoffMs = 1_000L
      while (isActive && isCurrent(generation)) {
        _state.value = _state.value.copy(realtime = RealtimeStatus.Reconnecting)
        runCatching {
          repository.statsEvents().collect { event ->
            if (isCurrent(generation)) {
              event.stats?.let { stats ->
              // Keep the device list in step with the stream's latest stale flags.
              // A frame without a device list retains the last REST snapshot.
              val devices = stats.devices.ifEmpty { _state.value.devices }
              statsFrameVersion += 1
              _state.value = _state.value.copy(
                stats = stats,
                devices = devices,
                isLoading = false,
                realtime = RealtimeStatus.Live,
                error = null
              )
              // A snapshot frame is also the clock check for a preset scope tab: past
              // local midnight the cached window no longer names 昨日/本周, so it is
              // re-resolved here.  The predicate is a date comparison unless the window
              // actually moved, so this never turns into a request per frame.
              refreshPendingRangeWindow()
              // The slim frame omits history; its `historyRevision` is the signal
              // that the document behind it moved. Re-ask only then — and that ask
              // is conditional, so an unchanged document costs a 304.
              val revision = stats.historyRevision
              if (revision != null && revision != historyRevisionSeen) {
                historyRevisionSeen = revision
                if (hasObservedHistory) refreshHistory()
              }
            }
            }
            backoffMs = 1_000L
          }
        }.onFailure {
          if (isActive && isCurrent(generation)) _state.value = _state.value.copy(realtime = RealtimeStatus.Disconnected)
        }
        if (isActive && isCurrent(generation)) {
          _state.value = _state.value.copy(realtime = RealtimeStatus.Reconnecting)
          delay(backoffMs)
          backoffMs = (backoffMs * 2).coerceAtMost(30_000L)
        }
      }
    }
  }
// ─── Accounts (Hub-owned quota credentials) ──────────────────────────────────

  fun refreshAccounts() = launchRequest { generation ->
    _state.value = _state.value.copy(accountsLoading = true, accountsError = null)
    when (val result = repository.accounts()) {
      is HubResult.Success -> if (isCurrent(generation)) _state.value = _state.value.copy(
        accounts = result.value.accounts,
        accountsLoading = false
      )
      is HubResult.Failure -> if (isCurrent(generation)) _state.value = _state.value.copy(
        accountsLoading = false,
        accountsError = result.error.message
      )
    }
  }

  /**
   * Add or update an account.  [credential] is assembled by the caller and dropped
   * here: the Hub never echoes it, so the client must not keep a copy in UI state
   * either.  A response carries the whole redacted list, which is why this assigns
   * rather than appending.
   */
  fun saveAccount(
    accountId: String?,
    provider: String,
    name: String?,
    label: String?,
    enabled: Boolean?,
    credential: kotlinx.serialization.json.JsonObject?
  ) = launchRequest { generation ->
    val request = AccountRequestDto(
      provider = provider,
      name = name?.trim()?.ifEmpty { null },
      label = label?.trim()?.ifEmpty { null },
      enabled = enabled,
      credential = credential?.takeIf { !it.isEmpty() }
    )
    val result = if (accountId == null) {
      repository.addAccount(request)
    } else {
      repository.patchAccount(accountId, request)
    }
    when (result) {
      is HubResult.Success -> if (isCurrent(generation)) _state.value = _state.value.copy(
        accounts = result.value.accounts,
        accountsError = null
      )
      is HubResult.Failure -> if (isCurrent(generation)) _state.value = _state.value.copy(
        accountsError = result.error.message
      )
    }
  }

  fun deleteAccount(accountId: String) = launchRequest { generation ->
    when (val result = repository.deleteAccount(accountId)) {
      is HubResult.Success -> if (isCurrent(generation)) _state.value = _state.value.copy(
        accounts = result.value.accounts,
        accountsError = null
      )
      is HubResult.Failure -> if (isCurrent(generation)) _state.value = _state.value.copy(
        accountsError = result.error.message
      )
    }
  }

  fun refreshAccountQuota(accountId: String) = launchRequest { generation ->
    when (val result = repository.refreshAccount(accountId)) {
      is HubResult.Success -> if (isCurrent(generation)) _state.value = _state.value.copy(
        accounts = result.value.accounts,
        accountsError = null
      )
      is HubResult.Failure -> if (isCurrent(generation)) _state.value = _state.value.copy(
        accountsError = result.error.message
      )
    }
  }

  /** Begin a Hub-side OAuth sign-in.  The caller opens [OAuthStartDto.authUrl]. */
  fun startOAuth(provider: String) = launchRequest { generation ->
    when (val result = repository.startOAuth(provider)) {
      is HubResult.Success -> if (isCurrent(generation)) _state.value = _state.value.copy(
        oauthSession = result.value.takeIf { it.ok && !it.sessionId.isNullOrBlank() },
        accountsError = if (result.value.ok) null else result.value.error
      )
      is HubResult.Failure -> if (isCurrent(generation)) _state.value = _state.value.copy(
        accountsError = result.error.message
      )
    }
  }

  fun clearOAuthSession() { _state.value = _state.value.copy(oauthSession = null) }

  /**
   * Complete the sign-in with whatever the provider handed back.  The field is
   * permissive by contract (callback URL, query string, or bare code), so this forwards
   * the paste verbatim instead of parsing it and getting the third shape wrong.
   *
   * [accountId] re-authorizes that account in place; without it the Hub adds a new
   * account.  Editing an existing OAuth account must pass it, or "finish login"
   * would try to create a duplicate and come back as `account_duplicate`.
   */
  fun exchangeOAuth(
    sessionId: String,
    pasted: String,
    name: String?,
    label: String?,
    accountId: String? = null
  ) = launchRequest { generation ->
      val result = repository.exchangeOAuth(
        OAuthExchangeRequestDto(
          sessionId = sessionId,
          redirectUrl = pasted.trim(),
          name = name?.trim()?.ifEmpty { null },
          label = label?.trim()?.ifEmpty { null },
          accountId = accountId?.trim()?.ifEmpty { null }
        )
      )
      when (result) {
        is HubResult.Success -> if (isCurrent(generation)) _state.value = _state.value.copy(
          accounts = result.value.accounts,
          oauthSession = null,
          accountsError = null
        )
        is HubResult.Failure -> if (isCurrent(generation)) _state.value = _state.value.copy(
          accountsError = result.error.message
        )
      }
    }

  /** Clear an account's stored credential; the account itself is kept. */
  fun clearAccountCredential(accountId: String) = launchRequest { generation ->
    when (val result = repository.clearAccountCredential(accountId)) {
      is HubResult.Success -> if (isCurrent(generation)) _state.value = _state.value.copy(
        accounts = result.value.accounts,
        oauthSession = null,
        accountsError = null
      )
      is HubResult.Failure -> if (isCurrent(generation)) _state.value = _state.value.copy(
        accountsError = result.error.message
      )
    }
  }

  // ─── Subscription ledger ────────────────────────────────────────────────────

  fun refreshSubscriptions() = launchRequest { generation ->
    when (val result = repository.subscriptions()) {
      is HubResult.Success -> if (isCurrent(generation)) _state.value = _state.value.copy(
        subscriptions = result.value.subscriptions,
        subscriptionsUpdatedAt = result.value.updatedAt,
        subscriptionsError = null
      )
      is HubResult.Failure -> if (isCurrent(generation)) _state.value = _state.value.copy(
        subscriptionsError = result.error.message
      )
    }
  }

  /**
   * Replace the ledger.  [HubUiState.subscriptionsUpdatedAt] is sent as the
   * compare-and-swap base: a concurrent edit from another client fails loudly instead
   * of being overwritten, which is the only reason the token is kept at all.
   */
  fun saveSubscriptions(next: List<SubscriptionDto>) = launchRequest { generation ->
    val base = _state.value.subscriptionsUpdatedAt
    val result = repository.putSubscriptions(SubscriptionsRequestDto(next, base))
    when (result) {
      is HubResult.Success -> if (isCurrent(generation)) _state.value = _state.value.copy(
        subscriptions = result.value.subscriptions,
        subscriptionsUpdatedAt = result.value.updatedAt,
        subscriptionsError = null
      )
      is HubResult.Failure -> if (isCurrent(generation)) _state.value = _state.value.copy(
        subscriptionsError = result.error.message
      )
    }
  }

  // ─── Display rates ──────────────────────────────────────────────────────────

  /**
   * Per-device history, keyed by device id.  `/api/history?deviceId=` is a separate
   * document from the fleet aggregate, so the device detail needs its own cache
   * instead of re-querying on every recomposition.
   */
  fun refreshDeviceHistory(deviceId: String) = launchRequest { generation ->
    when (val result = repository.history(deviceId)) {
      is HubResult.Success -> if (isCurrent(generation)) _state.value = _state.value.copy(
        deviceHistories = _state.value.deviceHistories + (deviceId to result.value)
      )
      is HubResult.Failure -> Unit
    }
  }

  fun renameDevice(deviceId: String, hostname: String) = launchRequest { generation ->
    when (val result = repository.renameDevice(deviceId, hostname)) {
      is HubResult.Success -> if (isCurrent(generation)) {
        _state.value = _state.value.copy(devices = result.value.devices, error = null)
        refreshStats()
      }
      is HubResult.Failure -> if (isCurrent(generation)) _state.value = _state.value.copy(
        error = result.error.message
      )
    }
  }

  fun deleteDevice(deviceId: String) = launchRequest { generation ->
    when (val result = repository.deleteDevice(deviceId)) {
      is HubResult.Success -> if (isCurrent(generation)) {
        _state.value = _state.value.copy(
          devices = result.value.devices,
          deviceHistories = _state.value.deviceHistories - deviceId,
          error = null
        )
        refreshStats()
      }
      is HubResult.Failure -> if (isCurrent(generation)) _state.value = _state.value.copy(
        error = result.error.message
      )
    }
  }

  fun refreshRates() = launchRequest { generation ->
    when (val result = repository.rates()) {
      is HubResult.Success -> if (isCurrent(generation)) _state.value = _state.value.copy(
        rates = result.value.rates,
        ratesDate = result.value.date
      )
      is HubResult.Failure -> Unit
    }
  }


}

internal fun UsageRangeDto.toPeriodDto(): PeriodDto = PeriodDto(
  totalTokens = totalTokens,
  costUsd = costUsd,
  clients = clients,
  clientCosts = clientCosts,
  models = models,
  modelCosts = modelCosts,
  clientModels = clientModels,
  clientModelCosts = clientModelCosts,
  projects = projects,
  sessions = sessions,
  // Provenance has to survive the fold or a range answer renders an estimate as an
  // exact figure while the same client on a snapshot period renders it with `~`.
  clientEstimated = clientEstimated,
  clientCredits = clientCredits,
  clientModelCredits = clientModelCredits,
  clientMeasurements = clientMeasurements,
  estimated = estimated
)


fun formatRangeLabel(startDate: String, endDate: String, startHour: Int, endHour: Int): String {
  fun pad(n: Int) = n.toString().padStart(2, '0')
  val start = "$startDate ${pad(startHour)}:00"
  val end = "$endDate ${pad(endHour)}:00"
  return "$start → $end"
}
