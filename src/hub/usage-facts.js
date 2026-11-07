'use strict';

const GRAPH_FACT_SOURCE = 'tokscaleGraph';
const EVENT_FACT_SOURCE = 'usageEventsBestEffort';
const MAX_DAILY_FACT_ROWS = 20_000;
const MAX_DAILY_FACTS_PER_DAY = 512;
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function token(value) {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(number(value))));
}

function cost(value) {
  if (value === null || value === undefined) return null;
  return Math.min(1e12, Math.max(0, number(value)));
}

function key(value, fallback, maxLength) {
  const normalized = String(value ?? '').trim();
  if (!normalized || RESERVED_KEYS.has(normalized.toLowerCase())) return fallback;
  return normalized.slice(0, maxLength);
}

function provenance(value) {
  return ['exact', 'estimated', 'unknown', 'bestEffort'].includes(value) ? value : 'unknown';
}

function factKey(fact) {
  return `${fact.date}\u0000${fact.client}\u0000${fact.model}\u0000${fact.provider}`;
}

function mergeFact(left, right) {
  const available = left.tokenComponentsAvailable && right.tokenComponentsAvailable;
  for (const field of ['tokens', 'messages']) left[field] += right[field];
  left.cost = left.cost === null || right.cost === null ? null : left.cost + right.cost;
  for (const field of ['outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'unclassifiedTokens']) {
    left[field] = available ? token(left[field]) + token(right[field]) : null;
  }
  left.tokenComponentsAvailable = available;
  if (left.provenance !== right.provenance) left.provenance = 'estimated';
  return left;
}

// Build the bounded relational write document at ingest time. deviceId is Hub
// attribution, not collector input: a graph fact never declares which device it
// belongs to. An absent `facts` member is an old history document and must not be
// replaced with an apparently complete empty graph partition.
function usageFactsFromHistory(deviceId, history, options = {}) {
  const id = key(deviceId, '', 191);
  const maxRows = Math.max(1, Math.min(MAX_DAILY_FACT_ROWS, Math.floor(number(options.maxRows) || MAX_DAILY_FACT_ROWS)));
  const perDay = Math.max(1, Math.min(MAX_DAILY_FACTS_PER_DAY, Math.floor(number(options.maxPerDay) || MAX_DAILY_FACTS_PER_DAY)));
  const result = {
    source: GRAPH_FACT_SOURCE,
    timeBasis: 'producerCalendarDay',
    timeZone: String(options.timeZone || ''),
    days: [],
    facts: [],
    truncated: false
  };
  if (!id || !history || typeof history !== 'object' || !Array.isArray(history.daily)) return result;
  let remaining = maxRows;
  for (const day of history.daily) {
    const date = String(day?.date || '').slice(0, 10);
    const parsedDate = new Date(`${date}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsedDate.getTime())
      || parsedDate.toISOString().slice(0, 10) !== date || !Object.prototype.hasOwnProperty.call(day || {}, 'facts')) continue;
    const merged = new Map();
    for (const entry of Array.isArray(day.facts) ? day.facts : []) {
      if (!entry || typeof entry !== 'object') continue;
      const available = entry.tokenComponentsAvailable === true;
      const nullableToken = (value) => available && value !== null && value !== undefined ? token(value) : null;
      const fact = {
        deviceId: id,
        date,
        client: key(entry.client, 'unknown', 100),
        model: key(entry.model || entry.modelId, 'unknown', 255),
        provider: key(entry.provider || entry.providerId, '', 255),
        tokens: token(entry.tokens),
        cost: cost(entry.cost),
        messages: token(entry.messages),
        outputTokens: nullableToken(entry.outputTokens),
        cacheReadTokens: nullableToken(entry.cacheReadTokens),
        cacheWriteTokens: nullableToken(entry.cacheWriteTokens),
        unclassifiedTokens: nullableToken(entry.unclassifiedTokens),
        tokenComponentsAvailable: available,
        provenance: provenance(entry.provenance),
        source: GRAPH_FACT_SOURCE,
        timeBasis: 'producerCalendarDay'
      };
      const identity = factKey(fact);
      const existing = merged.get(identity);
      if (existing) mergeFact(existing, fact);
      else merged.set(identity, fact);
    }
    const facts = [...merged.values()].sort((left, right) => factKey(left).localeCompare(factKey(right)));
    const retained = facts.slice(0, Math.min(perDay, remaining));
    const truncated = retained.length < facts.length;
    result.facts.push(...retained);
    result.days.push({
      deviceId: id,
      date,
      source: GRAPH_FACT_SOURCE,
      timeBasis: 'producerCalendarDay',
      timeZone: result.timeZone,
      factCount: retained.length,
      truncated
    });
    result.truncated = result.truncated || truncated;
    remaining -= retained.length;
    if (remaining <= 0) {
      // Coverage for later days is explicitly unknown/truncated, not zero usage.
      const remainingDays = history.daily.slice(history.daily.indexOf(day) + 1)
        .filter((entry) => Object.prototype.hasOwnProperty.call(entry || {}, 'facts'));
      if (remainingDays.length > 0) result.truncated = true;
      break;
    }
  }
  return result;
}

module.exports = {
  EVENT_FACT_SOURCE,
  GRAPH_FACT_SOURCE,
  MAX_DAILY_FACT_ROWS,
  MAX_DAILY_FACTS_PER_DAY,
  usageFactsFromHistory
};
