package com.igng.tokenmonitor.android.ui.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceDetailRequestCoordinatorTest {
  @Test
  fun olderDeviceMayFillItsOwnCacheButNotTheLatestVisibleStatus() {
    val coordinator = DeviceDetailRequestCoordinator()
    val deviceA = coordinator.begin("a")
    val deviceB = coordinator.begin("b")

    assertTrue(coordinator.shouldPublishDetail(deviceA))
    assertFalse(coordinator.shouldPublishStatus(deviceA))
    assertTrue(coordinator.shouldPublishDetail(deviceB))
    assertTrue(coordinator.shouldPublishStatus(deviceB))
  }

  @Test
  fun repeatedDeviceRequestInvalidatesBothOlderDataAndStatus() {
    val coordinator = DeviceDetailRequestCoordinator()
    val first = coordinator.begin("a")
    val second = coordinator.begin("a")

    assertFalse(coordinator.shouldPublishDetail(first))
    assertFalse(coordinator.shouldPublishStatus(first))
    assertTrue(coordinator.shouldPublishDetail(second))
    assertTrue(coordinator.shouldPublishStatus(second))
  }

  @Test
  fun resetRejectsEveryInFlightStatusAndCacheWrite() {
    val coordinator = DeviceDetailRequestCoordinator()
    val request = coordinator.begin("a")
    coordinator.reset()

    assertFalse(coordinator.shouldPublishDetail(request))
    assertFalse(coordinator.shouldPublishStatus(request))
  }
}
