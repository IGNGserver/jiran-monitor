package com.igng.tokenmonitor.android.data.repository

import com.igng.tokenmonitor.android.data.model.AppUpdateDto
import com.igng.tokenmonitor.android.data.model.ProjectVersion
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * The only hosts an update may come from: GitHub's release page and the CDN it
 * redirects downloads to. The repository index supplies the URL, but a malformed or
 * misconfigured index must not point the installer at arbitrary code.
 */
internal interface DownloadUrlPolicy {
  fun requireAllowed(raw: String): HttpUrl
  fun isAllowed(url: HttpUrl): Boolean
}

internal object GithubDownloadUrlPolicy : DownloadUrlPolicy {
  override fun requireAllowed(raw: String): HttpUrl {
    val url = raw.toHttpUrlOrNull() ?: throw IllegalArgumentException("更新包地址无效。")
    require(url.isHttps) { "更新包地址必须使用 HTTPS。" }
    require(isAllowed(url)) { "更新包地址不是受信任的 GitHub 域名。" }
    return url
  }

  override fun isAllowed(url: HttpUrl): Boolean =
    url.isHttps && (
      url.host.equals("github.com", ignoreCase = true) ||
        url.host.endsWith(".githubusercontent.com", ignoreCase = true)
      )
}

internal class ApkDownloader(
  private val client: OkHttpClient = defaultClient(),
  private val urlPolicy: DownloadUrlPolicy = GithubDownloadUrlPolicy
) {
  /**
   * Downloads [info] into [destination], hashing while writing, and returns the
   * verified file. The `.part` file is removed on failure or cancellation.
   */
  suspend fun download(
    info: AppUpdateDto,
    currentVersion: String,
    destination: File,
    onProgress: (copiedBytes: Long, totalBytes: Long?) -> Unit
  ): File = withContext(Dispatchers.IO) {
    val assetUrl = info.assetUrl?.trim().orEmpty()
    val expectedSha = info.sha256?.trim()?.lowercase().orEmpty()
    val latest = ProjectVersion.parse(info.latestVersion)
    val current = ProjectVersion.parse(currentVersion)
    require(info.installable) { "该版本缺少可用的安装包或校验信息。" }
    require(assetUrl.isNotEmpty()) { "更新包下载地址为空。" }
    require(expectedSha.matches(Regex("^[a-f0-9]{64}$"))) { "更新包校验信息不完整。" }
    require(latest != null && current != null && latest.isNewerThan(current)) {
      "更新包版本不高于当前版本，已阻止安装。"
    }

    val url = urlPolicy.requireAllowed(assetUrl)
    val parent = destination.parentFile ?: throw IOException("无法创建更新缓存目录。")
    parent.mkdirs()
    val part = File(parent, "${destination.name}.part")
    part.delete()
    parent.usableSpace.takeIf { it > 0 }?.let { usable ->
      val expectedBytes = info.assetSize ?: 0L
      if (expectedBytes > 0 && usable < expectedBytes + 8L * 1024 * 1024) {
        throw IOException("可用存储空间不足，无法下载更新包。")
      }
    }

    val request = Request.Builder()
      .url(url)
      .header("Accept", "application/octet-stream")
      .header("User-Agent", "Jiran-Android")
      .get()
      .build()
    val call = client.newCall(request)
    // Cancelling the coroutine must also unblock the socket read; closing only
    // the stream in the cancellation handler still leaves a thread waiting on
    // OkHttp until its read timeout.
    val cancelHandle = currentCoroutineContext()[Job]?.invokeOnCompletion { call.cancel() }
    var completed = false
    try {
      call.execute().use { response ->
        if (!response.isSuccessful) {
          throw IOException("下载更新失败：HTTP ${response.code}")
        }
        val finalUrl = response.request.url
        require(urlPolicy.isAllowed(finalUrl)) {
          "更新包跳转到了非 GitHub 域名，已阻止下载。"
        }
        val body = response.body ?: throw IOException("更新包响应为空。")
        val total = body.contentLength().takeIf { it > 0 }
        val digest = MessageDigest.getInstance("SHA-256")
        var copied = 0L
        body.byteStream().use { input ->
          FileOutputStream(part).use { output ->
            val buffer = ByteArray(128 * 1024)
            while (true) {
              currentCoroutineContext().ensureActive()
              val read = input.read(buffer)
              if (read < 0) break
              if (read == 0) continue
              output.write(buffer, 0, read)
              digest.update(buffer, 0, read)
              copied += read
              onProgress(copied, total)
            }
          }
        }
        if (total != null && copied != total) {
          throw IOException("下载不完整：应为 $total 字节，实际 $copied 字节。")
        }
        val actualSha = digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
        if (!actualSha.equals(expectedSha, ignoreCase = true)) {
          throw IOException("更新包 SHA-256 校验失败，已删除下载文件。")
        }
        if (destination.exists() && !destination.delete()) {
          throw IOException("无法替换旧的更新包，请重试。")
        }
        if (!part.renameTo(destination)) {
          part.copyTo(destination, overwrite = true)
          part.delete()
        }
        completed = true
        destination
      }
    } finally {
      cancelHandle?.dispose()
      if (!completed) part.delete()
    }
  }

  private companion object {
    fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
      .connectTimeout(20, TimeUnit.SECONDS)
      .readTimeout(60, TimeUnit.SECONDS)
      .followRedirects(true)
      .build()
  }
}
