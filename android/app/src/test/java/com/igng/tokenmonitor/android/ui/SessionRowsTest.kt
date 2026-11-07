package com.igng.tokenmonitor.android.ui

import com.igng.tokenmonitor.android.data.model.SessionRowDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionRowsTest {
  @Test
  fun `session identity includes device and client when server key is absent`() {
    val rows = normalizeSessionRows(
      listOf(
        SessionRowDto(deviceId = "device-a", client = "codex", sessionId = "same"),
        SessionRowDto(deviceId = "device-b", client = "codex", sessionId = "same"),
        SessionRowDto(deviceId = "device-a", client = "claude", sessionId = "same")
      ),
      "today"
    )
    assertEquals(3, rows.map { it.key }.toSet().size)
    assertNotEquals(rows[0].key, rows[1].key)
    assertNotEquals(rows[0].key, rows[2].key)
  }

  @Test
  fun `server key wins and actual aggregate fields map without inventing data`() {
    val row = normalizeSessionRows(
      listOf(
        SessionRowDto(
          key = "server-key",
          deviceId = "device-a",
          hostname = "workstation",
          sessionId = "s",
          modelCosts = mapOf("m" to 1.25),
          inputTokens = null
        )
      ),
      "today"
    ).single()
    assertEquals("server-key", row.key)
    assertEquals("workstation", row.session.deviceName)
    assertEquals("device-a", row.session.deviceId)
    assertEquals(1.25, row.session.modelCosts["m"]!!, 0.0)
    assertNull(row.session.inputTokens)
  }
}
