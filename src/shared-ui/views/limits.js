// Limits view: per-provider quota cards and their reset windows.
//
// Extracted from app.js so a view can be read and tested on its own. Renders
// from the app's shared state; anything host-specific goes through transport/.

import {
  formatRelative,
  formatReset
} from '../core/format.js';
import {
  ALL_PROVIDERS_OPTION_VALUE,
  clientLabel,
  limitCards,
  limitRemainingTone,
  statusRows
} from '../core/data.js';
import { tr, escapeHtml, appState, toolIconHtml, viewHelper } from '../core/viewContext.js';
import { canRenderManagementSection } from './settings.js';

const emptyHtml = (key) => viewHelper('emptyHtml')(key);
const panel = (...args) => viewHelper('panel')(...args);
const viewStats = (...args) => viewHelper('viewStats')(...args);
const usageMetricCard = (...args) => viewHelper('usageMetricCard')(...args);

export function localizeWindowLabel(window) {
  if (window?.kind === 'balanceUsd') return tr('limits.balanceUsd');
  if (window?.kind === 'balance') return tr('limits.balance');
  if (window?.kind === 'resetCredits') return tr('limits.resetCredits');
  if (window?.kind === 'named') return window?.label || tr('limits.window.named');
  if (window?.kind === 'credits') return tr('limits.credits');
  if (window?.kind === 'session') return tr('limits.window.session');
  if (window?.kind === 'weekly') return tr('limits.window.weekly');
  if (window?.kind === 'billing' || window?.kind === 'monthly') return tr('limits.window.monthly');
  return window?.label || '—';
}

export function groupAntigravityWindows(windows = []) {
  const groups = new Map();
  const ungrouped = [];
  const suffixPattern = /\s+(?:5-hour|weekly)$/i;

  for (const window of windows) {
    const rawLabel = String(window.label || '').trim();
    const match = rawLabel.match(suffixPattern);
    if ((window.kind === 'session' || window.kind === 'weekly') && match) {
      const groupName = rawLabel.replace(suffixPattern, '').trim() || 'General';
      const cleanWindow = {
        ...window,
        displayLabel: window.kind === 'session' ? tr('limits.window.session') : tr('limits.window.weekly')
      };
      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName).push(cleanWindow);
    } else {
      ungrouped.push(window);
    }
  }

  if (groups.size === 0) return null;
  return {
    groups: [...groups.entries()].map(([title, items]) => ({ title, items })),
    ungrouped
  };
}

export function renderSingleLimitWindow(window) {
  const isBalanceKind = window.kind === 'balance' || window.kind === 'balanceUsd';
  const showMeter = window.showMeter !== false && window.remaining != null && !isBalanceKind;
  const tone = showMeter ? limitRemainingTone(window.remaining) : 'unknown';
  // The bar can read either way round, but the tone keeps describing how much is
  // left, so "low quota" stays red whichever way the number is phrased.
  const meterFill = window.remaining;
  const primary = (isBalanceKind || !showMeter)
    ? (window.value || (window.remaining != null ? `${Math.round(window.remaining)}%` : '—'))
    : `${Math.round(meterFill)}%`;
  const metricHint = window.metric === 'credits' ? tr('limits.credits') : window.metric === 'resets' ? tr('limits.resetCredits') : '';
  const label = window.displayLabel || localizeWindowLabel(window);
  const isWide = window.kind === 'named' || window.kind === 'resetCredits' || isBalanceKind;

  return `
  <div class="limit-window${isWide ? ' limit-window-wide' : ''}">
    <div class="limit-window-label">
      <span>${escapeHtml(label)}${metricHint ? ` · ${escapeHtml(metricHint)}` : ''}</span>
      <strong class="remaining-tone remaining-tone-${tone}">${escapeHtml(String(primary))}</strong>
    </div>
    ${showMeter ? `<div class="meter meter-${tone}"><span style="width:${Math.max(0, Math.min(100, meterFill))}%"></span></div>` : '<div class="limit-balance-line"></div>'}
    <div class="row-sub" style="margin-top:8px">
      ${window.value && showMeter ? escapeHtml(window.value) : ''}
      ${window.detail ? escapeHtml(window.detail) : ''}
      ${window.resetsAt ? `${tr('limits.reset')} ${escapeHtml(formatReset(window.resetsAt, appState().locale))}` : ''}
    </div>
  </div>`;
}

export function renderLimitCardWindows(card) {
  if (!card.windows || !card.windows.length) {
    return renderSingleLimitWindow({ label: '—', remaining: null, showMeter: false });
  }

  if (card.provider === 'antigravity') {
    const agyGrouped = groupAntigravityWindows(card.windows);
    if (agyGrouped) {
      const groupsHtml = agyGrouped.groups.map((group) => `
        <div class="limit-window-group">
          <div class="limit-window-group-title">${escapeHtml(group.title)}</div>
          <div class="limit-window-group-items">
            ${group.items.map(renderSingleLimitWindow).join('')}
          </div>
        </div>
      `).join('');
      const ungroupedHtml = agyGrouped.ungrouped.length
        ? `<div class="limit-window-group-items" style="margin-top:8px">${agyGrouped.ungrouped.map(renderSingleLimitWindow).join('')}</div>`
        : '';
      return `<div class="limit-windows limit-windows-antigravity-grouped">${groupsHtml}${ungroupedHtml}</div>`;
    }
  }

  return `<div class="limit-windows">${card.windows.map(renderSingleLimitWindow).join('')}</div>`;
}

export function formatLimitBadge(card) {
  const status = String(card.status || '').toLowerCase();
  let badge;
  if (status === 'ok') {
    badge = `<span class="badge ok">${escapeHtml(tr('accounts.statusOk'))}</span>`;
  } else if (status === 'disabled') {
    badge = `<span class="badge">${escapeHtml(tr('accounts.statusDisabled'))}</span>`;
  } else if (status === 'unauthorized') {
    // Distinguish a retired plan from a stale credential: both need user action,
    // but only one is fixed by re-pasting. `region:'retired'` is set by the
    // Gemini adapter when Google reports the tier as no longer served.
    const retired = String(card.region || '').toLowerCase() === 'retired';
    badge = `<span class="badge warn bad">${escapeHtml(tr(retired ? 'limits.statusRetired' : 'limits.statusNeedsCredentials'))}</span>`;
  } else if (status === 'notconfigured') {
    badge = `<span class="badge">${escapeHtml(tr('limits.statusNotConfigured'))}</span>`;
  } else if (status === 'unavailable') {
    badge = `<span class="badge warn">${escapeHtml(tr('limits.statusUnavailable'))}</span>`;
  } else if (status === 'error') {
    badge = `<span class="badge warn bad">${escapeHtml(tr('limits.statusError'))}</span>`;
  } else {
    badge = `<span class="badge warn">${escapeHtml(card.status || tr('accounts.statusError'))}</span>`;
  }
  if (!card.stale) return badge;
  // Keep the failure reason visible. Showing only "stale" made a credential
  // expiry and a transient outage look identical; the stale marker is an
  // additional fact, not a replacement for the status.
  return `<span class="badge-stack">${badge}<span class="badge stale">${escapeHtml(tr('limits.stale'))}</span></span>`;
}

/**
 * One actionable line under a card that is not producing numbers. The point is
 * to name the fix ("update the credential") rather than echo the status, because
 * a bare "Error" leaves the user unable to tell an expired cookie from an
 * outage.
 */
export function formatLimitHint(card) {
  const status = String(card.status || '').toLowerCase();
  const staleHint = card.stale ? tr('limits.hintStale') : '';
  let hint = '';
  if (status === 'ok' || status === 'disabled') {
    // A stale healthy/disabled row still gets the last-known-values note below.
  } else if (status === 'unauthorized') {
    hint = String(card.region || '').toLowerCase() === 'retired'
      ? tr('limits.hintRetired')
      : tr('limits.hintNeedsCredentials');
  } else if (status === 'notconfigured') {
    hint = tr('limits.hintNotConfigured');
  } else if (status === 'sourceratelimited' || status === 'ratelimited') {
    hint = tr('limits.hintRateLimited');
  } else if (status === 'unavailable' || status === 'error') {
    hint = tr('limits.hintUnavailable');
  }
  return [hint, staleHint].filter(Boolean).join(' ');
}

/**
 * The scheduler's next due time, rendered only when it explains a card that is
 * not currently fresh. Older Hubs omit `nextRefreshAt`, so an absent value is
 * silent rather than an error.
 */
export function formatLimitNextRetry(card, locale = 'en') {
  const status = String(card?.status || '').toLowerCase();
  if (!card?.nextRefreshAt) return '';
  if (!card.stale && (status === 'ok' || status === 'disabled')) return '';
  return tr('limits.nextRetry', { time: formatRelative(card.nextRefreshAt, locale) });
}

export function renderLimitCards(cards, { compact = false, hideProvider = false } = {}) {
  if (!cards.length) return emptyHtml('empty.limits');
  return `
    <div class="limit-list${compact ? ' limit-list-compact' : ''}">
      ${cards.map((card) => {
        const account = card.accountEmail && card.name !== card.accountEmail
          ? card.accountEmail
          : '';
        const sub = [
          hideProvider ? '' : clientLabel(card.provider),
          card.plan || '',
          card.source ? String(card.source).toUpperCase() : '',
          account
        ].filter(Boolean).join(' · ');
        const nextRetry = formatLimitNextRetry(card, appState().locale);
        return `
        <article class="limit-card${compact ? ' limit-card-compact' : ''}">
          <div class="limit-head">
            <div class="row-main">
              ${toolIconHtml(card.provider)}
              <div class="row-copy">
                <div class="row-name">${escapeHtml(card.name)}</div>
                <div class="row-sub">${escapeHtml(sub)}</div>
              </div>
            </div>
            ${formatLimitBadge(card)}
          </div>
          <div class="limit-card-windows">${renderLimitCardWindows(card)}</div>
          ${(() => {
            const hint = formatLimitHint(card);
            // The jump targets the Management page's 账号 section, so it exists only
            // where that section renders: the Hub, for its owner.
            const canOpenAccounts = canRenderManagementSection('accounts')
              && appState().authorization?.authenticated === true
              && appState().authorization?.capabilities?.hubAccounts !== false;
            const action = canOpenAccounts && card.status !== 'ok'
              ? `<fluent-button appearance="transparent" type="button" class="limit-account-action" data-jump-view="settings" data-jump-section="accounts">${tr('management.section.accounts')}</fluent-button>`
              : '';
            return hint || action ? `<div class="limit-card-followup">${hint ? `<p class="muted tiny limit-card-hint">${escapeHtml(hint)}</p>` : ''}${action}</div>` : '';
          })()}
          <div class="limit-card-foot" title="${escapeHtml(card.updatedAt ? formatReset(card.updatedAt, appState().locale) : '')}">
            <span>${tr('limits.lastFetched', { time: formatRelative(card.updatedAt, appState().locale) })}</span>${nextRetry ? ` · ${nextRetry}` : ''}
          </div>
        </article>`;
      }).join('')}
    </div>
  `;
}

export function renderLimits() {
  const stats = viewStats();
  const allCards = limitCards(stats, appState().locale);
  const providers = [...new Set(allCards.map((card) => card.provider))].sort();
  const cards = (appState().limitProvider
    ? allCards.filter((card) => card.provider === appState().limitProvider)
    : allCards).sort((a, b) => {
      const rank = (card) => {
        const status = String(card.status).toLowerCase();
        return status === 'ok' ? 2 : status === 'disabled' ? 3 : card.stale ? 1 : 0;
      };
      return rank(a) - rank(b) || String(a.name).localeCompare(String(b.name));
    });
  const healthy = cards.filter((card) => !card.stale && String(card.status).toLowerCase() === 'ok').length;
  const stale = cards.filter((card) => card.stale).length;
  const attention = cards.filter((card) => !card.stale && !['ok', 'disabled'].includes(String(card.status).toLowerCase())).length;
  const healthSummary = `<div class="usage-metric-strip limit-health-strip">
    ${usageMetricCard(tr('limits.healthy'), healthy, '', healthy > 0 ? 'is-healthy' : '')}
    ${usageMetricCard(tr('limits.attention'), attention, '', attention > 0 ? 'is-attention' : '')}
    ${usageMetricCard(tr('limits.stale'), stale, '', stale > 0 ? 'is-stale' : '')}
  </div>`;
  const canRefreshAll = canRenderManagementSection('accounts')
    && appState().authorization?.authenticated === true
    && appState().authorization?.capabilities?.hubAccounts !== false;
  const refreshAction = canRefreshAll
    ? `<fluent-button appearance="transparent" type="button" class="ghost-btn" data-limits-refresh-all ${appState().limitsRefreshing ? 'disabled' : ''}>${tr('limits.refreshAll')}</fluent-button>`
    : '';
  const filter = `
    <div class="toolbar-row view-toolbar">
      <label class="field inline-field">
        <span>${tr('limits.filter')}</span>
        <fluent-dropdown data-limit-provider>
          <fluent-listbox>
            <fluent-option value="${ALL_PROVIDERS_OPTION_VALUE}"${appState().limitProvider ? '' : ' selected'}>${tr('filters.allProviders')}</fluent-option>
            ${providers.map((provider) => `<fluent-option value="${escapeHtml(provider)}"${provider === appState().limitProvider ? ' selected' : ''}>${escapeHtml(clientLabel(provider))}</fluent-option>`).join('')}
          </fluent-listbox>
        </fluent-dropdown>
      </label>
      <span class="panel-meta tiny">${tr('limits.accountsCount', { count: cards.length })}</span>
      ${refreshAction}
    </div>`;
  const healthPanel = appState().prefs.limitTab === 'health' ? renderStatus() : '';
  const grouped = new Map();
  cards.forEach((card) => {
    const key = String(card.provider || 'other');
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(card);
  });
  const providerGroups = [...grouped.entries()].map(([provider, rows]) => `
    <section class="provider-limit-group">
      <header class="provider-limit-head"><div class="row-main">${toolIconHtml(provider)}<h2>${escapeHtml(clientLabel(provider))}</h2></div><span class="muted tiny">${tr('limits.accountsCount', { count: rows.length })}</span></header>
      ${renderLimitCards(rows, { compact: true, hideProvider: true })}
    </section>`).join('');
  return `${healthSummary}${healthPanel}${filter}${providerGroups ? `<div class="provider-limit-groups">${providerGroups}</div>` : emptyHtml('empty.limits')}`;
}

export function renderStatus() {
  const rows = statusRows(viewStats(), appState().locale);
  if (!rows.length) return emptyHtml('empty.status');
  const summary = `
    <div class="summary-grid" style="margin-bottom:16px">
      <div class="summary-chip"><span class="summary-label">${tr('status.accounts')}</span><strong>${rows.length}</strong></div>
      <div class="summary-chip"><span class="summary-label">${tr('status.okCount')}</span><strong>${rows.filter((r) => r.health === 'ok').length}</strong></div>
      <div class="summary-chip"><span class="summary-label">${tr('status.warnCount')}</span><strong>${rows.filter((r) => r.health !== 'ok').length}</strong></div>
    </div>`;
  return panel(tr('nav.status'), summary + renderLimitCards(rows, { compact: true }));
}
