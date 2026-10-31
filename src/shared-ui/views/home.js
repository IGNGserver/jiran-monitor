// Overview view: the fleet summary a user lands on.
//
// Extracted from app.js so a view can be read and tested on its own. Renders from
// the app's shared state; anything host-specific goes through transport/.

import {
  formatCompact,
  formatCost,
  formatCredits,
  formatNumber
} from '../core/format.js';
import {
  clampHomeLimitAccountCount,
  clientLabel,
  countActiveDays,
  devicePlatformLabel,
  deviceRows,
  historyDaily,
  limitAttentionLevel,
  limitCards,
  limitRemainingTone,
  modelRows,
  toolRows
} from '../core/data.js';
import { tr, escapeHtml, appState, toolIconHtml, viewHelper } from '../core/viewContext.js';
import { historySource, renderSparkline, renderHeatmap, renderHistoryScopeNotice } from './trends.js';
import { formatLimitBadge, formatLimitHint } from './limits.js';

const emptyHtml = (key) => viewHelper('emptyHtml')(key);
const panel = (...args) => viewHelper('panel')(...args);
const viewStats = (...args) => viewHelper('viewStats')(...args);
const activePeriod = (...args) => viewHelper('activePeriod')(...args);
const formatDuration = (...args) => viewHelper('formatDuration')(...args);
const uiIcon = (...args) => viewHelper('uiIcon')(...args);
const segButtons = (...args) => viewHelper('segButtons')(...args);
const renderCompletenessNotice = (...args) => viewHelper('renderCompletenessNotice')(...args);

export function renderHome() {
  const period = activePeriod();
  const stats = viewStats();
  const tools = toolRows(period).slice(0, 5);
  const models = modelRows(period).slice(0, 5);
  const devices = deviceRows(stats, appState().customPeriod ? 'today' : appState().prefs.period).slice(0, 5);
  const limits = limitCards(stats, appState().locale)
    .sort((a, b) => {
      const rank = (card) => card.stale ? 1 : String(card.status || '').toLowerCase() === 'ok' ? 3 : 0;
      return rank(a) - rank(b) || String(a.name || '').localeCompare(String(b.name || ''));
    })
    .slice(0, clampHomeLimitAccountCount(appState().prefs.homeLimitAccountCount, 3));
  const history = historySource();
  const daily = historyDaily(history, 14);
  const heatDaily = historyDaily(history, 90);
  const historyDeviceId = String(appState().prefs.deviceFilter || '').trim();
  const historyPending = Boolean(historyDeviceId)
    && appState().historyLoading
    && appState().historyLoadingDeviceId === historyDeviceId;
  const historyError = appState().historyError
    && appState().historyErrorDeviceId === historyDeviceId;
  const hasHistory = daily.length > 0;
  const heatMetric = appState().prefs.heatmapMetric === 'tokens' ? 'tokens' : 'cost';
  const activeDaysWindow = appState().prefs.activeDaysWindow === 'year' ? 'year' : 'all';
  const summary = history?.summary || null;
  const displayActiveDays = hasHistory ? countActiveDays(history?.daily || [], activeDaysWindow) : null;
  const summaryActiveDays = Number(summary?.activeDays);
  const activeDaysValue = activeDaysWindow === 'year'
    ? displayActiveDays
    : (Number.isFinite(summaryActiveDays) ? summaryActiveDays : displayActiveDays);

  const totalTokens = Math.max(1, period.totalTokens || 0);

  // Tools: interactive visual proportion bars with client icons
  const toolsBody = tools.length
    ? `<div class="stack">${tools.map((row) => {
        const pct = Math.round((row.value / totalTokens) * 100);
        const credits = formatCredits(row.credits);
        const creditsText = credits ? ` · ${credits} ${tr('stats.credits')}` : '';
        return `
          <fluent-button appearance="secondary" type="button" class="home-interactive-row" data-jump-view="tool" data-jump-tool="${escapeHtml(row.key)}">
            <div class="row">
              <div class="row-main">
                ${toolIconHtml(row.key)}
                <div class="row-copy">
                  <div class="row-name">${escapeHtml(row.name)}</div>
                  <div class="row-sub">${row.value > 0 ? `${pct}% · ${escapeHtml(formatCost(row.cost, appState().prefs.currency))}` : ''}${creditsText ? escapeHtml(creditsText) : ''}</div>
                </div>
              </div>
              <div class="row-metrics">
                <div class="row-value">${row.value > 0 ? escapeHtml(formatCompact(row.value)) : escapeHtml(`${credits} ${tr('stats.credits')}`)}</div>
              </div>
            </div>
            <div class="share-meter"><span style="width:${Math.max(2, Math.min(100, pct))}%; background:${row.color}"></span></div>
          </fluent-button>
        `;
      }).join('')}</div>`
    : emptyHtml('empty.usage');

  // Models: interactive visual proportion bars with model colors
  const modelsBody = models.length
    ? `<div class="stack">${models.map((row) => {
        const pct = Math.round((row.value / totalTokens) * 100);
        return `
          <fluent-button appearance="secondary" type="button" class="home-interactive-row" data-jump-view="model" data-jump-usage-tab="models">
            <div class="row">
              <div class="row-main">
                <span class="swatch" style="background:${row.color}"></span>
                <div class="row-copy">
                  <div class="row-name">${escapeHtml(row.name)}</div>
                  <div class="row-sub">${pct}% · ${formatCost(row.cost, appState().prefs.currency)}</div>
                </div>
              </div>
              <div class="row-metrics">
                <div class="row-value">${formatCompact(row.value)}</div>
              </div>
            </div>
            <div class="share-meter"><span style="width:${Math.max(2, Math.min(100, pct))}%; background:${row.color}"></span></div>
          </fluent-button>
        `;
      }).join('')}</div>`
    : emptyHtml('empty.usage');

  // Devices: cards with status & quick jump
  const devicesBody = devices.length
    ? `<div class="stack">${devices.map((row) => `
        <fluent-button appearance="secondary" type="button" class="home-interactive-row" data-jump-view="device" data-jump-device="${escapeHtml(row.key)}">
          <div class="row">
            <div class="row-main">
              <span class="swatch" style="background:${row.color}"></span>
              <div class="row-copy">
                <div class="row-name">${escapeHtml(row.name)}</div>
                <div class="row-sub">${escapeHtml(row.platformDisplay || devicePlatformLabel(row.platform, row.osName, row.osVersion))}${row.stale ? ` · ${escapeHtml(tr('devices.stale'))}` : ''}</div>
              </div>
            </div>
            <div class="row-metrics">
              <div class="row-value">${formatCompact(row.value)}</div>
              <div class="row-cost">${formatCost(row.cost, appState().prefs.currency)}</div>
            </div>
          </div>
        </fluent-button>
      `).join('')}</div>`
    : emptyHtml('empty.usage');

  // Limits: graphical cards with progress bars and remaining tone
  const limitsBody = limits.length
    ? `<div class="home-limits-grid">${limits.map((card) => {
        const attention = limitAttentionLevel(card);
        const isAbnormal = attention !== 'none';
        const remaining = card.lowestRemaining;
        const tone = isAbnormal
          ? (attention === 'critical' ? 'critical' : 'warn')
          : (remaining == null ? 'unknown' : limitRemainingTone(remaining));
        const toneClass = `meter-${tone}${card.stale ? ' meter-stale' : ''}`;
        const pct = remaining == null ? 0 : Math.max(0, Math.min(100, Math.round(remaining)));
        const badgeHtml = isAbnormal ? formatLimitBadge(card) : '';
        const hintText = isAbnormal ? formatLimitHint(card) : '';
        const subParts = [
          clientLabel(card.provider),
          hintText || card.plan || ''
        ].filter(Boolean);
        const cardClass = `home-limit-card${isAbnormal ? ` has-attention attention-${attention}` : ''}`;
        return `
          <fluent-button appearance="secondary" type="button" class="${cardClass}" data-jump-view="limits"${hintText ? ` title="${escapeHtml(hintText)}"` : ''}>
            <div class="home-limit-head">
              <div class="home-limit-identity">
                ${toolIconHtml(card.provider)}
                <span class="home-limit-name">${escapeHtml(card.name)}</span>
              </div>
              <div class="home-limit-trail">
                ${badgeHtml}
                <span class="home-limit-val remaining-tone-${tone}">${remaining == null ? '—' : `${pct}%`}</span>
              </div>
            </div>
            <div class="home-limit-bar ${toneClass}"><span style="width:${pct}%"></span></div>
            ${subParts.length ? `<div class="home-limit-sub${hintText ? ' home-limit-sub-hint' : ''}">${escapeHtml(subParts.join(' · '))}</div>` : ''}
          </fluent-button>
        `;
      }).join('')}</div>`
    : emptyHtml('empty.limits');

  const activeTime = Number(summary?.activeTimeMs || 0);
  const completeness = renderCompletenessNotice(stats, appState().prefs.period);

  const viewAllAction = (targetView) => `<fluent-button appearance="secondary" type="button" class="panel-head-action" data-jump-view="${targetView}"><span>${tr(`nav.${targetView}`)}</span>${uiIcon('arrowUpRight')}</fluent-button>`;

  const sparklineHeader = hasHistory ? `
    <div class="home-sparkline-head">
      <div class="home-sparkline-pills">
        <div class="home-pill"><span class="home-pill-label">${tr('home.activeDays')}:</span><span class="home-pill-val">${formatNumber(activeDaysValue)}</span></div>
        <div class="home-pill"><span class="home-pill-label">${tr('home.streak')}:</span><span class="home-pill-val">${formatNumber(summary?.currentStreak || 0)}d</span></div>
        <div class="home-pill"><span class="home-pill-label">${tr('home.peakDay')}:</span><span class="home-pill-val">${formatCompact(summary?.peakDayTokens || 0)}</span></div>
        ${activeTime > 0 ? `<div class="home-pill"><span class="home-pill-label">${tr('home.activeTime')}:</span><span class="home-pill-val">${formatDuration(activeTime)}</span></div>` : ''}
      </div>
      ${viewAllAction('trends')}
    </div>
  ` : '';

  const historyStateBlock = historyPending
    ? `<div class="history-load-status" role="status"><fluent-spinner size="small">${tr('loading')}</fluent-spinner><span>${tr('loading')}</span></div>`
    : historyError
      ? `<div class="history-load-status" role="alert"><span>${escapeHtml(tr('error.generic'))}</span><fluent-button appearance="transparent" type="button" data-retry-history>${tr('actions.retry')}</fluent-button></div>`
      : `<div class="empty-inline" role="status">${tr('empty.history')}</div>`;
  const sparklineBlock = hasHistory
    ? `${sparklineHeader}${renderSparkline(daily)}`
    : historyStateBlock;

  const heatmapBody = heatDaily.length
    ? `
      <div class="toolbar-row">
        <fluent-radio-group class="seg" name="heatmapMetric" data-selection="heatmapMetric" value="${heatMetric}" orientation="horizontal" aria-label="${tr('home.heatmapMetric')}">
          ${segButtons([['tokens', tr('stats.tokens')], ['cost', tr('stats.cost')]], heatMetric, 'heatmap-metric')}
        </fluent-radio-group>
        <fluent-radio-group class="seg" name="activeDaysWindow" data-selection="activeDaysWindow" value="${activeDaysWindow}" orientation="horizontal" aria-label="${tr('home.activeDaysWindow')}">
          ${segButtons([['all', tr('home.activeDaysWindow.all')], ['year', tr('home.activeDaysWindow.year')]], activeDaysWindow, 'active-days-window')}
        </fluent-radio-group>
      </div>
      ${renderHeatmap(heatDaily, heatMetric)}
    `
    : emptyHtml('empty.history');

  return `
    ${completeness}
    ${renderHistoryScopeNotice()}
    <div class="overview-workspace">
      <div class="overview-activity${hasHistory ? '' : ' is-empty'}">${panel(tr('home.activity'), sparklineBlock, hasHistory ? tr('trends.range.days', { count: daily.length }) : '')}</div>
      <aside class="overview-health">${panel(tr('home.limits'), limitsBody, '', viewAllAction('limits'))}${panel(tr('home.devices'), devicesBody, '', viewAllAction('device'))}</aside>
      <div class="overview-breakdowns">${panel(tr('home.tools'), toolsBody, '', viewAllAction('tool'))}${panel(tr('home.models'), modelsBody, '', viewAllAction('model'))}</div>
    </div>
    ${heatDaily.length ? panel(tr('home.summary'), heatmapBody) : ''}
  `;
}
