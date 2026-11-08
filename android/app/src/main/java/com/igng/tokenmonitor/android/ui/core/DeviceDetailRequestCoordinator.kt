package com.igng.tokenmonitor.android.ui.core

/**
 * Latest-request gate for keyed device details and their single visible status.
 *
 * Responses for different devices may safely populate their own cache entries, but
 * only the newest request may change the shared loading/error status. Repeating a
 * request for the same device also invalidates that device's older cache response.
 */
internal class DeviceDetailRequestCoordinator {
  internal data class Request internal constructor(
    val deviceId: String,
    internal val sequence: Long
  )

  private var nextSequence = 0L
  private var activeRequest: Request? = null
  private val latestByDevice = mutableMapOf<String, Long>()

  fun begin(deviceId: String): Request {
    val request = Request(deviceId = deviceId, sequence = ++nextSequence)
    latestByDevice[deviceId] = request.sequence
    activeRequest = request
    return request
  }

  fun shouldPublishDetail(request: Request): Boolean =
    latestByDevice[request.deviceId] == request.sequence

  fun shouldPublishStatus(request: Request): Boolean =
    activeRequest == request && shouldPublishDetail(request)

  fun reset() {
    activeRequest = null
    latestByDevice.clear()
  }
}
