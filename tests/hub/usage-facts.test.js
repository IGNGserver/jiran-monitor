'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGraphResult } = require('../../src/shared/history');
const { usageFactsFromHistory } = require('../../src/hub/usage-facts');
const { MemoryRepository } = require('./memory-repository');

function graphEntry(overrides = {}) {
  return {
    client: 'claude', modelId: 'model-a', messages: 2, cost: 1,
    tokens: { input: 60, output: 20, cacheRead: 10, cacheWrite: 10 }, ...overrides
  };
}

function dailyFact(date, tokens) {
  return {
    deviceId: 'a', date, client: 'claude', model: 'm', provider: '', tokens,
    cost: 0, messages: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    unclassifiedTokens: 0, tokenComponentsAvailable: true, provenance: 'exact',
    source: 'tokscaleGraph', timeBasis: 'producerCalendarDay'
  };
}

function document(facts, extra = {}) {
  return {
    source: 'tokscaleGraph', facts,
    days: [...new Set(facts.map((fact) => fact.date))].map((date) => ({
      deviceId: 'a', date, source: 'tokscaleGraph', timeBasis: 'producerCalendarDay',
      factCount: facts.filter((fact) => fact.date === date).length, truncated: false
    })),
    truncated: false, ...extra
  };
}

test('legacy graph facts do not invent measured token components', () => {
  const legacy = parseGraphResult({ contributions: [{ date: '2026-11-06', clients: [graphEntry()] }] });
  assert.equal(legacy.contributions[0].facts[0].tokenComponentsAvailable, false);
  assert.equal(legacy.contributions[0].facts[0].outputTokens, null);
  assert.equal(legacy.contributions[0].facts[0].tokens, 100);
  const explicit = parseGraphResult({ contributions: [{ date: '2026-11-06', clients: [graphEntry({ tokenComponentsAvailable: true })] }] });
  assert.equal(explicit.contributions[0].facts[0].tokenComponentsAvailable, true);
  assert.equal(explicit.contributions[0].facts[0].outputTokens, 20);
  assert.equal(explicit.contributions[0].facts[0].unclassifiedTokens, 0);
});

test('fact normalization validates dates and reserved dynamic identities', () => {
  const result = usageFactsFromHistory('device-a', { daily: [
    { date: '2026-02-30', facts: [{ client: 'claude', model: 'm', tokens: 10 }] },
    { date: '2026-11-06', facts: [{ client: '__proto__', model: 'constructor', tokens: 10, tokenComponentsAvailable: false }] }
  ] });
  assert.equal(result.days.length, 1);
  assert.equal(result.facts[0].client, 'unknown');
  assert.equal(result.facts[0].model, 'unknown');
  assert.equal(result.facts[0].outputTokens, null);
  assert.equal(result.facts[0].cost, null);
});

test('daily fact replacement writes changed and missing days only', async () => {
  const store = new MemoryRepository();
  await store.replaceUsageDailyFacts('a', document([dailyFact('2026-11-01', 10), dailyFact('2026-11-02', 20)]));
  await store.replaceUsageDailyFacts('a', document([
    dailyFact('2026-11-01', 999), dailyFact('2026-11-02', 25)
  ], { changedDays: ['2026-11-02'] }));
  assert.equal(store.dailyFacts.find((fact) => fact.date === '2026-11-01').tokens, 10);
  assert.equal(store.dailyFacts.find((fact) => fact.date === '2026-11-02').tokens, 25);
  await store.replaceUsageDailyFacts('a', document([
    dailyFact('2026-11-01', 999), dailyFact('2026-11-02', 999), dailyFact('2026-11-03', 30)
  ], { changedDays: [] }));
  assert.equal(store.dailyFacts.find((fact) => fact.date === '2026-11-01').tokens, 10);
  assert.equal(store.dailyFacts.find((fact) => fact.date === '2026-11-03').tokens, 30);
  await store.replaceUsageDailyFacts('a', document([
    dailyFact('2026-11-02', 25), dailyFact('2026-11-03', 30)
  ], { changedDays: [], removeDays: ['2026-11-01'] }));
  assert.equal(store.dailyFacts.some((fact) => fact.date === '2026-11-01'), false);
});
