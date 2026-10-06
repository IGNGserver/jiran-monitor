'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  clearFleetTimeZoneState,
  computePeriodWindows,
  dayKeyAddDays,
  dayKeyOf,
  envFleetTimeZone,
  learnFleetTimeZone,
  monthKeyOf,
  nextDayStartMs,
  nextMonthStartMs,
  normalizeTimeZone,
  readFleetTimeZoneState,
  resolveFleetTimeZone,
  writeFleetTimeZoneState
} = require('../../src/shared/fleetTimeZone');

function tempStatePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiran-fleet-tz-'));
  return path.join(dir, 'fleet-time-zone.json');
}

test('normalizeTimeZone accepts IANA names and rejects offsets and unknown zones', () => {
  assert.equal(normalizeTimeZone('Asia/Shanghai'), 'Asia/Shanghai');
  assert.equal(normalizeTimeZone('  America/Los_Angeles  '), 'America/Los_Angeles');
  assert.equal(normalizeTimeZone('UTC'), 'UTC');
  assert.equal(normalizeTimeZone('+09:00'), '');
  assert.equal(normalizeTimeZone('Mars/Olympus_Mons'), '');
  assert.equal(normalizeTimeZone(''), '');
  assert.equal(normalizeTimeZone(null), '');
});

test('dayKeyOf buckets an instant in the requested zone', () => {
  // 2026-10-05 20:00 UTC is already 2026-10-06 in UTC+8 and still 2026-10-05
  // in UTC-7. This is the boundary the fleet calendar exists to unify.
  const instant = new Date('2026-10-05T20:00:00.000Z');
  assert.equal(dayKeyOf(instant, 'Asia/Shanghai'), '2026-10-06');
  assert.equal(dayKeyOf(instant, 'America/Los_Angeles'), '2026-10-05');
  assert.equal(monthKeyOf(instant, 'Asia/Shanghai'), '2026-10');
});

test('computePeriodWindows ends today at the zone midnight, not the host midnight', () => {
  // 2026-10-05 12:00 UTC = 20:00 in Shanghai; the window closes at Shanghai
  // midnight, 2026-10-05 16:00 UTC.
  const windows = computePeriodWindows(new Date('2026-10-05T12:00:00.000Z'), 'Asia/Shanghai');
  assert.equal(windows.today.key, '2026-10-05');
  assert.equal(windows.today.endsAt, '2026-10-05T16:00:00.000Z');
  assert.equal(windows.month.key, '2026-10');
  assert.equal(windows.month.endsAt, '2026-10-31T16:00:00.000Z');
  assert.equal(windows.timeZone, 'Asia/Shanghai');
});

test('computePeriodWindows handles DST day lengths exactly', () => {
  // US spring forward 2026-03-08: the local day is 23 hours, so the next
  // midnight is 07:00 UTC (PDT), not 08:00 UTC.
  const spring = computePeriodWindows(new Date('2026-03-08T09:30:00.000Z'), 'America/Los_Angeles');
  assert.equal(spring.today.key, '2026-03-08');
  assert.equal(spring.today.endsAt, '2026-03-09T07:00:00.000Z');

  // US fall back 2026-11-01: the local day is 25 hours.
  const fall = computePeriodWindows(new Date('2026-11-01T08:30:00.000Z'), 'America/Los_Angeles');
  assert.equal(fall.today.key, '2026-11-01');
  assert.equal(fall.today.endsAt, '2026-11-02T08:00:00.000Z');
});

test('computePeriodWindows wraps the month boundary in the zone calendar', () => {
  // 2026-12-31 10:00 UTC = 18:00 Shanghai: still December, ending at Shanghai
  // 2027-01-01 00:00 (2026-12-31 16:00 UTC).
  const december = computePeriodWindows(new Date('2026-12-31T10:00:00.000Z'), 'Asia/Shanghai');
  assert.equal(december.today.key, '2026-12-31');
  assert.equal(december.month.key, '2026-12');
  assert.equal(december.month.endsAt, '2026-12-31T16:00:00.000Z');

  // 20:00 UTC is already January in Shanghai.
  const january = computePeriodWindows(new Date('2026-12-31T20:00:00.000Z'), 'Asia/Shanghai');
  assert.equal(january.today.key, '2027-01-01');
  assert.equal(january.month.key, '2027-01');
  assert.equal(january.month.endsAt, '2027-01-31T16:00:00.000Z');
});

test('computePeriodWindows without a zone keeps the host calendar and stamps it', () => {
  const now = new Date(2026, 5, 27, 14, 30, 0);
  const windows = computePeriodWindows(now);
  assert.equal(windows.today.key, '2026-06-27');
  assert.equal(windows.month.key, '2026-06');
  const todayEnd = new Date(windows.today.endsAt);
  assert.equal(todayEnd.getHours(), 0);
  assert.equal(todayEnd.getDate(), 28);
  const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (hostZone) assert.equal(windows.timeZone, hostZone);
});

test('nextDayStartMs and nextMonthStartMs report the exact boundary', () => {
  const from = Date.parse('2026-10-05T12:00:00.000Z');
  assert.equal(nextDayStartMs('2026-10-05', from, 'Asia/Shanghai'), Date.parse('2026-10-05T16:00:00.000Z'));
  assert.equal(nextMonthStartMs('2026-10', from, 'Asia/Shanghai'), Date.parse('2026-10-31T16:00:00.000Z'));
});

test('dayKeyAddDays rolls calendar dates across month and year ends', () => {
  assert.equal(dayKeyAddDays('2026-12-31', 1), '2027-01-01');
  assert.equal(dayKeyAddDays('2026-03-01', -1), '2026-02-28');
  assert.equal(dayKeyAddDays('2026-10-05', 30), '2026-11-04');
});

test('learnFleetTimeZone persists the Hub zone and reports only real changes', () => {
  const statePath = tempStatePath();
  assert.equal(learnFleetTimeZone('Asia/Shanghai', { path: statePath }), true);
  assert.equal(readFleetTimeZoneState({ path: statePath }).learnedTimeZone, 'Asia/Shanghai');
  assert.equal(learnFleetTimeZone('Asia/Shanghai', { path: statePath }), false);
  assert.equal(learnFleetTimeZone('Mars/Olympus_Mons', { path: statePath }), false);
  assert.equal(readFleetTimeZoneState({ path: statePath }).learnedTimeZone, 'Asia/Shanghai');
  assert.equal(learnFleetTimeZone('America/Los_Angeles', { path: statePath }), true);
  assert.equal(readFleetTimeZoneState({ path: statePath }).learnedTimeZone, 'America/Los_Angeles');
  assert.equal(clearFleetTimeZoneState({ path: statePath }), true);
  assert.equal(readFleetTimeZoneState({ path: statePath }).learnedTimeZone, '');
});

test('resolveFleetTimeZone prefers the operator env over the learned Hub zone', () => {
  const statePath = tempStatePath();
  writeFleetTimeZoneState({ learnedTimeZone: 'America/Los_Angeles' }, { path: statePath });
  assert.equal(resolveFleetTimeZone({ path: statePath, env: {} }), 'America/Los_Angeles');
  assert.equal(
    resolveFleetTimeZone({ path: statePath, env: { TOKEN_MONITOR_FLEET_TIMEZONE: 'Asia/Shanghai' } }),
    'Asia/Shanghai'
  );
  // An invalid env value must not shadow a valid learned zone.
  assert.equal(
    resolveFleetTimeZone({ path: statePath, env: { TOKEN_MONITOR_FLEET_TIMEZONE: '+09:00' } }),
    'America/Los_Angeles'
  );
  assert.equal(envFleetTimeZone({ TOKEN_MONITOR_FLEET_TIMEZONE: 'UTC' }), 'UTC');
  assert.equal(envFleetTimeZone({}), '');
});
