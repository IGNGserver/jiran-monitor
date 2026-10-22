package com.igng.tokenmonitor.android.ui

import android.os.Build

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.igng.tokenmonitor.android.data.local.ConnectionConfig
import com.igng.tokenmonitor.android.data.model.HealthDto
import com.igng.tokenmonitor.android.data.repository.HubRepository
import com.igng.tokenmonitor.android.data.repository.HubResult
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class ConnectionUiState(
  val hubUrl: String = "",
  val secret: String = "",
  val allowInsecureHttp: Boolean = false,
  /** Non-blank means this device already holds a revocable Hub session. */
  val sessionToken: String = "",
  val loading: Boolean = true,
  val testing: Boolean = false,
  val message: String? = null,
  val health: HealthDto? = null
) {
  val connectedWithSession: Boolean get() = sessionToken.isNotBlank()
}

@HiltViewModel
class ConnectionViewModel @Inject constructor(private val repository: HubRepository) : ViewModel() {
  private val _state = MutableStateFlow(ConnectionUiState())
  val state = _state.asStateFlow()

  init {
    viewModelScope.launch {
      try {
        val saved = withContext(Dispatchers.IO) { repository.connection() }
        _state.value = ConnectionUiState(
          hubUrl = saved.hubUrl,
          secret = saved.secret,
          allowInsecureHttp = saved.allowInsecureHttp,
          sessionToken = saved.sessionToken,
          loading = false
        )
      } catch (error: CancellationException) {
        throw error
      } catch (_: Exception) {
        _state.value = ConnectionUiState(loading = false, message = "无法读取本机连接设置，请重新保存连接信息。")
      }
    }
  }

  fun updateUrl(value: String) {
    // A device session belongs to the Hub that issued it. Changing the address
    // must not send that token to a different server.
    val nextToken = if (value.trim() == _state.value.hubUrl.trim()) _state.value.sessionToken else ""
    _state.value = _state.value.copy(hubUrl = value, sessionToken = nextToken)
  }
  fun updateSecret(value: String) { _state.value = _state.value.copy(secret = value) }
  fun updateAllowInsecureHttp(value: Boolean) { _state.value = _state.value.copy(allowInsecureHttp = value) }

  fun testConnection() = viewModelScope.launch {
    val config = ConnectionConfig(
      _state.value.hubUrl,
      _state.value.secret,
      _state.value.allowInsecureHttp,
      _state.value.sessionToken
    )
    _state.value = _state.value.copy(testing = true, message = null)
    when (val result = repository.testConnection(config)) {
      is HubResult.Success -> _state.value = _state.value.copy(testing = false, health = result.value, message = "连接成功：Hub v${result.value.version ?: "?"}")
      is HubResult.Failure -> _state.value = _state.value.copy(testing = false, message = result.error.message)
    }
  }

  fun save(onSaved: () -> Unit = {}) = viewModelScope.launch {
    val config = ConnectionConfig(
      _state.value.hubUrl,
      _state.value.secret,
      _state.value.allowInsecureHttp,
      _state.value.sessionToken
    )
    try {
      when (val result = repository.saveConnection(config, Build.MODEL.orEmpty())) {
        is HubResult.Success -> {
          val saved = withContext(Dispatchers.IO) { repository.connection() }
          _state.value = _state.value.copy(
            secret = saved.secret,
            sessionToken = saved.sessionToken,
            message = if (saved.sessionToken.isNotBlank()) {
              "连接信息已加密保存；此设备使用独立会话。"
            } else {
              "连接信息已加密保存。"
            }
          )
        }
        is HubResult.Failure -> {
          _state.value = _state.value.copy(message = result.error.message)
          return@launch
        }
      }
    } catch (error: CancellationException) {
      throw error
    } catch (_: Exception) {
      _state.value = _state.value.copy(message = "保存连接信息失败，请重试。")
      return@launch
    }
    onSaved()
  }

  fun clear(onCleared: () -> Unit = {}) = viewModelScope.launch {
    try {
      when (val result = repository.clearConnection()) {
        is HubResult.Success -> _state.value = ConnectionUiState(loading = false, message = "已清除本机保存的连接信息。")
        is HubResult.Failure -> {
          _state.value = _state.value.copy(message = result.error.message)
          return@launch
        }
      }
    } catch (error: CancellationException) {
      throw error
    } catch (_: Exception) {
      _state.value = _state.value.copy(message = "清除连接信息失败，请重试。")
      return@launch
    }
    onCleared()
  }
}
