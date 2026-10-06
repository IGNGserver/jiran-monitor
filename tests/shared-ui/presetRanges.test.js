'use strict';

// The calendar presets are computed in the browser and answered by the range API,
// so their date math is the whole feature: a window that is off by one day, or an
// upper bound that leaks the next day's first hour into the total, is a wrong number
// on screen rather than a visible crash.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  PRESET_RANGE_PERIODS,
  SCOPE_WEEK_FIRST_DAY_INDEX,
  firstDayOfWeekIndex,
  isPresetRangePeriod,
  isRangeScopeSelection,
  localDayKey,
  presetRangeWindow,
  presetRangeWindowMatches,
  resolveScopePeriod,
  weekStart
} = require('../../src/shared-ui/core/dateRanges.js');
const { MESSAGE_KEYS, SUPPORTED_LOCALES } = require('../../src/shared-ui/core/i18n.js');

const REPO_ROOT = path.join(__dirname, '..', '..');

function at(year, month, day, hour = 9) {
  return new Date(year, month - 1, day, hour, 20, 0, 0);
}

function clockOf(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    + `:${String(date.getSeconds()).padStart(2, '0')}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

test('yesterday is the single day before today, whatever the clock reads', () => {
  const range = presetRangeWindow('yesterday', at(2026, 9, 26, 23));
  assert.equal(range.startDate, '2026-09-25');
  assert.equal(range.endDate, '2026-09-25');
  assert.equal(localDayKey(range.from), '2026-09-25');
  assert.equal(clockOf(range.from), '00:00:00.000');
  assert.equal(clockOf(range.to), '23:59:59.999');
});

test('a preset window ends at the last millisecond of the day', () => {
  // The desktop hosts read the `to` bound as "include that whole hour", so
  // midnight-to-midnight would add the following day's first hour to the total.
  // The Hub rounds to calendar days either way, so both hosts agree on this bound.
  for (const period of PRESET_RANGE_PERIODS) {
    const range = presetRangeWindow(period, at(2026, 9, 26));
    assert.equal(clockOf(range.to), '23:59:59.999', `${period} upper bound`);
  }
});

test('yesterday crosses month and year boundaries', () => {
  assert.equal(presetRangeWindow('yesterday', at(2026, 3, 1)).startDate, '2026-02-28');
  assert.equal(presetRangeWindow('yesterday', at(2026, 1, 1)).startDate, '2025-12-31');
});

test('this week runs from ISO Monday through today, in every locale', () => {
  // The window is a measurement, so no locale may move it: a host whose CLDR data says
  // Sunday (Android under a US locale) would otherwise answer a different span for the
  // same 本周 label, and the two figures would never be comparable.
  for (const locale of ['', 'en', 'en-US', 'zh-CN', 'de', 'not a locale tag!!']) {
    for (const day of [at(2026, 9, 21), at(2026, 9, 23), at(2026, 10, 1), at(2026, 1, 1)]) {
      const range = presetRangeWindow('week', day);
      assert.equal(range.endDate, localDayKey(day), `${locale}: a week never reaches the future`);
      assert.equal(range.from.getDay(), SCOPE_WEEK_FIRST_DAY_INDEX, `${locale}: starts on ISO Monday`);
      assert.ok(range.from <= day && day.getTime() - range.from.getTime() < 7 * 86_400_000,
        `${locale}: stays inside seven days`);
    }
  }
  // Sunday is the *last* day of the Monday-start week, not the first of a new one.
  assert.equal(presetRangeWindow('week', at(2026, 9, 27)).startDate, '2026-09-21');
});

test('weekStart walks back to the requested weekday', () => {
  // Monday-first: Wednesday 2026-09-23 started on Monday the 21st.
  assert.equal(localDayKey(weekStart(at(2026, 9, 23), 1)), '2026-09-21');
  // Sunday-first, and crossing a month boundary: Thursday 2026-10-01 started on 9-27.
  assert.equal(localDayKey(weekStart(at(2026, 10, 1), 0)), '2026-09-27');
  // On the week's own first day the window is that single day.
  assert.equal(localDayKey(weekStart(at(2026, 9, 21), 1)), '2026-09-21');
});

test('the scope week start ignores the locale entirely', () => {
  // Guard for the note above: `Intl.Locale#weekInfo` must not be able to move a window.
  assert.equal(firstDayOfWeekIndex(), SCOPE_WEEK_FIRST_DAY_INDEX);
  assert.equal(firstDayOfWeekIndex('en'), SCOPE_WEEK_FIRST_DAY_INDEX);
  assert.equal(firstDayOfWeekIndex('not a locale tag!!'), SCOPE_WEEK_FIRST_DAY_INDEX);
  assert.equal(firstDayOfWeekIndex(undefined), firstDayOfWeekIndex('zh-CN'));
});

test('only the calendar presets resolve through the range API', () => {
  for (const period of ['today', 'month', 'allTime', '', 'nope']) {
    assert.equal(presetRangeWindow(period, at(2026, 9, 26)), null, period);
    assert.equal(isPresetRangePeriod(period), false, period);
  }
  assert.deepEqual([...PRESET_RANGE_PERIODS], ['yesterday', 'week']);
});

test('a fetched range answers only the tab that asked for it', () => {
  // This is the rule that kept the two surfaces honest. One cached range answer used to
  // be preferred for *every* scope tab, so 今日/昨日 printed the same figure and
  // 本周/本月/全部 printed another, while the analytics page showed its own snapshot
  // numbers for the same selection.
  const periods = {
    today: { totalTokens: 100 },
    month: { totalTokens: 2000 },
    allTime: { totalTokens: 9000 }
  };
  const yesterday = presetRangeWindow('yesterday', at(2026, 9, 26));
  const fetched = { kind: 'yesterday', startDate: yesterday.startDate, endDate: yesterday.endDate };
  const customPeriod = { totalTokens: 500 };

  assert.equal(resolveScopePeriod({ period: 'yesterday', customRange: fetched, customPeriod, periods }), customPeriod,
    'the preset that asked gets its own answer');
  for (const period of ['today', 'month', 'allTime']) {
    assert.equal(resolveScopePeriod({ period, customRange: fetched, customPeriod, periods }), periods[period],
      `${period} reads the snapshot, never the cached range`);
  }
  // A different preset, or none at all, gets no substitution.
  assert.equal(resolveScopePeriod({ period: 'week', customRange: fetched, customPeriod, periods }), null);
  assert.equal(resolveScopePeriod({ period: 'yesterday', customRange: null, customPeriod: null, periods }), null,
    'a loading or failed preset renders no figure rather than someone else\'s');
  // A hand-picked range lives on the transient "custom" chip, whatever `prefs.period` was.
  assert.ok(isRangeScopeSelection({ period: 'today', customRange: { kind: 'custom' } }));
  assert.equal(resolveScopePeriod({ period: 'today', customRange: { kind: 'custom' }, customPeriod, periods }), customPeriod);
  assert.equal(isRangeScopeSelection({ period: 'today', customRange: null }), false);
  assert.equal(isRangeScopeSelection({ period: 'week', customRange: { kind: 'yesterday' } }), false);
  // Unknown kinds are not a scope answer either.
  assert.equal(isRangeScopeSelection({ period: 'today', customRange: { kind: '' } }), false);
  assert.equal(isRangeScopeSelection({}), false);
});

test('a fetched window stops matching once the day rolls over', () => {
  const asked = presetRangeWindow('week', at(2026, 9, 23), 'en');
  const fetched = {
    kind: asked.period,
    startDate: asked.startDate,
    endDate: asked.endDate
  };
  assert.equal(presetRangeWindowMatches(asked, fetched), true);
  assert.equal(presetRangeWindowMatches(asked, null), false);
  assert.equal(presetRangeWindowMatches(asked, { ...fetched, kind: 'yesterday' }), false);
  // The next day extends the week, so the cached numbers are no longer the answer.
  const nextDay = presetRangeWindow('week', at(2026, 9, 24), 'en');
  assert.equal(presetRangeWindowMatches(nextDay, fetched), false);
  assert.equal(presetRangeWindowMatches(nextDay, { ...fetched, endDate: nextDay.endDate }), true);
});

test('every scope tab the app can render has a label in every locale', () => {
  const appSource = fs.readFileSync(path.join(REPO_ROOT, 'src', 'shared-ui', 'app.js'), 'utf8');
  const tabs = appSource.match(/const PERIOD_TABS = \[([^\]]+)\]/);
  assert.ok(tabs, 'app.js should declare the scope tab order');
  const ids = tabs[1].split(',').map((entry) => entry.trim().replace(/'/g, '')).filter(Boolean);
  assert.deepEqual(ids, ['today', 'yesterday', 'week', 'month', 'allTime']);
  for (const locale of SUPPORTED_LOCALES) {
    for (const id of ids) {
      assert.ok(
        MESSAGE_KEYS[locale].includes(`period.${id}`),
        `period.${id} is missing from ${locale}`
      );
    }
  }
});

test('a fleet calendar computes presets in the Hub zone, not the viewer zone', () => {
  // 2026-10-05 20:00 UTC is already 2026-10-06 in Shanghai and still 2026-10-05
  // in Los Angeles, so the same instant must produce different windows.
  const instant = new Date('2026-10-05T20:00:00.000Z');
  const shanghai = presetRangeWindow('yesterday', instant, 'Asia/Shanghai');
  assert.equal(shanghai.startDate, '2026-10-05');
  assert.equal(shanghai.endDate, '2026-10-05');
  // Bounds are the zone's own midnights, not the viewer's.
  assert.equal(shanghai.from.toISOString(), '2026-10-04T16:00:00.000Z');
  assert.equal(shanghai.to.toISOString(), '2026-10-05T15:59:59.999Z');

  const losAngeles = presetRangeWindow('yesterday', instant, 'America/Los_Angeles');
  assert.equal(losAngeles.startDate, '2026-10-04');
  assert.equal(losAngeles.from.toISOString(), '2026-10-04T07:00:00.000Z');
  assert.equal(losAngeles.to.toISOString(), '2026-10-05T06:59:59.999Z');
});

test('a fleet calendar keeps the ISO Monday week window and DST-safe bounds', () => {
  // 2026-10-06 is a Tuesday in Shanghai; the week starts Monday 2026-10-05.
  const week = presetRangeWindow('week', new Date('2026-10-06T02:00:00.000Z'), 'Asia/Shanghai');
  assert.equal(week.startDate, '2026-10-05');
  assert.equal(week.endDate, '2026-10-06');

  // US fall back 2026-11-01 is a 25-hour day; its end bound must still be the
  // last millisecond before local midnight (08:00 UTC on 11-02).
  const fall = presetRangeWindow('yesterday', new Date('2026-11-02T10:00:00.000Z'), 'America/Los_Angeles');
  assert.equal(fall.startDate, '2026-11-01');
  assert.equal(fall.from.toISOString(), '2026-11-01T07:00:00.000Z');
  assert.equal(fall.to.toISOString(), '2026-11-02T07:59:59.999Z');
});
