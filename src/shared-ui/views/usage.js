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
  clientLabel,
  mapRows,
  modelColor,
  periodActivityCounts,
  periodTokenMetrics,
  projectRows,
  sessionRows
} from '../core/data.js';
import { tr, escapeHtml, appState, toolIconHtml, viewHelper } from '../core/viewContext.js';
import { renderListView, usageMetricCard } from './rows.js';
import { renderAnalysisScopeBar } from './analysis.js';
import { renderModelWorkspace } from './models.js';

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
  const componentsAvailable = period.metricAvailability?.components !== false;
  const cacheRate = !componentsAvailable || metrics.cacheHitPercent == null ? '—' : `${Math.round(metrics.cacheHitPercent)}%`;
  return `<div class="usage-metric-strip">
    ${usageMetricCard(tr('stats.tokens'), formatNumber(metrics.totalTokens), `${counts.tools} ${tr('usage.tabs.tools').toLowerCase()} · ${counts.models} ${tr('usage.tabs.models').toLowerCase()}`)}
    ${usageMetricCard(tr('usage.input'), componentsAvailable ? formatNumber(metrics.inputTokens) : '—', componentsAvailable ? `${formatNumber(metrics.uncachedInputTokens)} ${tr('usage.uncached').toLowerCase()}` : tr('data.unavailable'))}
    ${usageMetricCard(tr('usage.output'), componentsAvailable ? formatNumber(metrics.outputTokens) : '—')}
    ${usageMetricCard(tr('usage.cacheRate'), cacheRate, componentsAvailable ? `${formatNumber(metrics.cacheReadTokens)} ${tr('usage.cacheRead').toLowerCase()}` : tr('data.unavailable'))}
  </div>`;
}

export function renderTokenMix(metrics = {}) {
  if (metrics.available === false) return `<div class="usage-detail-empty muted tiny">${escapeHtml(tr('data.unavailable'))}</div>`;
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
    const openDetail = kind === 'session' ? `<fluent-button appearance="secondary" type="button" data-select-session="${escapeHtml(row.key)}">${escapeHtml(tr('analysis.openSession'))}</fluent-button>` : '';
    const detail = hasMetrics ? `<div class="usage-row-detail"><div class="usage-detail-label">${escapeHtml(tr('usage.breakdown'))}</div>${renderTokenMix(row.metrics)}${openDetail}</div>` : '';
    return detail
      ? `<details class="usage-table-row" data-row-key="${escapeHtml(row.key || row.name || '')}"><summary>${usageRowSummary(row, { icon: showIcon, detail: true })}</summary>${detail}</details>`
      : `<article class="usage-table-row" data-row-key="${escapeHtml(row.key || row.name || '')}">${usageRowSummary(row, { icon: showIcon })}</article>`;
  }).join('')}</div>`;
}

export function renderUsageModels(period) {
  return renderModelWorkspace(period);
}

function usageListControls(kind, query, sort) {
  const sortOptions = kind === 'sessions'
    ? [['recent-desc', 'analysis.recent'], ['tokens-desc', 'stats.tokens'], ['cost-desc', 'stats.cost']]
    : [['tokens-desc', 'stats.tokens'], ['cost-desc', 'stats.cost'], ['name-asc', 'analysis.name']];
  return `<div class="toolbar-row view-toolbar"><label class="field model-search-field"><span class="sr-only">${escapeHtml(tr(`analysis.search${kind === 'sessions' ? 'Sessions' : 'Projects'}`))}</span><input id="${kind}Search" data-usage-search="${kind}" type="search" value="${escapeHtml(query || '')}" placeholder="${escapeHtml(tr(`analysis.search${kind === 'sessions' ? 'Sessions' : 'Projects'}`))}" autocomplete="off" /></label><label class="field inline-field"><span>${escapeHtml(tr('analysis.sort'))}</span><fluent-dropdown data-usage-list-sort="${kind}"><fluent-listbox>${sortOptions.map(([value, key]) => `<fluent-option value="${value}"${sort === value ? ' selected' : ''}>${escapeHtml(tr(key))}</fluent-option>`).join('')}</fluent-listbox></fluent-dropdown></label></div>`;
}

export function renderUsageProjects(period) {
  const projectData = projectRows(period, { incomplete: Boolean(viewStats()?.projectsIncomplete) && appState().prefs.period === 'allTime' });
  const query = String(appState().prefs.projectQuery || '').trim().toLocaleLowerCase();
  const sort = appState().prefs.projectSort || 'tokens-desc';
  const rows = projectData.rows.filter((row) => !query || `${row.name} ${row.key}`.toLocaleLowerCase().includes(query)).sort((a, b) => sort === 'cost-desc' ? b.cost - a.cost : sort === 'name-asc' ? a.name.localeCompare(b.name) : b.value - a.value);
  const incompleteBanner = projectData.incomplete
    ? `<div class="notice warn" role="status">${escapeHtml(tr('projects.incomplete'))}</div>`
    : '';
  const rangeBanner = appState().customPeriod
    ? `<div class="notice" role="status">${escapeHtml(tr('usage.rangeDetailsUnavailable'))}</div>`
    : '';
  return `${rangeBanner}${incompleteBanner}${usageListControls('projects', appState().prefs.projectQuery, sort)}${panel(tr('usage.tabs.projects'), renderUsageMetricRows(rows, { kind: 'project', emptyKey: 'empty.projects' }))}`;
}

function renderSessionDetail(sessionData, key, period) {
  const row = sessionData.rows.find((item) => item.key === key)
    || (period?.sessions?.[key] ? sessionRows({ ...period, sessions: { [key]: period.sessions[key] } }).rows[0] : null);
  if (!row) return `<button type="button" class="ghost-btn" data-close-session>← ${escapeHtml(tr('usage.tabs.sessions'))}</button>${emptyHtml('empty.sessions')}`;
  const models = mapRows(row.raw?.models || {}, row.raw?.modelCosts || {}, { kind: 'model' });
  return `<section class="session-detail-view"><button type="button" class="ghost-btn" data-close-session>← ${escapeHtml(tr('usage.tabs.sessions'))}</button><div class="session-detail-heading"><h2>${escapeHtml(row.name)}</h2><span class="muted">${escapeHtml(row.key)}</span></div>${renderUsageMetricRows([row], { kind: 'session', showIcon: true })}<div class="session-facts"><span>${escapeHtml(tr('analysis.client'))}: <strong>${escapeHtml(clientLabel(row.client))}</strong></span><span>${escapeHtml(tr('analysis.project'))}: <strong>${escapeHtml(row.raw?.projectLabel || row.raw?.project || '—')}</strong></span><span>${escapeHtml(tr('analysis.recent'))}: <strong>${escapeHtml(formatRelative(row.lastUsedAt, appState().locale))}</strong></span></div>${panel(tr('usage.tabs.models'), renderUsageMetricRows(models, { kind: 'model' }))}</section>`;
}

export function renderUsageSessions(period) {
  const remote = appState().sessionAnalytics || {};
  const useRemote = remote.enabled === true && !appState().customPeriod;
  const sourcePeriod = useRemote
    ? { ...period, sessions: Object.fromEntries((remote.rows || []).map((row) => [row.key, row])) }
    : period;
  const sessionData = sessionRows(sourcePeriod, useRemote ? { limit: Math.max(200, remote.rows?.length || 0) } : {});
  if (appState().prefs.selectedSessionId) return renderSessionDetail(sessionData, appState().prefs.selectedSessionId, sourcePeriod);
  const query = String(appState().prefs.sessionQuery || '').trim().toLocaleLowerCase();
  const sort = appState().prefs.sessionSort || 'recent-desc';
  const rows = (remote.stale ? [] : sessionData.rows).filter((row) => useRemote || !query || `${row.key} ${row.name} ${row.sub} ${row.client}`.toLocaleLowerCase().includes(query)).map((row) => ({
    ...row,
    sub: `${row.sub || ''}${row.lastUsedAt ? ` · ${formatRelative(row.lastUsedAt, appState().locale)}` : ''}`
  })).sort((a, b) => (sort === 'tokens-desc' ? b.value - a.value : sort === 'cost-desc' ? b.cost - a.cost : Date.parse(b.lastUsedAt || 0) - Date.parse(a.lastUsedAt || 0)) || a.key.localeCompare(b.key));
  const rangeBanner = appState().customPeriod
    ? `<div class="notice" role="status">${escapeHtml(tr('usage.rangeDetailsUnavailable'))}</div>`
    : '';
  const shown = rows.length;
  const total = useRemote ? Number(remote.total || shown) : sessionData.total;
  const countNotice = total > shown
    ? `<div class="notice" role="status">${escapeHtml(tr(useRemote ? 'sessions.pageCount' : 'sessions.truncated', { shown, total }))}</div>`
    : '';
  const error = useRemote && remote.error ? `<div class="notice warn" role="alert">${escapeHtml(tr('error.generic'))}</div>` : '';
  const loading = useRemote && (remote.loading || remote.stale) && !rows.length ? viewHelper('loadingHtml')() : '';
  const more = useRemote && (remote.nextCursor || remote.error)
    ? `<div class="pager-row"><fluent-button appearance="secondary" type="button" data-load-more-sessions ${remote.loading ? 'disabled' : ''}>${escapeHtml(remote.nextCursor ? tr('sessions.loadMore') : tr('actions.retry'))}</fluent-button></div>`
    : '';
  return `${rangeBanner}${countNotice}${error}${usageListControls('sessions', appState().prefs.sessionQuery, sort)}${panel(tr('usage.tabs.sessions'), `${loading}${renderUsageMetricRows(rows, { kind: 'session', showIcon: true, emptyKey: 'empty.sessions' })}${more}`)}`;
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
  return `${renderAnalysisScopeBar()}<section class="page-intro usage-page-intro">${renderUsageSubnav()}</section><section class="usage-tabpanel" id="usage-tabpanel" role="tabpanel" aria-labelledby="usage-tab-${tab}" tabindex="0">${renderHistoryScopeNotice()}${renderUsageMetricStrip(period)}${body}</section>`;
}
