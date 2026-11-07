package com.igng.tokenmonitor.android.ui.analytics

import com.igng.tokenmonitor.android.data.model.PeriodDto
import com.igng.tokenmonitor.android.data.model.SessionDto
import com.igng.tokenmonitor.android.ui.NormalizedSessionRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelAnalyticsTest {
  @Test
  fun `missing model components and cost stay unknown`() {
    val rows = buildModelRows(
      PeriodDto(
        models = mapOf("known" to 1_000L, "partial" to 500L),
        modelCosts = mapOf("known" to 2.0),
        modelOutputs = mapOf("known" to 600L),
        modelCacheReads = mapOf("known" to 100L),
        modelCacheWrites = mapOf("known" to 50L)
      )
    )

    val known = rows.first { it.name == "known" }
    assertEquals(250L, known.inputTokens)
    assertEquals(2.0, known.costUsd!!, 0.0)
    val partial = rows.first { it.name == "partial" }
    assertNull(partial.inputTokens)
    assertNull(partial.outputTokens)
    assertNull(partial.costUsd)
  }

  @Test
  fun `inconsistent component arithmetic is unknown rather than clamped zero`() {
    val row = buildModelRows(
      PeriodDto(
        models = mapOf("m" to 10L),
        modelOutputs = mapOf("m" to 8L),
        modelCacheReads = mapOf("m" to 8L),
        modelCacheWrites = mapOf("m" to 8L)
      )
    ).single()
    assertNull(row.inputTokens)
  }

  @Test
  fun `session cost allocation requires an entirely absent model cost map`() {
    val sessions = listOf(
      NormalizedSessionRow(
        key = "allocated",
        period = "today",
        session = SessionDto(totalTokens = 100, costUsd = 10.0, models = mapOf("a" to 60L, "b" to 40L))
      ),
      NormalizedSessionRow(
        key = "partial",
        period = "today",
        session = SessionDto(
          totalTokens = 100,
          costUsd = 10.0,
          models = mapOf("a" to 60L, "b" to 40L),
          modelCosts = mapOf("a" to 7.0)
        )
      )
    )
    val rows = buildModelRows(PeriodDto(models = mapOf("a" to 120L, "b" to 80L)), sessions)
    val a = rows.first { it.name == "a" }
    val b = rows.first { it.name == "b" }
    assertEquals(6.0, a.sessions.first { it.key == "allocated" }.costUsd!!, 0.0)
    assertTrue(a.sessions.first { it.key == "allocated" }.costEstimated)
    assertEquals(7.0, a.sessions.first { it.key == "partial" }.costUsd!!, 0.0)
    assertFalse(a.sessions.first { it.key == "partial" }.costEstimated)
    assertEquals(4.0, b.sessions.first { it.key == "allocated" }.costUsd!!, 0.0)
    assertNull(b.sessions.first { it.key == "partial" }.costUsd)
    assertNull(a.costUsd)
    assertNull(b.costUsd)
  }

  @Test
  fun `project identity includes device and other preserves unknown components`() {
    val sessions = listOf(
      NormalizedSessionRow(
        key = "a", period = "today",
        session = SessionDto(projectId = "p", projectLabel = "Same", deviceId = "device-a", models = mapOf("m" to 10L))
      ),
      NormalizedSessionRow(
        key = "b", period = "today",
        session = SessionDto(projectId = "p", projectLabel = "Same", deviceId = "device-b", models = mapOf("m" to 20L))
      )
    )
    val rows = listOf(
      ModelAnalyticsRow("a", 10, 1.0, 1, 2, 3, 4, emptySet(), emptySet(), emptyList(), emptyList(), null),
      ModelAnalyticsRow("b", 20, null, null, null, null, null, emptySet(), emptySet(), emptyList(), emptyList(), null),
      ModelAnalyticsRow("c", 30, 2.0, 3, 4, 5, 6, emptySet(), emptySet(), emptyList(), emptyList(), null)
    )

    assertEquals(2, buildModelRows(PeriodDto(models = mapOf("m" to 30L)), sessions).single().projects.size)
    val other = topModelsWithOther(rows, 1).last()
    assertTrue(other.isOther)
    assertEquals(50L, other.tokens)
    assertNull(other.costUsd)
    assertNull(other.inputTokens)
  }
}
