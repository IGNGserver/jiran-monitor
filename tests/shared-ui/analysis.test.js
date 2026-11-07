'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  filterPeriodByAnalysis, modelAnalyticsRows, filterHistoryForAnalysis,
  modelHistoryComparison, topNWithOther, toCsv, modelDeviceRows, relatedSessions
} = require('../../src/shared-ui/core/analysis.js');
const { tokenMetricsForRow } = require('../../src/shared-ui/core/data.js');
const { configureViewContext } = require('../../src/shared-ui/core/viewContext.js');
const { renderModelWorkspace } = require('../../src/shared-ui/views/models.js');

function period() {
  return {
    totalTokens: 150, costUsd: 15,
    clients: { c1: 100, c2: 50 }, clientCosts: { c1: 10, c2: 5 },
    models: { m1: 120, m2: 30 }, modelCosts: { m1: 12, m2: 3 },
    modelOutputs: { m1: 20 }, modelCacheReads: { m1: 10 },
    clientModels: { c1: { m1: 80, m2: 20 }, c2: { m1: 40, m2: 10 } },
    clientModelCosts: { c1: { m1: 8, m2: 2 }, c2: { m1: 4, m2: 1 } },
    sessions: {
      s1: {
        client: 'c1', sessionId: 's1', deviceId: 'device-a', projectId: 'p1', projectKey: 'device-a:p1', projectLabel: 'Same folder',
        totalTokens: 100, costUsd: 10, models: { m1: 80, m2: 20 }, modelCosts: { m1: 8, m2: 2 }
      },
      s2: {
        client: 'c2', sessionId: 's2', deviceId: 'device-b', projectId: 'p1', projectKey: 'device-b:p1', projectLabel: 'Same folder',
        totalTokens: 50, costUsd: 5, models: { m1: 40, m2: 10 }, modelCosts: { m1: 4, m2: 1 }
      }
    }
  };
}

test('client+model and project+model filters use joint/model-scoped totals', () => {
  const joint = filterPeriodByAnalysis(period(), { analysisClient: 'c1', analysisModel: 'm1' });
  assert.equal(joint.totalTokens, 80);
  assert.equal(joint.costUsd, 8);
  assert.deepEqual(joint.models, { m1: 80 });
  const project = filterPeriodByAnalysis(period(), { analysisProject: 'device-a:p1', analysisModel: 'm1' });
  assert.equal(project.totalTokens, 80);
  assert.equal(project.costUsd, 8);
  assert.deepEqual(project.models, { m1: 80 });
  assert.equal(project.projects['device-a:p1'].tokens, 80);
  assert.equal(project.projects['device-a:p1'].label, 'Same folder');
  assert.equal(project.projects['device-b:p1'], undefined);
  assert.equal(project.analysisProvenance, 'session-derived');
});

test('model rows never turn a missing component map into a measured zero', () => {
  const rows = modelAnalyticsRows(period());
  assert.equal(rows.find((row) => row.key === 'm1').cacheHitPercent > 0, true);
  assert.equal(rows.find((row) => row.key === 'm2').cacheHitPercent, null);
  const unavailable = tokenMetricsForRow({
    models: { m1: 100 }, modelOutputs: { m1: 20 },
    metricAvailability: { components: true, modelComponents: false }
  }, 'model', 'm1');
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.cacheHitPercent, null);
  const session = tokenMetricsForRow({ sessions: { s1: { totalTokens: 100 } } }, 'session', 's1');
  assert.equal(session.available, false);
});

test('missing model cost and components stay unknown and session allocation is explicit', () => {
  const row = modelAnalyticsRows({
    models: { m: 100 }, modelCosts: {}, modelOutputs: { m: 20 }
  })[0];
  assert.equal(row.cost, null);
  assert.equal(row.costProvenance, 'unknown');
  assert.equal(row.costPerMillion, null);
  assert.equal(row.outputTokens, 20);
  assert.equal(row.cacheReadTokens, null);
  assert.equal(row.uncachedInputTokens, null);

  const sessions = relatedSessions({ sessions: {
    allocated: { totalTokens: 100, costUsd: 10, models: { m: 25 }, modelCosts: {} },
    partial: { totalTokens: 100, costUsd: 10, models: { m: 25 }, modelCosts: { other: 1 } },
    exact: { totalTokens: 100, costUsd: 10, models: { m: 25 }, modelCosts: { m: 3 } }
  } }, 'm');
  assert.deepEqual(sessions.map(({ key, cost, costEstimated, costProvenance }) => ({ key, cost, costEstimated, costProvenance })), [
    { key: 'allocated', cost: 2.5, costEstimated: true, costProvenance: 'allocated' },
    { key: 'partial', cost: null, costEstimated: false, costProvenance: 'unknown' },
    { key: 'exact', cost: 3, costEstimated: false, costProvenance: 'exact' }
  ]);
});

test('legacy client snapshots never present fleet models as client attribution', () => {
  const legacy = { ...period(), clientModels: {}, clientModelCosts: {} };
  const client = filterPeriodByAnalysis(legacy, { analysisClient: 'c1' });
  assert.equal(client.totalTokens, 100);
  assert.equal(client.costUsd, 10);
  assert.deepEqual(client.models, {});
  assert.equal(client.analysisProvenance, 'partial-joint');
  const joint = filterPeriodByAnalysis(legacy, { analysisClient: 'c1', analysisModel: 'm1' });
  assert.equal(joint.totalTokens, null);
  assert.equal(joint.costUsd, null);
  assert.deepEqual(joint.models, {});
  const modelOnly = filterPeriodByAnalysis(legacy, { analysisModel: 'm1' });
  assert.equal(modelOnly.totalTokens, 120);
  assert.equal(modelOnly.costUsd, 12);
});

test('project session derivation preserves partial and allocated cost provenance', () => {
  const source = period();
  source.sessions.s1.modelCosts = { m2: 2 };
  const partial = filterPeriodByAnalysis(source, { analysisProject: 'device-a:p1', analysisModel: 'm1' });
  assert.equal(partial.totalTokens, 80);
  assert.equal(partial.costUsd, null);
  assert.equal(partial.modelCosts.m1, null);
  source.sessions.s1.modelCosts = {};
  const allocated = filterPeriodByAnalysis(source, { analysisProject: 'device-a:p1', analysisModel: 'm1' });
  assert.equal(allocated.costUsd, 8);
  assert.equal(allocated.analysisCostEstimated, true);
  const allocatedRow = modelAnalyticsRows(allocated).find((row) => row.key === 'm1');
  assert.equal(allocatedRow.costProvenance, 'allocated');
  assert.equal(allocatedRow.costEstimated, true);
});
test('history filtering actually applies preferences and marks missing maps unknown', () => {
  const history = { daily: [
    { date: '2026-11-01', tokens: 20, cost: 2, perModel: { m1: { tokens: 10, cost: 1, outputTokens: 2 } } },
    { date: '2026-11-02', tokens: 30, cost: 3 },
    { date: '2026-11-03', tokens: 8, cost: 0.8, facts: [
      { client: 'c1', model: 'm1', tokens: 5, cost: 0.5, outputTokens: 2, tokenComponentsAvailable: true },
      { client: 'c1', model: 'm1', tokens: 3, cost: 0.3, outputTokens: null, tokenComponentsAvailable: false }
    ] },
    { date: '2026-11-04', tokens: 4, cost: 0.4, facts: [
      { client: 'c1', model: 'm1', tokens: 4, cost: null, outputTokens: 1, tokenComponentsAvailable: true }
    ] }
  ] };
  const filtered = filterHistoryForAnalysis(history, { analysisModel: 'm1' });
  assert.equal(filtered.daily[0].tokens, 10);
  assert.equal(filtered.daily[1].analysisUnknown, true);
  assert.equal(filtered.partial, true);
  const joint = filterHistoryForAnalysis(history, { analysisClient: 'c1', analysisModel: 'm1' });
  assert.equal(joint.daily[2].tokens, 8);
  assert.equal(joint.daily[2].outputTokens, null);
  assert.equal(joint.daily[2].metricAvailability.components, false);
  assert.equal(joint.daily[3].cost, null);
  assert.equal(modelHistoryComparison(history, 'm1', { client: 'c1' }).cost, null);
  const comparison = modelHistoryComparison(history, 'm1');
  assert.equal(comparison.days, 1);
  assert.equal(comparison.tokens, 10);
  assert.equal(comparison.partial, true);
});

test('model table has sibling actions, sortable headers, and client-scoped devices', () => {
  const stats = { devices: [{ deviceId: 'd1', hostname: 'One', periods: { today: period() } }] };
  assert.equal(modelDeviceRows(stats, 'today', 'm1', 'c1')[0].tokens, 80);
  assert.equal(modelDeviceRows(stats, 'today', 'm1', 'c1')[0].cost, 8);
  assert.equal(modelDeviceRows(stats, 'today', 'm1', 'c2')[0].tokens, 40);
  const current = { ...period(), analysisCostEstimated: true };
  configureViewContext({
    state: {
      prefs: { modelQuery: '', modelSort: 'tokens-desc', modelCompare: [], currency: 'USD', deviceFilter: '', period: 'today' },
      stats, customPeriod: null, history: null, historyDeviceId: ''
    },
    tr: (key) => key,
    escapeHtml: (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    activePeriod: () => current,
    viewStats: () => stats,
    panel: (title, body) => `<section>${title}${body}</section>`,
    emptyHtml: () => '',
    renderTokenMix: () => '',
    usageMetricCard: () => ''
  });
  const html = renderModelWorkspace(current);
  assert.match(html, /<th scope="col" aria-sort="descending"/);
  assert.match(html, /<div class="model-identity"><button type="button" class="model-link"/);
  assert.match(html, /data-label="stats\.cost">~\$/);
  assert.match(html, /class="notice model-comparison-note">analysis\.allocatedCost/);
  assert.doesNotMatch(html, /class="model-link"[^>]*><div class="model-identity"><strong[^>]*>[^<]+<\/strong><button/);
});

test('Top N + Other preserves each metric total and CSV blocks formulas', () => {
  const daily = [{ date: '2026-11-01', perModel: {
    a: { tokens: 10, cost: 1, activeTimeMs: 100 },
    b: { tokens: 20, cost: 2, activeTimeMs: 200 },
    c: { tokens: 30, cost: 3, activeTimeMs: 300 }
  } }];
  for (const [metric, expected] of [['tokens', 60], ['cost', 6], ['activeTime', 600]]) {
    const result = topNWithOther(daily, 'model', 2, metric);
    assert.deepEqual(result.keys, metric === 'tokens' ? ['c', 'b', '__other__'] : metric === 'cost' ? ['c', 'b', '__other__'] : ['c', 'b', '__other__']);
    assert.equal(result.days[0].total, expected);
    assert.equal(Object.values(result.days[0].values).reduce((sum, value) => sum + value, 0), expected);
    assert.equal(result.days[0].values.__other__, expected - (metric === 'tokens' ? 50 : metric === 'cost' ? 5 : 500));
  }
  const csv = toCsv([{ label: 'Model', value: 'model' }], [{ model: '=1+1' }, { model: ' safe' }]);
  assert.match(csv, /'=1\+1/);
  assert.match(csv, / safe/);
});
