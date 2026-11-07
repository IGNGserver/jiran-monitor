package com.igng.tokenmonitor.android.ui

import com.igng.tokenmonitor.android.data.model.PeriodDto
import com.igng.tokenmonitor.android.data.model.SessionDto
import com.igng.tokenmonitor.android.data.model.SessionRowDto

/** One row identity shared by the list, ranking, model attribution and detail route. */
data class NormalizedSessionRow(
  val key: String,
  val period: String,
  val session: SessionDto
)

/** DTO mapping is lossless and has no Compose/Android dependency. */
fun SessionRowDto.toSessionDto(): SessionDto = SessionDto(
  client = client,
  sessionId = sessionId,
  projectId = projectId,
  projectLabel = projectLabel,
  totalTokens = totalTokens,
  costUsd = costUsd,
  messageCount = messageCount,
  inputTokens = inputTokens,
  outputTokens = outputTokens,
  cacheReadTokens = cacheReadTokens,
  cacheWriteTokens = cacheWriteTokens,
  reasoningTokens = reasoningTokens,
  startedAt = startedAt,
  lastUsedAt = lastUsedAt,
  models = models,
  modelCosts = modelCosts,
  credits = credits,
  modelCredits = modelCredits,
  deviceId = deviceId,
  deviceName = hostname
)

/**
 * Normalize only the requested period. In particular, never fold today/month/allTime
 * maps together: they are overlapping snapshots, not three disjoint session sets.
 */
fun normalizeSessionRows(
  rows: List<SessionRowDto>,
  requestedPeriod: String
): List<NormalizedSessionRow> {
  val period = requestedPeriod.ifBlank { "today" }
  val baseKeys = rows.map { row ->
    val session = row.toSessionDto()
    val identity = session.sessionId?.trim()?.takeIf { it.isNotEmpty() }
      ?: listOf(
        session.projectId.orEmpty(), session.startedAt.orEmpty(), session.lastUsedAt.orEmpty()
      ).joinToString(":")
    row.key?.takeIf { it.isNotBlank() }
      ?: "$period|${session.deviceId.orEmpty()}:${session.client.orEmpty()}:$identity"
  }
  val occurrences = mutableMapOf<String, Int>()
  return rows.mapIndexed { index, row ->
    val base = baseKeys[index]
    val occurrence = (occurrences[base] ?: 0) + 1
    occurrences[base] = occurrence
    NormalizedSessionRow(
      key = if (occurrence == 1) base else "$base#duplicate-$occurrence",
      period = period,
      session = row.toSessionDto()
    )
  }
}

fun normalizeLegacySessionRows(period: PeriodDto?, periodName: String): List<NormalizedSessionRow> {
  val rows = period?.sessions.orEmpty().map { (fallbackId, session) ->
    SessionRowDto(
      period = periodName,
      client = session.client,
      sessionId = session.sessionId?.takeIf { it.isNotBlank() } ?: fallbackId,
      projectId = session.projectId,
      projectLabel = session.projectLabel,
      totalTokens = session.totalTokens,
      costUsd = session.costUsd,
      messageCount = session.messageCount,
      inputTokens = session.inputTokens,
      outputTokens = session.outputTokens,
      cacheReadTokens = session.cacheReadTokens,
      cacheWriteTokens = session.cacheWriteTokens,
      reasoningTokens = session.reasoningTokens,
      startedAt = session.startedAt,
      lastUsedAt = session.lastUsedAt,
      models = session.models,
      modelCosts = session.modelCosts,
      credits = session.credits,
      modelCredits = session.modelCredits,
      deviceId = session.deviceId,
      hostname = session.deviceName
    )
  }
  return normalizeSessionRows(rows, periodName)
}

/** Search and ordering operate only on loaded rows; the UI prints the server/client cap. */
enum class SessionSort { Recent, Tokens, Cost, Name }

fun querySessionRows(
  rows: List<NormalizedSessionRow>,
  query: String,
  sort: SessionSort
): List<NormalizedSessionRow> {
  val needle = query.trim().lowercase()
  val filtered = if (needle.isEmpty()) rows else rows.filter { row ->
    val s = row.session
    listOf(
      s.sessionId, s.client, s.projectLabel, s.deviceName, s.deviceId
    ).any { it?.lowercase()?.contains(needle) == true } ||
      s.models.keys.any { it.lowercase().contains(needle) }
  }
  return when (sort) {
    SessionSort.Recent -> filtered.sortedByDescending { it.session.lastUsedAt ?: it.session.startedAt ?: "" }
    SessionSort.Tokens -> filtered.sortedByDescending { it.session.totalTokens }
    SessionSort.Cost -> filtered.sortedByDescending { it.session.costUsd }
    SessionSort.Name -> filtered.sortedBy { it.session.projectLabel ?: it.session.sessionId ?: it.key }
  }
}
