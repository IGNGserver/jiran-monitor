'use strict';

// The session archive restores usage for tools whose data was deleted, so 累计 can
// legitimately exceed a fresh full scan — that is the point of the feature.
//
// What it must never do is make the difference invisible. `archivedTokens` is that
// split: zero means every token in the period is provable from the tools still on
// disk, and any positive value is the part the product is asking to be taken on
// trust. Without it a 累计 headline cannot be reconciled against tokscale at all,
// which is how a correct-looking number still reads as a counting bug.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  aggregateDevices,
  normalizeDeviceRecord,
  summarizeStats
} = require('../../src/shared/usage');
const {
  applySessionUsageArchive,
  captureSessionUsageArchive
} = require('../../src/shared/sessionUsageArchive');

const NOW = new Date('2026-07-09T12:00:00.000Z');
const TIME_ZONE = 'UTC';

function session(client, sessionId, totalTokens, costUsd) {
  return {
    client,
    sessionId,
    totalTokens,
    costUsd,
    messageCount: 1,
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    lastUsedAt: NOW.toISOString()
  };
}

function perPeriod(periods) {
  return {
    deviceId: 'macbook',
    hostname: 'macbook',
    today: { ...periods },
    month: { ...periods },
    allTime: { ...periods }
  };
}

/** Both tools still on disk: the state the archive captures from. */
function recordWithBothTools() {
  return perPeriod({
    totalTokens: 150,
    costUsd: 1.5,
    clients: { opencode: 100, codex: 50 },
    clientCosts: { opencode: 1.25, codex: 0.25 },
    sessions: {
      'opencode:o1': session('opencode', 'o1', 100, 1.25),
      'codex:c1': session('codex', 'c1', 50, 0.25)
    }
  });
}

/** `codex` deleted: tokscale no longer sees it, only the archive still knows it. */
function recordWithCodexDeleted() {
  return perPeriod({
    totalTokens: 100,
    costUsd: 1.25,
    clients: { opencode: 100 },
    clientCosts: { opencode: 1.25 },
    sessions: { 'opencode:o1': session('opencode', 'o1', 100, 1.25) }
  });
}

test('a restored session is counted in the total and reported as archived', () => {
  const archive = captureSessionUsageArchive({}, recordWithBothTools(), NOW, { timeZone: TIME_ZONE });
  const visible = applySessionUsageArchive(recordWithCodexDeleted(), archive, { now: NOW, timeZone: TIME_ZONE });

  assert.equal(visible.allTime.totalTokens, 150, 'the archived share still belongs in the headline');
  assert.equal(visible.allTime.archivedTokens, 50, 'and the headline must be able to name how much of itself it cannot prove');
  assert.equal(visible.allTime.archivedCostUsd, 0.25);
  assert.equal(visible.allTime.archivedClients.codex, 50);
  // Provenance must not leak onto the tool that is still on disk.
  assert.equal(visible.allTime.clients.opencode, 100);
  assert.equal(visible.allTime.archivedClients.opencode, undefined);
});

// `applySessionUsageArchive` is a filter, not a normalizer: with nothing to restore
// it returns the record untouched. The zero guarantee therefore lives in the period
// shape (`emptyPeriod`/`normalizePeriod`), which is what every collector and every
// ingest path runs — so the record here is normalized first, exactly as a posted one
// would be.
test('nothing archived reports zero, so a zero still means "provable from disk"', () => {
  const normalized = normalizeDeviceRecord(recordWithCodexDeleted());
  const visible = applySessionUsageArchive(normalized, { version: 1, sessions: {} }, { now: NOW, timeZone: TIME_ZONE });

  // A normalized record keeps its periods under `periods`, so that is where the
  // archive applies and where the split has to be readable.
  assert.equal(visible.periods.allTime.archivedTokens, 0);
  assert.equal(visible.periods.allTime.archivedCostUsd, 0);
  assert.deepEqual({ ...visible.periods.allTime.archivedClients }, {});
});

test('the split survives the wire, the fleet aggregate and the first-paint projection', () => {
  const normalized = normalizeDeviceRecord({
    deviceId: 'a',
    hostname: 'a',
    periods: {
      allTime: {
        totalTokens: 150,
        costUsd: 1.5,
        archivedTokens: 50,
        archivedCostUsd: 0.25,
        archivedClients: { codex: 50 }
      }
    }
  });
  assert.equal(normalized.periods.allTime.archivedTokens, 50, 'normalization must not drop the split');
  assert.equal(normalized.periods.allTime.archivedCostUsd, 0.25);
  assert.equal(normalized.periods.allTime.archivedClients.codex, 50);

  const fleet = aggregateDevices([normalized, structuredClone(normalized)], 600000, NOW.getTime());
  assert.equal(fleet.periods.allTime.archivedTokens, 100, 'the fleet split is the sum of its devices');
  assert.equal(fleet.periods.allTime.archivedClients.codex, 100);

  const summary = summarizeStats(fleet);
  assert.equal(summary.periods.allTime.archivedTokens, 100, 'first paint has to carry it or the hero cannot explain itself');
});

test('an older record without the field normalizes to zero rather than undefined', () => {
  const normalized = normalizeDeviceRecord({
    deviceId: 'legacy',
    hostname: 'legacy',
    periods: { allTime: { totalTokens: 10, costUsd: 0.01 } }
  });
  assert.equal(normalized.periods.allTime.archivedTokens, 0);
  assert.equal(normalized.periods.allTime.archivedCostUsd, 0);
  assert.deepEqual({ ...normalized.periods.allTime.archivedClients }, {});
});
