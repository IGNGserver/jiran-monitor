package com.igng.tokenmonitor.android.data.repository

import com.igng.tokenmonitor.android.data.model.AppUpdateDto
import com.igng.tokenmonitor.android.data.model.ProjectVersion
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request

internal const val UPDATE_FEED_URL = "https://raw.githubusercontent.com/IGNGserver/jiran-monitor/updates/updates.json"
internal const val UPDATE_REPOSITORY = "IGNGserver/jiran-monitor"
internal const val UPDATE_INTERVAL_MS = 6L * 60 * 60 * 1000
internal const val UPDATE_MANUAL_COOLDOWN_MS = 60_000L
private const val MAX_FEED_BYTES = 4 * 1024 * 1024
internal val updateJson = Json { ignoreUnknownKeys = true }

internal fun normalizeUpdateChannel(channel: String?): String =
  if (channel == "preview" || channel == "prerelease") "preview" else "stable"

@Serializable
internal data class UpdateFeedAsset(
  val name: String = "", val size: Long = 0, val browser_download_url: String = "",
  val digest: String? = null, val state: String = "", val versionCode: Long? = null
)
@Serializable
internal data class UpdateFeedRelease(
  val tag_name: String = "", val html_url: String = "", val published_at: String = "",
  val draft: Boolean = false, val prerelease: Boolean = false,
  val assets: List<UpdateFeedAsset> = emptyList()
)
@Serializable
internal data class UpdateFeed(
  val schemaVersion: Int = 0, val repository: String = "", val generatedAt: String = "",
  val releases: List<UpdateFeedRelease> = emptyList()
)
@Serializable
internal data class UpdateFeedCache(
  val payload: String? = null, val etag: String? = null, val lastAttemptAt: Long = 0,
  val nextCheckAt: Long = 0, val retryAt: Long = 0, val failures: Int = 0
)

internal fun parseUpdateFeed(text: String): UpdateFeed = updateJson.decodeFromString<UpdateFeed>(text).also {
  require(it.schemaVersion == 1 && it.repository == UPDATE_REPOSITORY && runCatching { java.time.Instant.parse(it.generatedAt) }.isSuccess) {
    "更新索引无效，请稍后重试。"
  }
}

/** Select once, preserving the legacy -rev.N ordering used by released APKs. */
internal fun selectAndroidUpdate(feed: UpdateFeed, currentVersion: String, channel: String, currentCode: Long): AppUpdateDto {
  val current = ProjectVersion.parse(currentVersion) ?: throw IOException("当前版本号无效。")
  val selectedChannel = normalizeUpdateChannel(channel)
  val eligible = feed.releases.mapNotNull { release ->
    val version = ProjectVersion.parse(release.tag_name) ?: return@mapNotNull null
    if (release.draft || (selectedChannel == "stable" && (release.prerelease || version.revision != null))) return@mapNotNull null
    val expectedPrefix = "https://github.com/$UPDATE_REPOSITORY/releases/download/${release.tag_name}/"
    val asset = release.assets.firstOrNull {
      it.name == "Jiran-Android-${release.tag_name.removePrefix("v").removePrefix("V")}.apk" && it.state == "uploaded"
        && it.size > 0 && it.browser_download_url.startsWith(expectedPrefix)
        && it.digest?.matches(Regex("sha256:[a-fA-F0-9]{64}")) == true
        && (it.versionCode == null || it.versionCode > currentCode)
    } ?: return@mapNotNull null
    Triple(version, release, asset)
  }.sortedByDescending { it.first }
  val candidate = eligible.firstOrNull { it.first > current }
  val installed = feed.releases.firstOrNull { ProjectVersion.parse(it.tag_name) == current }
  val installedChannel = if (installed?.prerelease == true || current.revision != null) "preview" else "stable"
  val base = AppUpdateDto(currentVersion = currentVersion, currentChannel = installedChannel, message = "up_to_date")
  if (candidate == null) return base.copy(message = if (eligible.isEmpty()) "no_compatible_release" else "up_to_date")
  val (_, release, asset) = candidate
  return base.copy(
    available = true, installable = true, latestVersion = release.tag_name.removePrefix("v").removePrefix("V"),
    latestChannel = if (release.prerelease || candidate.first.revision != null) "preview" else "stable",
    releaseTag = release.tag_name,
    releaseUrl = "https://github.com/$UPDATE_REPOSITORY/releases/tag/${release.tag_name}",
    notesUrl = "https://github.com/$UPDATE_REPOSITORY/releases/tag/${release.tag_name}",
    publishedAt = release.published_at, assetName = asset.name, assetUrl = asset.browser_download_url,
    assetSize = asset.size, sha256 = asset.digest!!.removePrefix("sha256:"), message = "update_available"
  )
}

/** Device-local HTTP state; no Hub client, credentials, or GitHub REST API. */
internal class RepositoryUpdateFeed(
  private val readCache: () -> UpdateFeedCache,
  private val writeCache: (UpdateFeedCache) -> Unit,
  private val client: OkHttpClient = OkHttpClient.Builder().callTimeout(15, java.util.concurrent.TimeUnit.SECONDS).build(),
  private val url: String = UPDATE_FEED_URL,
  private val now: () -> Long = System::currentTimeMillis,
  private val jitter: () -> Long = { kotlin.random.Random.nextLong(30 * 60 * 1000) }
) {
  private val mutex = Mutex()
  suspend fun load(manual: Boolean): UpdateFeed = withContext(Dispatchers.IO) {
    mutex.withLock {
      val cache = readCache()
      val cached = cache.payload?.let { runCatching { parseUpdateFeed(it) }.getOrNull() }
      val time = now()
      val blockedUntil = maxOf(cache.retryAt, cache.lastAttemptAt + UPDATE_MANUAL_COOLDOWN_MS)
      if (time < blockedUntil) {
        if (cached != null && time >= cache.retryAt) return@withLock cached
        throw IOException("更新检查暂时冷却，请于 ${java.util.Date(blockedUntil)} 后重试。")
      }
      if (!manual && cached != null && time < cache.nextCheckAt) return@withLock cached
      val attempted = cache.copy(lastAttemptAt = time)
      writeCache(attempted)
      var serverWait = 0L
      try {
        val request = Request.Builder().url(url).header("Accept", "application/json").apply {
          if (cached != null) cache.etag?.let { header("If-None-Match", it) }
        }.build()
        client.newCall(request).execute().use { response ->
          serverWait = retryDelay(response.header("Retry-After"), response.header("X-RateLimit-Reset"), time)
          if (response.code != 304 && !response.isSuccessful) throw IOException("更新源返回 HTTP ${response.code}，请稍后重试。")
          val text = if (response.code == 304) cache.payload ?: throw IOException("更新缓存缺失。") else {
            val body = response.body ?: throw IOException("更新索引为空。")
            require(body.contentLength() <= MAX_FEED_BYTES) { "更新索引过大。" }
            body.byteStream().use { input ->
              val output = ByteArrayOutputStream()
              val buffer = ByteArray(16384)
              while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                require(output.size() + count <= MAX_FEED_BYTES) { "更新索引过大。" }
                output.write(buffer, 0, count)
              }
              output.toString("UTF-8")
            }
          }
          val feed = parseUpdateFeed(text)
          writeCache(UpdateFeedCache(payload = text, etag = response.header("ETag") ?: if (response.code == 304) cache.etag else null,
            lastAttemptAt = time, nextCheckAt = now() + UPDATE_INTERVAL_MS + jitter()))
          feed
        }
      } catch (error: Exception) {
        val failures = (cache.failures + 1).coerceAtMost(10)
        val backoff = (UPDATE_MANUAL_COOLDOWN_MS * (1L shl (failures - 1))).coerceAtMost(UPDATE_INTERVAL_MS)
        writeCache(attempted.copy(failures = failures, retryAt = now() + maxOf(backoff, serverWait)))
        throw error
      }
    }
  }
}

internal fun retryDelay(retryAfter: String?, reset: String?, time: Long): Long {
  val seconds = retryAfter?.toDoubleOrNull()?.let { (it * 1000).toLong() }
  val date = if (seconds == null && retryAfter != null) runCatching {
    SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US).apply { timeZone = TimeZone.getTimeZone("GMT") }.parse(retryAfter)?.time
  }.getOrNull() else null
  return maxOf(0, seconds ?: ((date ?: time) - time), (reset?.toLongOrNull()?.times(1000) ?: time) - time)
}