'use strict';

const { normalizeDeviceRecord } = require('../shared/usage');

const RESERVED_DYNAMIC_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function safeDynamicKey(value, fallback = 'unknown') {
  const key = String(value ?? '').trim();
  return key && !RESERVED_DYNAMIC_KEYS.has(key.toLowerCase()) ? key : fallback;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

const NUMERIC_FIELDS = [
  'totalTokens',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'messageCount',
  'payloadCostUsd',
  'credits'
];

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nonNegativeInteger(value) {
  return Math.max(0, Math.round(number(value)));
}

function normalizedTimestamp(value, fallback) {
  const date = new Date(value || fallback || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function components(source, fraction = 1) {
  const totalTokens = nonNegativeInteger(number(source.totalTokens) * fraction);
  const outputTokens = nonNegativeInteger(number(source.outputTokens) * fraction);
  const cacheReadTokens = nonNegativeInteger(number(source.cacheReadTokens) * fraction);
  const cacheWriteTokens = nonNegativeInteger(number(source.cacheWriteTokens) * fraction);
  const explicitInput = source.inputTokens === undefined ? null : number(source.inputTokens);
  const inputTokens = explicitInput === null
    ? Math.max(0, totalTokens - outputTokens - cacheReadTokens - cacheWriteTokens)
    : nonNegativeInteger(explicitInput * fraction);
  return {
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: nonNegativeInteger(number(source.reasoningTokens) * fraction),
    messageCount: nonNegativeInteger(number(source.messageCount) * fraction),
    payloadCostUsd: Math.max(0, number(source.costUsd) * fraction),
    credits: Math.max(0, number(source.credits) * fraction)
  };
}

function eventKey(candidate) {
  return `${candidate.client}\u0000${candidate.sessionId}\u0000${candidate.model}`;
}

function sessionCandidates(period, updatedAt) {
  const candidates = [];
  for (const session of Object.values(period.sessions || {})) {
    const client = safeDynamicKey(session?.client, '');
    const sessionId = String(session?.sessionId || '').trim();
    if (!client || !sessionId) continue;
    const totalTokens = nonNegativeInteger(session.totalTokens);
    const models = Object.entries(session.models || {}).filter(([, tokens]) => number(tokens) > 0);
    const rows = models.length > 0 ? models : [['unknown', totalTokens]];
    for (const [rawModel, rawTokens] of rows) {
      const model = safeDynamicKey(rawModel);
      const modelTokens = nonNegativeInteger(rawTokens);
      const fraction = totalTokens > 0 ? modelTokens / totalTokens : 1;
      const providerNames = Object.keys(session.providers || {}).filter(Boolean);
      const tokenComponents = components(session, fraction);
      tokenComponents.totalTokens = modelTokens;
      tokenComponents.payloadCostUsd = Math.max(0, number(
        session.modelCosts?.[model] ?? (number(session.costUsd) * fraction)
      ));
      // Same precedence as cost: the session already attributes this model's
      // credits exactly, so use that and never re-derive it by ratio. The ratio
      // fallback only applies to a session that reports a total but no split.
      tokenComponents.credits = Math.max(0, number(
        session.modelCredits?.[model] ?? (number(session.credits) * fraction)
      ));
      candidates.push({
        client,
        sessionId,
        model,
        provider: providerNames.length === 1 ? providerNames[0] : null,
        projectId: String(session.projectId || '').trim() || null,
        projectLabel: String(session.projectLabel || '').trim() || null,
        startedAt: normalizedTimestamp(session.startedAt, updatedAt),
        recordedAt: normalizedTimestamp(session.lastUsedAt, updatedAt),
        ...tokenComponents
      });
    }
  }
  return candidates;
}

function snapshotCandidates(period, updatedAt) {
  const candidates = [];
  const clientModels = period.clientModels || {};
  for (const [rawClient, models] of Object.entries(clientModels)) {
    const client = safeDynamicKey(rawClient, '');
    if (!client || !models || typeof models !== 'object') continue;
    for (const [rawModel, rawTokens] of Object.entries(models)) {
      const model = safeDynamicKey(rawModel);
      const modelTokens = nonNegativeInteger(rawTokens);
      if (modelTokens === 0) continue;
      const modelTotal = Math.max(modelTokens, nonNegativeInteger(period.models?.[model]));
      const fraction = modelTotal > 0 ? modelTokens / modelTotal : 1;
      const tokenComponents = components({
        totalTokens: modelTotal,
        outputTokens: period.modelOutputs?.[model],
        cacheReadTokens: period.modelCacheReads?.[model],
        cacheWriteTokens: period.modelCacheWrites?.[model],
        costUsd: period.modelCosts?.[model]
      }, fraction);
      // clientModelCosts is already scoped to this client+model. Passing it
      // through components() would apply the client share a second time.
      tokenComponents.payloadCostUsd = Math.max(0, number(
        period.clientModelCosts?.[client]?.[model]
          ?? (number(period.modelCosts?.[model]) * fraction)
      ));
      // Read from the client×model map only. There is no model-level credit
      // total to apportion a share of — credits are metered per provider, so a
      // ratio here would invent a split the provider never reported. A client
      // that publishes no credits contributes none, which is the correct answer
      // rather than a gap.
      tokenComponents.credits = Math.max(0, number(period.clientModelCredits?.[client]?.[model]));
      candidates.push({
        client,
        sessionId: `snapshot:${client}:${model}`,
        model,
        provider: null,
        projectId: null,
        projectLabel: null,
        startedAt: normalizedTimestamp(updatedAt),
        recordedAt: normalizedTimestamp(updatedAt),
        ...tokenComponents
      });
    }
  }

  if (candidates.length > 0) return candidates;

  for (const [rawClient, rawTokens] of Object.entries(period.clients || {})) {
    const client = safeDynamicKey(rawClient, '');
    const totalTokens = nonNegativeInteger(rawTokens);
    if (!client || totalTokens === 0) continue;
    candidates.push({
      client,
      sessionId: `snapshot:${client}:unknown`,
      model: 'unknown',
      provider: null,
      projectId: null,
      projectLabel: null,
      startedAt: normalizedTimestamp(updatedAt),
      recordedAt: normalizedTimestamp(updatedAt),
      ...components({
        totalTokens,
        outputTokens: period.clientOutputs?.[client],
        cacheReadTokens: period.clientCacheReads?.[client],
        cacheWriteTokens: period.clientCacheWrites?.[client],
        costUsd: period.clientCosts?.[client],
        // Exact, not apportioned: this row is the client's whole bucket, so the
        // client-level credit total belongs to it in full.
        credits: period.clientCredits?.[client]
      })
    });
  }
  return candidates;
}

// The all-time snapshot is the only monotonic source guaranteed on every
// synchronized payload. Some sync payloads intentionally omit allTime.sessions,
// so snapshot:* identifiers make that aggregate source explicit instead of
// pretending it came from an individual CLI conversation.
function usageCandidates(record, { normalized: alreadyNormalized = false } = {}) {
  // Internal callers can reuse an already-normalized snapshot. Raw boundaries
  // retain the defensive normalizer by default; null still means no baseline.
  const normalized = alreadyNormalized ? (record || {}) : normalizeDeviceRecord(record || {});
  const period = normalized.periods?.allTime || {};
  const updatedAt = normalized.updatedAt || normalized.receivedAt;
  const sessions = sessionCandidates(period, updatedAt);
  return sessions.length > 0 ? sessions : snapshotCandidates(period, updatedAt);
}

function deltaValue(current, previous) {
  const currentValue = number(current);
  const previousValue = number(previous);
  // Counters may reset after a local log cleanup or client reinstall. The new
  // counter becomes a fresh baseline; an append-only event must never be negative.
  return currentValue >= previousValue ? currentValue - previousValue : currentValue;
}

function calculateUsageEventDeltas(previousRecord, currentRecord, options = {}) {
  const previousByKey = new Map(usageCandidates(previousRecord, options).map((candidate) => [eventKey(candidate), candidate]));
  const candidates = usageCandidates(currentRecord, options);
  const events = [];
  for (const candidate of candidates) {
    const previous = previousByKey.get(eventKey(candidate));
    const delta = {};
    for (const field of NUMERIC_FIELDS) delta[field] = deltaValue(candidate[field], previous?.[field]);
    if (!NUMERIC_FIELDS.some((field) => delta[field] > 0)) continue;
    events.push({
      ...candidate,
      ...delta,
      counterReset: Boolean(previous && number(candidate.totalTokens) < number(previous.totalTokens))
    });
  }
  return { candidates, events };
}

function summarizeSessions(candidates) {
  const summaries = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.client}\u0000${candidate.sessionId}`;
    if (!summaries.has(key)) {
      summaries.set(key, {
        deviceId: null,
        client: candidate.client,
        sessionId: candidate.sessionId,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        messageCount: 0,
        costUsd: 0,
        startedAt: candidate.startedAt,
        lastUsedAt: candidate.recordedAt,
        models: {}
      });
    }
    const summary = summaries.get(key);
    for (const field of NUMERIC_FIELDS) {
      if (field === 'payloadCostUsd') summary.costUsd += number(candidate[field]);
      else summary[field] = number(summary[field]) + number(candidate[field]);
    }
    const model = safeDynamicKey(candidate.model);
    summary.models[model] = (hasOwn(summary.models, model) ? summary.models[model] : 0) + number(candidate.totalTokens);
    if (Date.parse(candidate.startedAt) < Date.parse(summary.startedAt)) summary.startedAt = candidate.startedAt;
    if (Date.parse(candidate.recordedAt) > Date.parse(summary.lastUsedAt)) summary.lastUsedAt = candidate.recordedAt;
  }
  return [...summaries.values()];
}

module.exports = { calculateUsageEventDeltas, summarizeSessions, usageCandidates };
