package com.igng.tokenmonitor.android.ui

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.FileProvider
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.igng.tokenmonitor.android.BuildConfig
import com.igng.tokenmonitor.android.data.model.AppUpdateDto
import com.igng.tokenmonitor.android.data.model.ProjectVersion
import com.igng.tokenmonitor.android.data.repository.AppUpdateRepository
import com.igng.tokenmonitor.android.data.repository.HubResult
import com.igng.tokenmonitor.android.ui.update.canInstallPackages
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.File
import java.io.IOException
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

data class UpdateUiState(
  val currentVersion: String = BuildConfig.VERSION_NAME,
  val channel: String = "stable",
  val checking: Boolean = false,
  val info: AppUpdateDto? = null,
  val downloading: Boolean = false,
  val downloadedBytes: Long = 0,
  val totalBytes: Long? = null,
  /**
   * The downloaded file stays addressable after the installer is launched, so a
   * user who cancels the system installer can open it again without a second
   * download. [installUri] is the one-shot hand-off consumed by the app root.
   */
  val downloadedUri: String? = null,
  val installUri: String? = null,
  val needsInstallPermission: Boolean = false,
  val message: String? = null,
  val isError: Boolean = false
) {
  val progress: Float?
    get() = totalBytes?.takeIf { it > 0 }
      ?.let { (downloadedBytes.toFloat() / it.toFloat()).coerceIn(0f, 1f) }
}

@HiltViewModel
class UpdateViewModel @Inject constructor(
  @ApplicationContext private val context: Context,
  private val updateRepository: AppUpdateRepository
) : ViewModel() {
  private val _state = MutableStateFlow(UpdateUiState(channel = updateRepository.channel()))
  val state: StateFlow<UpdateUiState> = _state.asStateFlow()
  private var downloadJob: Job? = null
  // A cancelled coroutine may still be unwinding while a new download starts;
  // only the current generation is allowed to write progress or the outcome.
  private var downloadGeneration = 0L

  init {
    checkForUpdate(manual = false)
    viewModelScope.launch(Dispatchers.IO) {
      // The download state lives only in this ViewModel, so an APK cached by a
      // previous process cannot be installed from the UI. Drop stale parts and
      // old versions without racing a download that is starting right now.
      runCatching {
        val root = File(context.cacheDir, "updates")
        val cutoff = System.currentTimeMillis() - 7L * 24 * 60 * 60 * 1000
        root.listFiles()?.forEach { file ->
          if (file.isFile && file.name.endsWith(".part")) file.delete()
          else if (file.lastModified() in 1L until cutoff) file.deleteRecursively()
        }
      }
    }
  }

  fun setChannel(channel: String) {
    if (_state.value.downloading || _state.value.checking) return
    updateRepository.setChannel(channel)
    _state.update { it.copy(channel = updateRepository.channel(), info = null, downloadedUri = null, installUri = null) }
    checkForUpdate(manual = false)
  }

  fun checkForUpdate(manual: Boolean = true) {
    val snapshot = _state.value
    if (snapshot.checking || snapshot.downloading) return
    _state.update {
      it.copy(
        checking = true,
        info = null,
        downloadedUri = null,
        installUri = null,
        needsInstallPermission = false,
        downloadedBytes = 0,
        totalBytes = null,
        message = null,
        isError = false
      )
    }
    viewModelScope.launch {
      when (val result = updateRepository.check(BuildConfig.VERSION_NAME, manual)) {
        is HubResult.Success -> applyCheckResult(result.value)
        is HubResult.Failure -> _state.update {
          it.copy(
            checking = false,
            info = null,
            message = result.error.message,
            isError = true
          )
        }
      }
    }
  }

  private fun applyCheckResult(info: AppUpdateDto) {
    val current = ProjectVersion.parse(BuildConfig.VERSION_NAME)
    val latest = ProjectVersion.parse(info.latestVersion)
    if (!info.available) {
      _state.update {
        it.copy(
          checking = false,
          info = null,
          message = if (info.message == "no_compatible_release") "当前通道暂无适用的更高版本。" else "当前已是最新版本（v${BuildConfig.VERSION_NAME}）。",
          isError = false
        )
      }
      return
    }
    if (current == null || latest == null || !latest.isNewerThan(current)) {
      _state.update {
        it.copy(
          checking = false,
          info = null,
          message = "仓库返回的更新版本无效，已忽略。",
          isError = true
        )
      }
      return
    }
    _state.update {
      it.copy(
        checking = false,
        info = info,
        // A release without an installable asset is still shown so the user can
        // open its notes; the card carries the specific reason, so a second
        // generic error line would only repeat it.
        message = if (info.installable) "发现新版本 v${info.latestVersion}。" else null,
        isError = false
      )
    }
  }

  fun downloadUpdate() {
    val snapshot = _state.value
    val info = snapshot.info ?: return
    if (snapshot.downloading || !info.installable) return
    val target = targetFile(info)
    if (target == null) {
      _state.update { it.copy(message = "更新版本号无效，无法下载。", isError = true) }
      return
    }
    _state.update {
      it.copy(
        downloading = true,
        downloadedBytes = 0,
        totalBytes = info.assetSize,
        downloadedUri = null,
        installUri = null,
        needsInstallPermission = false,
        message = null,
        isError = false
      )
    }
    val generation = ++downloadGeneration
    downloadJob = viewModelScope.launch {
      try {
        val file = updateRepository.download(
          info = info,
          currentVersion = BuildConfig.VERSION_NAME,
          destination = target
        ) { copied, total ->
          if (generation == downloadGeneration) {
            _state.update { it.copy(downloadedBytes = copied, totalBytes = total) }
          }
        }
        val packageError = verifyDownloadedApk(file, info)
        if (packageError != null) {
          file.delete()
          throw IOException(packageError)
        }
        // One downloadable version is enough; an older package must not keep
        // occupying the cache beside the verified one.
        File(context.cacheDir, "updates").listFiles()?.forEach { candidate ->
          if (candidate != file.parentFile) candidate.deleteRecursively()
        }
        val uri = FileProvider.getUriForFile(
          context,
          "${context.packageName}.fileprovider",
          file
        ).toString()
        if (generation == downloadGeneration) {
          _state.update {
            it.copy(
              downloading = false,
              downloadedUri = uri,
              installUri = uri,
              needsInstallPermission = !canInstallPackages(context),
              message = "更新包已下载并通过校验。",
              isError = false
            )
          }
        }
      } catch (error: CancellationException) {
        if (generation == downloadGeneration) {
          _state.update {
            it.copy(
              downloading = false,
              downloadedBytes = 0,
              totalBytes = null,
              message = "已取消下载。",
              isError = false
            )
          }
        }
        throw error
      } catch (error: Exception) {
        // OkHttp reports a cancelled call as an IOException. If the coroutine
        // was cancelled, that is not a download failure and must not replace the
        // "已取消下载" state with an error.
        if (generation != downloadGeneration || !currentCoroutineContext().isActive) {
          if (generation == downloadGeneration) {
            _state.update {
              it.copy(
                downloading = false,
                downloadedBytes = 0,
                totalBytes = null,
                message = "已取消下载。",
                isError = false
              )
            }
          }
          throw CancellationException("download cancelled")
        }
        _state.update {
          it.copy(
            downloading = false,
            downloadedBytes = 0,
            totalBytes = null,
            message = error.message ?: "更新下载失败，请重试。",
            isError = true
          )
        }
      }
    }
  }

  fun cancelDownload() {
    downloadGeneration += 1
    downloadJob?.cancel()
    downloadJob = null
    _state.update {
      it.copy(
        downloading = false,
        downloadedBytes = 0,
        totalBytes = null,
        message = "已取消下载。",
        isError = false
      )
    }
  }

  fun requestInstall() {
    val uri = _state.value.downloadedUri ?: return
    _state.update {
      it.copy(
        installUri = uri,
        needsInstallPermission = !canInstallPackages(context),
        message = null,
        isError = false
      )
    }
  }

  fun onInstallerLaunched() {
    _state.update {
      it.copy(
        installUri = null,
        message = "已打开系统安装器，请按系统提示完成安装。",
        isError = false
      )
    }
  }

  fun onInstallPermissionRequired() {
    _state.update {
      it.copy(
        installUri = null,
        needsInstallPermission = true,
        message = "请允许本应用安装未知应用；返回后会自动继续安装。",
        isError = false
      )
    }
  }

  fun onInstallPermissionGranted() {
    val snapshot = _state.value
    if (!snapshot.needsInstallPermission) return
    val uri = snapshot.downloadedUri ?: return
    _state.update {
      it.copy(
        needsInstallPermission = false,
        installUri = uri,
        message = null,
        isError = false
      )
    }
  }

  fun onInstallerLaunchFailed(message: String = "无法打开系统安装器，请重试。") {
    _state.update {
      it.copy(
        installUri = null,
        downloadedUri = null,
        message = message,
        isError = true
      )
    }
  }

  fun onInstallSettingsUnavailable() {
    _state.update {
      it.copy(
        message = "无法打开系统设置，请在系统设置中允许计然安装未知应用。",
        isError = true
      )
    }
  }

  private fun targetFile(info: AppUpdateDto): File? {
    val version = info.latestVersion ?: return null
    val safeVersion = version.replace(Regex("[^0-9A-Za-z._-]"), "_")
    if (safeVersion.isBlank()) return null
    return File(context.cacheDir, "updates/$safeVersion/Jiran-Android-$safeVersion.apk")
  }

  @Suppress("DEPRECATION")
  private fun verifyDownloadedApk(file: File, info: AppUpdateDto): String? {
    val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
    val archive = context.packageManager.getPackageArchiveInfo(file.absolutePath, flags)
      ?: return "无法读取更新包信息，安装已取消。"
    if (archive.packageName != context.packageName) {
      return "更新包不是计然 Android 客户端，安装已取消。"
    }
    val versionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      archive.longVersionCode
    } else {
      archive.versionCode.toLong()
    }
    if (archive.versionName != info.latestVersion) return "更新包版本与所选版本不一致，安装已取消。"
    val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) archive.signingInfo?.apkContentsSigners else archive.signatures
    if (signatures.isNullOrEmpty()) return "更新包缺少签名，安装已取消。"
    val trusted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      fun installedTrusts(signature: android.content.pm.Signature): Boolean {
        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())
        return context.packageManager.hasSigningCertificate(context.packageName, digest, PackageManager.CERT_INPUT_SHA256)
      }
      if (archive.signingInfo?.hasMultipleSigners() == true) signatures.all(::installedTrusts)
      else (archive.signingInfo?.signingCertificateHistory ?: signatures).any(::installedTrusts)
    } else {
      val installed = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES).signatures
      signatures.toSet() == installed?.toSet()
    }
    if (!trusted) return "更新包签名与当前应用不一致，安装已取消。"
    if (versionCode <= BuildConfig.VERSION_CODE.toLong()) {
      return "更新包版本不高于当前已安装版本，安装已取消。"
    }
    return null
  }
}
