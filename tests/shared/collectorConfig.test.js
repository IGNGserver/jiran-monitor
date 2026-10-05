'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_WSL_REFRESH_INTERVAL_MS,
  normalizeWslRefreshIntervalMs,
  usageConfigFromSource
} = require('../../src/shared/collectorConfig');

test('normalizeWslRefreshIntervalMs clamps to a sane floor and allows opt-out', () => {
  // Absent/garbage keeps the documented default rather than disabling refresh.
  assert.equal(normalizeWslRefreshIntervalMs(undefined), DEFAULT_WSL_REFRESH_INTERVAL_MS);
  assert.equal(normalizeWslRefreshIntervalMs('abc'), DEFAULT_WSL_REFRESH_INTERVAL_MS);
  // 0 is the explicit opt-out (interval/full ticks still scan WSL).
  assert.equal(normalizeWslRefreshIntervalMs(0), 0);
  // Anything else is floored at one second so a stray 1 cannot spin scans.
  assert.equal(normalizeWslRefreshIntervalMs(1), 1000);
  assert.equal(normalizeWslRefreshIntervalMs(45000), 45000);
});

test('usageConfigFromSource carries the WSL refresh cadence through', () => {
  assert.equal(usageConfigFromSource({}).wslRefreshIntervalMs, DEFAULT_WSL_REFRESH_INTERVAL_MS);
  assert.equal(
    usageConfigFromSource({}, { wslRefreshIntervalMs: 30000 }).wslRefreshIntervalMs,
    30000
  );
});
