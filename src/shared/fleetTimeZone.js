'use strict';

// The fleet calendar.
//
// Every device's `today` / `month` is a wall-clock window in some zone. When each
// device uses its own OS zone, a Hub aggregate sums differently-aligned windows:
// a UTC-8 device's local midnight lands at 16:00 in a UTC+8 fleet, so the whole
// device-day leaves the aggregate at that instant even though the fleet's day is
// still open (and before it, the previous device-day over-counted). A configured
// fleet timezone makes every syncing device bucket its windows into one calendar,
// so all `periodWindows.endsAt` values coincide and the aggregate only steps at
// the fleet's midnight.
//
// The Hub owns the setting and advertises it (health, ingest responses, stats);
// a device learns it from the Hub and remembers it in this shared state file.
// `TOKEN_MONITOR_FLEET_TIMEZONE` (fed by the `JIRAN_` alias) is the operator
// override and the only way to pre-seed a device before its first Hub contact.
// An unset setting is deliberately inert: every existing fleet keeps its current
// per-device calendars until the operator opts in.

const fs = require('node:fs');
const path = require('node:path');
const { readJson, sharedDataDir, writeJsonAtomic } = require('./config');

const ZONE_MAX_LENGTH = 128;
const DAY_MS = 24 * 60 * 60 * 1000;
// A zone day can be 23-25 hours long (DST), and a date can even be skipped
// (Pacific/Apia 2011). A day boundary is therefore always inside this bound.
const MAX_DAY_SPAN_MS = 26 * 60 * 60 * 1000;
const MAX_MONTH_SPAN_MS = 32 * DAY_MS;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Modern V8 resolves fixed-offset strings like `+09:00` through Intl, but a
// pinned offset cannot follow DST and would drift off local midnight twice a
// year. Only named zones are accepted; `Etc/GMT+8` is a real IANA name, so the
// bare-offset shape is matched explicitly rather than any string containing +.
const FIXED_OFFSET_RE = /^[+-]|^(?:UTC|GMT)[+-]/i;

const formatterCache = new Map();

function isValidTimeZone(value) {
  const zone = String(value || '').trim().slice(0, ZONE_MAX_LENGTH);
  if (!zone || FIXED_OFFSET_RE.test(zone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0);
    return true;
  } catch (_) {
    return false;
  }
}

// A zone the tz database knows, or ''. Fixed offsets are rejected by Intl and by
// this project on purpose: an offset cannot follow DST, so it would drift off
// local midnight twice a year.
function normalizeTimeZone(value) {
  const zone = String(value || '').trim().slice(0, ZONE_MAX_LENGTH);
  return isValidTimeZone(zone) ? zone : '';
}

// This machine's zone, best effort. Used only to name the default calendar when
// nothing else is configured.
function hostTimeZone() {
  try {
    return normalizeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch (_) {
    return '';
  }
}

function zonedFormatter(zone) {
  let formatter = formatterCache.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    formatterCache.set(zone, formatter);
  }
  return formatter;
}

function zonedParts(date, zone) {
  const parts = zonedFormatter(zone).formatToParts(date);
  const fields = {};
  for (const part of parts) {
    if (part.type !== 'literal') fields[part.type] = part.value;
  }
  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour),
    minute: Number(fields.minute),
    second: Number(fields.second)
  };
}

function pad(value, width) {
  return String(value).padStart(width, '0');
}

function hostDayKey(date = new Date()) {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

function hostMonthKey(date = new Date()) {
  return hostDayKey(date).slice(0, 7);
}

// The `YYYY-MM-DD` day this instant falls in, in `zone`. An empty zone means the
// machine's own calendar, which is the pre-fleet behaviour.
function dayKeyOf(date, zone = '') {
  if (!zone) return hostDayKey(date);
  const { year, month, day } = zonedParts(date, zone);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function monthKeyOf(date, zone = '') {
  return dayKeyOf(date, zone).slice(0, 7);
}

// Calendar-day arithmetic on a `YYYY-MM-DD` key. UTC math on purpose: the key
// already names a calendar day, so there is no zone to re-apply.
function dayKeyAddDays(key, delta) {
  const ms = Date.parse(`${String(key || '').slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + delta * DAY_MS).toISOString().slice(0, 10);
}

// The first instant in (fromMs, fromMs + bound] whose `keyOf` differs from
// `currentKey`.
//
// Zone day/month keys advance monotonically in practice, so a binary search over
// the bound finds the boundary to the second. The one theoretical exception is a
// fall-back transition that crosses local midnight (some zones historically moved
// the clock at 00:00): the key then dips back into the previous date for the
// transition length, which can shift the reported boundary by that length. The
// alternative - offset arithmetic on wall midnight - is wrong for skipped dates
// (Pacific/Apia) and missing midnights, which are just as rare; this is the
// simpler of two bounded approximations and it is exact for every zone whose
// transitions do not straddle midnight.
function firstKeyChangeMs(currentKey, fromMs, keyOf, boundMs) {
  let lo = fromMs;
  let hi = fromMs + boundMs;
  // Guard: if even the far bound still reports the current key (a zone that
  // somehow stopped advancing), return the bound rather than an unbounded loop.
  if (keyOf(hi) === currentKey) return hi;
  while (lo + 1 < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (keyOf(mid) === currentKey) lo = mid;
    else hi = mid;
  }
  return hi;
}

function nextDayStartMs(dayKey, fromMs, zone) {
  return firstKeyChangeMs(dayKey, fromMs, (ms) => dayKeyOf(new Date(ms), zone), MAX_DAY_SPAN_MS);
}

function nextMonthStartMs(monthKey, fromMs, zone) {
  return firstKeyChangeMs(monthKey, fromMs, (ms) => monthKeyOf(new Date(ms), zone), MAX_MONTH_SPAN_MS);
}

// The first instant of the zone day containing `referenceMs`. Derived as the
// boundary out of the previous calendar day, which is exact for every zone whose
// transitions do not straddle midnight. A skipped previous date (Pacific/Apia)
// cannot name that boundary, so the fallback is the earliest instant any zone's
// UTC+14 day could start - deliberately conservative, because callers use this
// only as a lower bound for a row scan and then filter by day key exactly.
function startOfDayMs(referenceMs, zone = '') {
  const dayKey = dayKeyOf(new Date(referenceMs), zone);
  const prevKey = dayKeyAddDays(dayKey, -1);
  // The previous calendar day started between 23h and 25h before this one, and
  // this one started at most 25h before `referenceMs`, so 26h back is always
  // inside the previous day - a valid `prevKey` bracket for the search.
  const fromMs = referenceMs - MAX_DAY_SPAN_MS;
  const boundary = firstKeyChangeMs(
    prevKey,
    fromMs,
    (ms) => dayKeyOf(new Date(ms), zone),
    MAX_DAY_SPAN_MS * 2
  );
  if (dayKeyOf(new Date(boundary), zone) === dayKey) return boundary;
  return Date.parse(`${dayKey}T00:00:00.000Z`) - 14 * 60 * 60 * 1000;
}

// today/month windows for a device snapshot, bucketed in `zone`.
//
// `key` is the zone-local day/month and `endsAt` the UTC instant the window
// closes. The Hub expires a frozen snapshot with `nowMs >= endsAt`, so aligned
// zones make every device expire together. The timeZone field is the wire's
// self-description (normalizePeriodWindows validates it) and is what lets a
// consumer tell a fleet-calendar record from a legacy device-local one.
function computePeriodWindows(now = new Date(), timeZone = '') {
  const zone = normalizeTimeZone(timeZone);
  if (!zone) {
    const startOfNextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
    const localZone = hostTimeZone();
    return {
      today: { key: hostDayKey(now), endsAt: startOfNextDay.toISOString() },
      month: { key: hostMonthKey(now), endsAt: startOfNextMonth.toISOString() },
      ...(localZone ? { timeZone: localZone } : {})
    };
  }
  const nowMs = now.getTime();
  const todayKey = dayKeyOf(now, zone);
  const monthKey = monthKeyOf(now, zone);
  return {
    today: { key: todayKey, endsAt: new Date(nextDayStartMs(todayKey, nowMs, zone)).toISOString() },
    month: { key: monthKey, endsAt: new Date(nextMonthStartMs(monthKey, nowMs, zone)).toISOString() },
    timeZone: zone
  };
}

function fleetTimeZoneStatePath(options = {}) {
  return options.path || path.join(sharedDataDir(options), 'fleet-time-zone.json');
}

function normalizeFleetTimeZoneState(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    version: 1,
    learnedTimeZone: normalizeTimeZone(source.learnedTimeZone),
    learnedAt: typeof source.learnedAt === 'string' ? source.learnedAt : ''
  };
}

function readFleetTimeZoneState(options = {}) {
  const read = options.readJson || readJson;
  return normalizeFleetTimeZoneState(read(fleetTimeZoneStatePath(options), {}));
}

function writeFleetTimeZoneState(state, options = {}) {
  const write = options.writeJsonAtomic || writeJsonAtomic;
  write(fleetTimeZoneStatePath(options), normalizeFleetTimeZoneState(state));
}

// Remember the zone a Hub advertised. Returns true only when the stored value
// actually changed, which is the signal the collector uses to run its re-key
// migration exactly once.
function learnFleetTimeZone(zone, options = {}) {
  const normalized = normalizeTimeZone(zone);
  if (!normalized) return false;
  const current = readFleetTimeZoneState(options);
  if (current.learnedTimeZone === normalized) return false;
  writeFleetTimeZoneState({
    version: 1,
    learnedTimeZone: normalized,
    learnedAt: new Date().toISOString()
  }, options);
  return true;
}

function clearFleetTimeZoneState(options = {}) {
  const unlink = options.unlinkSync || fs.unlinkSync;
  try {
    unlink(fleetTimeZoneStatePath(options));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

// Operator env override, read on the legacy slot the JIRAN_ alias folds into.
function envFleetTimeZone(env = process.env) {
  return normalizeTimeZone(env.TOKEN_MONITOR_FLEET_TIMEZONE);
}

// The zone this process should bucket in: an explicit env setting wins over what
// a Hub advertised previously.
function resolveFleetTimeZone(options = {}) {
  const env = options.env || process.env;
  const envZone = envFleetTimeZone(env);
  if (envZone) return envZone;
  const state = options.state || readFleetTimeZoneState(options);
  return normalizeTimeZone(state.learnedTimeZone);
}

module.exports = {
  DATE_KEY_RE,
  clearFleetTimeZoneState,
  computePeriodWindows,
  dayKeyAddDays,
  dayKeyOf,
  envFleetTimeZone,
  fleetTimeZoneStatePath,
  hostDayKey,
  hostMonthKey,
  hostTimeZone,
  isValidTimeZone,
  learnFleetTimeZone,
  monthKeyOf,
  nextDayStartMs,
  nextMonthStartMs,
  normalizeFleetTimeZoneState,
  normalizeTimeZone,
  readFleetTimeZoneState,
  resolveFleetTimeZone,
  startOfDayMs,
  writeFleetTimeZoneState
};
