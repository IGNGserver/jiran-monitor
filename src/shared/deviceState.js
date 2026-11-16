'use strict';

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const { filterReasonixSyntheticSessions } = require('./reasonixSessionGuard');

const PARTIAL_USAGE_CARRY_FIELDS = Object.freeze([
  'month',
  'allTime',
  'clientStatus',
  'wslStatus',
  'periodWindows',
  'projectsEnabled',
  'allTimeProjectsOmitted',
  'allTimeProjectsIncomplete',
  'sessionDetailsOmitted',
  'periodProjectsOmitted',
  'nativeSessions',
  'nativeProjects',
  'syncUploadIntervalMs'
]);

function setSafeProperty(target, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  } else {
    target[key] = value;
  }
}

function cloneValue(value, seen = null) {
  if (value === null || typeof value !== 'object') return value;
  const visited = seen || new Map();
  if (visited.has(value)) return visited.get(value);
  if (Array.isArray(value)) {
    const copy = new Array(value.length);
    visited.set(value, copy);
    for (let index = 0; index < value.length; index += 1) {
      copy[index] = cloneValue(value[index], visited);
    }
    return copy;
  }
  const copy = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
  visited.set(value, copy);
  for (const [key, entry] of Object.entries(value)) {
    setSafeProperty(copy, key, cloneValue(entry, visited));
  }
  return copy;
}

function normalizedEnvelope(value) {
  const envelope = {};
  for (const [key, entry] of Object.entries(value || {})) {
    if (entry !== undefined) {
      setSafeProperty(envelope, key, cloneValue(entry));
    }
  }
  return envelope;
}

function sanitizeUsagePeriods(value, { copy = true } = {}) {
  const next = copy ? cloneValue(value || {}) : { ...(value || {}) };
  if (!copy && next.periods && typeof next.periods === 'object') {
    next.periods = { ...next.periods };
  }
  const periods = next?.periods && typeof next.periods === 'object' ? next.periods : next;
  for (const periodName of ['today', 'month', 'allTime']) {
    const period = periods?.[periodName];
    if (period && typeof period === 'object' && hasOwn(period, 'sessions')) {
      const filtered = filterReasonixSyntheticSessions(period.sessions);
      if (filtered !== period.sessions) {
        periods[periodName] = copy ? period : { ...period, sessions: filtered };
        if (copy) period.sessions = filtered;
      }
    }
  }
  return next;
}

function mergeUsagePart(previous, incoming) {
  const next = sanitizeUsagePeriods(incoming || {}, { copy: true });
  delete next.limits;
  if (!previous) return next;

  if (!hasOwn(next, 'history') && hasOwn(previous, 'history')) {
    next.history = previous.history;
  }

  const partial = !hasOwn(next, 'month') || !hasOwn(next, 'allTime');
  if (partial) {
    for (const field of PARTIAL_USAGE_CARRY_FIELDS) {
      if (!hasOwn(next, field) && hasOwn(previous, field)) {
        next[field] = previous[field];
      }
    }
  }
  return next;
}

function createDeviceState(options = {}) {
  const epoch = options.epoch ?? 0;
  const envelope = normalizedEnvelope(options.envelope);
  const onRecord = typeof options.onRecord === 'function' ? options.onRecord : null;
  const retainSnapshot = options.retainSnapshot !== false;
  const emitReturn = options.emitReturn !== false;
  let usagePart = null;
  let limitsPart = hasOwn(options, 'initialLimits') ? cloneValue(options.initialLimits) : undefined;
  let currentRecord = null;
  let hasCompleteUsageBaseline = false;
  let revision = 0;
  let stopped = false;

  function accepts(meta) {
    if (stopped) return false;
    return !hasOwn(meta, 'epoch') || meta.epoch === epoch;
  }

  function publish(source, reason) {
    if (!usagePart || stopped) return null;
    const record = { ...usagePart, ...envelope };
    if (limitsPart !== undefined) record.limits = limitsPart;
    currentRecord = retainSnapshot ? record : null;
    revision += 1;
    const meta = { revision, source, reason, epoch };
    if (onRecord) {
      onRecord(retainSnapshot ? cloneValue(record) : record, meta);
    }
    if (!retainSnapshot) {
      usagePart = null;
      return emitReturn ? record : null;
    }
    return emitReturn ? cloneValue(record) : null;
  }

  function updateUsage(summary, reason = 'usage', meta = {}) {
    if (!accepts(meta)) return null;
    if (!retainSnapshot) {
      if (meta.preview === true) return null;
      usagePart = sanitizeUsagePeriods(summary || {}, { copy: false });
      delete usagePart.limits;
      return publish('usage', reason);
    }
    usagePart = mergeUsagePart(usagePart, summary);
    if (hasOwn(usagePart, 'month') && hasOwn(usagePart, 'allTime')) {
      hasCompleteUsageBaseline = true;
    }
    if (meta.preview === true && !hasCompleteUsageBaseline) return null;
    return publish('usage', reason);
  }

  function updateLimits(limits, reason = 'limits', meta = {}) {
    if (!accepts(meta)) return null;
    limitsPart = cloneValue(limits);
    return publish('limits', reason);
  }

  function getSnapshot() {
    return currentRecord ? cloneValue(currentRecord) : null;
  }

  function stop() {
    stopped = true;
    if (!retainSnapshot) {
      usagePart = null;
      currentRecord = null;
    }
  }

  return {
    getSnapshot,
    stop,
    updateLimits,
    updateUsage
  };
}

module.exports = {
  cloneValue,
  createDeviceState
};
