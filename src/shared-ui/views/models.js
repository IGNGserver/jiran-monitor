import {
  modelAnalyticsRows,
  modelClientRows,
  modelDeviceRows,
  modelHistoryComparison,
  relatedSessions,
  analysisFilters
} from '../core/analysis.js';
import { clientLabel, tokenMetricsForRow } from '../core/data.js';
import { formatCost, formatNumber, formatRelative } from '../core/format.js';
import { tr, escapeHtml, appState, viewHelper } from '../core/viewContext.js';
import { historySource, renderSparkline } from './trends.js';
import { usageMetricCard } from './rows.js';

const panel = (...args) => viewHelper('panel')(...args);
const activePeriod = (...args) => viewHelper('activePeriod')(...args);
const viewStats = (...args) => viewHelper('viewStats')(...args);
const renderTokenMix = (...args) => viewHelper('renderTokenMix')(...args);
const emptyHtml = (key) => viewHelper('emptyHtml')(key);

const currency = () => appState().prefs.currency;
const cost = (value, estimated = false) => value === null || value === undefined ? '—' : `${estimated ? '~' : ''}${formatCost(value, currency())}`;
const percent = (value) => Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(1)}%` : '—';
const rate = (value) => Number.isFinite(value) ? `${formatNumber(value, { maximumFractionDigits: 1 })}%` : '—';

function modelTitle(model, { select = false } = {}) {
  const title = select
    ? `<button type="button" class="model-link" data-select-model="${escapeHtml(model)}"><strong title="${escapeHtml(model)}">${escapeHtml(model)}</strong></button>`
    : `<strong title="${escapeHtml(model)}">${escapeHtml(model)}</strong>`;
  return `<div class="model-identity">${title}<button type="button" class="copy-model" data-copy-model="${escapeHtml(model)}" aria-label="${escapeHtml(tr('analysis.copyModel'))}">⧉</button></div>`;
}

function comparisonTable(rows) {
  const selected = Array.isArray(appState().prefs.modelCompare) ? appState().prefs.modelCompare : [];
  const compared = selected.map((key) => rows.find((row) => row.key === key) || modelAnalyticsRows(activePeriod({ applyAnalysis: false })).find((row) => row.key === key)).filter(Boolean);
  if (!compared.length) return '';
  return panel(tr('analysis.compareTitle'), `<div class="table-scroll"><table class="data-table model-compare-table"><thead><tr><th>${escapeHtml(tr('analysis.model'))}</th><th>${escapeHtml(tr('stats.tokens'))}</th><th>${escapeHtml(tr('stats.cost'))}</th><th>${escapeHtml(tr('usage.output'))}</th><th>${escapeHtml(tr('usage.cacheRate'))}</th><th>${escapeHtml(tr('analysis.costPerMillion'))}</th><th><span class="sr-only">${escapeHtml(tr('actions.close'))}</span></th></tr></thead><tbody>${compared.map((row) => `<tr><td>${modelTitle(row.key)}</td><td>${formatNumber(row.tokens)}</td><td>${escapeHtml(cost(row.cost, row.costEstimated))}</td><td>${ownMetric(activePeriod(), 'modelOutputs', row.key) ? formatNumber(row.outputTokens) : '—'}</td><td>${rate(row.cacheHitPercent)}</td><td>${row.costPerMillion === null ? '—' : escapeHtml(cost(row.costPerMillion, row.costEstimated))}</td><td><button type="button" class="icon-text-btn" data-compare-model="${escapeHtml(row.key)}" aria-label="${escapeHtml(tr('analysis.removeCompare'))}">×</button></td></tr>`).join('')}</tbody></table></div>`, tr('analysis.compareHint'));
}

function ownMetric(period, field, key) {
  if (period?.metricAvailability?.components === false || period?.metricAvailability?.modelComponents === false) return false;
  return Boolean(period?.[field] && Object.prototype.hasOwnProperty.call(period[field], key));
}

function modelTable(rows) {
  const compare = Array.isArray(appState().prefs.modelCompare) ? appState().prefs.modelCompare : [];
  const ariaSort = (sort, direction = 'descending') => ` aria-sort="${appState().prefs.modelSort === sort ? direction : 'none'}"`;
  return `<div class="table-scroll"><table class="data-table model-workspace-table"><caption class="sr-only">${escapeHtml(tr('usage.tabs.models'))}</caption><thead><tr>
    <th scope="col"><span class="sr-only">${escapeHtml(tr('analysis.compare'))}</span></th>
    <th scope="col"${ariaSort('name-asc', 'ascending')}><button type="button" class="table-sort${appState().prefs.modelSort === 'name-asc' ? ' active' : ''}" data-model-sort="name-asc">${escapeHtml(tr('analysis.model'))}${appState().prefs.modelSort === 'name-asc' ? ' ↑' : ''}</button></th>
    ${[['tokens-desc', 'stats.tokens'], ['cost-desc', 'stats.cost'], ['output-desc', 'usage.output'], ['cache-desc', 'usage.cacheRead']].map(([sort, key]) => `<th scope="col"${ariaSort(sort)}><button type="button" class="table-sort${appState().prefs.modelSort === sort ? ' active' : ''}" data-model-sort="${sort}">${escapeHtml(tr(key))}${appState().prefs.modelSort === sort ? ' ↓' : ''}</button></th>`).join('')}
    <th scope="col">${escapeHtml(tr('usage.cacheRate'))}</th><th scope="col">${escapeHtml(tr('analysis.costPerMillion'))}</th><th scope="col">${escapeHtml(tr('analysis.clients'))}</th>
  </tr></thead><tbody>${rows.map((row) => {
    const selected = compare.includes(row.key);
    return `<tr class="model-data-row${selected ? ' is-compared' : ''}">
      <td><input type="checkbox" data-compare-model="${escapeHtml(row.key)}" ${selected ? 'checked' : ''} aria-label="${escapeHtml(tr('analysis.compareModel', { model: row.key }))}" /></td>
      <td>${modelTitle(row.key, { select: true })}</td>
      <td data-label="${escapeHtml(tr('stats.tokens'))}">${formatNumber(row.tokens)}</td>
      <td data-label="${escapeHtml(tr('stats.cost'))}">${escapeHtml(cost(row.cost, row.costEstimated))}</td>
      <td data-label="${escapeHtml(tr('usage.output'))}">${ownMetric(activePeriod(), 'modelOutputs', row.key) ? formatNumber(row.outputTokens) : '—'}</td>
      <td data-label="${escapeHtml(tr('usage.cacheRead'))}">${ownMetric(activePeriod(), 'modelCacheReads', row.key) ? formatNumber(row.cacheReadTokens) : '—'}</td>
      <td data-label="${escapeHtml(tr('usage.cacheRate'))}">${rate(row.cacheHitPercent)}</td>
      <td data-label="${escapeHtml(tr('analysis.costPerMillion'))}">${row.costPerMillion === null ? '—' : escapeHtml(cost(row.costPerMillion, row.costEstimated))}</td>
      <td data-label="${escapeHtml(tr('analysis.clients'))}">${formatNumber(row.clients)}</td>
    </tr>`;
  }).join('')}</tbody></table></div>`;
}

function renderModelTrend(comparison) {
  if (comparison?.available === false) return panel(tr('analysis.modelTrend'), `<p class="muted">${escapeHtml(tr('analysis.historyProjectUnavailable'))}</p>`);
  const daily = (comparison?.daily || []).slice(-30);
  if (!daily.length) return '';
  const partial = comparison.partial ? `<div class="page-notice" role="note">${escapeHtml(tr('analysis.historyPartial'))}</div>` : '';
  return `${partial}${panel(tr('analysis.modelTrend'), renderSparkline(daily, appState().prefs.trendsMetric === 'cost' ? 'cost' : 'tokens'), tr('trends.range.days', { count: daily.length }))}`;
}

function renderModelDetail(period) {
  const model = String(appState().prefs.selectedModelId || '');
  const rows = modelAnalyticsRows(period);
  const row = rows.find((item) => item.key === model) || modelAnalyticsRows(activePeriod({ applyAnalysis: false })).find((item) => item.key === model);
  if (!row) return `<button type="button" class="ghost-btn" data-close-model>← ${escapeHtml(tr('usage.tabs.models'))}</button>${emptyHtml('empty.models')}`;
  const metrics = tokenMetricsForRow(period, 'model', model, row.tokens);
  const filters = analysisFilters(appState().prefs);
  const comparison = modelHistoryComparison(historySource(), model, filters);
  const clients = modelClientRows(period, model);
  const deviceDistributionAvailable = !appState().customPeriod && !filters.project;
  const devices = deviceDistributionAvailable ? modelDeviceRows(viewStats(), appState().prefs.period, model, filters.client) : [];
  const allRelatedSessions = relatedSessions(period, model);
  const sessions = allRelatedSessions.slice(0, 20);
  const relatedProjects = new Map();
  for (const session of allRelatedSessions) {
    const projectId = String(session.projectId || session.projectLabel || '');
    const key = String(session.projectKey || (session.deviceId && projectId ? `${session.deviceId}:${projectId}` : projectId) || '');
    if (!key) continue;
    const currentProject = relatedProjects.get(key) || { key, name: session.projectLabel || key, tokens: 0, cost: 0, sessions: 0 };
    currentProject.tokens += Number(session.models?.[model] || 0);
    currentProject.cost += Number(session.modelCosts?.[model] || 0);
    currentProject.sessions += 1;
    relatedProjects.set(key, currentProject);
  }
  const compared = Array.isArray(appState().prefs.modelCompare) ? appState().prefs.modelCompare : [];
  return `<section class="model-detail-view">
    <div class="model-detail-header"><div><button type="button" class="ghost-btn" data-close-model>← ${escapeHtml(tr('usage.tabs.models'))}</button><h2>${modelTitle(model)}</h2><p class="muted">${escapeHtml(tr('analysis.detailHint'))}</p></div><div class="page-commands"><fluent-button appearance="secondary" type="button" data-compare-model="${escapeHtml(model)}">${escapeHtml(compared.includes(model) ? tr('analysis.removeCompare') : tr('analysis.addCompare'))}</fluent-button><fluent-button appearance="transparent" type="button" data-jump-view="settings" data-jump-section="consumption" data-jump-usage-tab="pricing" data-pricing-model="${escapeHtml(model)}">${escapeHtml(tr('nav.pricing'))}</fluent-button></div></div>
    <div class="usage-metric-strip model-detail-metrics">
      ${usageMetricCard(tr('stats.tokens'), formatNumber(row.tokens), comparison ? tr('analysis.previousPeriod', { value: percent(comparison.tokenChange) }) : '')}
      ${usageMetricCard(tr('stats.cost'), cost(row.cost, row.costEstimated), comparison ? tr('analysis.previousPeriod', { value: percent(comparison.costChange) }) : '')}
      ${usageMetricCard(tr('usage.output'), ownMetric(period, 'modelOutputs', model) ? formatNumber(row.outputTokens) : '—', ownMetric(period, 'modelOutputs', model) && row.tokens ? `${formatNumber((row.outputTokens / row.tokens) * 100, { maximumFractionDigits: 1 })}%` : '')}
      ${usageMetricCard(tr('usage.cacheRate'), rate(row.cacheHitPercent), ownMetric(period, 'modelCacheReads', model) ? `${formatNumber(row.cacheReadTokens)} ${tr('usage.cacheRead')}` : tr('data.unavailable'))}
      ${usageMetricCard(tr('analysis.costPerMillion'), row.costPerMillion === null ? '—' : cost(row.costPerMillion, row.costEstimated), tr('analysis.effectiveRate'))}
      ${usageMetricCard(tr('analysis.sessions'), formatNumber(row.sessions), tr('analysis.clientsCount', { count: row.clients }))}
    </div>
    ${comparison ? `<div class="notice model-comparison-note">${escapeHtml(tr('analysis.comparisonWindow', { days: comparison.days, previous: comparison.previousDays }))}</div>` : ''}
    ${row.costEstimated ? `<div class="notice model-comparison-note">${escapeHtml(tr('analysis.allocatedCost'))}</div>` : ''}
    <div class="model-detail-grid">
      <div>${panel(tr('usage.breakdown'), renderTokenMix(metrics))}${renderModelTrend(comparison)}</div>
      <div>${panel(tr('analysis.clients'), clients.length ? `<div class="model-source-list">${clients.map((client) => `<button type="button" class="model-source-row" data-filter-client="${escapeHtml(client.key)}"><span>${escapeHtml(clientLabel(client.key))}</span><strong>${formatNumber(client.tokens)}</strong><span>${escapeHtml(cost(client.cost, client.costEstimated))}</span></button>`).join('')}</div>` : `<p class="muted">${escapeHtml(tr('analysis.noJointData'))}</p>`)}
      ${panel(tr('home.devices'), !deviceDistributionAvailable ? `<p class="muted">${escapeHtml(tr('analysis.deviceRangeUnavailable'))}</p>` : devices.length ? `<div class="model-source-list">${devices.map((device) => `<button type="button" class="model-source-row" data-jump-view="devices" data-jump-device="${escapeHtml(device.key)}"><span>${escapeHtml(device.name)}</span><strong>${formatNumber(device.tokens)}</strong><span>${escapeHtml(cost(device.cost, device.costEstimated))}</span></button>`).join('')}</div>` : `<p class="muted">${escapeHtml(tr('data.unavailable'))}</p>`)}</div>
    </div>
    <div class="model-detail-grid">
      ${panel(tr('usage.tabs.projects'), relatedProjects.size ? `<div class="model-source-list">${[...relatedProjects.values()].sort((a, b) => b.tokens - a.tokens).map((project) => `<button type="button" class="model-source-row" data-filter-project="${escapeHtml(project.key)}"><span>${escapeHtml(project.name)}</span><strong>${formatNumber(project.tokens)}</strong><span>${formatNumber(project.sessions)}</span></button>`).join('')}</div><p class="muted tiny">${escapeHtml(tr('analysis.sessionDerived'))}</p>` : `<p class="muted">${escapeHtml(tr('data.unavailable'))}</p>`)}
      ${panel(tr('usage.tabs.sessions'), sessions.length ? `<div class="model-session-list">${sessions.map((session) => `<button type="button" class="model-source-row" data-select-session="${escapeHtml(session.key)}"><span>${escapeHtml(session.projectLabel || session.sessionId || session.key)}</span><strong>${formatNumber(session.tokens)}</strong><span title="${session.costEstimated ? escapeHtml(tr('analysis.allocatedCost')) : ''}">${escapeHtml(`${cost(session.cost, session.costEstimated)} · ${formatRelative(session.lastUsedAt || session.startedAt, appState().locale)}`)}</span></button>`).join('')}</div>` : `<p class="muted">${escapeHtml(tr('data.unavailable'))}</p>`)}
    </div>
  </section>`;
}

export function renderModelWorkspace(period = activePeriod()) {
  if (appState().prefs.selectedModelId) return renderModelDetail(period);
  const prefs = appState().prefs;
  const rows = modelAnalyticsRows(period, { query: prefs.modelQuery, sort: prefs.modelSort });
  const controls = `<div class="toolbar-row view-toolbar model-toolbar">
    <label class="field model-search-field"><span class="sr-only">${escapeHtml(tr('analysis.searchModels'))}</span><input id="modelSearch" data-model-search type="search" value="${escapeHtml(prefs.modelQuery || '')}" placeholder="${escapeHtml(tr('analysis.searchModels'))}" autocomplete="off" /></label>
    <label class="field inline-field"><span>${escapeHtml(tr('analysis.sort'))}</span><fluent-dropdown data-model-sort-select><fluent-listbox>${[['tokens-desc', 'stats.tokens'], ['cost-desc', 'stats.cost'], ['output-desc', 'usage.output'], ['cache-desc', 'usage.cacheRead'], ['name-asc', 'analysis.model']].map(([value, key]) => `<fluent-option value="${value}"${prefs.modelSort === value || (!prefs.modelSort && value === 'tokens-desc') ? ' selected' : ''}>${escapeHtml(tr(key))}</fluent-option>`).join('')}</fluent-listbox></fluent-dropdown></label>
    <fluent-button appearance="secondary" type="button" data-export-models ${rows.length ? '' : 'disabled'}>${escapeHtml(tr('analysis.exportCsv'))}</fluent-button>
    <span class="muted tiny">${escapeHtml(tr('analysis.results', { count: rows.length }))}</span>
  </div>`;
  const topModel = rows[0]?.key;
  const topComparison = topModel ? modelHistoryComparison(historySource(), topModel, analysisFilters(prefs)) : null;
  return `${controls}${rows.some((row) => row.costEstimated) ? `<div class="notice model-comparison-note">${escapeHtml(tr('analysis.allocatedCost'))}</div>` : ''}${comparisonTable(rows)}${topModel ? renderModelTrend(topComparison) : ''}${rows.length ? panel(tr('usage.tabs.models'), modelTable(rows), tr('analysis.rankingHint')) : emptyHtml('empty.models')}`;
}

export function modelRowsForExport() {
  return modelAnalyticsRows(activePeriod(), { query: appState().prefs.modelQuery, sort: appState().prefs.modelSort });
}
