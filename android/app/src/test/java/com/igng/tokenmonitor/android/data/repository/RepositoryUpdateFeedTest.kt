package com.igng.tokenmonitor.android.data.repository

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class RepositoryUpdateFeedTest {
  private fun release(version: String, preview: Boolean = false, complete: Boolean = true) = UpdateFeedRelease(
    tag_name = "v$version", prerelease = preview,
    assets = if (!complete) emptyList() else listOf(UpdateFeedAsset(
      name = "Jiran-Android-$version.apk", size = 100, state = "uploaded",
      browser_download_url = "https://github.com/$UPDATE_REPOSITORY/releases/download/v$version/Jiran-Android-$version.apk",
      digest = "sha256:" + "a".repeat(64)
    ))
  )
  private fun feed(vararg releases: UpdateFeedRelease) = UpdateFeed(1, UPDATE_REPOSITORY, "2026-10-26T00:00:00Z", releases.toList())

  @Test fun selectedChannelIsIndependentOfInstalledVersionAndNeverDowngrades() {
    val data = feed(release("1.5.0", true), release("1.4.0"))
    assertEquals("1.4.0", selectAndroidUpdate(data, "1.0.0", "stable", 1).latestVersion)
    assertEquals("1.5.0", selectAndroidUpdate(data, "1.0.0", "preview", 1).latestVersion)
    assertFalse(selectAndroidUpdate(data, "1.5.0", "stable", 1).available)
    assertEquals("preview", normalizeUpdateChannel("prerelease"))
  }

  @Test fun incompleteOrForeignPackagesCannotHideAnOlderCompatibleUpgrade() {
    val data = feed(release("1.6.0", complete = false), release("1.5.0"))
    assertEquals("1.5.0", selectAndroidUpdate(data, "1.0.0", "stable", 1).latestVersion)
    val foreign = release("1.6.0").let { it.copy(assets = it.assets.map { a -> a.copy(browser_download_url = "https://evil.example/a.apk") }) }
    assertFalse(selectAndroidUpdate(feed(foreign), "1.0.0", "preview", 1).available)
  }

  @Test fun knownAndroidVersionCodeMustAlsoIncrease() {
    val data = release("1.5.0").let { it.copy(assets = it.assets.map { a -> a.copy(versionCode = 10) }) }
    assertFalse(selectAndroidUpdate(feed(data), "1.0.0", "preview", 10).available)
    assertTrue(selectAndroidUpdate(feed(data), "1.0.0", "preview", 9).available)
  }

  @Test fun legacyRevisionOrderingMatchesReleasedApks() {
    assertEquals("0.47.0-rev.40", selectAndroidUpdate(feed(release("0.47.0-rev.40", true)), "0.47.0-rev.39", "preview", 1).latestVersion)
    assertFalse(selectAndroidUpdate(feed(release("0.47.0")), "0.47.0-rev.39", "stable", 1).available)
    assertEquals("1.5.0", selectAndroidUpdate(feed(release("1.5.0")), "0.47.0-rev.39", "stable", 1).latestVersion)
  }

  @Test fun deviceCacheSendsEtagAndCoalescesParallelChecks() = runBlocking {
    MockWebServer().use { server ->
      server.enqueue(MockResponse().setBody(updateJson.encodeToString(feed())).setHeader("ETag", "feed-1"))
      server.enqueue(MockResponse().setResponseCode(304))
      server.start()
      var state = UpdateFeedCache()
      var time = 1_000_000L
      fun reader() = RepositoryUpdateFeed({ state }, { state = it }, url = server.url("/updates.json").toString(), now = { time }, jitter = { 0 })
      val first = reader()
      listOf(async { first.load(true) }, async { first.load(true) }).awaitAll()
      assertEquals(1, server.requestCount)
      time += 60_001
      reader().load(true)
      assertEquals(2, server.requestCount)
      assertNull(server.takeRequest().getHeader("Authorization"))
      assertEquals("feed-1", server.takeRequest().getHeader("If-None-Match"))
    }
  }

  @Test fun manualChecksCannotBypassPersistedServerCooldown() = runBlocking {
    MockWebServer().use { server ->
      server.enqueue(MockResponse().setResponseCode(429).setHeader("Retry-After", "3600"))
      server.start()
      var state = UpdateFeedCache()
      var time = 1_000_000L
      fun reader() = RepositoryUpdateFeed({ state }, { state = it }, url = server.url("/updates.json").toString(), now = { time })
      assertTrue(runCatching { reader().load(true) }.isFailure)
      assertEquals(4_600_000L, state.retryAt)
      time += 61_000
      assertTrue(runCatching { reader().load(true) }.isFailure)
      assertEquals(1, server.requestCount)
    }
  }

  @Test fun invalidFeedAndMissingCached304AreErrors() {
    assertTrue(runCatching { parseUpdateFeed("{}") }.isFailure)
    assertTrue(runCatching { parseUpdateFeed(updateJson.encodeToString(feed().copy(repository = "other/repo"))) }.isFailure)
    assertEquals(120_000L, retryDelay("120", null, 1_000_000))
    assertEquals(300_000L, retryDelay(null, "1300", 1_000_000))
  }
}