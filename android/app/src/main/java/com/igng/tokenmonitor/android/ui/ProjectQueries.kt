package com.igng.tokenmonitor.android.ui

import com.igng.tokenmonitor.android.data.model.ProjectDto

enum class ProjectSort { Tokens, Cost, Name }

data class ProjectQueryRow(
  val id: String,
  val label: String,
  val tokens: Long,
  val costUsd: Double,
  val clients: Map<String, Long>
)

fun queryProjects(projects: Map<String, ProjectDto>, query: String, sort: ProjectSort): List<ProjectQueryRow> {
  val needle = query.trim().lowercase()
  val filtered = projects.map { (id, project) ->
    ProjectQueryRow(id, project.label?.takeIf { it.isNotBlank() } ?: id, project.tokens, project.costUsd, project.clients)
  }.filter {
    needle.isEmpty() || it.id.lowercase().contains(needle) || it.label.lowercase().contains(needle) ||
      it.clients.keys.any { client -> client.lowercase().contains(needle) }
  }
  return when (sort) {
    ProjectSort.Tokens -> filtered.sortedByDescending { it.tokens }
    ProjectSort.Cost -> filtered.sortedByDescending { it.costUsd }
    ProjectSort.Name -> filtered.sortedBy { it.label.lowercase() }
  }
}
