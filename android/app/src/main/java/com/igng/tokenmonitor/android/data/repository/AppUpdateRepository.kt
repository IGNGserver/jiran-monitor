package com.igng.tokenmonitor.android.data.repository

import com.igng.tokenmonitor.android.data.model.AppUpdateDto
import java.io.File
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The update check goes through the Hub; the APK download deliberately does
 * **not** reuse [HubApiFactory]'s client, because that client injects the Hub's
 * bearer secret into every request and the APK comes from GitHub's CDN. The Hub
 * secret must never cross that origin.
 */
@Singleton
class AppUpdateRepository @Inject constructor(
  private val hubRepository: HubRepository
) {
  private val downloader = ApkDownloader()

  suspend fun check(currentVersion: String): HubResult<AppUpdateDto> =
    hubRepository.updateInfo(currentVersion)

  suspend fun download(
    info: AppUpdateDto,
    currentVersion: String,
    destination: File,
    onProgress: (copiedBytes: Long, totalBytes: Long?) -> Unit
  ): File = downloader.download(info, currentVersion, destination, onProgress)
}
