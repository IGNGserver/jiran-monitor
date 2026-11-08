package com.igng.tokenmonitor.android.data.local

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.igng.tokenmonitor.android.data.remote.HubApiFactory
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

data class ConnectionConfig(
  val hubUrl: String,
  /** Legacy owner secret. Cleared once the Hub issues a device session. */
  val secret: String,
  val allowInsecureHttp: Boolean = false,
  /** Revocable per-device token; preferred over [secret] when present. */
  val sessionToken: String = ""
) {
  val credential: String get() = sessionToken.ifBlank { secret }
  val isComplete: Boolean get() = hubUrl.isNotBlank() && credential.isNotBlank()
}

interface ConnectionStorage {
  fun read(): ConnectionConfig
  fun save(config: ConnectionConfig)
  fun clear()
}

/**
 * Hub connection state, kept in [EncryptedSharedPreferences].
 *
 * `androidx.security:security-crypto` is deprecated upstream but still the only
 * shipped implementation with a Keystore-backed, key-rotating-free data store we
 * can read a live file from; replacing it is an ordered migration, not a swap.
 * `docs/design/android-credentials.md` records why, and the steps (read the legacy
 * file once, write and verify the replacement, then drop the dependency) that must
 * happen before this class changes shape.
 */
@Singleton
class ConnectionStore @Inject constructor(@ApplicationContext context: Context) : ConnectionStorage {
  // Keystore setup and the encrypted preferences file can block on cold launch.
  // Callers load the first value on Dispatchers.IO; constructing the Hilt graph must
  // not perform this work on the Activity's first frame.
  private val preferences by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
    val masterKey = MasterKey.Builder(context)
      .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
      .build()
    EncryptedSharedPreferences.create(
      context,
      "token_monitor_hub",
      masterKey,
      EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
      EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )
  }

  override fun read(): ConnectionConfig = ConnectionConfig(
    hubUrl = preferences.getString(HUB_URL, "").orEmpty(),
    secret = preferences.getString(SECRET, "").orEmpty(),
    allowInsecureHttp = preferences.getBoolean(ALLOW_INSECURE_HTTP, false),
    sessionToken = preferences.getString(SESSION_TOKEN, "").orEmpty()
  )

  override fun save(config: ConnectionConfig) {
    val hubUrl = config.hubUrl.trim().let { raw ->
      if (raw.isEmpty()) raw
      else HubApiFactory.normalizeUrl(raw).trimEnd('/')
    }
    preferences.edit()
      .putString(HUB_URL, hubUrl)
      .putString(SECRET, config.secret)
      .putString(SESSION_TOKEN, config.sessionToken)
      .putBoolean(ALLOW_INSECURE_HTTP, config.allowInsecureHttp)
      .apply()
  }

  override fun clear() = preferences.edit().clear().apply()

  private companion object {
    const val HUB_URL = "hub_url"
    const val SECRET = "hub_secret"
    const val SESSION_TOKEN = "hub_session_token"
    const val ALLOW_INSECURE_HTTP = "allow_insecure_http"
  }
}
