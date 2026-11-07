// Trends view: charts over the daily history series.
//
// Extracted from app.js so a view can be read and tested on its own. The module
// renders from the app's shared state and never reaches for host APIs — anything
// environment-specific goes through transport/.

import {
  formatCompact,
  formatCost,
  formatNumber
} from '../core/format.js';
import { ALL_DEVICES_OPTION_VALUE, clientLabel, deviceOptionValue, heatmapValue, historyDaily } from '../core/data.js';
import { filterHistoryForAnalysis, hasAnalysisFilters, topNWithOther } from '../core/analysis.js';
import { renderAnalysisScopeBar } from './analysis.js';
import {
  tr,
  escapeHtml,
  appState,
  viewHelper
} from '../core/viewContext.js';

// Helpers the app owns and installs on the view context. Binding them at module
// scope keeps the extracted render code byte-identical to what it replaced,
// instead of threading a context object through every helper.
const emptyHtml = (key) => viewHelper('emptyHtml')(key);
const panel = (...args) => viewHelper('panel')(...args);
const usageMetricCard = (...args) => viewHelper('usageMetricCard')(...args);
const formatDuration = (...args) => viewHelper('formatDuration')(...args);
const trendValue = (...args) => viewHelper('trendValue')(...args);
const formatTrendValue = (...args) => viewHelper('formatTrendValue')(...args);

export function renderCompletenessNotice(stats, periodName) {
  if (!stats) return '';
  const notes = [];
  if (periodName === 'allTime' && stats.projectsIncomplete) notes.push(tr('data.projectsIncomplete'));
  const omittedSessions = Number(stats.sessionDetailsOmitted?.[periodName] || 0);
  if (omittedSessions > 0) notes.push(tr('data.sessionsOmitted', { count: omittedSessions }));
  const omittedProjects = Number(stats.periodProjectsOmitted?.[periodName] || 0);
  if (omittedProjects > 0) notes.push(tr('data.projectsOmitted', { count: omittedProjects }));
  if (!notes.length) return '';
  return `<div class="notice warn completeness-notice" role="status"><strong>${escapeHtml(tr('data.partial'))}</strong><span>${escapeHtml(notes.join(' '))}</span></div>`;
}

export function renderHistoryScopeNotice() {
  const notices = [];
  if (appState().customPeriod) notices.push(tr('usage.customRangeGlobal'));
  return notices.map((notice) => `<div class="notice" role="status">${escapeHtml(notice)}</div>`).join('');
}


export function historySource() {
  const deviceId = String(appState().prefs.deviceFilter || '').trim();
  if (appState().history && appState().historyDeviceId === deviceId) return appState().history;
  return deviceId ? null : (appState().stats?.historyPreview || null);
}

export function historyHasBreakdown(history) {
  return (history?.daily || []).some((day) => {
    const clients = day?.perClient && Object.keys(day.perClient).length > 0;
    const models = day?.perModel && Object.keys(day.perModel).length > 0;
    return Boolean(clients || models);
  });
}

function niceCeiling(value, minimum = 1) {
  const n = Math.max(minimum, Number(value) || minimum);
  const exp = Math.floor(Math.log10(n));
  const base = 10 ** exp;
  const mantissa = n / base;
  const nice = mantissa <= 1 ? 1 : mantissa <= 2 ? 2 : mantissa <= 5 ? 5 : 10;
  return nice * base;
}

function yAxisScale(maxValue, tickCount = 4, minimum = 1) {
  const top = niceCeiling(maxValue, minimum);
  const ticks = [];
  for (let i = 0; i <= tickCount; i += 1) ticks.push((top * i) / tickCount);
  return { top, ticks };
}

function renderYAxis({ pad, width, height, top, ticks, formatTick = formatCompact }) {
  const innerH = height - pad.top - pad.bottom;
  const lines = ticks.map((value) => {
    const y = height - pad.bottom - (innerH * value) / Math.max(Number.EPSILON, top);
    return `
      <line class="grid-line" x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" />
      <text class="axis-label axis-y" x="${pad.left - 8}" y="${y + 3}" text-anchor="end">${escapeHtml(formatTick(value))}</text>
    `;
  }).join('');
  return lines;
}

function tipText(parts) {
  return parts.filter(Boolean).join(' · ');
}

function unavailableMetric(daily, metric) {
  return metric === 'cost' && daily.some((day) => day?.cost === null)
    ? `<div class="page-notice" role="note">${escapeHtml(tr('data.unavailable'))}</div>` : '';
}

export function renderSparkline(daily, metric = 'tokens') {
  if (!daily.length) return emptyHtml('empty.history');
  const unavailable = unavailableMetric(daily, metric);
  if (unavailable) return unavailable;
  const valueMetric = metric === 'cost' ? 'cost' : 'tokens';
  const width = 720;
  const height = 240;
  const pad = { top: 18, right: 16, bottom: 32, left: 52 };
  const values = daily.map((day) => Number(day[valueMetric] || 0));
  const minimum = valueMetric === 'cost' ? 0.0001 : 1;
  const { top, ticks } = yAxisScale(Math.max(minimum, ...values), 4, minimum);
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const slot = innerW / Math.max(1, daily.length);
  const barW = Math.max(4, slot - 4);
  const bars = daily.map((day, index) => {
    const tokens = Number(day.tokens || 0);
    const cost = Number(day.cost || 0);
    const value = Number(day[valueMetric] || 0);
    const h = Math.max(value > 0 ? 2 : 0, (innerH * value) / top);
    const x = pad.left + index * slot + (slot - barW) / 2;
    const y = height - pad.bottom - h;
    const tip = tipText([
      day.date || '',
      `${formatNumber(tokens)} ${tr('stats.tokens')}`,
      cost ? formatCost(cost, appState().prefs.currency) : ''
    ]);
    return `<g class="chart-bar"><rect class="bar-seg chart-hit" x="${x}" y="${value > 0 ? y : height - pad.bottom - 2}" width="${barW}" height="${value > 0 ? h : 2}" rx="3" fill="var(--accent)" opacity="${value > 0 ? 0.9 : 0.25}" data-tip="${escapeHtml(tip)}"></rect></g>`;
  }).join('');
  const labelDays = [daily[0], daily[Math.floor(daily.length / 2)], daily[daily.length - 1]].filter(Boolean);
  const labels = labelDays.map((day) => {
    const idx = daily.indexOf(day);
    const x = pad.left + idx * slot + slot / 2;
    return `<text class="axis-label" x="${x}" y="${height - 10}" text-anchor="middle">${escapeHtml(String(day.date || '').slice(5))}</text>`;
  }).join('');
  return `
    <div class="chart-wrap">
      <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Usage trend">
        ${renderYAxis({ pad, width, height, top, ticks, formatTick: (value) => formatTrendValue(value, valueMetric) })}
        <line class="axis-base" x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" />
        ${bars}
        ${labels}
      </svg>
    </div>
  `;
}

export function renderHeatmap(daily, metric = 'tokens') {
  if (!daily.length) return emptyHtml('empty.history');
  const unavailable = unavailableMetric(daily, metric);
  if (unavailable) return unavailable;
  const heatMetric = metric === 'cost' ? 'cost' : 'tokens';
  const values = daily.map((day) => heatmapValue(day, heatMetric));
  const max = Math.max(1, ...values);
  const cell = 14;
  const gap = 3;
  const first = daily[0]?.date;
  const startDow = first ? new Date(`${first}T00:00:00Z`).getUTCDay() : 0;
  const weeks = Math.ceil((daily.length + startDow) / 7);
  const left = 38;
  const top = 4;
  const width = left + weeks * (cell + gap) + 8;
  const height = top + 7 * (cell + gap) + 8;
  const weekdayFormatter = new Intl.DateTimeFormat(appState().locale, { weekday: 'short', timeZone: 'UTC' });
  const dowLabels = Array.from({ length: 7 }, (_, index) => weekdayFormatter.format(new Date(Date.UTC(2023, 0, index + 1))))
    .map((label, index) => `<text class="axis-label" x="${left - 5}" y="${top + index * (cell + gap) + cell - 2}" text-anchor="end">${escapeHtml(label)}</text>`)
    .join('');
  const cells = daily.map((day, index) => {
    const pos = index + startDow;
    const week = Math.floor(pos / 7);
    const dow = pos % 7;
    const tokens = Number(day.tokens || 0);
    const cost = Number(day.cost || 0);
    const value = heatmapValue(day, heatMetric);
    const ratio = value / max;
    const level = value <= 0 ? 0 : ratio < 0.25 ? 1 : ratio < 0.5 ? 2 : ratio < 0.75 ? 3 : 4;
    const x = left + week * (cell + gap);
    const y = top + dow * (cell + gap);
    const tip = tipText([
      day.date || '',
      `${formatNumber(tokens)} ${tr('stats.tokens')}`,
      cost ? formatCost(cost, appState().prefs.currency) : ''
    ]);
    return `<rect class="heat heat-${heatMetric} lvl-${level} chart-hit" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" data-tip="${escapeHtml(tip)}"></rect>`;
  }).join('');
  return `
    <div class="chart-wrap chart-wrap-heat">
      <svg class="chart-svg chart-svg-heat" style="min-width:${Math.max(320, width)}px;height:${height + 12}px" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(tr('home.summary'))}">
        ${dowLabels}
        ${cells}
      </svg>
    </div>
  `;
}

function trendSeriesLabel(stackBy, key) {
  if (key === '__other__') return tr('analysis.other');
  return stackBy === 'model' ? key : clientLabel(key);
}

export function renderStackedBars(daily, stackBy, metric = 'tokens') {
  if (!daily.length) return emptyHtml('empty.history');
  const unavailable = unavailableMetric(daily, metric);
  if (unavailable) return unavailable;
  const collapsed = topNWithOther(daily, stackBy, 8, metric);
  if (collapsed.totalKeys > 8) {
    const property = stackBy === 'model' ? 'perModel' : 'perClient';
    daily = collapsed.days.map((day) => ({
      ...day,
      [property]: Object.fromEntries(collapsed.keys.map((key) => [key, {
        tokens: metric === 'tokens' ? day.values[key] : 0,
        cost: metric === 'cost' ? day.values[key] : 0,
        activeTimeMs: metric === 'activeTime' ? day.values[key] : 0
      }]))
    }));
  }
  const width = 760;
  const height = 280;
  const pad = { top: 18, right: 16, bottom: 36, left: 52 };
  const seriesKeys = new Map();
  for (const day of daily) {
    const map = stackBy === 'model' ? (day.perModel || {}) : (day.perClient || {});
    for (const [key, value] of Object.entries(map)) {
      const amount = trendValue(value, metric);
      if (amount > 0) seriesKeys.set(key, (seriesKeys.get(key) || 0) + amount);
    }
  }
  let topKeys = [...seriesKeys.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, collapsed.totalKeys > 8 ? 9 : 8)
    .map(([key]) => key);
  const useTotalsFallback = topKeys.length === 0;
  if (useTotalsFallback) {
    topKeys = ['total'];
    for (const day of daily) {
      const amount = trendValue(day, metric);
      if (amount > 0) seriesKeys.set('total', (seriesKeys.get('total') || 0) + amount);
    }
  }

  const dayTotals = daily.map((day) => {
    if (useTotalsFallback) return trendValue(day, metric);
    const map = stackBy === 'model' ? (day.perModel || {}) : (day.perClient || {});
    return topKeys.reduce((sum, key) => sum + trendValue(map[key], metric), 0);
  });
  const minimum = metric === 'cost' ? 0.0001 : 1;
  const { top, ticks } = yAxisScale(Math.max(...dayTotals, minimum), 4, minimum);
  const slot = (width - pad.left - pad.right) / Math.max(1, daily.length);
  const barW = Math.max(4, slot - 4);
  const palette = ['--chart-series-1', '--chart-series-2', '--chart-series-3', '--chart-series-4', '--chart-series-5'];
  const colorMap = Object.fromEntries(topKeys.map((key, index) => [key, useTotalsFallback ? 'var(--accent)' : `var(${palette[index % palette.length]})`]));

  const bars = daily.map((day, index) => {
    const map = useTotalsFallback
      ? { total: day }
      : (stackBy === 'model' ? (day.perModel || {}) : (day.perClient || {}));
    let y = height - pad.bottom;
    const x = pad.left + index * slot + (slot - barW) / 2;
    const barsForDay = [];
    const tipLines = [];
    for (const key of topKeys) {
      const amount = trendValue(map[key], metric);
      if (amount <= 0) continue;
      const h = Math.max(1, ((height - pad.top - pad.bottom) * amount) / top);
      y -= h;
      const label = useTotalsFallback
        ? tr('stats.tokens')
        : trendSeriesLabel(stackBy, key);
      tipLines.push(`${label}: ${formatTrendValue(amount, metric)}`);
      barsForDay.push(`<rect class="bar-seg chart-hit" x="${x}" y="${y}" width="${barW}" height="${h}" fill="${colorMap[key]}" data-tip="${escapeHtml(tipText([day.date || '', `${label}: ${formatTrendValue(amount, metric)}`]))}"></rect>`);
    }
    const total = dayTotals[index];
    const totalTip = tipText([
      day.date || '',
      formatTrendValue(total, metric),
      Number(day.cost || 0) ? formatCost(day.cost, appState().prefs.currency) : '',
      ...tipLines
    ]);
    // Full-height invisible hit area so empty days and gaps still show the day total.
    const dayHitArea = `<rect class="chart-hit chart-hit-day" x="${x}" y="${pad.top}" width="${barW}" height="${height - pad.top - pad.bottom}" fill="transparent" data-tip="${escapeHtml(totalTip)}"></rect>`;
    const barGroup = barsForDay.length ? `<g class="chart-bar">${barsForDay.join('')}</g>` : '';
    return `${dayHitArea}${barGroup}`;
  }).join('');

  const labelDays = [daily[0], daily[Math.floor(daily.length / 2)], daily[daily.length - 1]].filter(Boolean);
  const labels = labelDays.map((day) => {
    const idx = daily.indexOf(day);
    const x = pad.left + idx * slot + slot / 2;
    return `<text class="axis-label" x="${x}" y="${height - 12}" text-anchor="middle">${escapeHtml(String(day.date || '').slice(5))}</text>`;
  }).join('');

  const legend = topKeys.map((key, index) => {
    const amount = seriesKeys.get(key) || 0;
    const total = topKeys.reduce((sum, seriesKey) => sum + (seriesKeys.get(seriesKey) || 0), 0);
    const percent = total ? Math.round((amount / total) * 100) : 0;
    return `
      <li class="trend-rank-row">
        <span class="trend-rank-index">${index + 1}</span>
        <span class="swatch" style="background:${colorMap[key]}"></span>
        <span class="trend-rank-name">${escapeHtml(useTotalsFallback ? tr('stats.tokens') : trendSeriesLabel(stackBy, key))}</span>
        <span class="trend-rank-value">${escapeHtml(formatTrendValue(amount, metric))}</span>
        <span class="trend-rank-share">${percent}%</span>
      </li>
    `;
  }).join('');

  return `
    <div class="trend-chart-layout">
      <div class="chart-wrap trend-plot">
        <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Stacked usage">
          ${renderYAxis({ pad, width, height, top, ticks, formatTick: (value) => formatTrendValue(value, metric) })}
          <line class="axis-base" x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" />
          ${bars}
          ${labels}
        </svg>
      </div>
      <aside class="trend-ranking" aria-label="${escapeHtml(stackBy === 'model' ? tr('nav.model') : tr('nav.tool'))}">
        <h3>${escapeHtml(stackBy === 'model' ? tr('nav.model') : tr('nav.tool'))}</h3>
        <ol>${legend || `<li>${emptyHtml('empty.history')}</li>`}</ol>
      </aside>
    </div>
  `;
}

function renderTrendBreakdownTable(daily, stackBy, metric) {
  const sourceKey = stackBy === 'model' ? 'perModel' : 'perClient';
  const totals = new Map();
  for (const day of daily) {
    for (const [key, value] of Object.entries(day?.[sourceKey] || {})) {
      const row = totals.get(key) || { tokens: 0, cost: 0, activeTimeMs: null };
      row.tokens += Number(value?.tokens || 0);
      row.cost += Number(value?.cost || 0);
      if (value && Object.hasOwn(value, 'activeTimeMs')) {
        row.activeTimeMs = Number(row.activeTimeMs || 0) + Number(value.activeTimeMs || 0);
      }
      totals.set(key, row);
    }
  }

  const hasSeriesMetric = [...totals.values()].some((row) => trendValue(row, metric) > 0);
  if (!hasSeriesMetric) {
    const aggregate = daily.reduce((row, day) => ({
      tokens: row.tokens + Number(day?.tokens || 0),
      cost: row.cost + Number(day?.cost || 0),
      activeTimeMs: row.activeTimeMs + Number(day?.activeTimeMs || 0)
    }), { tokens: 0, cost: 0, activeTimeMs: 0 });
    totals.clear();
    totals.set('', aggregate);
  }

  const rows = [...totals.entries()]
    .sort((a, b) => trendValue(b[1], metric) - trendValue(a[1], metric) || a[0].localeCompare(b[0]));
  const totalMetric = rows.reduce((sum, [, row]) => sum + trendValue(row, metric), 0);
  const label = stackBy === 'model' ? tr('nav.model') : tr('nav.tool');
  const title = tr('trends.tableTitle', { group: label });
  const rowHtml = rows.map(([key, row]) => {
    const value = trendValue(row, metric);
    const share = totalMetric > 0 ? Math.round((value / totalMetric) * 100) : 0;
    const name = key ? trendSeriesLabel(stackBy, key) : tr('trends.allUsage');
    return '<tr><th scope="row">' + escapeHtml(name)
      + '</th><td>' + escapeHtml(formatNumber(row.tokens))
      + '</td><td>' + escapeHtml(formatCost(row.cost, appState().prefs.currency))
      + '</td><td>' + (row.activeTimeMs == null ? '—' : escapeHtml(formatDuration(row.activeTimeMs)))
      + '</td><td>' + share + '%</td></tr>';
  }).join('');
  const body = '<div class="trends-table-wrap" tabindex="0" aria-label="' + escapeHtml(title) + '">'
    + '<table class="trends-breakdown-table"><thead><tr>'
    + '<th scope="col">' + escapeHtml(label) + '</th>'
    + '<th scope="col">' + escapeHtml(tr('stats.tokens')) + '</th>'
    + '<th scope="col">' + escapeHtml(tr('stats.cost')) + '</th>'
    + '<th scope="col">' + escapeHtml(tr('home.activeTime')) + '</th>'
    + '<th scope="col">' + escapeHtml(tr('trends.share')) + '</th>'
    + '</tr></thead><tbody>' + rowHtml + '</tbody></table></div>';
  return panel(title, body, tr(metric === 'activeTime' ? 'home.activeTime' : metric === 'cost' ? 'stats.cost' : 'stats.tokens'));
}

export function renderTrends() {
  const deviceId = String(appState().prefs.deviceFilter || '').trim();
  const devices = appState().stats?.devices || [];
  const historyLoading = Boolean(deviceId)
    && appState().historyLoading
    && appState().historyLoadingDeviceId === deviceId;
  const historyError = appState().historyError
    && appState().historyErrorDeviceId === deviceId;
  const history = historySource();
  const historyAnalysis = filterHistoryForAnalysis(history, appState().prefs, { custom: Boolean(appState().customPeriod) });
  const scopedHistory = { ...history, daily: historyAnalysis.daily };
  const daily = historyLoading || historyError
    ? []
    : historyDaily(scopedHistory, appState().prefs.trendsRange === 'all' ? 0 : appState().prefs.trendsRange);
  const hasHistory = daily.length > 0 && historyAnalysis.available;
  const trendMetric = ['tokens', 'cost', 'activeTime'].includes(appState().prefs.trendsMetric) ? appState().prefs.trendsMetric : 'tokens';
  const activeTimeUnavailable = trendMetric === 'activeTime' && !historyAnalysis.activeTimeAvailable;
  const rangeSummary = daily.reduce((summary, day) => ({
    tokens: summary.tokens + Number(day?.tokens || 0),
    cost: summary.cost + Number(day?.cost || 0),
    activeTime: summary.activeTime + Number(day?.activeTimeMs || 0)
  }), { tokens: 0, cost: 0, activeTime: 0 });
  const trendSummary = hasHistory ? `<div class="usage-metric-strip trend-summary">
    ${usageMetricCard(tr('home.activeDays'), formatNumber(daily.filter((day) => Number(day?.tokens || 0) > 0 || Number(day?.cost || 0) > 0).length))}
    ${usageMetricCard(tr('stats.tokens'), formatNumber(rangeSummary.tokens))}
    ${usageMetricCard(tr('stats.cost'), formatCost(rangeSummary.cost, appState().prefs.currency))}
    ${usageMetricCard(tr('home.activeTime'), historyAnalysis.activeTimeAvailable ? formatDuration(rangeSummary.activeTime) : '—')}
  </div>` : '';
  const selectedDevice = devices.find((device) => String(device.deviceId || '') === deviceId);
  const deviceOptions = [
    `<fluent-option value="${ALL_DEVICES_OPTION_VALUE}"${deviceId ? '' : ' selected'}>${escapeHtml(tr('filters.allDevices'))}</fluent-option>`,
    ...devices.map((device) => `<fluent-option value="${escapeHtml(deviceOptionValue(device.deviceId || ''))}"${String(device.deviceId || '') === deviceId ? ' selected' : ''}>${escapeHtml(device.hostname || device.deviceId || tr('devices.title'))}</fluent-option>`)
  ].join('');
  const trendSelect = (key, label, value, options) => '<label class="field trends-filter-group"><span>'
    + escapeHtml(label)
    + '</span><fluent-dropdown data-trends-setting="' + key + '" aria-label="' + escapeHtml(label) + '">'
    + '<fluent-listbox>' + options.map(([optionValue, optionLabel]) => '<fluent-option value="' + escapeHtml(optionValue) + '"'
      + (String(optionValue) === String(value) ? ' selected' : '')
      + '>' + escapeHtml(optionLabel) + '</fluent-option>').join('') + '</fluent-listbox>'
    + '</fluent-dropdown></label>';
  const historyContent = historyLoading
    ? `<div class="history-load-status" role="status"><fluent-spinner size="small">${escapeHtml(tr('loading'))}</fluent-spinner><span>${escapeHtml(tr('loading'))}</span></div>`
    : historyError
      ? `<div class="history-load-status" role="alert"><span>${escapeHtml(tr('error.generic'))}</span><fluent-button appearance="transparent" type="button" data-retry-history>${escapeHtml(tr('actions.retry'))}</fluent-button></div>`
      : !historyAnalysis.available
        ? `<div class="empty-inline" role="status">${escapeHtml(tr('analysis.historyProjectUnavailable'))}</div>`
        : activeTimeUnavailable
          ? `<div class="empty-inline" role="status">${escapeHtml(tr('analysis.historyActiveTimeUnavailable'))}</div>`
          : hasHistory ? renderStackedBars(daily, appState().prefs.trendsStack, trendMetric) : emptyHtml('empty.history');
  const historyFilterNotice = historyAnalysis.partial && hasAnalysisFilters(appState().prefs) && !appState().customPeriod
    ? `<div class="page-notice" role="note">${escapeHtml(tr('analysis.historyPartial'))}</div>`
    : '';
  return `
    ${renderAnalysisScopeBar()}
    ${renderHistoryScopeNotice()}
    ${historyFilterNotice}
    ${trendSummary}
    <div class="trends-toolbar" role="group" aria-label="${tr('nav.trends')}">
      <label class="field trends-device-filter"><span>${escapeHtml(tr('trends.device'))}</span><fluent-dropdown data-trends-device aria-label="${escapeHtml(tr('trends.device'))}" title="${escapeHtml(selectedDevice?.hostname || selectedDevice?.deviceId || tr('filters.allDevices'))}"><fluent-listbox>${deviceOptions}</fluent-listbox></fluent-dropdown></label>
      ${trendSelect('trendsRange', tr('trends.range'), appState().prefs.trendsRange, ['7', '30', '90', '365', 'all'].map((range) => [range, range === 'all' ? tr('trends.range.all') : tr('trends.range.days', { count: range })]))}
      ${trendSelect('trendsMetric', tr('trends.metric'), trendMetric, [['tokens', tr('stats.tokens')], ['cost', tr('stats.cost')], ['activeTime', tr('home.activeTime')]])}
      ${trendSelect('trendsStack', tr('trends.stack'), appState().prefs.trendsStack === 'model' ? 'model' : 'client', [['client', tr('trends.stack.client')], ['model', tr('trends.stack.model')]])}
    </div>
    ${panel(tr('nav.trends'), historyContent, hasHistory ? `${daily[0].date} – ${daily.at(-1).date}` : selectedDevice?.hostname || '')}
    ${hasHistory && !activeTimeUnavailable ? renderTrendBreakdownTable(daily, appState().prefs.trendsStack === 'model' ? 'model' : 'client', trendMetric) : ''}
  `;
}
