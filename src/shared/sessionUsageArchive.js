'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { PERIODS, normalizePeriod } = require('./usage');
const { filterReasonixSyntheticSessions, isReasonixSyntheticSession } = require('./reasonixSessionGuard');
const { readJson, sharedDataDir, writeJsonAtomic } = require('./config');
const { dayKeyOf, monthKeyOf, normalizeTimeZone } = require('./fleetTimeZone');

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

// Marks an archive whose entries are already canonical (see
// normalizeSessionUsageArchive). The pipeline hands the same normalized archive
// through load -> capture -> apply on every tick, and each step used to re-walk
// and re-normalize every entry: that redundant work is what made the per-tick
// cost scale with the archive size. A WeakSet keeps the marker off the object so
// it can never leak into the serialized file, and is immune to JSON round trips
// resurrecting it.
const normalizedArchives = new WeakSet();

function markSessionArchiveNormalized(archive) {
  if (archive && typeof archive === 'object' && archive.sessions && typeof archive.sessions === 'object') {
    normalizedArchives.add(archive.sessions);
  }
  return archive;
}

function mapNumber(map, key) {
  return hasOwn(map, key) ? numberValue(map[key]) : 0;
}

function ensureNestedMap(map, key) {
  if (!hasOwn(map, key) || !map[key] || typeof map[key] !== 'object' || Array.isArray(map[key])) {
    map[key] = {};
  }
  return map[key];
}

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function sessionUsageArchiveDate(deviceRecord, fallback = new Date()) {
  const collectedAt = new Date(deviceRecord?.updatedAt || '');
  return Number.isNaN(collectedAt.getTime()) ? toDate(fallback) : collectedAt;
}

// The calendar day/month an instant falls on, in the active fleet zone ('' =
// this machine's own zone). Every archive window key is produced here so the
// archive can never re-inject a session into a day the fleet has already left.
function localDay(dateValue, timeZone = '') {
  return dayKeyOf(toDate(dateValue), normalizeTimeZone(timeZone));
}

function localMonth(dateValue, timeZone = '') {
  return monthKeyOf(toDate(dateValue), normalizeTimeZone(timeZone));
}

// Every caller feeds this function a session that has already been through
// normalizePeriod(), so `client` is a canonical client id and `sessionId` is a
// trimmed non-empty string. Rebuilding a synthetic period here just to read two
// strings back out cost a full normalizePeriod per session per period, which
// dominated the whole archive pipeline (~90% of the per-tick transform) and grew
// linearly with the archive. Keep the validity rule identical to the old path:
// the normalization boundary yields null for either half, or for an all-empty
// key, and such entries were dropped.
function sessionKey(client, sessionId) {
  const name = String(client || '');
  const id = String(sessionId || '');
  if (!name || !id) return null;
  const key = `${name}:${id}`;
  return key === ':' ? null : key;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function sameJson(left, right) {
  return isDeepStrictEqual(left || null, right || null);
}

function periodFor(record, periodName) {
  return normalizePeriod(record?.periods?.[periodName] || record?.[periodName]);
}

function normalizedSessionFrom(value, fallbackKey) {
  if (isReasonixSyntheticSession(value, fallbackKey)) return null;
  const period = normalizePeriod({ sessions: { [fallbackKey || 'session']: value } });
  return Object.values(period.sessions)[0] || null;
}

function hasSessionUsage(session) {
  return numberValue(session?.totalTokens) > 0 || numberValue(session?.costUsd) > 0;
}

function normalizeSessionUsageArchive(value, options = {}) {
  const source = value?.sessions && typeof value.sessions === 'object' ? value.sessions : value;
  const normalized = { version: 1, sessions: {} };
  if (!source || typeof source !== 'object') return normalized;
  const timeZone = normalizeTimeZone(options.timeZone);
  // Already canonical: the marker is only set by the branch at the end of this
  // function, by captureSessionUsageArchive (which only ever adds entries that
  // came out of normalizePeriod), and by resetSessionUsageArchive.
  if (normalizedArchives.has(source)) return value;

  for (const [rawKey, rawEntry] of Object.entries(source)) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    if (isReasonixSyntheticSession(rawEntry, rawKey)) continue;
    const rawPeriods = rawEntry.periods && typeof rawEntry.periods === 'object'
      ? rawEntry.periods
      : rawEntry;
    const entry = {
      client: '',
      sessionId: '',
      capturedAt: toDate(rawEntry.capturedAt).toISOString(),
      day: String(rawEntry.day || localDay(rawEntry.capturedAt, timeZone)),
      month: String(rawEntry.month || localMonth(rawEntry.capturedAt, timeZone)),
      periodWindows: {},
      periods: {}
    };

    for (const periodName of PERIODS) {
      const session = normalizedSessionFrom(rawPeriods?.[periodName], rawKey);
      if (!session || isReasonixSyntheticSession(session, rawKey) || !hasSessionUsage(session)) continue;
      const key = sessionKey(session.client, session.sessionId);
      if (!key) continue;
      entry.client = session.client;
      entry.sessionId = session.sessionId;
      entry.periods[periodName] = session;
      const rawWindow = rawEntry.periodWindows?.[periodName] || {};
      entry.periodWindows[periodName] = {
        capturedAt: toDate(rawWindow.capturedAt || rawEntry.capturedAt).toISOString()
      };
      if (periodName === 'today') entry.periodWindows[periodName].day = String(rawWindow.day || rawEntry.day || localDay(rawEntry.capturedAt, timeZone));
      if (periodName === 'month') entry.periodWindows[periodName].month = String(rawWindow.month || rawEntry.month || localMonth(rawEntry.capturedAt, timeZone));
    }

    if (!entry.client || !entry.sessionId || Object.keys(entry.periods).length === 0) continue;
    normalized.sessions[`${entry.client}:${entry.sessionId}`] = entry;
  }

  return markSessionArchiveNormalized(normalized);
}

function captureSessionUsageArchive(existingArchive, deviceRecord, capturedAt = new Date(), options = {}) {
  const timeZone = normalizeTimeZone(options.timeZone);
  const archive = normalizeSessionUsageArchive(existingArchive, { timeZone });
  if (!deviceRecord || typeof deviceRecord !== 'object') return archive;

  const captureDate = toDate(capturedAt);
  for (const periodName of PERIODS) {
    const period = periodFor(deviceRecord, periodName);
    for (const session of Object.values(period.sessions || {})) {
      if (isReasonixSyntheticSession(session) || !hasSessionUsage(session)) continue;
      const archiveKey = sessionKey(session.client, session.sessionId);
      if (!archiveKey) continue;
      const entry = archive.sessions[archiveKey] || {
        client: session.client,
        sessionId: session.sessionId,
        capturedAt: captureDate.toISOString(),
        day: localDay(captureDate, timeZone),
        month: localMonth(captureDate, timeZone),
        periodWindows: {},
        periods: {}
      };
      const nextSession = clone(session);
      const window = entry.periodWindows?.[periodName] || {};
      const sameWindow = periodName === 'today'
        ? window.day === localDay(captureDate, timeZone)
        : periodName === 'month'
          ? window.month === localMonth(captureDate, timeZone)
          : true;
      if (sameJson(entry.periods[periodName], nextSession) && sameWindow) continue;
      entry.client = session.client;
      entry.sessionId = session.sessionId;
      entry.capturedAt = captureDate.toISOString();
      entry.day = localDay(captureDate, timeZone);
      entry.month = localMonth(captureDate, timeZone);
      entry.periods[periodName] = nextSession;
      entry.periodWindows = entry.periodWindows || {};
      entry.periodWindows[periodName] = { capturedAt: captureDate.toISOString() };
      if (periodName === 'today') entry.periodWindows[periodName].day = localDay(captureDate, timeZone);
      if (periodName === 'month') entry.periodWindows[periodName].month = localMonth(captureDate, timeZone);
      archive.sessions[archiveKey] = entry;
    }
  }

  // Entries added above come straight out of normalizePeriod(), so the archive is
  // still canonical and the next pass can skip the full re-normalization.
  return markSessionArchiveNormalized(archive);
}

function targetPeriod(summary, periodName) {
  if (summary.periods && typeof summary.periods === 'object') {
    summary.periods[periodName] = normalizePeriod(summary.periods[periodName]);
    return summary.periods[periodName];
  }
  summary[periodName] = normalizePeriod(summary[periodName]);
  return summary[periodName];
}

function allocateIntegerTotal(total, weightedEntries) {
  if (total <= 0 || weightedEntries.length === 0) return new Map();
  const weightTotal = weightedEntries.reduce((sum, [, weight]) => sum + weight, 0);
  const allocations = weightedEntries.map(([key, weight]) => {
    const exact = total * weight / weightTotal;
    return { key, value: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = total - allocations.reduce((sum, item) => sum + item.value, 0);
  allocations.sort((a, b) => b.remainder - a.remainder || a.key.localeCompare(b.key));
  for (let index = 0; index < remaining; index += 1) allocations[index].value += 1;
  return new Map(allocations.map(({ key, value }) => [key, value]));
}

// Per-session contribution to a period, computed once per session object.
//
// Reapplying an archive recomputes every archived session on every tick, and the
// integer re-allocation over `models` is the expensive part. Archived sessions are
// immutable between archive writes (entries are replaced, never mutated), so a
// WeakMap keyed by the session object can memoize the answer indefinitely; a
// replaced entry becomes unreachable and its cache entry is collected with it.
const sessionBreakdownCache = new WeakMap();

function computeSessionContribution(session) {
  const cached = sessionBreakdownCache.get(session);
  if (cached) return cached;

  const client = session.client;
  const cacheRead = Math.max(0, Math.round(numberValue(session.cacheReadTokens)));
  const cacheWrite = Math.max(0, Math.round(numberValue(session.cacheWriteTokens)));
  const output = Math.max(0, Math.round(numberValue(session.outputTokens)));

  const modelTokens = Object.entries(session.models || {})
    .map(([model, tokens]) => [model, numberValue(tokens)])
    .filter(([, tokens]) => tokens > 0);
  const totalModelTokens = modelTokens.reduce((sum, [, tokens]) => sum + tokens, 0);

  let modelCacheReads = null;
  let modelCacheWrites = null;
  let modelOutputs = null;
  if (totalModelTokens > 0) {
    modelCacheReads = allocateIntegerTotal(cacheRead, modelTokens);
    modelCacheWrites = allocateIntegerTotal(cacheWrite, modelTokens);
    modelOutputs = allocateIntegerTotal(output, modelTokens);
  }

  const contribution = {
    client,
    cacheRead,
    cacheWrite,
    output,
    modelTokens,
    modelCacheReads,
    modelCacheWrites,
    modelOutputs
  };
  sessionBreakdownCache.set(session, contribution);
  return contribution;
}

function applySessionContribution(period, contribution) {
  const { client, cacheRead, cacheWrite, output, modelTokens } = contribution;
  if (cacheRead > 0) period.clientCacheReads[client] = mapNumber(period.clientCacheReads, client) + cacheRead;
  if (cacheWrite > 0) period.clientCacheWrites[client] = mapNumber(period.clientCacheWrites, client) + cacheWrite;
  if (output > 0) period.clientOutputs[client] = mapNumber(period.clientOutputs, client) + output;
  if (modelTokens.length === 0) return;

  const { modelCacheReads, modelCacheWrites, modelOutputs } = contribution;
  for (const [model] of modelTokens) {
    const cr = modelCacheReads.get(model) || 0;
    const cw = modelCacheWrites.get(model) || 0;
    const ou = modelOutputs.get(model) || 0;
    if (cr > 0) period.modelCacheReads[model] = mapNumber(period.modelCacheReads, model) + cr;
    if (cw > 0) period.modelCacheWrites[model] = mapNumber(period.modelCacheWrites, model) + cw;
    if (ou > 0) period.modelOutputs[model] = mapNumber(period.modelOutputs, model) + ou;
  }
}

function addArchivedSession(period, session) {
  const key = sessionKey(session.client, session.sessionId);
  if (!key || hasOwn(period.sessions, key)) return;

  const archived = { ...clone(session), archived: true };
  period.sessions[key] = archived;
  const tokens = Math.max(0, Math.round(numberValue(archived.totalTokens)));
  const cost = numberValue(archived.costUsd);
  const cacheRead = Math.max(0, Math.round(numberValue(archived.cacheReadTokens)));
  const cacheWrite = Math.max(0, Math.round(numberValue(archived.cacheWriteTokens)));
  const output = Math.max(0, Math.round(numberValue(archived.outputTokens)));

  period.totalTokens += tokens;
  period.costUsd += cost;
  period.cacheReadTokens += cacheRead;
  period.cacheWriteTokens += cacheWrite;
  period.outputTokens += output;
  if (tokens > 0) period.clients[archived.client] = mapNumber(period.clients, archived.client) + tokens;
  if (cost > 0) period.clientCosts[archived.client] = mapNumber(period.clientCosts, archived.client) + cost;

  for (const [model, modelTokens] of Object.entries(archived.models || {})) {
    const next = Math.max(0, Math.round(numberValue(modelTokens)));
    if (next <= 0) continue;
    period.models[model] = mapNumber(period.models, model) + next;
    const models = ensureNestedMap(period.clientModels, archived.client);
    models[model] = mapNumber(models, model) + next;
  }
  for (const [model, modelCost] of Object.entries(archived.modelCosts || {})) {
    const next = numberValue(modelCost);
    if (next <= 0) continue;
    period.modelCosts[model] = mapNumber(period.modelCosts, model) + next;
    const costs = ensureNestedMap(period.clientModelCosts, archived.client);
    costs[model] = mapNumber(costs, model) + next;
  }

  applySessionContribution(period, computeSessionContribution(archived));
}

function shouldApplyPeriod(periodName, entry, now, timeZone = '') {
  const window = entry?.periodWindows?.[periodName] || {};
  if (periodName === 'today') return (window.day || entry.day) === localDay(now, timeZone);
  if (periodName === 'month') return (window.month || entry.month) === localMonth(now, timeZone);
  return periodName === 'allTime';
}

function applySessionUsageArchive(summary, archive, options = {}) {
  const timeZone = normalizeTimeZone(options.timeZone);
  const normalizedArchive = normalizeSessionUsageArchive(archive, { timeZone });
  const now = toDate(options.now);
  const next = clone(summary);
  const periodContainer = next.periods && typeof next.periods === 'object' ? next.periods : next;
  for (const periodName of PERIODS) {
    const period = periodContainer?.[periodName];
    if (period && typeof period === 'object' && Object.prototype.hasOwnProperty.call(period, 'sessions')) {
      period.sessions = filterReasonixSyntheticSessions(period.sessions);
    }
  }
  const targetPeriods = new Map();
  const targetFor = (periodName) => {
    if (!targetPeriods.has(periodName)) targetPeriods.set(periodName, targetPeriod(next, periodName));
    return targetPeriods.get(periodName);
  };

  for (const entry of Object.values(normalizedArchive.sessions)) {
    for (const periodName of PERIODS) {
      const session = entry.periods?.[periodName];
      if (!session || !hasSessionUsage(session) || !shouldApplyPeriod(periodName, entry, now, timeZone)) continue;
      addArchivedSession(targetFor(periodName), session);
    }
  }

  return next;
}

/**
 * Restore archived (pruned) sessions into one arbitrary calendar window.
 *
 * `applySessionUsageArchive` answers the fixed today/month/allTime tabs. A custom
 * range — and the 昨日 / 本周 presets, which are ranges the UI computes — needs the
 * same restoration, or a day whose tool already pruned its sessions reads lower
 * here than in the 本月 tab: the same day measured two ways. Membership is decided
 * by the archived day bucket, de-duplication by the shared `client:sessionId` key,
 * and the caller's own hour-level filter still runs afterwards, so a partial window
 * cannot gain a day it does not cover.
 */
function applySessionUsageArchiveRange(period, archive, range) {
  if (!period || typeof period !== 'object') return period;
  const startDate = String(range?.startDate || '');
  const endDate = String(range?.endDate || '');
  if (!startDate || !endDate) return period;
  if (!period.sessions || typeof period.sessions !== 'object') period.sessions = Object.create(null);
  const normalized = normalizeSessionUsageArchive(archive);
  for (const entry of Object.values(normalized.sessions || {})) {
    const session = entry?.periods?.today;
    if (!session || !hasSessionUsage(session)) continue;
    const day = entry?.periodWindows?.today?.day || entry?.day;
    if (!day || day < startDate || day > endDate) continue;
    addArchivedSession(period, session);
  }
  return period;
}

function sessionUsageArchivePath(options = {}) {
  return options.path || path.join(sharedDataDir(options), 'session-usage-archive.json');
}

function readSessionUsageArchive(options = {}) {
  const read = options.readJson || readJson;
  return normalizeSessionUsageArchive(read(sessionUsageArchivePath(options), {}), options);
}

function writeSessionUsageArchive(archive, options = {}) {
  const write = options.writeJsonAtomic || writeJsonAtomic;
  write(sessionUsageArchivePath(options), normalizeSessionUsageArchive(archive, options));
}

function clearSessionUsageArchive(options = {}) {
  const unlink = options.unlinkSync || fs.unlinkSync;
  try {
    unlink(sessionUsageArchivePath(options));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

module.exports = {
  applySessionUsageArchiveRange,
  applySessionUsageArchive,
  captureSessionUsageArchive,
  clearSessionUsageArchive,
  normalizeSessionUsageArchive,
  readSessionUsageArchive,
  sessionUsageArchiveDate,
  sessionUsageArchivePath,
  writeSessionUsageArchive
};
