package com.igng.tokenmonitor.android.ui.components

import com.igng.tokenmonitor.android.data.model.SessionRowDto
import com.igng.tokenmonitor.android.ui.toSessionDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The staged `/api/sessions` row and the snapshot session row are the two sources
 * the 对话 screen folds together. The mapping has to be lossless, or a session
 * opened from the staged list renders a different cost/model split than the same
 * session rendered from a snapshot.
 *
 * Pure function, so it runs in the JVM suite: the module's Compose runtime is not
 * loadable here.
 */
class SessionRowMappingTest {
  @Test
  fun stagedRowKeepsEveryFieldTheDetailScreenReads() {
    val row = SessionRowDto(
      period = "today",
      client = "codex",
      sessionId = "session-1",
      projectId = "project-3",
      projectLabel = "Project 3",
      totalTokens = 1200,
      costUsd = 0.5,
      messageCount = 9,
      inputTokens = 600,
      outputTokens = 500,
      cacheReadTokens = 100,
      cacheWriteTokens = 0,
      reasoningTokens = 0,
      startedAt = "2026-07-18T00:00:00.000Z",
      lastUsedAt = "2026-07-18T01:00:00.000Z",
      models = mapOf("gpt-5" to 1200L),
      credits = 3.5,
      modelCredits = mapOf("gpt-5" to 3.5)
    )

    val session = row.toSessionDto()

    assertEquals("codex", session.client)
    assertEquals("session-1", session.sessionId)
    assertEquals("project-3", session.projectId)
    assertEquals("Project 3", session.projectLabel)
    assertEquals(1200L, session.totalTokens)
    assertEquals(0.5, session.costUsd, 0.0)
    assertEquals(9L, session.messageCount)
    assertEquals(100L, session.cacheReadTokens)
    assertEquals("2026-07-18T01:00:00.000Z", session.lastUsedAt)
    assertEquals(mapOf("gpt-5" to 1200L), session.models)
    assertEquals(3.5, session.credits)
    assertEquals(mapOf("gpt-5" to 3.5), session.modelCredits)
  }

  @Test
  fun aSparseStagedRowStillMapsWithoutInventingValues() {
    val session = SessionRowDto(client = "qoder", sessionId = "s-9").toSessionDto()
    assertEquals("qoder", session.client)
    assertEquals(0L, session.totalTokens)
    assertEquals(0.0, session.costUsd, 0.0)
    assertNull(session.credits)
    assertEquals(emptyMap<String, Long>(), session.models)
  }
}
