'use strict';

const { randomBytes } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { PERIODS, aggregateDevices, aggregateHistory, normalizeDeviceRecord, projectDeviceForNow, summarizeStats } = require('../shared/usage');
const { historyPreview, historyRevision, deviceHistoryRevision } = require('../shared/history');
const { computePeriodWindows, dayKeyOf } = require('../shared/fleetTimeZone');
const { staleAfterMsForSyncUpload } = require('../shared/syncUploadInterval');

// A committed device replaces one immutable contribution. The persisted snapshot
// remains authoritative; a failed/cold cache can always be rebuilt from it. Never
// retain both raw and normalized copies of the fleet or query it for quota edits.
function createFleetReadModel({ store, staleAfterMs, timeZone = '', now = Date.now }) {
  const epoch = randomBytes(6).toString('hex');
  let sequence = 0;
  let records = null;
  let loading = null;
  let resetVersion = 0;
  const pending = new Map();
  const details = new Map();
  let usageVersion = 0;
  const sessionVersions = Object.fromEntries(PERIODS.map((name) => [name, 0]));
  let historyVersion = 0;
  let fullCache = null;
  let summaryCache = null;
  let historyCache = null;
  const metrics = { fleetReads: 0, normalizedDevices: 0, fullBuilds: 0, summaryBuilds: 0, historyBuilds: 0 };
  const revision = () => `${epoch}-${++sequence}`;

  function remember(record, previous) {
    const legacyKey = (entry, name) => {
      const ms = Date.parse(entry?.updatedAt || entry?.receivedAt || '');
      return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, name === 'month' ? 7 : 10) : '';
    };
    const detailChanged = !previous || !isDeepStrictEqual(
      { ...previous, updatedAt: '', receivedAt: '', history: null },
      { ...record, updatedAt: '', receivedAt: '', history: null }
    ) || ['today', 'month'].some((name) => !record.periodWindows?.[name]?.endsAt
      && legacyKey(previous, name) !== legacyKey(record, name));
    if (detailChanged || !details.has(record.deviceId)) details.set(record.deviceId, revision());
    const historyChanged = !previous
      || !isDeepStrictEqual(previous.history, record.history)
      || previous.historyAvailable !== record.historyAvailable
      || !isDeepStrictEqual(previous.periodWindows?.today, record.periodWindows?.today);
    if (detailChanged) {
      usageVersion++;
      fullCache = summaryCache = null;
    }
    for (const name of PERIODS) {
      if (!previous || !isDeepStrictEqual(previous.periods?.[name]?.sessions, record.periods?.[name]?.sessions)) sessionVersions[name]++;
    }
    if (historyChanged) {
      historyVersion++;
      historyCache = null;
    }
  }

  function put(input, { normalized = false } = {}) {
    const record = normalized ? input : normalizeDeviceRecord(input);
    if (!normalized) metrics.normalizedDevices++;
    const previous = records?.get(record.deviceId) || pending.get(record.deviceId);
    remember(record, previous);
    if (records) records.set(record.deviceId, record);
    else pending.set(record.deviceId, record);
  }

  function remove(deviceId) {
    records?.delete(deviceId);
    // A tombstone also wins over a SELECT that was started before the commit.
    if (!records) pending.set(deviceId, null);
    details.delete(deviceId);
    for (const name of PERIODS) sessionVersions[name]++;
    usageVersion++;
    historyVersion++;
    fullCache = summaryCache = historyCache = null;
  }

  function reset() {
    resetVersion++;
    records = null;
    pending.clear();
    details.clear();
    for (const name of PERIODS) sessionVersions[name]++;
    usageVersion++;
    historyVersion++;
    fullCache = summaryCache = historyCache = null;
    // Keep the physical in-flight read latched. Invalidating a promise reference
    // must not create unbounded simultaneous SQL/normalization work.
  }

  async function getRecords() {
    if (records) return [...records.values()];
    if (!loading) {
      const version = resetVersion;
      loading = (async () => {
        metrics.fleetReads++;
        const rows = await store.listDeviceRecords();
        if (version !== resetVersion) return;
        const next = new Map();
        for (const row of rows) {
          const record = normalizeDeviceRecord(row);
          metrics.normalizedDevices++;
          next.set(record.deviceId, record);
          if (!details.has(record.deviceId)) details.set(record.deviceId, revision());
        }
        for (const [id, record] of pending) {
          if (record) next.set(id, record);
          else next.delete(id);
        }
        pending.clear();
        records = next;
      })().finally(() => { loading = null; });
    }
    await loading;
    return getRecords();
  }

  function calendarBoundary(rows, at) {
    // Explicit producer windows can expire between the Hub's midnights. Legacy
    // periods expire at UTC midnight; history uses the configured fleet calendar.
    let boundary = Math.min(
      Date.parse(computePeriodWindows(new Date(at), timeZone).today.endsAt),
      Date.parse(computePeriodWindows(new Date(at), 'UTC').today.endsAt)
    );
    for (const record of rows) {
      for (const name of ['today', 'month']) {
        const end = Date.parse(record.periodWindows?.[name]?.endsAt || '');
        if (end > at) boundary = Math.min(boundary, end);
      }
    }
    return boundary;
  }

  async function history(deviceId = '') {
    const rows = await getRecords();
    return buildHistory(rows, now(), deviceId);
  }

  function buildHistory(rows, at, deviceId = '') {
    if (!historyCache || historyCache.version !== historyVersion || at >= historyCache.until) {
      metrics.historyBuilds++;
      const document = aggregateHistory(rows, { normalized: true, fallbackTodayKey: dayKeyOf(new Date(at), timeZone) });
      historyCache = {
        version: historyVersion,
        until: calendarBoundary(rows, at),
        document,
        preview: historyPreview(document),
        revision: historyRevision(document),
        deviceRevision: deviceHistoryRevision(rows),
        scoped: new Map()
      };
    }
    if (!deviceId) return historyCache;
    const scopeKey = rows.some((record) => record.deviceId === deviceId) ? deviceId : '';
    if (!historyCache.scoped.has(scopeKey)) {
      const scopedRows = rows.filter((record) => record.deviceId === deviceId);
      const document = aggregateHistory(scopedRows, { normalized: true, fallbackTodayKey: dayKeyOf(new Date(at), timeZone) });
      historyCache.scoped.set(scopeKey, { document, revision: historyRevision(document) });
    }
    return historyCache.scoped.get(scopeKey);
  }

  function detailToken(record, at) {
    const view = projectDeviceForNow(record, staleAfterMs, at);
    const windows = ['today', 'month'].map((name) => view.periods[name] === record.periods[name] ? 1 : 0).join('');
    return `${details.get(record.deviceId)}:${windows}`;
  }

  async function device(deviceId) {
    let record = records?.get(deviceId) || pending.get(deviceId);
    if (!record && !records && typeof store.getActiveDeviceRecord === 'function') {
      const version = resetVersion;
      const raw = await store.getActiveDeviceRecord(deviceId);
      if (version !== resetVersion) return device(deviceId);
      if (records || pending.has(deviceId)) record = records?.get(deviceId) || pending.get(deviceId);
      else if (raw) { put(raw); record = pending.get(deviceId); }
    } else if (!records && typeof store.getActiveDeviceRecord !== 'function') {
      record = (await getRecords()).find((entry) => entry.deviceId === deviceId);
    }
    if (!record) return null;
    const view = projectDeviceForNow(record, staleAfterMs, now());
    delete view.limits;
    view.detailRevision = detailToken(record, now());
    return view;
  }

  async function usage({ summary = false } = {}) {
    const rows = await getRecords();
    return buildUsage(rows, now(), summary);
  }

  function buildUsage(rows, at, summary) {
    let cached = summary ? summaryCache : fullCache;
    if (!cached || cached.version !== usageVersion || at >= cached.until) {
      metrics[summary ? 'summaryBuilds' : 'fullBuilds']++;
      const full = aggregateDevices(rows, staleAfterMs, at, {
        normalized: true,
        ...(summary ? { omitAggregateSessions: true } : {})
      });
      cached = {
        version: usageVersion,
        until: calendarBoundary(rows, at),
        stats: summary ? summarizeStats(full) : full,
        revision: revision()
      };
      if (summary) summaryCache = cached;
      else fullCache = cached;
    }
    // Presence/age is a cheap wall-clock overlay, not a reason to re-fold session
    // archives. Expiring periods invalidate the heavy projection at a boundary.
    const devices = cached.stats.devices.map((device) => {
      const current = records.get(device.deviceId) || device;
      const ageMs = at - Date.parse(current.receivedAt || current.updatedAt || 0);
      const deadline = staleAfterMsForSyncUpload(device.syncUploadIntervalMs, staleAfterMs);
      return {
        ...device,
        updatedAt: current.updatedAt,
        receivedAt: current.receivedAt,
        ageMs: Number.isFinite(ageMs) ? ageMs : null,
        stale: Number.isFinite(ageMs) && deadline > 0 ? ageMs > deadline : false,
        detailRevision: detailToken(current, at)
      };
    });
    const sessionRevision = Object.fromEntries(PERIODS.map((name) => {
      const expired = rows.map((record) => projectDeviceForNow(record, staleAfterMs, at).periods[name] === record.periods[name] ? 1 : 0).join('');
      return [name, `${epoch}:${sessionVersions[name]}:${expired}`];
    }));
    return { ...cached.stats, updatedAt: new Date(at).toISOString(), devices, sessionRevision };
  }

  async function snapshot({ summary = false } = {}) {
    const rows = await getRecords();
    const at = now();
    // Both projections observe the same immutable records and instant. There is
    // no await between them at which a committed upload can mix two generations.
    return { stats: buildUsage(rows, at, summary), history: buildHistory(rows, at) };
  }

  async function nextBoundary() {
    const rows = await getRecords();
    const at = now();
    let boundary = calendarBoundary(rows, at);
    for (const record of rows) {
      const threshold = staleAfterMsForSyncUpload(record.syncUploadIntervalMs, staleAfterMs);
      const staleAt = Date.parse(record.receivedAt || record.updatedAt || 0) + threshold + 1;
      if (threshold > 0 && staleAt > at) boundary = Math.min(boundary, staleAt);
    }
    return boundary;
  }

  return { getRecords, put, remove, reset, history, usage, snapshot, device, nextBoundary,
    metrics: () => ({ ...metrics }) };
}

module.exports = { createFleetReadModel };
