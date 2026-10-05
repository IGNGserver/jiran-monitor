package com.igng.tokenmonitor.android.data.repository

import com.igng.tokenmonitor.android.data.local.ConnectionConfig
import com.igng.tokenmonitor.android.data.local.ConnectionStorage
import com.igng.tokenmonitor.android.data.remote.HubApiFactory
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class HubRepositoryTest {
  private lateinit var server: MockWebServer
  private lateinit var repository: HubRepository
  private lateinit var store: FakeConnectionStorage
  private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

  @Before fun setUp() {
    server = MockWebServer()
    server.start()
    store = FakeConnectionStorage(ConnectionConfig(server.url("/").toString(), "shared-secret"))
    repository = HubRepository(store, HubApiFactory.forTesting(json, 150), json)
  }

  @After fun tearDown() { server.shutdown() }

  @Test fun pricingReturnsDataFor200() = runBlocking {
    server.enqueue(MockResponse().setResponseCode(200).setBody("""{"pricing":[{"model":"gpt-5","inputPricePerMillion":1.25,"outputPricePerMillion":10,"cacheReadPricePerMillion":0.125,"cacheWritePricePerMillion":0,"source":"manual"}]}"""))

    val result = repository.pricing()

    assertTrue(result is HubResult.Success)
    assertEquals("gpt-5", (result as HubResult.Success).value.pricing.single().model)
    assertEquals("Bearer shared-secret", server.takeRequest().getHeader("Authorization"))
  }

  @Test fun apiReusesConnectionsUntilTargetOrSecretChanges() = runBlocking {
    val factory = HubApiFactory.forTesting(json)
    val first = store.read()
    val firstApi = factory.create(first)
    assertSame(firstApi, factory.create(first))

    val changed = first.copy(secret = "new-secret")
    val changedApi = factory.create(changed)
    assertNotSame(firstApi, changedApi)
    server.enqueue(MockResponse().setResponseCode(200).setBody("""{"periods":{}}"""))
    changedApi.stats()
    assertEquals("Bearer new-secret", server.takeRequest().getHeader("Authorization"))
  }

  @Test fun testConnectionVerifiesHealthAndAuthenticatedStats() = runBlocking {
    server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true,"role":"hub","version":1}"""))
    server.enqueue(MockResponse().setResponseCode(200).setBody("""{"periods":{}}"""))
    server.enqueue(MockResponse().setResponseCode(200).setBody("""{"apiVersion":3,"capabilities":{"stats":true,"usageRange":false,"pricing":false},"authenticated":true}"""))

    val result = repository.testConnection(store.read())

    assertTrue(result is HubResult.Success)
    assertEquals("hub", (result as HubResult.Success).value.role)
    assertEquals("Bearer shared-secret", server.takeRequest().getHeader("Authorization"))
    assertEquals("Bearer shared-secret", server.takeRequest().getHeader("Authorization"))
    assertEquals("Bearer shared-secret", server.takeRequest().getHeader("Authorization"))
  }

  @Test fun testConnectionRejectsASecretThatCannotReadStats() = runBlocking {
    server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true,"role":"hub"}"""))
    server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"unauthorized"}"""))

    val result = repository.testConnection(store.read())

    assertTrue(result is HubResult.Failure)
    assertEquals(HubError.Kind.Unauthorized, (result as HubResult.Failure).error.kind)
  }

  @Test fun pricingMaps401ToReadableUnauthorizedError() = runBlocking {
    server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"unauthorized"}"""))

    val result = repository.pricing()

    assertTrue(result is HubResult.Failure)
    assertEquals(HubError.Kind.Unauthorized, (result as HubResult.Failure).error.kind)
  }

  @Test fun pricingMapsTimeoutToNetworkError() = runBlocking {
    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))

    val result = repository.pricing()

    assertTrue(result is HubResult.Failure)
    assertEquals(HubError.Kind.Network, (result as HubResult.Failure).error.kind)
  }

  @Test fun pricingMapsMalformedJsonToReadableError() = runBlocking {
    server.enqueue(MockResponse().setResponseCode(200).setBody("{not-json"))

    val result = repository.pricing()

    assertTrue(result is HubResult.Failure)
    assertEquals(HubError.Kind.MalformedResponse, (result as HubResult.Failure).error.kind)
  }

  @Test fun upstream422KeepsHubFailureReason() = runBlocking {
    server.enqueue(MockResponse().setResponseCode(422).setBody("""{"error":"pricing_not_found","message":"No upstream pricing was found for missing-model"}"""))

    val result = repository.fetchUpstream("missing-model")

    assertTrue(result is HubResult.Failure)
    val error = (result as HubResult.Failure).error
    assertEquals(HubError.Kind.Api, error.kind)
    assertTrue(error.message.contains("pricing_not_found"))
  }

  @Test fun allowInsecureHttpPermitsRemoteHttpEndpoint() = runBlocking {
    val nonTestingFactory = HubApiFactory(json)
    val insecureConfig = ConnectionConfig("http://remote.host:17321", "test-secret", allowInsecureHttp = true)
    val request = nonTestingFactory.statsRequest(insecureConfig)
    assertEquals("http://remote.host:17321/api/stats/stream?detail=slim", request.url.toString())
  }

  @Test fun stagedCapabilityReadsTheSummaryEndpoint() = runBlocking {
    server.enqueue(MockResponse().setResponseCode(200).setBody("""{"periods":{"today":{"totalTokens":42}},"devices":[]}"""))

    val result = repository.stats(staged = true)

    assertTrue(result is HubResult.Success)
    assertEquals(42L, (result as HubResult.Success).value.periods.today.totalTokens)
    assertEquals("/api/stats/summary", server.takeRequest().path)
  }

  @Test fun unstagedCapabilityKeepsTheFullStatsEndpoint() = runBlocking {
    server.enqueue(MockResponse().setResponseCode(200).setBody("""{"periods":{"today":{"totalTokens":7}},"devices":[]}"""))

    val result = repository.stats(staged = false)

    assertTrue(result is HubResult.Success)
    assertEquals("/api/stats", server.takeRequest().path)
  }

  @Test fun deviceDetailReturnsTheSingleDevice() = runBlocking {
    server.enqueue(MockResponse().setResponseCode(200).setBody("""{"device":{"deviceId":"dev-a","hostname":"alpha","periods":{"today":{"totalTokens":9}}}}"""))

    val result = repository.device("dev-a")

    assertTrue(result is HubResult.Success)
    val device = (result as HubResult.Success).value.device
    assertEquals("alpha", device?.hostname)
    assertEquals(9L, device?.periods?.today?.totalTokens)
    assertEquals("/api/devices/dev-a", server.takeRequest().path)
  }

  @Test fun sessionListCarriesTotalAndRows() = runBlocking {
    server.enqueue(MockResponse().setResponseCode(200).setBody("""{"total":3,"shown":1,"sessions":[{"period":"today","client":"codex","sessionId":"s-1","totalTokens":120}]}"""))

    val result = repository.sessions()

    assertTrue(result is HubResult.Success)
    val list = (result as HubResult.Success).value
    assertEquals(3, list.total)
    assertEquals(1, list.shown)
    assertEquals("codex", list.sessions.single().client)
  }

  @Test fun conditionalHistorySendsTheValidatorAndMaps304ToNoDocument() = runBlocking {
    server.enqueue(MockResponse().setResponseCode(304))

    val result = repository.historyIfChanged(etag = "\"hist-abc\"")

    assertTrue(result is HubResult.Success)
    assertEquals(null, (result as HubResult.Success).value.document)
    assertEquals("\"hist-abc\"", server.takeRequest().getHeader("If-None-Match"))
  }

  @Test fun conditionalHistoryReturnsTheDocumentAndItsEtag() = runBlocking {
    server.enqueue(MockResponse()
      .setResponseCode(200)
      .setHeader("ETag", "\"hist-xyz\"")
      .setBody("""{"daily":[],"monthly":[],"summary":{"totalTokens":5}}"""))

    val result = repository.historyIfChanged(etag = null)

    assertTrue(result is HubResult.Success)
    val fetch = (result as HubResult.Success).value
    assertEquals("\"hist-xyz\"", fetch.etag)
    assertEquals(5.0, fetch.document?.summary?.totalTokens)
  }

  @Test fun historySanitizesLegacyTimestampKeysBeforeUiConsumption() = runBlocking {
    server.enqueue(MockResponse()
      .setResponseCode(200)
      .setBody("""{"daily":[{"date":"2026-09-30T00:00:00.000Z","tokens":1},{"date":"bad","tokens":2}],"monthly":[{"month":"2026-09-30T00:00:00.000Z","tokens":3},{"month":"bad","tokens":4}]}"""))

    val result = repository.history("dev-a")

    assertTrue(result is HubResult.Success)
    val history = (result as HubResult.Success).value
    assertEquals(listOf("2026-09-30"), history.daily.map { it.date })
    assertEquals(listOf("2026-09"), history.monthly.map { it.month })
  }

  @Test fun disallowingInsecureHttpBlocksRemoteHttpEndpoint() {
    val nonTestingFactory = HubApiFactory(json)
    val insecureConfig = ConnectionConfig("http://remote.host:17321", "test-secret", allowInsecureHttp = false)
    var thrown = false
    try {
      nonTestingFactory.statsRequest(insecureConfig)
    } catch (e: IllegalArgumentException) {
      thrown = true
      assertTrue(e.message?.contains("Android 客户端只允许 HTTPS Hub") == true)
    }
    assertTrue(thrown)
  }

  @Test fun usageRangeSendsTheCallerWindowInstants() = runBlocking {
    server.enqueue(MockResponse().setResponseCode(200).setBody("""{"startDate":"2026-10-04","endDate":"2026-10-04","totalTokens":50}"""))

    val result = repository.usageRange(
      startDate = "2026-10-04",
      endDate = "2026-10-04",
      startHour = 0,
      endHour = 23,
      from = "2026-10-03T16:00:00Z",
      to = "2026-10-04T15:59:59.999Z"
    )

    assertTrue(result is HubResult.Success)
    assertEquals(50L, (result as HubResult.Success).value.totalTokens)
    val path = server.takeRequest().path ?: ""
    assertTrue(path, path.contains("startDate=2026-10-04"))
    assertTrue(path, path.contains("from="))
    assertTrue(path, path.contains("to="))
  }

  private class FakeConnectionStorage(private var config: ConnectionConfig) : ConnectionStorage {
    override fun read(): ConnectionConfig = config
    override fun save(config: ConnectionConfig) { this.config = config }
    override fun clear() { config = ConnectionConfig("", "") }
  }
}
