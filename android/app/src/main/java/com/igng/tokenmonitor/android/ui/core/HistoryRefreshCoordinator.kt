package com.igng.tokenmonitor.android.ui.core

/**
 * Compose-free state machine for revision-driven history reads.
 *
 * A stream revision is only an observation: it becomes loaded after the matching
 * conditional request succeeds (including HTTP 304). A failed request remains
 * requested, never loaded, and is retried with bounded backoff even if the stream
 * does not advertise that revision again.
 */
internal class HistoryRefreshCoordinator(
  private val initialRetryDelayMs: Long = 1_000L,
  private val maxRetryDelayMs: Long = 30_000L
) {
  internal data class Request internal constructor(
    internal val id: Long,
    val revision: String?
  )

  internal data class Completion(
    val retryRevision: String? = null,
    val retryDelayMs: Long = 0L
  )

  init {
    require(initialRetryDelayMs > 0) { "initialRetryDelayMs must be positive" }
    require(maxRetryDelayMs >= initialRetryDelayMs) { "maxRetryDelayMs is below the initial delay" }
  }

  var observedRevision: String? = null
    private set
  var requestedRevision: String? = null
    private set
  var loadedRevision: String? = null
    private set

  private var nextRequestId = 0L
  private var activeRequest: Request? = null
  private var consecutiveFailures = 0
  private var failedRevision: String? = null
  private var retryAfterMs = 0L

  val isRefreshing: Boolean get() = activeRequest != null

  fun reset() {
    observedRevision = null
    requestedRevision = null
    loadedRevision = null
    activeRequest = null
    consecutiveFailures = 0
    failedRevision = null
    retryAfterMs = 0L
  }

  fun observe(revision: String?) {
    if (revision.isNullOrBlank() || revision == observedRevision) return
    observedRevision = revision
    // A newer revision is new evidence and may be fetched immediately. The old
    // revision's backoff must not suppress it.
    if (revision != failedRevision) retryAfterMs = 0L
  }

  /** Starts an explicit user/screen request, coalesced with any active request. */
  fun startManual(): Request? = start(revision = null)

  /** Starts the observed revision when loaded state, backoff and single-flight allow it. */
  fun startAutomatic(nowMs: Long): Request? {
    val revision = observedRevision ?: return null
    if (activeRequest != null || revision == loadedRevision) return null
    if (revision == failedRevision && nowMs < retryAfterMs) return null
    return start(revision)
  }

  private fun start(revision: String?): Request? {
    if (activeRequest != null) return null
    val request = Request(id = ++nextRequestId, revision = revision)
    activeRequest = request
    requestedRevision = revision
    return request
  }

  /**
   * Completes a request and describes the follow-up needed for the latest observation.
   * Stale completions (after reset) cannot change revisions or schedule another read.
   */
  fun complete(request: Request, succeeded: Boolean, nowMs: Long): Completion {
    if (activeRequest != request) return Completion()
    activeRequest = null

    if (succeeded) {
      // A manual request has no proof that it answered the stream's revision. An
      // automatic 200 and an automatic 304 both prove its requested revision.
      request.revision?.let { loadedRevision = it }
      consecutiveFailures = 0
      failedRevision = null
      retryAfterMs = 0L
    } else {
      consecutiveFailures += 1
      failedRevision = request.revision ?: observedRevision
      retryAfterMs = nowMs + retryDelay()
    }

    val pendingRevision = observedRevision?.takeIf { it != loadedRevision } ?: return Completion()
    val delayMs = when {
      succeeded -> 0L // A newer frame arrived while this request was in flight.
      pendingRevision != failedRevision -> 0L
      else -> (retryAfterMs - nowMs).coerceAtLeast(0L)
    }
    return Completion(retryRevision = pendingRevision, retryDelayMs = delayMs)
  }

  private fun retryDelay(): Long {
    val shift = (consecutiveFailures - 1).coerceIn(0, 20)
    return (initialRetryDelayMs * (1L shl shift)).coerceAtMost(maxRetryDelayMs)
  }
}
