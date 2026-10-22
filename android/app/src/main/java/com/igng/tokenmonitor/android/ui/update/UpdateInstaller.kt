package com.igng.tokenmonitor.android.ui.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings

/** Android 8+ gates sideloading behind a per-app "install unknown apps" grant. */
fun canInstallPackages(context: Context): Boolean =
  Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
    context.packageManager.canRequestPackageInstalls()

/**
 * Opens the system package installer. The platform still asks the user to
 * confirm; this app never installs silently.
 */
fun launchApkInstaller(context: Context, uri: String): Boolean {
  val intent = Intent(Intent.ACTION_VIEW).apply {
    setDataAndType(Uri.parse(uri), "application/vnd.android.package-archive")
    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
  }
  return runCatching {
    context.startActivity(intent)
    true
  }.getOrDefault(false)
}

fun openInstallPermissionSettings(context: Context): Boolean {
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
  val appSpecific = Intent(
    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
    Uri.parse("package:${context.packageName}")
  )
  if (runCatching { context.startActivity(appSpecific); true }.getOrDefault(false)) return true
  // Some OEM settings apps do not expose the per-app screen; the global
  // security page at least tells the user where the switch lives.
  return runCatching {
    context.startActivity(Intent(Settings.ACTION_SECURITY_SETTINGS))
    true
  }.getOrDefault(false)
}
