package com.igng.tokenmonitor.android.ui.analytics

import com.igng.tokenmonitor.android.data.model.PeriodDto
import com.igng.tokenmonitor.android.ui.NormalizedSessionRow

enum class ModelSort { Tokens, Cost, Input, Output, Name }

data class ModelSessionLink(
  val key: String,
  val label: String,
  val tokens: Long,
  val costUsd: Double?,
  val costEstimated: Boolean
)
data class ModelProjectLink(val id: String, val label: String, val tokens: Long)

data class ModelAnalyticsRow(
  val name: String,
  val tokens: Long,
  val costUsd: Double?,
  val inputTokens: Long?,
  val outputTokens: Long?,
  val cacheReadTokens: Long?,
  val cacheWriteTokens: Long?,
  val clients: Set<String>,
  val devices: Set<String>,
  val projects: List<ModelProjectLink>,
  val sessions: List<ModelSessionLink>,
  val sessionCostUsd: Double?,
  val sessionCostEstimated: Boolean = false,
  val isOther: Boolean = false
)

private fun component(
  name: String,
  period: PeriodDto,
  devicePeriods: List<Pair<String, PeriodDto>>,
  values: PeriodDto.() -> Map<String, Long>
): Long? = when {
  period.values().containsKey(name) -> period.values()[name]
  devicePeriods.any { it.second.values().containsKey(name) } ->
    devicePeriods.sumOf { it.second.values()[name] ?: 0L }
  else -> null
}

private fun sumCosts(values: List<Double?>): Double? =
  if (values.all { it != null }) values.sumOf { it ?: 0.0 } else null

fun buildModelRows(
  period: PeriodDto?,
  sessions: List<NormalizedSessionRow> = emptyList(),
  devicePeriods: List<Pair<String, PeriodDto>> = emptyList()
): List<ModelAnalyticsRow> {
  if (period == null) return emptyList()
  val names = buildSet {
    addAll(period.models.keys)
    addAll(period.modelCosts.keys)
    period.clientModels.values.forEach { addAll(it.keys) }
    devicePeriods.forEach { (_, devicePeriod) ->
      addAll(devicePeriod.models.keys)
      addAll(devicePeriod.modelCosts.keys)
    }
  }
  val sessionsByKey = sessions.associateBy { it.key }
  return names.map { name ->
    val links = sessions.mapNotNull { row ->
      val session = row.session
      val tokens = session.models[name] ?: return@mapNotNull null
      val exactCost = session.modelCosts[name]
      val allocatedCost = if (exactCost == null && session.modelCosts.isEmpty() && session.totalTokens > 0L) {
        session.costUsd * tokens.toDouble() / session.totalTokens.toDouble()
      } else null
      ModelSessionLink(
        key = row.key,
        label = session.projectLabel?.takeIf { it.isNotBlank() }
          ?: session.sessionId?.takeIf { it.isNotBlank() }
          ?: row.key,
        tokens = tokens,
        costUsd = exactCost ?: allocatedCost,
        costEstimated = exactCost == null && allocatedCost != null
      )
    }
    val projects = links.groupBy { link ->
      sessionsByKey[link.key]?.session?.let {
        val project = it.projectId ?: it.projectLabel ?: ""
        val device = it.deviceId ?: ""
        "$device:$project" to (it.projectLabel ?: it.projectId ?: "未命名项目")
      } ?: (":" to "未命名项目")
    }.map { (identity, projectLinks) ->
      ModelProjectLink(identity.first, identity.second, projectLinks.sumOf { it.tokens })
    }.sortedByDescending { it.tokens }
    val output = component(name, period, devicePeriods) { modelOutputs }
    val cacheRead = component(name, period, devicePeriods) { modelCacheReads }
    val cacheWrite = component(name, period, devicePeriods) { modelCacheWrites }
    val tokens = period.models[name] ?: devicePeriods.sumOf { it.second.models[name] ?: 0L }
    val input = if (output != null && cacheRead != null && cacheWrite != null) {
      (tokens - output - cacheRead - cacheWrite).takeIf { it >= 0L }
    } else null
    val deviceCosts = devicePeriods.map { it.second.modelCosts[name] }
    ModelAnalyticsRow(
      name = name,
      tokens = tokens,
      costUsd = period.modelCosts[name] ?: deviceCosts.takeIf { it.isNotEmpty() }?.let(::sumCosts),
      inputTokens = input,
      outputTokens = output,
      cacheReadTokens = cacheRead,
      cacheWriteTokens = cacheWrite,
      clients = period.clientModels.filterValues { name in it }.keys +
        sessions.filter { name in it.session.models }.mapNotNull { it.session.client }.toSet(),
      devices = buildSet {
        devicePeriods.forEach { (label, devicePeriod) ->
          if ((devicePeriod.models[name] ?: 0L) != 0L || devicePeriod.modelCosts.containsKey(name)) add(label)
        }
        sessions.forEach { row ->
          if (name in row.session.models) add(row.session.deviceName ?: row.session.deviceId ?: return@forEach)
        }
      },
      projects = projects,
      sessions = links.sortedByDescending { it.tokens },
      sessionCostUsd = if (links.isEmpty()) null else sumCosts(links.map { it.costUsd }),
      sessionCostEstimated = links.any { it.costEstimated }
    )
  }.sortedByDescending { it.tokens }
}

fun queryModelRows(rows: List<ModelAnalyticsRow>, query: String, sort: ModelSort): List<ModelAnalyticsRow> {
  val needle = query.trim().lowercase()
  val filtered = if (needle.isEmpty()) rows else rows.filter { row ->
    row.name.lowercase().contains(needle) || row.clients.any { it.lowercase().contains(needle) } ||
      row.devices.any { it.lowercase().contains(needle) }
  }
  return when (sort) {
    ModelSort.Tokens -> filtered.sortedByDescending { it.tokens }
    ModelSort.Cost -> filtered.sortedByDescending { it.costUsd ?: -1.0 }
    ModelSort.Input -> filtered.sortedByDescending { it.inputTokens ?: -1L }
    ModelSort.Output -> filtered.sortedByDescending { it.outputTokens ?: -1L }
    ModelSort.Name -> filtered.sortedBy { it.name.lowercase() }
  }
}

/** Keep the ranking honest: Other is a real aggregate, not a silently discarded tail. */
fun topModelsWithOther(rows: List<ModelAnalyticsRow>, limit: Int): List<ModelAnalyticsRow> {
  val safeLimit = limit.coerceAtLeast(1)
  if (rows.size <= safeLimit) return rows
  val head = rows.take(safeLimit)
  val tail = rows.drop(safeLimit)
  return head + ModelAnalyticsRow(
    name = "Other",
    tokens = tail.sumOf { it.tokens },
    costUsd = sumCosts(tail.map { it.costUsd }),
    inputTokens = if (tail.all { it.inputTokens != null }) tail.sumOf { it.inputTokens ?: 0L } else null,
    outputTokens = if (tail.all { it.outputTokens != null }) tail.sumOf { it.outputTokens ?: 0L } else null,
    cacheReadTokens = if (tail.all { it.cacheReadTokens != null }) tail.sumOf { it.cacheReadTokens ?: 0L } else null,
    cacheWriteTokens = if (tail.all { it.cacheWriteTokens != null }) tail.sumOf { it.cacheWriteTokens ?: 0L } else null,
    clients = tail.flatMap { it.clients }.toSet(),
    devices = tail.flatMap { it.devices }.toSet(),
    projects = emptyList(),
    sessions = emptyList(),
    sessionCostUsd = null,
    isOther = true
  )
}
