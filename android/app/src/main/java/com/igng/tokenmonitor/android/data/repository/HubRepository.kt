package com.igng.tokenmonitor.android.data.repository

import com.igng.tokenmonitor.android.data.local.ConnectionConfig
import com.igng.tokenmonitor.android.data.local.ConnectionStorage
import com.igng.tokenmonitor.android.data.model.AccountRequestDto
import com.igng.tokenmonitor.android.data.model.AccountsResponseDto
import com.igng.tokenmonitor.android.data.model.OAuthExchangeRequestDto
import com.igng.tokenmonitor.android.data.model.OAuthStartDto
import com.igng.tokenmonitor.android.data.model.RatesResponseDto
import com.igng.tokenmonitor.android.data.model.SubscriptionsRequestDto
import com.igng.tokenmonitor.android.data.model.SubscriptionsResponseDto
import com.igng.tokenmonitor.android.data.model.BatchPricingResponseDto
import com.igng.tokenmonitor.android.data.model.DeviceResponseDto
import com.igng.tokenmonitor.android.data.model.DevicesResponseDto
import com.igng.tokenmonitor.android.data.model.HealthDto
import com.igng.tokenmonitor.android.data.model.HubAuthorizationDto
import com.igng.tokenmonitor.android.data.model.HistoryDto
import com.igng.tokenmonitor.android.data.model.sanitizeForDisplay
import com.igng.tokenmonitor.android.data.model.PricingListDto
import com.igng.tokenmonitor.android.data.model.PricingRequestDto
import com.igng.tokenmonitor.android.data.model.PricingResponseDto
import com.igng.tokenmonitor.android.data.model.SessionsResponseDto
import com.igng.tokenmonitor.android.data.model.SseStatsDto
import com.igng.tokenmonitor.android.data.model.StatsDto
import com.igng.tokenmonitor.android.data.model.UsageRangeDto
import com.igng.tokenmonitor.android.data.remote.HubApiFactory
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import retrofit2.HttpException

sealed interface HubResult<out T> {
  data class Success<T>(val value: T) : HubResult<T>
  data class Failure(val error: HubError) : HubResult<Nothing>
}

/**
 * A conditional read's outcome: [document] is null when the server answered
 * `304 Not Modified`, and [etag] is the validator to send on the next read.
 */
data class HistoryFetch(val document: HistoryDto?, val etag: String?)

data class HubError(val message: String, val kind: Kind) {
  enum class Kind { NotConfigured, Unauthorized, Network, MalformedResponse, Api }
}

private inline fun <T, R> HubResult<T>.mapSuccess(transform: (T) -> R): HubResult<R> = when (this) {
  is HubResult.Success -> HubResult.Success(transform(value))
  is HubResult.Failure -> this
}

@Singleton
class HubRepository @Inject constructor(
  private val store: ConnectionStorage,
  private val apiFactory: HubApiFactory,
  private val json: Json
) {
  fun connection(): ConnectionConfig = store.read()
  fun saveConnection(config: ConnectionConfig) = store.save(config)
  fun clearConnection() = store.clear()

  suspend fun testConnection(config: ConnectionConfig): HubResult<HealthDto> = safeCall {
    val api = apiFactory.create(config)
    val health = api.health()
    require(health.ok && health.role.equals("hub", ignoreCase = true)) {
      "地址没有返回可用的 Hub。"
    }
    // /api/health is intentionally public on the Hub, so a health-only check
    // cannot prove that the saved secret can access the protected API.
    api.stats()
    val authorization = api.capabilities()
    health.copy(
      apiVersion = authorization.apiVersion ?: health.apiVersion,
      capabilities = authorization.capabilities
    )
  }
  suspend fun capabilities(): HubResult<HubAuthorizationDto> = withConnection { apiFactory.create(it).capabilities() }
  suspend fun stats(): HubResult<StatsDto> =
    withConnection { apiFactory.create(it).stats() }.mapSuccess { it.sanitizeForDisplay() }
  /**
   * [staged] asks for the first-paint summary instead of the full fleet snapshot.
   * The caller decides from the Hub's advertised capability, so an older Hub is
   * served by the unchanged `/api/stats`.
   */
  suspend fun stats(staged: Boolean): HubResult<StatsDto> =
    withConnection { apiFactory.create(it).let { api -> if (staged) api.statsSummary() else api.stats() } }
      .mapSuccess { it.sanitizeForDisplay() }
  suspend fun device(deviceId: String): HubResult<DeviceResponseDto> =
    withConnection { apiFactory.create(it).device(deviceId) }
  suspend fun sessions(period: String? = null): HubResult<SessionsResponseDto> =
    withConnection { apiFactory.create(it).sessions(period) }
  suspend fun history(deviceId: String? = null): HubResult<HistoryDto> =
    withConnection { apiFactory.create(it).history(deviceId) }
      .mapSuccess { it.sanitizeForDisplay() }

  /**
   * Conditional history read.
   *
   * [HistoryFetch.document] is null when the Hub answered `304 Not Modified`, which
   * means the caller's cached document is still current and no body crossed the
   * wire. The ETag is returned so the caller can reuse it on the next read. Kept as
   * its own method because a 304 is a success to the caller but not a 2xx, so it
   * never goes through [safeCall]'s HttpException path.
   */
  suspend fun historyIfChanged(deviceId: String? = null, etag: String?): HubResult<HistoryFetch> {
    val config = try {
      withContext(Dispatchers.IO) { connection() }
    } catch (error: CancellationException) {
      throw error
    } catch (_: Exception) {
      return HubResult.Failure(HubError("无法读取本机连接设置，请重新保存连接信息。", HubError.Kind.Api))
    }
    if (!config.isComplete) {
      return HubResult.Failure(HubError("请先在设置中保存 Hub 地址和共享密钥。", HubError.Kind.NotConfigured))
    }
    return try {
      val response = apiFactory.create(config).historyConditional(deviceId, etag)
      HubResult.Success(HistoryFetch(
        document = if (response.code() == 304) null else response.body()?.sanitizeForDisplay(),
        etag = response.headers()["etag"]
      ))
    } catch (error: HttpException) {
      val message = when (error.code()) {
        401 -> "未授权：请检查共享密钥。"
        else -> "Hub 返回 HTTP ${error.code()}。"
      }
      HubResult.Failure(HubError(message, if (error.code() == 401) HubError.Kind.Unauthorized else HubError.Kind.Api))
    } catch (_: SerializationException) {
      HubResult.Failure(HubError("Hub 返回的数据格式无法解析，请确认客户端与 Hub 版本兼容。", HubError.Kind.MalformedResponse))
    } catch (error: IOException) {
      HubResult.Failure(HubError("无法连接 Hub：${error.message ?: "网络不可用"}", HubError.Kind.Network))
    }
  }
  suspend fun devices(): HubResult<DevicesResponseDto> = withConnection { apiFactory.create(it).devices() }
  suspend fun usageRange(
    startDate: String,
    endDate: String,
    startHour: Int = 0,
    endHour: Int = 23,
    from: String? = null,
    to: String? = null
  ): HubResult<UsageRangeDto> =
    withConnection { apiFactory.create(it).usageRange(startDate, endDate, startHour, endHour, from, to) }
  suspend fun pricing(): HubResult<PricingListDto> = withConnection { apiFactory.create(it).pricing() }
  suspend fun putPricing(model: String, request: PricingRequestDto): HubResult<PricingResponseDto> = withConnection { apiFactory.create(it).putPricing(model, request) }
  suspend fun fetchUpstream(model: String): HubResult<PricingResponseDto> = withConnection { apiFactory.create(it).fetchUpstream(model) }
  suspend fun fetchAllUpstream(): HubResult<BatchPricingResponseDto> = withConnection { apiFactory.create(it).fetchAllUpstream() }

  suspend fun rates(): HubResult<RatesResponseDto> = withConnection { apiFactory.create(it).rates() }

  suspend fun accounts(): HubResult<AccountsResponseDto> = withConnection { apiFactory.create(it).accounts() }
  suspend fun addAccount(request: AccountRequestDto): HubResult<AccountsResponseDto> =
    withConnection { apiFactory.create(it).addAccount(request) }
  suspend fun patchAccount(id: String, request: AccountRequestDto): HubResult<AccountsResponseDto> =
    withConnection { apiFactory.create(it).patchAccount(id, request) }
  suspend fun deleteAccount(id: String): HubResult<AccountsResponseDto> =
    withConnection { apiFactory.create(it).deleteAccount(id) }
  suspend fun clearAccountCredential(id: String): HubResult<AccountsResponseDto> =
    withConnection { apiFactory.create(it).clearAccountCredential(id) }
  suspend fun refreshAccount(id: String): HubResult<AccountsResponseDto> =
    withConnection { apiFactory.create(it).refreshAccount(id) }
  suspend fun startOAuth(provider: String): HubResult<OAuthStartDto> =
    withConnection { apiFactory.create(it).startOAuth(mapOf("provider" to provider)) }
  suspend fun exchangeOAuth(request: OAuthExchangeRequestDto): HubResult<AccountsResponseDto> =
    withConnection { apiFactory.create(it).exchangeOAuth(request) }

  suspend fun subscriptions(): HubResult<SubscriptionsResponseDto> =
    withConnection { apiFactory.create(it).subscriptions() }
  suspend fun putSubscriptions(request: SubscriptionsRequestDto): HubResult<SubscriptionsResponseDto> =
    withConnection { apiFactory.create(it).putSubscriptions(request) }

  suspend fun renameDevice(id: String, hostname: String): HubResult<DevicesResponseDto> =
    withConnection { apiFactory.create(it).renameDevice(id, mapOf("hostname" to hostname)) }
  suspend fun deleteDevice(id: String): HubResult<DevicesResponseDto> =
    withConnection { apiFactory.create(it).deleteDevice(id) }

  fun statsEvents(): Flow<SseStatsDto> = callbackFlow {
    val config = withContext(Dispatchers.IO) { connection() }
    if (!config.isComplete) {
      close(IllegalStateException("Hub connection is not configured"))
      return@callbackFlow
    }
    val source = apiFactory.eventSource(config, apiFactory.statsRequest(config), object : EventSourceListener() {
      override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
        runCatching { json.decodeFromString<SseStatsDto>(data).sanitizeForDisplay() }
          .onSuccess { trySend(it) }
          .onFailure { close(it) }
      }

      override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
        close(t ?: IOException("SSE closed with HTTP ${response?.code ?: "unknown"}"))
      }
    })
    awaitClose { source.cancel() }
  }

  private suspend fun <T> withConnection(call: suspend (ConnectionConfig) -> T): HubResult<T> {
    val config = try {
      withContext(Dispatchers.IO) { connection() }
    } catch (error: CancellationException) {
      throw error
    } catch (_: Exception) {
      return HubResult.Failure(HubError("无法读取本机连接设置，请重新保存连接信息。", HubError.Kind.Api))
    }
    return if (!config.isComplete) HubResult.Failure(HubError("请先在设置中保存 Hub 地址和共享密钥。", HubError.Kind.NotConfigured))
    else safeCall { call(config) }
  }

  private suspend fun <T> safeCall(call: suspend () -> T): HubResult<T> = try {
    HubResult.Success(call())
  } catch (error: HttpException) {
    val message = when (error.code()) {
      401 -> "未授权：请检查共享密钥。"
      404, 422 -> "请求未完成：${error.response()?.errorBody()?.string().orEmpty().ifBlank { "模型没有可用的上游定价。" }}"
      else -> "Hub 返回 HTTP ${error.code()}。"
    }
    HubResult.Failure(HubError(message, if (error.code() == 401) HubError.Kind.Unauthorized else HubError.Kind.Api))
  } catch (_: SerializationException) {
    HubResult.Failure(HubError("Hub 返回的数据格式无法解析，请确认客户端与 Hub 版本兼容。", HubError.Kind.MalformedResponse))
  } catch (error: IOException) {
    HubResult.Failure(HubError("无法连接 Hub：${error.message ?: "网络不可用"}", HubError.Kind.Network))
  } catch (error: IllegalArgumentException) {
    HubResult.Failure(HubError(error.message ?: "Hub 地址无效。", HubError.Kind.Api))
  }
}
