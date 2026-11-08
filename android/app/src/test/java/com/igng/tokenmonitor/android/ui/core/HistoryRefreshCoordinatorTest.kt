package com.igng.tokenmonitor.android.ui.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HistoryRefreshCoordinatorTest {
  @Test
  fun successfulConditionalReadAdvancesOnlyTheRequestedRevision() {
    val coordinator = HistoryRefreshCoordinator()
    coordinator.observe("rev-1")

    val request = coordinator.startAutomatic(nowMs = 0)
    assertNotNull(request)
    assertEquals("rev-1", coordinator.requestedRevision)
    assertNull(coordinator.loadedRevision)
    assertNull(coordinator.startAutomatic(nowMs = 0))
    assertTrue(coordinator.isRefreshing)

    val completion = coordinator.complete(request!!, succeeded = true, nowMs = 1)
    assertEquals("rev-1", coordinator.loadedRevision)
    assertNull(completion.retryRevision)
    assertFalse(coordinator.isRefreshing)
    assertNull(coordinator.startAutomatic(nowMs = 2))
  }

  @Test
  fun transientFailureKeepsRevisionPendingAndRetriesAfterBackoff() {
    val coordinator = HistoryRefreshCoordinator(initialRetryDelayMs = 100, maxRetryDelayMs = 400)
    coordinator.observe("rev-1")
    val request = coordinator.startAutomatic(nowMs = 0)!!

    val failure = coordinator.complete(request, succeeded = false, nowMs = 10)
    assertEquals("rev-1", failure.retryRevision)
    assertEquals(100, failure.retryDelayMs)
    assertNull(coordinator.loadedRevision)
    assertNull(coordinator.startAutomatic(nowMs = 109))

    val retry = coordinator.startAutomatic(nowMs = 110)!!
    assertEquals("rev-1", retry.revision)
    val secondFailure = coordinator.complete(retry, succeeded = false, nowMs = 110)
    assertEquals(200, secondFailure.retryDelayMs)

    val third = coordinator.startAutomatic(nowMs = 310)!!
    val thirdFailure = coordinator.complete(third, succeeded = false, nowMs = 310)
    assertEquals(400, thirdFailure.retryDelayMs)
    val fourth = coordinator.startAutomatic(nowMs = 710)!!
    val fourthFailure = coordinator.complete(fourth, succeeded = false, nowMs = 710)
    assertEquals(400, fourthFailure.retryDelayMs) // Bounded, not unbounded exponential growth.

    val finalRetry = coordinator.startAutomatic(nowMs = 1_110)!!
    val success = coordinator.complete(finalRetry, succeeded = true, nowMs = 1_111)
    assertEquals("rev-1", coordinator.loadedRevision)
    assertNull(success.retryRevision)
  }

  @Test
  fun newerObservationSupersedesFailureBackoffAndInFlightSuccess() {
    val coordinator = HistoryRefreshCoordinator(initialRetryDelayMs = 1_000)
    coordinator.observe("rev-1")
    val first = coordinator.startAutomatic(nowMs = 0)!!
    coordinator.observe("rev-2")

    val failure = coordinator.complete(first, succeeded = false, nowMs = 10)
    assertEquals("rev-2", failure.retryRevision)
    assertEquals(0, failure.retryDelayMs)

    val second = coordinator.startAutomatic(nowMs = 10)!!
    coordinator.observe("rev-3")
    val success = coordinator.complete(second, succeeded = true, nowMs = 20)
    assertEquals("rev-2", coordinator.loadedRevision)
    assertEquals("rev-3", success.retryRevision)
    assertEquals(0, success.retryDelayMs)
  }

  @Test
  fun manualSuccessDoesNotClaimTheObservedRevisionWasLoaded() {
    val coordinator = HistoryRefreshCoordinator()
    coordinator.observe("rev-1")
    val manual = coordinator.startManual()!!

    val completion = coordinator.complete(manual, succeeded = true, nowMs = 0)
    assertNull(coordinator.loadedRevision)
    assertEquals("rev-1", completion.retryRevision)
    assertEquals("rev-1", coordinator.startAutomatic(nowMs = 0)?.revision)
  }

  @Test
  fun resetInvalidatesAnOldRequestsCompletion() {
    val coordinator = HistoryRefreshCoordinator()
    coordinator.observe("old-hub-rev")
    val oldRequest = coordinator.startAutomatic(nowMs = 0)!!
    coordinator.reset()
    coordinator.observe("new-hub-rev")

    val stale = coordinator.complete(oldRequest, succeeded = true, nowMs = 1)
    assertNull(stale.retryRevision)
    assertNull(coordinator.loadedRevision)
    assertEquals("new-hub-rev", coordinator.startAutomatic(nowMs = 1)?.revision)
  }
}
