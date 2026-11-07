package com.igng.tokenmonitor.android.data.model

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** The one calendar used by scope ranges, history and widget freshness. */
object FleetCalendar {
  /** An absent or malformed Hub zone deliberately retains the pre-fleet behaviour. */
  fun zone(fleetTimeZone: String?, fallback: ZoneId = ZoneId.systemDefault()): ZoneId =
    fleetTimeZone?.trim()?.takeIf { it.isNotEmpty() }?.let { raw ->
      runCatching { ZoneId.of(raw) }.getOrNull()
    } ?: fallback

  fun zoneId(fleetTimeZone: String?, fallback: ZoneId = ZoneId.systemDefault()): String =
    zone(fleetTimeZone, fallback).id

  fun today(
    fleetTimeZone: String?,
    now: Instant = Instant.now(),
    fallback: ZoneId = ZoneId.systemDefault()
  ): LocalDate = now.atZone(zone(fleetTimeZone, fallback)).toLocalDate()
}
