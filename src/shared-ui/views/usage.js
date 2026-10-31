// Usage view: per-tool drill-down plus the model/project/session breakdowns.
//
// Extracted from app.js so a view can be read and tested on its own. Renders from
// the app's shared state; anything host-specific goes through transport/.

import {
  formatCost,
  formatCredits,
  formatNumber,
  formatRelative
} from '../core/format.js';
import {
  mapRows,
  modelColor,
  modelRows,
  periodActivityCounts,
  periodTokenMetrics,
  projectRows,
  sessionRows
} from '../core/data.js';
import { tr, escapeHtml, appState, toolIconHtml, viewHelper } from '../core/viewContext.js';
import { renderListView, usageMetricCard } from './rows.js';

const panel = (...args) => viewHelper('panel')(...args);
const viewStats = (...args) => viewHelper('viewStats')(...args);
const activePeriod = (...args) => viewHelper('activePeriod')(...args);
const uiIcon = (...args) => viewHelper('uiIcon')(...args);
const toolRows = (...args) => viewHelper('toolRows')(...args);
const emptyHtml = (key) => viewHelper('emptyHtml')(key);
const shareBarHtml = (...args) => viewHelper('shareBarHtml')(...args);
const renderHistoryScopeNotice = (...args) => viewHelper('renderHistoryScopeNotice')(...args);

export function renderTools() {
  const period = activePeriod();
  const tools = toolRows(period).map((row) => ({ ...row, client: row.key }));
  if (!tools.length) return emptyHtml('empty.usage');
  const selectedId = appState().prefs.selectedToolId || tools[0].key;
  const selected = tools.find((row) => row.key === selectedId) || tools[0];
  const modelMap = period?.clientModels?.[selected.key] || {};
  const modelCostMap = period?.clientModelCosts?.[selected.key] || {};
  const models = mapRows(modelMap, modelCostMap, {
    labelFor: (key) => key,
    colorFor: (key) => modelColor(key)
  });
  const toolList = tools.map((row) => {
    const active = row.key === selected.key;
    const credits = formatCredits(row.credits);
    const ariaParts = [row.name];
    ariaParts.push(`${formatNumber(row.value)} tokens`, formatCost(row.cost, appState().prefs.currency));
    if (credits) ariaParts.push(`${credits} ${tr('stats.credits')}`);
    return `
      <button type="button" class="tool-select-row${active ? ' selected' : ''}" aria-pressed="${active}" aria-label="${escapeHtml(ariaParts.join(', '))}" data-select-tool="${escapeHtml(row.key)}">
        <div class="row-main">
          ${toolIconHtml(row.key)}
          <div class="row-copy">
            <div class="row-name">${escapeHtml(row.name)}</div>
        <div class="row-sub">${row.value > 0 ? Math.round((row.value / Math.max(1, period.totalTokens || 0)) * 100) : 0}%${credits ? ` · ${escapeHtml(`${credits} ${tr('stats.credits')}`)}` : ''}</div>
          </div>
        </div>
        <div class="row-side">
          <div class="row-value">${row.value > 0 ? escapeHtml(formatNumber(row.value)) : escapeHtml(`${credits} ${tr('stats.credits')}`)}</div>
          <div class="row-cost">${row.value > 0 ? escapeHtml(formatCost(row.cost, appState().prefs.currency)) : ''}</div>
        </div>
      </button>`;
  }).join('');

  return `
    <div class="grid-2 tools-layout">
      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">${tr('nav.tool')}</h2></div>
        <div class="tool-select-list" role="group" aria-label="${escapeHtml(tr('nav.tool'))}">${toolList}</div>
      </section>
      <section class="panel">
        <div class="panel-head">
          <h2 class="panel-title">${escapeHtml(selected.name)}</h2>
          <div class="panel-meta tiny">${tr('tools.models')}</div>
        </div>
        ${selected.metrics ? `<div class="usage-detail-label">${escapeHtml(tr('usage.breakdown'))}</div>${renderTokenMix(selected.metrics)}` : ''}
        ${selected.estimated ? `<div class="usage-measurement-note tiny">${escapeHtml(tr('usage.estimatedHint'))}</div>` : ''}
        <div class="usage-detail-label usage-detail-label-spaced">${escapeHtml(tr('usage.tabs.models'))}</div>
        ${models.length ? shareBarHtml(models.slice(0, 16), { clientIcons: false }) : emptyHtml('empty.usage')}
      </section>
    </div>
  `;
}



export function renderUsageMetricStrip(period) {
  const metrics = periodTokenMetrics(period);
  const counts = periodActivityCounts(period);
  const cacheRate = metrics.cacheHitPercent == null ? '—' : `${Math.round(metrics.cacheHitPercent)}%`;
  return `<div class="usage-metric-strip">
    ${usageMetricCard(tr('stats.tokens'), formatNumber(metrics.totalTokens), `${counts.tools} ${tr('usage.tabs.tools').toLowerCase()} · ${counts.models} ${tr('usage.tabs.models').toLowerCase()}`)}
    ${usageMetricCard(tr('usage.input'), formatNumber(metrics.inputTokens), `${formatNumber(metrics.uncachedInputTokens)} ${tr('usage.uncached').toLowerCase()}`)}
    ${usageMetricCard(tr('usage.output'), formatNumber(metrics.outputTokens))}
    ${usageMetricCard(tr('usage.cacheRate'), cacheRate, `${formatNumber(metrics.cacheReadTokens)} ${tr('usage.cacheRead').toLowerCase()}`)}
  </div>`;
}

export function renderTokenMix(metrics = {}) {
  const values = [
    [tr('usage.input'), metrics.inputTokens, 'var(--chart-series-1)'],
    [tr('usage.output'), metrics.outputTokens, 'var(--chart-series-2)'],
    [tr('usage.cacheRead'), metrics.cacheReadTokens, 'var(--chart-series-3)'],
    [tr('usage.cacheWrite'), metrics.cacheWriteTokens, 'var(--chart-series-4)'],
    [tr('usage.uncached'), metrics.uncachedInputTokens, 'var(--chart-series-5)']
  ];
  const total = Math.max(1, Number(metrics.totalTokens || 0));
  const visible = values.filter(([, value]) => Number(value || 0) > 0);
  if (!visible.length) return `<div class="usage-detail-empty muted tiny">${escapeHtml(tr('empty.usage'))}</div>`;
  return `<div class="token-mix" aria-label="${escapeHtml(tr('usage.breakdown'))}">
    ${visible.map(([label, value, color]) => {
      const amount = Number(value || 0);
      const percent = Math.max(2, Math.min(100, (amount / total) * 100));
      return `<div class="token-mix-row"><div class="token-mix-head"><span>${escapeHtml(label)}</span><strong>${formatNumber(amount)}</strong></div><div class="share-meter"><span style="width:${percent}%;background:${color}"></span></div></div>`;
    }).join('')}
  </div>`;
}

export function renderUsageSubnav() {
  const current = ['tools', 'models', 'projects', 'sessions'].includes(appState().prefs.usageTab)
    ? appState().prefs.usageTab
    : 'tools';
  return `<tm-tablist class="page-tabs" aria-label="${escapeHtml(tr('nav.usage'))}" role="tablist">
    ${['tools', 'models', 'projects', 'sessions'].map((tab) => `<fluent-tab id="usage-tab-${tab}" role="tab" aria-controls="usage-tabpanel" aria-selected="${current === tab ? 'true' : 'false'}" class="page-tab${current === tab ? ' active' : ''}" data-usage-tab="${tab}">${escapeHtml(tr(`usage.tabs.${tab}`))}</fluent-tab>`).join('')}
  </tm-tablist>`;
}

export function usageRowSummary(row, { icon = false, detail = '' } = {}) {
  // A hidden tool icon falls back to the colour swatch, so the row keeps its shape.
  const iconHtml = (icon && toolIconHtml(row.client || row.key))
    || `<span class="swatch" style="background:${row.color || 'var(--accent)'}"></span>`;
  const suffix = row.percent != null ? ` · ${Math.round(row.percent)}%` : '';
  return `<div class="usage-table-row-main"><div class="row-main">${iconHtml}<div class="row-copy"><div class="row-name">${escapeHtml(row.name)}</div><div class="row-sub">${escapeHtml(`${row.sub || ''}${suffix}`.replace(/^ · | · $/g, ''))}</div></div></div><div class="row-metrics"><div class="row-value">${formatNumber(row.value)}</div><div class="row-cost">${formatCost(row.cost, appState().prefs.currency)}</div></div>${detail ? `<span class="usage-row-chevron">${uiIcon('chevronDown')}</span>` : ''}</div>`;
}

export function renderUsageMetricRows(rows, { kind, showIcon = false, emptyKey = 'empty.usage' } = {}) {
  if (!rows.length) return renderListView([], emptyKey);
  return `<div class="usage-table" data-usage-kind="${escapeHtml(kind || '')}">${rows.map((row) => {
    const hasMetrics = row.metrics && row.metrics.totalTokens > 0;
    const detail = hasMetrics ? `<div class="usage-row-detail"><div class="usage-detail-label">${escapeHtml(tr('usage.breakdown'))}</div>${renderTokenMix(row.metrics)}</div>` : '';
    return detail
      ? `<details class="usage-table-row" data-row-key="${escapeHtml(row.key || row.name || '')}"><summary>${usageRowSummary(row, { icon: showIcon, detail: true })}</summary>${detail}</details>`
      : `<article class="usage-table-row" data-row-key="${escapeHtml(row.key || row.name || '')}">${usageRowSummary(row, { icon: showIcon })}</article>`;
  }).join('')}</div>`;
}

export function renderUsageModels(period) {
  const rows = modelRows(period);
  return panel(tr('usage.tabs.models'), renderUsageMetricRows(rows, { kind: 'model' }));
}

export function renderUsageProjects(period) {
  const projectData = projectRows(period, { incomplete: Boolean(viewStats()?.projectsIncomplete) && appState().prefs.period === 'allTime' });
  const incompleteBanner = projectData.incomplete
    ? `<div class="notice warn" role="status">${escapeHtml(tr('projects.incomplete'))}</div>`
    : '';
  const rangeBanner = appState().customPeriod
    ? `<div class="notice" role="status">${escapeHtml(tr('usage.rangeDetailsUnavailable'))}</div>`
    : '';
  return `${rangeBanner}${incompleteBanner}${panel(tr('usage.tabs.projects'), renderUsageMetricRows(projectData.rows, { kind: 'project', emptyKey: 'empty.projects' }))}`;
}

export function renderUsageSessions(period) {
  const sessionData = sessionRows(period);
  const truncated = sessionData.truncated
    ? `<div class="notice" role="status">${escapeHtml(tr('sessions.truncated', { shown: sessionData.rows.length, total: sessionData.total }))}</div>`
    : '';
  const rangeBanner = appState().customPeriod
    ? `<div class="notice" role="status">${escapeHtml(tr('usage.rangeDetailsUnavailable'))}</div>`
    : '';
  const rows = sessionData.rows.map((row) => ({
    ...row,
    sub: `${row.sub || ''}${row.lastUsedAt ? ` · ${formatRelative(row.lastUsedAt, appState().locale)}` : ''}`
  }));
  return `${rangeBanner}${truncated}${panel(tr('usage.tabs.sessions'), renderUsageMetricRows(rows, { kind: 'session', showIcon: true, emptyKey: 'empty.sessions' }))}`;
}

export function renderUsage() {
  const period = activePeriod();
  const tab = ['tools', 'models', 'projects', 'sessions'].includes(appState().prefs.usageTab)
    ? appState().prefs.usageTab
    : 'tools';
  const body = tab === 'tools'
    ? renderTools()
    : tab === 'models'
      ? renderUsageModels(period)
      : tab === 'projects'
        ? renderUsageProjects(period)
        : renderUsageSessions(period);
  return `<section class="page-intro usage-page-intro">${renderUsageSubnav()}</section><section class="usage-tabpanel" id="usage-tabpanel" role="tabpanel" aria-labelledby="usage-tab-${tab}" tabindex="0">${renderHistoryScopeNotice()}${renderUsageMetricStrip(period)}${body}</section>`;
}
