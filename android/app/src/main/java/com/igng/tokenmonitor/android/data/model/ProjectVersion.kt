package com.igng.tokenmonitor.android.data.model

/**
 * The project version scheme shared with the Hub and the release pipeline:
 * `<major>.<minor>.<patch>` with an optional local `-rev.<n>` suffix.
 *
 * The Hub already selects the release; the client re-parses it so a malformed
 * or downgrade answer cannot be turned into an installer intent.
 */
data class ProjectVersion(
  val major: Long,
  val minor: Long,
  val patch: Long,
  val revision: Long?
) : Comparable<ProjectVersion> {
  override fun compareTo(other: ProjectVersion): Int {
    if (major != other.major) return major.compareTo(other.major)
    if (minor != other.minor) return minor.compareTo(other.minor)
    if (patch != other.patch) return patch.compareTo(other.patch)
    return (revision ?: 0L).compareTo(other.revision ?: 0L)
  }

  fun isNewerThan(other: ProjectVersion): Boolean = compareTo(other) > 0

  companion object {
    private val pattern = Regex(
      "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-rev\\.([1-9]\\d*))?$"
    )

    fun parse(value: String?): ProjectVersion? {
      val normalized = value?.trim()?.replaceFirst(Regex("^v", RegexOption.IGNORE_CASE), "")
        ?: return null
      val match = pattern.matchEntire(normalized) ?: return null
      val major = match.groupValues[1].toLongOrNull() ?: return null
      val minor = match.groupValues[2].toLongOrNull() ?: return null
      val patch = match.groupValues[3].toLongOrNull() ?: return null
      val revisionText = match.groupValues[4]
      val revision = if (revisionText.isEmpty()) null else revisionText.toLongOrNull() ?: return null
      return ProjectVersion(major, minor, patch, revision)
    }
  }
}
