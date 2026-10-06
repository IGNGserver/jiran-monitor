package com.igng.tokenmonitor.android.data.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

@Serializable
data class HealthDto(
  val ok: Boolean = false,
  val role: String? = null,
  val version: Int? = null,
  val apiVersion: Int? = null,
  val capabilities: HubCapabilitiesDto = HubCapabilitiesDto(),
  val deviceCount: Int? = null,
  val secretRequired: Boolean? = null,
  val now: String? = null
)

@Serializable
data class HubCapabilitiesDto(
  val stats: Boolean = true,
  val history: Boolean = true,
  val statsStream: Boolean = true,
  val subscriptions: Boolean = true,
  val usageRange: Boolean = false,
  val pricing: Boolean = false,
  val deviceDelete: Boolean = false,
  val deviceRename: Boolean = false,
  val publicStats: Boolean = false,
  /**
   * Whether the Hub serves the staged first-paint endpoints
   * (`/api/stats/summary`, `/api/devices/{id}`, `/api/sessions`).
   *
   * Absent on an older Hub, and absence must mean "not available": falling back
   * to `/api/stats` is always correct, only slower, whereas calling a
   * `statsSummary` that does not exist would fail the whole refresh.
   */
  val statsSummary: Boolean = false,
  val deviceDetail: Boolean = false,
  val sessionList: Boolean = false,
  /**
   * Whether this Hub owns quota accounts (`/api/accounts`).  Defaults to true on
   * purpose: an older Hub that omits the field still has the endpoint, and hiding
   * account management on a missing key would be a regression, not a safety win.
   */
  val hubAccounts: Boolean? = true
)

@Serializable
data class HubAuthorizationDto(
  val apiVersion: Int? = null,
  val capabilities: HubCapabilitiesDto = HubCapabilitiesDto(),
  val authenticated: Boolean = false
)

@Serializable
data class StatsDto(
  val staleAfterMs: Long? = null,
  val periods: PeriodsDto = PeriodsDto(),
  val devices: List<DeviceDto> = emptyList(),
  val projectsIncomplete: Boolean? = null,
  /**
   * Session rows one or more synchronized devices dropped to stay inside the ingest
   * limit.  Without it the sessions screen's own 200-row cap looked like the whole
   * story, while the Hub had already silently omitted detail.
   */
  val sessionDetailsOmitted: Boolean? = null,
  /** A project rollup was itself too large to fit the ingest limit. */
  val periodProjectsOmitted: Boolean? = null,
  /**
   * Whose quota numbers these are: `hub` for the account service, absent when no
   * authority exists.  Surfaced so 限额 can say where it came from instead of
   * implying every device carries its own quota.
   */
  val limitsAuthority: String? = null,
  val historyPreview: HistoryDto? = null,
  /**
   * Revision of the fleet history document. The slim stream frame omits the
   * document, so this is how a client learns the document behind it moved; an
   * unchanged value means the cached copy is still current.
   */
  val historyRevision: String? = null,
  /** Per-device attribution revision; changes when a device's history source moves. */
  val deviceHistoryRevision: String? = null,
  val limits: LimitsDto? = null
)

@Serializable
data class HistoryBreakdownDto(
  val tokens: Double = 0.0,
  val cost: Double = 0.0,
  val messages: Double = 0.0
)

@Serializable
data class HistoryDayDto(
  val date: String = "",
  val tokens: Double = 0.0,
  val cost: Double = 0.0,
  val activeTimeMs: Double = 0.0,
  val perClient: Map<String, HistoryBreakdownDto> = emptyMap(),
  val perModel: Map<String, HistoryBreakdownDto> = emptyMap()
)

@Serializable
data class HistoryMonthDto(
  val month: String = "",
  val tokens: Double = 0.0,
  val cost: Double = 0.0,
  val activeTimeMs: Double = 0.0,
  val perClient: Map<String, HistoryBreakdownDto> = emptyMap(),
  val perModel: Map<String, HistoryBreakdownDto> = emptyMap()
)

/** Full /api/history payload (includes perClient/perModel stacks). */
@Serializable
data class HistoryDto(
  val daily: List<HistoryDayDto> = emptyList(),
  val monthly: List<HistoryMonthDto> = emptyList(),
  val summary: HistorySummaryDto = HistorySummaryDto()
)

typealias HistoryPreviewDto = HistoryDto

@Serializable
data class HistorySummaryDto(
  val totalTokens: Double = 0.0,
  val totalCost: Double = 0.0,
  val activeDays: Double = 0.0,
  val currentStreak: Double = 0.0,
  val longestStreak: Double = 0.0,
  val peakDayTokens: Double = 0.0,
  val favoriteModel: String? = null,
  val messages: Double = 0.0,
  val activeTimeMs: Double = 0.0
)

@Serializable
data class LimitsDto(
  val updatedAt: String? = null,
  val refreshMs: Long? = null,
  val providers: List<LimitProviderDto> = emptyList()
)

@Serializable
data class LimitProviderDto(
  val provider: String = "",
  val accountKey: String? = null,
  val accountEmail: String? = null,
  val accountLabel: String? = null,
  val accountName: String? = null,
  val plan: String? = null,
  val planType: String? = null,
  val planLabel: String? = null,
  val workspaceKind: String? = null,
  val status: String? = null,
  val source: String? = null,
  val updatedAt: String? = null,
  val balanceUsd: Double? = null,
  val balance: BalanceDto? = null,
  val resetCredits: ResetCreditsDto? = null,
  val windows: List<LimitWindowDto> = emptyList()
)

@Serializable
data class BalanceDto(
  val amount: Double? = null,
  val currency: String? = null,
  val todaySpend: Double? = null,
  val weekSpend: Double? = null,
  val monthSpend: Double? = null,
  val allTimeSpend: Double? = null
)

@Serializable
data class ResetCreditsDto(
  val availableCount: Double? = null,
  val totalCount: Double? = null,
  val available: Double? = null,
  val total: Double? = null,
  val remaining: Double? = null,
  val limit: Double? = null
)

@Serializable
data class LimitWindowDto(
  val kind: String = "",
  val label: String? = null,
  val used: Double? = null,
  val limit: Double? = null,
  val remaining: Double? = null,
  val usedPercent: Double? = null,
  val remainingPercent: Double? = null,
  val resetsAt: String? = null,
  val windowMinutes: Double? = null,
  val resetDescription: String? = null,
  val metric: String? = null,
  val detail: String? = null,
  val showMeter: Boolean = true
)

/**
 * The device-local calendar windows behind `today` / `month`, as the Hub
 * normalizes them (`src/shared/usage.js` `normalizePeriodWindows`): each window
 * carries the UTC instant it ends (`endsAt`) plus the device-local `key` for
 * reference.
 *
 * Not a `Map<String, PeriodWindowDto>`: the Hub writes the IANA `timeZone` that
 * produced the keys as a *sibling* string beside the two window objects
 * (`docs/API.md`), so a homogeneous value-typed map would fail to decode the whole
 * stats / devices / stream document the moment a host resolves a zone.
 */
@Serializable
data class PeriodWindowsDto(
  val today: PeriodWindowDto? = null,
  val month: PeriodWindowDto? = null,
  val timeZone: String? = null
)

@Serializable
data class PeriodWindowDto(
  val endsAt: String? = null,
  val key: String? = null
)

@Serializable
data class PeriodsDto(
  val today: PeriodDto = PeriodDto(),
  val month: PeriodDto = PeriodDto(),
  val allTime: PeriodDto = PeriodDto()
)

@Serializable
data class PeriodDto(
  val totalTokens: Long = 0,
  val costUsd: Double = 0.0,
  val clients: Map<String, Long> = emptyMap(),
  val clientCosts: Map<String, Double> = emptyMap(),
  val models: Map<String, Long> = emptyMap(),
  val modelCosts: Map<String, Double> = emptyMap(),
  val clientModels: Map<String, Map<String, Long>> = emptyMap(),
  val clientModelCosts: Map<String, Map<String, Double>> = emptyMap(),
  val projects: Map<String, ProjectDto> = emptyMap(),
  val sessions: Map<String, SessionDto> = emptyMap(),
  /**
   * Sparse provenance map: a client is present only when *some* of its tokens were
   * estimated from message content rather than an exact meter.  `null`/absent means
   * "not estimated", which is not the same as `false` from a client that reported
   * nothing.  `docs/API.md` is the authority; the web UI renders these with a `~`
   * prefix, and without the field the client showed a guess with the same weight as
   * a measurement.
   */
  val clientEstimated: Map<String, Boolean> = emptyMap(),
  /**
   * Credits consumed in the provider's own metered unit.  Only Qoder publishes this,
   * and for Qoder it is the *only* exact figure: Qoder bills in credits and leaves
   * every token field of its usage block at zero, so a client that ignores this map
   * shows Qoder as using nothing at all.
   */
  val clientCredits: Map<String, Double> = emptyMap(),
  /** Client×model grain of [clientCredits]; forwarded for the same reason. */
  val clientModelCredits: Map<String, Map<String, Double>> = emptyMap(),
  /** Unified per-client token/cost provenance and native provider meters. */
  val clientMeasurements: Map<String, ClientMeasurementDto> = emptyMap(),
  /** Period-level "at least one row here was estimated". */
  val estimated: Boolean = false
)

@Serializable
data class ProjectDto(
  val label: String? = null,
  val tokens: Long = 0,
  val costUsd: Double = 0.0,
  val clients: Map<String, Long> = emptyMap()
)

@Serializable
data class SessionDto(
  val client: String? = null,
  val sessionId: String? = null,
  val projectId: String? = null,
  val projectLabel: String? = null,
  val totalTokens: Long = 0,
  val costUsd: Double = 0.0,
  val messageCount: Long = 0,
  val inputTokens: Long = 0,
  val outputTokens: Long = 0,
  val cacheReadTokens: Long = 0,
  val cacheWriteTokens: Long = 0,
  val reasoningTokens: Long = 0,
  val startedAt: String? = null,
  val lastUsedAt: String? = null,
  val models: Map<String, Long> = emptyMap(),
  /** Credits for this session; see [PeriodDto.clientCredits]. */
  val credits: Double? = null,
  val modelCredits: Map<String, Double> = emptyMap()
)

@Serializable
data class NativeMeterDto(
  val value: Double = 0.0,
  val provenance: String = "unknown"
)

@Serializable
data class ClientMeasurementDto(
  val tokens: String? = null,
  val costUsd: String? = null,
  val meters: Map<String, NativeMeterDto> = emptyMap()
)

@Serializable
data class DeviceDto(
  val deviceId: String? = null,
  val hostname: String? = null,
  val platform: String? = null,
  val osName: String? = null,
  val osVersion: String? = null,
  val agentRuntime: String? = null,
  val updatedAt: String? = null,
  val receivedAt: String? = null,
  val stale: Boolean = false,
  val clientStatus: Map<String, String> = emptyMap(),
  val wslStatus: WslStatusDto? = null,
  val periods: PeriodsDto = PeriodsDto(),
  /**
   * Never populated.  The Hub deletes `limits` from every device record before it
   * answers (`src/hub/server.js`: `delete device.limits`), because quota is
   * Hub-owned account state, not per-device state — see `stats.limitsAuthority`.
   * Kept so the shape still round-trips a device record read straight off the wire,
   * and the client must not build UI on it.
   */
  val limits: LimitsDto? = null,
  /** Real calendar boundaries behind `today` / `month` / `allTime`. */
  val periodWindows: PeriodWindowsDto = PeriodWindowsDto(),
  val agentVersion: String? = null,
  val trackedClients: List<String> = emptyList(),
  val projectsEnabled: Boolean? = null
)

@Serializable
data class WslStatusDto(
  val state: String? = null,
  val detected: List<String> = emptyList(),
  val withData: List<String> = emptyList()
)

@Serializable
data class DevicesResponseDto(val devices: List<DeviceDto> = emptyList())

/** One device's full periods, from `/api/devices/{id}`. */
@Serializable
data class DeviceResponseDto(val device: DeviceDto? = null)

/**
 * The aggregate session list from `/api/sessions`.
 *
 * [total] is the number of rows the Hub holds and [shown] the number it returned
 * after its display cap; the list is capped rather than complete, so the screen
 * can say so instead of presenting a truncated list as the whole archive.
 */
@Serializable
data class SessionsResponseDto(
  val total: Int = 0,
  val shown: Int = 0,
  val sessions: List<SessionRowDto> = emptyList()
)

/** A [SessionDto] plus the period it was drawn from. */
@Serializable
data class SessionRowDto(
  val period: String? = null,
  val client: String? = null,
  val sessionId: String? = null,
  val projectId: String? = null,
  val projectLabel: String? = null,
  val totalTokens: Long = 0,
  val costUsd: Double = 0.0,
  val messageCount: Long = 0,
  val inputTokens: Long = 0,
  val outputTokens: Long = 0,
  val cacheReadTokens: Long = 0,
  val cacheWriteTokens: Long = 0,
  val reasoningTokens: Long = 0,
  val startedAt: String? = null,
  val lastUsedAt: String? = null,
  val models: Map<String, Long> = emptyMap(),
  val credits: Double? = null,
  val modelCredits: Map<String, Double> = emptyMap()
)

@Serializable
data class PricingDto(
  val id: Long? = null,
  val model: String = "",
  val inputPricePerMillion: Double = 0.0,
  val outputPricePerMillion: Double = 0.0,
  val cacheReadPricePerMillion: Double = 0.0,
  val cacheWritePricePerMillion: Double = 0.0,
  val source: String = "manual",
  val updatedAt: String? = null
)

@Serializable
data class PricingListDto(val pricing: List<PricingDto> = emptyList())

@Serializable
data class PricingRequestDto(
  val inputPricePerMillion: Double,
  val outputPricePerMillion: Double,
  val cacheReadPricePerMillion: Double,
  val cacheWritePricePerMillion: Double
)

@Serializable
data class PricingResponseDto(val ok: Boolean = false, val pricing: PricingDto? = null)

@Serializable
data class BatchPricingResponseDto(val results: List<BatchPricingResultDto> = emptyList())

@Serializable
data class BatchPricingResultDto(
  val model: String = "",
  val ok: Boolean = false,
  val pricing: PricingDto? = null,
  val error: String? = null,
  val message: String? = null
)

@Serializable
data class UsageRangeDto(
  val from: String = "",
  val to: String = "",
  val startDate: String? = null,
  val endDate: String? = null,
  val startHour: Int? = null,
  val endHour: Int? = null,
  val source: String = "",
  val totalTokens: Long = 0,
  val costUsd: Double = 0.0,
  val clients: Map<String, Long> = emptyMap(),
  val clientCosts: Map<String, Double> = emptyMap(),
  val models: Map<String, Long> = emptyMap(),
  val modelCosts: Map<String, Double> = emptyMap(),
  val clientModels: Map<String, Map<String, Long>> = emptyMap(),
  val clientModelCosts: Map<String, Map<String, Double>> = emptyMap(),
  val projects: Map<String, ProjectDto> = emptyMap(),
  val sessions: Map<String, SessionDto> = emptyMap(),
  /**
   * Sparse provenance map: a client is present only when *some* of its tokens were
   * estimated from message content rather than an exact meter.  `null`/absent means
   * "not estimated", which is not the same as `false` from a client that reported
   * nothing.  `docs/API.md` is the authority; the web UI renders these with a `~`
   * prefix, and without the field the client showed a guess with the same weight as
   * a measurement.
   */
  val clientEstimated: Map<String, Boolean> = emptyMap(),
  /**
   * Credits consumed in the provider's own metered unit.  Only Qoder publishes this,
   * and for Qoder it is the *only* exact figure: Qoder bills in credits and leaves
   * every token field of its usage block at zero, so a client that ignores this map
   * shows Qoder as using nothing at all.
   */
  val clientCredits: Map<String, Double> = emptyMap(),
  /** Client×model grain of [clientCredits]; forwarded for the same reason. */
  val clientModelCredits: Map<String, Map<String, Double>> = emptyMap(),
  val clientMeasurements: Map<String, ClientMeasurementDto> = emptyMap(),
  /** Period-level "at least one row here was estimated". */
  val estimated: Boolean = false
)

@Serializable
data class SseStatsDto(
  val type: String? = null,
  val reason: String? = null,
  val stats: StatsDto? = null,
  val at: String? = null
)

// ─── Hub-owned accounts, subscriptions and rates ────────────────────────────
//
// These three payloads are the reason the client used to be a read-only mirror:
// quota was displayed but never managed, cost was shown only in USD, and a plan
// ledger the Hub already stores had no surface at all.  Field names follow
// `docs/API.md`; a credential is *never* present in a response, so no DTO here can
// hold one — the request type below is the only place a credential exists, and it
// is written and forgotten.

@Serializable
data class HubAccountDto(
  val id: String = "",
  val provider: String = "",
  val name: String? = null,
  val label: String? = null,
  val accountEmail: String? = null,
  val accountName: String? = null,
  val plan: String? = null,
  val enabled: Boolean = true,
  val status: String? = null,
  val lastSuccessAt: String? = null,
  val lastAttemptAt: String? = null,
  val lastError: String? = null,
  /** Whether the Hub still holds a credential for this account.  Absent when the
   *  Hub was asked without credential metadata, so `null` means "unknown". */
  val credentialConfigured: Boolean? = null,
  val credentialMetadata: JsonObject? = null,
  /**
   * This account's current quota snapshot.  The Hub stores one provider row per
   * account, so this is a single [LimitProviderDto] — not a [LimitsDto] wrapper.
   * Typing it as the wrapper decoded to an empty `providers` list and blanked the
   * account's 当前额度 section.
   */
  val limits: LimitProviderDto? = null
)

@Serializable
data class AccountsResponseDto(
  val ok: Boolean = false,
  val authority: String? = null,
  /**
   * Provider ids the Hub can manage (`claude`, `codex`, …).  The wire value is a
   * `List<String>` — the add-account picker uses the client's own provider table,
   * so this field is informational; typing it as `List<LimitProviderDto>` failed
   * to decode every `/api/accounts` response.
   */
  val providers: List<String> = emptyList(),
  val accounts: List<HubAccountDto> = emptyList()
)

/**
 * Create/update body.  [credential] is a provider-shaped object the caller assembles
 * and never reads back: the Hub stores it encrypted and does not echo it.
 */
@Serializable
data class AccountRequestDto(
  val provider: String = "",
  val name: String? = null,
  val label: String? = null,
  val enabled: Boolean? = null,
  val credential: kotlinx.serialization.json.JsonObject? = null
)

@Serializable
data class OAuthStartDto(
  val ok: Boolean = false,
  val sessionId: String? = null,
  val authUrl: String? = null,
  val provider: String? = null,
  val error: String? = null
)

/**
 * Exchange body.  `redirectUrl` is deliberately permissive — a provider may hand back
 * a full callback URL, a bare query string, or just a code (`docs/API.md`); the client
 * forwards whatever the user pasted without trying to parse it.
 */
@Serializable
data class OAuthExchangeRequestDto(
  val sessionId: String = "",
  val redirectUrl: String = "",
  val name: String? = null,
  val label: String? = null,
  /** When set, the Hub re-authorizes that account in place instead of adding one. */
  val accountId: String? = null
)

@Serializable
data class SubscriptionDto(
  val id: String = "",
  val provider: String? = null,
  val plan: String? = null,
  val amount: Double? = null,
  val currency: String? = null,
  val interval: String? = null,
  val intervalCount: Int? = null,
  val startDate: String? = null,
  val endDate: String? = null,
  val nextRenewalOverride: String? = null,
  val autoRenew: Boolean? = null,
  val recordType: String? = null,
  val accountEmail: String? = null,
  val profileName: String? = null,
  val note: String? = null
)

@Serializable
data class SubscriptionsResponseDto(
  val ok: Boolean = false,
  val version: Int? = null,
  val subscriptions: List<SubscriptionDto> = emptyList(),
  val updatedAt: String? = null,
  val error: String? = null
)

/**
 * Write body for the ledger.  [baseUpdatedAt] is the compare-and-swap token: the Hub
 * rejects a `PUT` whose base is not the stored `updatedAt`, so a stale edit fails
 * instead of silently overwriting someone else's change.
 */
@Serializable
data class SubscriptionsRequestDto(
  val subscriptions: List<SubscriptionDto> = emptyList(),
  val baseUpdatedAt: String? = null
)

@Serializable
data class RatesResponseDto(
  val ok: Boolean = false,
  val rates: Map<String, Double> = emptyMap(),
  val date: String? = null,
  val source: String? = null
)
