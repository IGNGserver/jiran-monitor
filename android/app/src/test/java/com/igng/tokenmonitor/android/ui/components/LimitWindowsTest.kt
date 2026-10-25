package com.igng.tokenmonitor.android.ui.components

import com.igng.tokenmonitor.android.data.model.LimitProviderDto
import com.igng.tokenmonitor.android.data.model.LimitWindowDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Which limit windows an account row is allowed to show.
 *
 * The row used to cut the list at three (`meterWindows.take(3)`), which silently
 * hid every further cadence an account reported — Antigravity bills several
 * models, each with a session and a weekly window. These tests pin the property
 * that the list follows the payload, and that the Antigravity grouping keeps the
 * same shape as the desktop renderer.
 *
 * Pure and Compose-free, so the JVM suite can run it (the module's test runner
 * cannot load the Compose runtime — see the note in `DisplayFx.kt`).
 */
class LimitWindowsTest {
  private fun window(
    kind: String,
    label: String? = null,
    usedPercent: Double? = 50.0,
    showMeter: Boolean = true
  ) = LimitWindowDto(
    kind = kind,
    label = label,
    usedPercent = usedPercent,
    showMeter = showMeter
  )

  private fun provider(vararg windows: LimitWindowDto) = LimitProviderDto(
    provider = "antigravity",
    accountKey = "account-1",
    windows = windows.toList()
  )

  @Test
  fun keepsEveryMeteredWindowInPayloadOrder() {
    val account = provider(
      window("session", "Gemini 3 Pro 5-hour", 10.0),
      window("weekly", "Gemini 3 Pro weekly", 20.0),
      window("session", "Claude Sonnet 5-hour", 30.0),
      window("weekly", "Claude Sonnet weekly", 40.0),
      window("billing", "Monthly", 50.0)
    )

    val windows = meteredLimitWindows(account)

    assertEquals(5, windows.size)
    assertEquals(
      listOf(
        "Gemini 3 Pro 5-hour",
        "Gemini 3 Pro weekly",
        "Claude Sonnet 5-hour",
        "Claude Sonnet weekly",
        "Monthly"
      ),
      windows.map { it.label }
    )
  }

  @Test
  fun excludesHiddenAndUnmeasuredWindows() {
    val account = provider(
      window("session", "Shown", 25.0),
      window("weekly", "Hidden", 25.0, showMeter = false),
      window("billing", "Unmeasured", usedPercent = null),
      window("named", "Also shown", 75.0)
    )

    assertEquals(listOf("Shown", "Also shown"), meteredLimitWindows(account).map { it.label })
  }

  @Test
  fun groupsAntigravityCadenceWindowsByModel() {
    val windows = listOf(
      window("session", "Gemini 3 Pro 5-hour", 10.0),
      window("weekly", "Gemini 3 Pro weekly", 20.0),
      window("session", "Claude Sonnet 5-hour", 30.0),
      window("weekly", "Claude Sonnet weekly", 40.0),
      window("named", "Credit pack", 5.0)
    )

    val grouped = groupAntigravityWindows(windows)!!

    assertEquals(listOf("Gemini 3 Pro", "Claude Sonnet"), grouped.groups.map { it.title })
    assertEquals(listOf("会话", "每周"), grouped.groups.first().items.map { it.label })
    assertEquals(2, grouped.groups.first().items.size)
    assertEquals(listOf("Credit pack"), grouped.ungrouped.map { it.label })
  }

  @Test
  fun cadenceSuffixMatchingIsCaseInsensitiveAndLeavesSingleWindowsAlone() {
    val windows = listOf(
      window("session", "Gemini 3 Pro 5-HOUR", 10.0),
      window("weekly", "Gemini 3 Pro Weekly", 20.0),
      window("session", "A plain session", 30.0)
    )

    val grouped = groupAntigravityWindows(windows)!!

    assertEquals(listOf("Gemini 3 Pro"), grouped.groups.map { it.title })
    assertEquals(listOf("A plain session"), grouped.ungrouped.map { it.label })
  }

  @Test
  fun returnsNullWhenNothingCarriesACadenceSuffix() {
    val windows = listOf(
      window("session", "Session", 10.0),
      window("billing", "Monthly", 20.0)
    )

    assertNull(groupAntigravityWindows(windows))
  }

  @Test
  fun aBareCadenceWordWithoutAModelPrefixStaysUngrouped() {
    val windows = listOf(
      window("session", "Gemini 3 Pro 5-hour", 10.0),
      window("weekly", "weekly", 20.0)
    )

    val grouped = groupAntigravityWindows(windows)!!

    assertEquals(listOf("Gemini 3 Pro"), grouped.groups.map { it.title })
    assertEquals(listOf("weekly"), grouped.ungrouped.map { it.label })
  }
}
