// Calendar windows for the preset time ranges that are not periods on the wire.
//
// Day / month / total ship with every stats snapshot because the collector scans
// exactly those three windows. "Yesterday" and "this week" are calendar ranges in
// the same sense as a hand-picked custom range, so they resolve through
// /api/usage/range instead: no new wire field, no extra tokscale scan per tick, and
// the same aggregate-plus-detail semantics the range dialog already has.
//
// Bounds are whole local days. The upper bound is the last millisecond of the final
// day rather than the next midnight, because the desktop hosts read `to` as
// "include that whole hour" — midnight-to-midnight would leak the first hour of the
// following day into the total. The Hub rounds `to` down to a calendar day either way.

export const PRESET_RANGE_PERIODS = Object.freeze(['yesterday', 'week']);

/**
 * The day the 本周 window starts on: ISO 8601 Monday, on every surface and in every
 * locale.
 *
 * This is a *measurement* rule, not a display preference. `Intl.Locale#weekInfo` is
 * absent in the Chromium builds both hosts run on, so a locale-driven lookup could only
 * ever return a fallback here — while a client that *does* have CLDR data (Android,
 * Node) would compute a different span and report a different figure for the same 本周
 * label. One window, one number, so a phone and a browser are comparable. Calendar grids
 * and heatmaps are presentation and may start wherever their locale says; nothing that
 * prints a reported total reads this.
 */
export const SCOPE_WEEK_FIRST_DAY_INDEX = 1;

export function isPresetRangePeriod(period) {
  return PRESET_RANGE_PERIODS.includes(String(period || ''));
}

function pad(value) {
  return String(value).padStart(2, '0');
}

export function localDayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// Date's day overflow handles month/year boundaries and DST: adding 1 to the 31st
// rolls over, and a 23- or 25-hour day still lands on the next calendar date.
function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

// --- Fleet calendar -------------------------------------------------------
//
// When the Hub reports a fleet timezone, the reported day/month totals are keyed
// by *that* calendar, not the viewer's. The preset windows must therefore be
// computed in it too, or 昨日/本周 ask for a different window than the numbers
// answer. The renderer cannot import the Node-side fleetTimeZone module
// (CommonJS + node:fs), so this is the browser host's one copy of the zone math.
//
// Keys are calendar strings, so weekday arithmetic is zone-independent; only the
// instant bounds need the zone's UTC offset, computed through Intl (browsers do
// not expose the offset directly) with an iterative correction that lands on the
// real wall time for every zone whose transitions do not straddle midnight.

function addDaysToKey(key, days) {
  const ms = Date.parse(`${String(key || '').slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function isValidTimeZone(value) {
  const zone = String(value || '').trim();
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch (_) {
    return false;
  }
}

export function zonedDayKey(date, timeZone) {
  if (!timeZone) return localDayKey(date);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const read = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${read('year')}-${read('month')}-${read('day')}`;
}

function zoneOffsetMs(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(new Date(ms));
  const read = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  const asUtc = Date.UTC(read('year'), read('month') - 1, read('day'), read('hour'), read('minute'), read('second'));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

function zonedWallTimeMs(dayKey, hour, minute, second, millisecond, timeZone) {
  const [year, month, day] = String(dayKey).split('-').map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  let guess = wall;
  for (let index = 0; index < 3; index += 1) {
    const next = wall - zoneOffsetMs(guess, timeZone);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

export function zonedDayStartMs(dayKey, timeZone) {
  if (!timeZone) {
    const [year, month, day] = String(dayKey).split('-').map(Number);
    return new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
  }
  return zonedWallTimeMs(dayKey, 0, 0, 0, 0, timeZone);
}

function zonedDayEndMs(dayKey, timeZone) {
  if (!timeZone) {
    const [year, month, day] = String(dayKey).split('-').map(Number);
    return new Date(year, month - 1, day, 23, 59, 59, 999).getTime();
  }
  return zonedWallTimeMs(addDaysToKey(dayKey, 1), 0, 0, 0, 0, timeZone) - 1;
}

function weekdayOfKey(key) {
  return new Date(`${String(key).slice(0, 10)}T00:00:00.000Z`).getUTCDay();
}

function weekStartKey(dayKey, firstDayIndex = SCOPE_WEEK_FIRST_DAY_INDEX) {
  const back = (weekdayOfKey(dayKey) - firstDayIndex + 7) % 7;
  return addDaysToKey(dayKey, -back);
}

/**
 * The day the scope bar's 本周 window starts on.
 *
 * A function rather than a bare read of [SCOPE_WEEK_FIRST_DAY_INDEX] so the shape stays
 * familiar to call sites, but it takes no locale: the argument was only ever a fallback
 * lookup here, and letting a host's CLDR data move the window would give the same label a
 * different span on a different device.
 */
export function firstDayOfWeekIndex() {
  return SCOPE_WEEK_FIRST_DAY_INDEX;
}

export function weekStart(date = new Date(), firstDayIndex = SCOPE_WEEK_FIRST_DAY_INDEX) {
  const day = startOfDay(date);
  const back = (day.getDay() - firstDayIndex + 7) % 7;
  return addDays(day, -back);
}

/**
 * @returns {{period: string, startDate: string, endDate: string, from: Date, to: Date}|null}
 *   the inclusive calendar days plus the request bounds, or null for a period that
 *   is not a preset range (those come from the snapshot's `periods`).
 *
 * `timeZone` is the Hub's fleet calendar when one is configured. An empty zone
 * keeps the viewer's own calendar, which is the local-mode behaviour.
 */
export function presetRangeWindow(period, now = new Date(), timeZone = '') {
  const name = String(period || '');
  if (!isPresetRangePeriod(name)) return null;
  // A malformed zone (a legacy caller passing a locale, a corrupted stats field)
  // must degrade to the viewer's calendar, never throw the renderer down.
  const zone = isValidTimeZone(timeZone) ? String(timeZone).trim() : '';
  if (zone) {
    const todayKey = zonedDayKey(now, zone);
    const first = name === 'yesterday' ? addDaysToKey(todayKey, -1) : weekStartKey(todayKey);
    const last = name === 'yesterday' ? first : todayKey;
    return {
      period: name,
      startDate: first,
      endDate: last,
      from: new Date(zonedDayStartMs(first, zone)),
      to: new Date(zonedDayEndMs(last, zone))
    };
  }
  const today = startOfDay(now);
  // Yesterday is a closed window; the current week always runs up to today.
  const first = name === 'yesterday' ? addDays(today, -1) : weekStart(today);
  const last = name === 'yesterday' ? first : today;
  return {
    period: name,
    startDate: localDayKey(first),
    endDate: localDayKey(last),
    from: first,
    to: endOfDay(last)
  };
}

/** True while a fetched window still answers the same question it was asked for. */
export function presetRangeWindowMatches(expected, active) {
  if (!expected || !active) return false;
  return active.kind === expected.period
    && active.startDate === expected.startDate
    && active.endDate === expected.endDate;
}

/**
 * True when a fetched range answer belongs to the scope tab that is being rendered.
 *
 * A range answer belongs to exactly one selection: the preset that asked for it, or the
 * transient "custom" chip a hand-picked range occupies. Everything else — including the
 * same preset from before midnight — is another tab's number, and rendering it under the
 * current label reports a measurement the user never asked for. This is the predicate the
 * scope chip already uses to pick what to highlight (`rangeKind === 'custom' ? 'custom' :
 * period`), so the highlighted tab and the figure on screen are decided by one rule.
 */
export function isRangeScopeSelection({ period, customRange } = {}) {
  const kind = String(customRange?.kind || '');
  if (!kind) return false;
  if (kind === 'custom') return true;
  return isPresetRangePeriod(kind) && kind === String(period || '');
}

/**
 * Resolve a scope tab to the period it may render.
 *
 * `periods` carries the three windows the collector scans; a preset or picked range is
 * answered by `customPeriod`. When the selection asks for a range the host does not have
 * (loading, failed, or stale after midnight) this returns `null` rather than substituting
 * a snapshot period — the caller renders a loading or retry affordance instead of a
 * number it never obtained.
 */
export function resolveScopePeriod({ period, customRange, customPeriod, periods } = {}) {
  if (customPeriod && isRangeScopeSelection({ period, customRange })) return customPeriod;
  if (isPresetRangePeriod(period)) return null;
  return periods?.[String(period || '')] || null;
}
