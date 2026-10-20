package com.igng.tokenmonitor.android.data.remote

import com.igng.tokenmonitor.android.data.local.ConnectionConfig
import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import retrofit2.Retrofit
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class HubApiFactory private constructor(
  private val json: Json,
  private val requestTimeoutMs: Long,
  private val globalAllowInsecureHttp: Boolean,
  private val streamIdleTimeoutMs: Long
) {
  @Inject constructor(json: Json) : this(json, 20_000L, false, 90_000L)

  private data class CachedClients(
    val config: ConnectionConfig,
    val api: HubApi,
    val streamClient: OkHttpClient
  )

  @Volatile private var cached: CachedClients? = null

  // Retrofit and OkHttp are designed to be reused. Building them for every endpoint
  // discards the connection pool, so one dashboard refresh opens several fresh TLS
  // connections to the same Hub. A changed URL or secret gets a new authenticated pair.
  private fun clients(config: ConnectionConfig): CachedClients {
    cached?.takeIf { it.config == config }?.let { return it }
    return synchronized(this) {
      cached?.takeIf { it.config == config } ?: run {
        val baseUrl = checkedUrl(config.hubUrl, config.allowInsecureHttp)
        val restClient = client(config)
        val value = CachedClients(
          config,
          Retrofit.Builder()
            .baseUrl(baseUrl)
            .client(restClient)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
            .create(HubApi::class.java),
          // Hub heartbeats arrive every 15s. A finite idle read deadline detects
          // a blackholed proxy without imposing a maximum healthy stream lifetime.
          restClient.newBuilder().readTimeout(streamIdleTimeoutMs, TimeUnit.MILLISECONDS)
            .pingInterval(15_000L, TimeUnit.MILLISECONDS).build()
        )
        cached = value
        value
      }
    }
  }

  fun create(config: ConnectionConfig): HubApi = clients(config).api

  fun eventSource(config: ConnectionConfig, request: Request, listener: EventSourceListener): EventSource =
    EventSources.createFactory(clients(config).streamClient).newEventSource(request, listener)

  fun statsRequest(config: ConnectionConfig): Request = Request.Builder()
    // `detail=slim` asks for the first-paint frame. Without it the Hub keeps
    // sending the full fleet document on every ingest broadcast, which is what the
    // legacy clients need — current clients re-fetch
    // the omitted documents via the staged endpoints when its revisions move.
    .url("${checkedUrl(config.hubUrl, config.allowInsecureHttp)}api/stats/stream?detail=slim")
    .header("Accept", "text/event-stream")
    .build()

  private fun client(config: ConnectionConfig): OkHttpClient = OkHttpClient.Builder()
    .connectTimeout(requestTimeoutMs, TimeUnit.MILLISECONDS)
    .readTimeout(requestTimeoutMs, TimeUnit.MILLISECONDS)
    .addInterceptor { chain ->
      val request = chain.request().newBuilder().apply {
        if (config.secret.isNotBlank()) header("Authorization", "Bearer ${config.secret}")
      }.build()
      chain.proceed(request)
    }
    .build()

  companion object {
    /**
     * Bare host / IP / host:port → http://… for convenience.
     * Existing http(s) schemes are preserved. Always ends with '/'.
     */
    fun normalizeUrl(raw: String): String {
      val value = raw.trim()
      require(value.isNotEmpty()) { "Hub URL is required" }
      val withScheme = when {
        value.startsWith("http://", ignoreCase = true) || value.startsWith("https://", ignoreCase = true) -> value
        else -> "http://$value"
      }
      return if (withScheme.endsWith('/')) withScheme else "$withScheme/"
    }

    fun forTesting(json: Json, requestTimeoutMs: Long = 100L, streamIdleTimeoutMs: Long = 90_000L): HubApiFactory =
      HubApiFactory(json, requestTimeoutMs, true, streamIdleTimeoutMs)
  }

  private fun normalizeUrl(raw: String): String = Companion.normalizeUrl(raw)

  private fun checkedUrl(raw: String, allowInsecure: Boolean = false): String {
    val normalized = normalizeUrl(raw)
    require(globalAllowInsecureHttp || allowInsecure || normalized.startsWith("https://", ignoreCase = true)) {
      "Android 客户端只允许 HTTPS Hub；如需连接外网 HTTP 或 LAN/VPN，请在设置中勾选允许 HTTP 连接。"
    }
    return normalized
  }
}
