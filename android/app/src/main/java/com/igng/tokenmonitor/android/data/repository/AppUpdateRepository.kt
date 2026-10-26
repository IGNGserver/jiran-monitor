package com.igng.tokenmonitor.android.data.repository

import android.content.Context
import com.igng.tokenmonitor.android.BuildConfig
import com.igng.tokenmonitor.android.data.model.AppUpdateDto
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.File
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.encodeToString

/** Both metadata and packages are fetched by this device without Hub credentials. */
@Singleton
class AppUpdateRepository @Inject constructor(@ApplicationContext context: Context) {
  private val prefs = context.getSharedPreferences("jiran_device_updates", Context.MODE_PRIVATE)
  private val downloader = ApkDownloader()
  private val feed = RepositoryUpdateFeed(
    readCache = { runCatching { updateJson.decodeFromString<UpdateFeedCache>(prefs.getString("cache", null) ?: "{}") }.getOrDefault(UpdateFeedCache()) },
    writeCache = { prefs.edit().putString("cache", updateJson.encodeToString(it)).commit() }
  )
  fun channel(): String = normalizeUpdateChannel(prefs.getString("channel", "stable"))
  fun setChannel(value: String) { prefs.edit().putString("channel", normalizeUpdateChannel(value)).apply() }

  suspend fun check(currentVersion: String, manual: Boolean = true): HubResult<AppUpdateDto> = try {
    HubResult.Success(selectAndroidUpdate(feed.load(manual), currentVersion, channel(), BuildConfig.VERSION_CODE.toLong()))
  } catch (error: CancellationException) {
    throw error
  } catch (error: Exception) {
    HubResult.Failure(HubError(error.message ?: "无法读取仓库更新索引。", HubError.Kind.Network))
  }

  suspend fun download(info: AppUpdateDto, currentVersion: String, destination: File,
    onProgress: (copiedBytes: Long, totalBytes: Long?) -> Unit): File =
    downloader.download(info, currentVersion, destination, onProgress)
}