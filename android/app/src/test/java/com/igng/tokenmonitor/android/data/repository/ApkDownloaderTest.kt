package com.igng.tokenmonitor.android.data.repository

import com.igng.tokenmonitor.android.data.model.AppUpdateDto
import java.io.IOException
import java.security.MessageDigest
import kotlin.io.path.createTempDirectory
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ApkDownloaderTest {
  private lateinit var server: MockWebServer
  private lateinit var directory: java.io.File

  private val policy = object : DownloadUrlPolicy {
    override fun requireAllowed(raw: String): HttpUrl {
      val url = raw.toHttpUrlOrNull() ?: error("invalid test URL")
      require(url.host == server.hostName) { "unexpected test host: ${url.host}" }
      return url
    }

    override fun isAllowed(url: HttpUrl): Boolean = url.host == server.hostName
  }

  @Before
  fun setUp() {
    server = MockWebServer()
    server.start()
    directory = createTempDirectory("jiran-update-test").toFile()
  }

  @After
  fun tearDown() {
    server.shutdown()
    directory.deleteRecursively()
  }

  @Test
  fun downloadsAndVerifiesApkWhileReportingProgress() = runBlocking {
    val bytes = ByteArray(64 * 1024) { index -> (index % 251).toByte() }
    server.enqueue(MockResponse().setBody(Buffer().write(bytes)))
    val destination = directory.resolve("update.apk")
    val progress = mutableListOf<Pair<Long, Long?>>()

    val file = ApkDownloader(OkHttpClient(), policy).download(
      info = updateInfo(server.url("/apk").toString(), bytes),
      currentVersion = "1.3.0",
      destination = destination
    ) { copied, total -> progress += copied to total }

    assertEquals(destination, file)
    assertArrayEquals(bytes, destination.readBytes())
    assertEquals(bytes.size.toLong(), progress.last().first)
    assertFalse(directory.resolve("update.apk.part").exists())
  }

  @Test
  fun deletesThePartFileWhenTheDigestDoesNotMatch() {
    val bytes = ByteArray(1024) { 7 }
    server.enqueue(MockResponse().setBody(Buffer().write(bytes)))
    val destination = directory.resolve("update.apk")
    val downloader = ApkDownloader(OkHttpClient(), policy)
    val info = updateInfo(server.url("/apk").toString(), bytes).copy(sha256 = "0".repeat(64))

    val error = assertThrows(IOException::class.java) {
      runBlocking {
        downloader.download(info, "1.3.0", destination) { _, _ -> }
      }
    }
    assertTrue(error.message.orEmpty().contains("SHA-256"))
    assertFalse(destination.exists())
    assertFalse(directory.resolve("update.apk.part").exists())
  }

  @Test
  fun rejectsAnHttpFailureBeforeTouchingTheTarget() {
    server.enqueue(MockResponse().setResponseCode(500))
    val destination = directory.resolve("update.apk")
    val downloader = ApkDownloader(OkHttpClient(), policy)
    val info = updateInfo(server.url("/apk").toString(), ByteArray(1))

    assertThrows(IOException::class.java) {
      runBlocking {
        downloader.download(info, "1.3.0", destination) { _, _ -> }
      }
    }
    assertFalse(destination.exists())
    assertFalse(directory.resolve("update.apk.part").exists())
  }

  @Test
  fun rejectsADowngradeBeforeAnyNetworkRequest() {
    val downloader = ApkDownloader(OkHttpClient(), policy)
    val info = updateInfo(server.url("/apk").toString(), ByteArray(1))

    assertThrows(IllegalArgumentException::class.java) {
      runBlocking {
        downloader.download(info, "1.3.1", directory.resolve("update.apk")) { _, _ -> }
      }
    }
    assertEquals(0, server.requestCount)
  }

  @Test
  fun productionPolicyOnlyAllowsGithubOverHttps() {
    assertTrue(
      GithubDownloadUrlPolicy.isAllowed(
        "https://github.com/IGNGserver/jiran-monitor/releases/download/v1.3.1/Jiran-Android-1.3.1.apk".toHttpUrlOrNull()!!
      )
    )
    assertTrue(
      GithubDownloadUrlPolicy.isAllowed(
        "https://release-assets.githubusercontent.com/github-production-release-asset/file".toHttpUrlOrNull()!!
      )
    )
    assertFalse(
      GithubDownloadUrlPolicy.isAllowed(
        "http://github.com/IGNGserver/jiran-monitor/releases/download/v1.3.1/a.apk".toHttpUrlOrNull()!!
      )
    )
    assertFalse(
      GithubDownloadUrlPolicy.isAllowed(
        "https://evil.example/Jiran-Android-1.3.1.apk".toHttpUrlOrNull()!!
      )
    )
  }

  private fun updateInfo(assetUrl: String, bytes: ByteArray): AppUpdateDto = AppUpdateDto(
    currentVersion = "1.3.0",
    currentChannel = "test",
    available = true,
    installable = true,
    latestVersion = "1.3.1",
    latestChannel = "test",
    assetName = "Jiran-Android-1.3.1.apk",
    assetUrl = assetUrl,
    assetSize = bytes.size.toLong(),
    sha256 = MessageDigest.getInstance("SHA-256").digest(bytes)
      .joinToString("") { "%02x".format(it.toInt() and 0xff) }
  )
}
