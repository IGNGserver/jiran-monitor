package com.igng.tokenmonitor.android.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProjectVersionTest {
  @Test
  fun parsesProjectVersionsWithAndWithoutRevision() {
    assertEquals(ProjectVersion(1, 3, 1, null), ProjectVersion.parse("1.3.1"))
    assertEquals(ProjectVersion(1, 3, 1, 2), ProjectVersion.parse("1.3.1-rev.2"))
    assertEquals(ProjectVersion(1, 3, 1, null), ProjectVersion.parse("v1.3.1"))
  }

  @Test
  fun rejectsMalformedVersions() {
    assertNull(ProjectVersion.parse(null))
    assertNull(ProjectVersion.parse(""))
    assertNull(ProjectVersion.parse("1.3"))
    assertNull(ProjectVersion.parse("1.3.1-beta.1"))
    assertNull(ProjectVersion.parse("1.3.1-rev.0"))
    assertNull(ProjectVersion.parse("01.3.1"))
  }

  @Test
  fun comparesPatchAndRevisionWithGradleVersionCodeOrdering() {
    assertTrue(ProjectVersion.parse("1.3.2")!!.isNewerThan(ProjectVersion.parse("1.3.1")!!))
    assertTrue(ProjectVersion.parse("1.3.1-rev.2")!!.isNewerThan(ProjectVersion.parse("1.3.1")!!))
    assertTrue(ProjectVersion.parse("1.3.1-rev.10")!!.isNewerThan(ProjectVersion.parse("1.3.1-rev.9")!!))
    assertTrue(ProjectVersion.parse("1.3.1-rev.9")!!.isNewerThan(ProjectVersion.parse("1.3.0-rev.99")!!))
    assertFalse(ProjectVersion.parse("1.3.1")!!.isNewerThan(ProjectVersion.parse("1.3.1")!!))
    assertFalse(ProjectVersion.parse("1.3.0")!!.isNewerThan(ProjectVersion.parse("1.3.1")!!))
  }
}
