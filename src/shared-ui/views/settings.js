// Management page: the single Administration destination.
//
// On the Hub this is one page consolidating three destinations that used to be
// separate views: 账号 (provider accounts), 消费 (subscriptions + pricing,
// supplied by app.js because those renderers share its ledger state) and the
// browser preferences. A web admin additionally gets 高级 (device data
// transfer).
//
// The desktop host renders none of those sections. Accounts, the ledger and
// browser preferences are Hub surfaces — credentials and shared records live on
// the Hub, and a desktop install has no business editing them — so the desktop
// page is only the three device groups from settingsDesktop.js (显示 / 行为 /
// 中枢连接). The appearance choices that group owns (language, theme, currency)
// stay reachable there because this machine's settings document is what the
// window, the locale and the cost formatters read.
//
// The settings-scaffolding classes (`settings-layout`, `settings-form`,
// `[data-settings-section]`) are what `settingsNavigation()` in core/fluent.js
// turns into the left-hand section rail, so every section is a top-level child
// of `.settings-layout` and the rail switches between them.
//
// The dispatched view id stays `settings`: it is the persisted-route and
// native-menu compatibility surface. Only its label became 管理.

import { isCapable } from '../transport/index.js';
import { tr, escapeHtml, appState, settingsOptionList } from '../core/viewContext.js';
import {
  clampHomeLimitAccountCount,
  CURRENCY_OPTIONS,
  LANGUAGE_OPTIONS,
  THEME_OPTIONS
} from '../core/data.js';
import { renderDesktopSettings } from './settingsDesktop.js';
import { renderTransferPanel } from './transfer.js';
import { renderAccounts } from './accounts.js';

function section(id, title, body, { active = false } = {}) {
  return `<section class="panel settings-section" data-settings-section="${escapeHtml(id)}"${active ? ' data-settings-active' : ''}>
      <div class="panel-head"><h2 class="panel-title">${escapeHtml(title)}</h2></div>
      <div class="settings-section-body">${body}</div>
    </section>`;
}

// The page's routed sections, per host. The desktop host has none: 账号 / 消费 /
// 偏好 are Hub surfaces (credentials and the shared ledger live on the Hub) and
// its rail is the three device groups, which have no URL. This is the single
// answer to "can this host render that section" — the router normalizes against
// it, and a view that links to a section asks it, so a jump can never land on a
// section that is not there.
const WEB_MANAGEMENT_SECTIONS = Object.freeze(['accounts', 'consumption', 'preferences', 'advanced']);
const DESKTOP_MANAGEMENT_SECTIONS = Object.freeze([]);

export function managementSections() {
  return isCapable('desktopSettings') ? DESKTOP_MANAGEMENT_SECTIONS : WEB_MANAGEMENT_SECTIONS;
}

export function canRenderManagementSection(id) {
  return managementSections().includes(id);
}

/** A section this host can actually render; anything else (an old bookmark, a
 *  persisted pref from another host) falls back to that host's first section. */
export function normalizeManagementSection(value) {
  const sections = managementSections();
  return sections.includes(value) ? value : (sections[0] || '');
}

function pageIntro(description) {
  const pageLabel = tr('settings.pageTitle');
  return `<section class="page-intro settings-page-intro"><div><div class="eyebrow">${escapeHtml(tr('settings.appTitle'))}</div><h2>${escapeHtml(pageLabel)}</h2><p>${escapeHtml(description)}</p></div></section>`;
}

function formatSessionTime(value) {
  const ms = Date.parse(String(value || ''));
  if (!Number.isFinite(ms)) return '';
  try {
    return new Intl.DateTimeFormat(appState().locale || undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(ms));
  } catch (_) {
    return new Date(ms).toISOString();
  }
}

function renderSessions() {
  if (isCapable('desktopSettings')) return '';
  const state = appState();
  if (state.authorization?.capabilities?.sessionAuth !== true) return '';
  const sessions = Array.isArray(state.sessions) ? state.sessions : [];
  const current = state.session || sessions.find((entry) => entry.current) || null;
  const currentId = current?.id || '';
  let body;
  if (state.sessionsLoading && sessions.length === 0) {
    body = `<p class="muted tiny">${escapeHtml(tr('settings.sessionLoading'))}</p>`;
  } else if (sessions.length === 0) {
    body = `<p class="muted tiny">${escapeHtml(state.sessionsError || tr('settings.sessionEmpty'))}</p>`;
  } else {
    body = `<div class="settings-session-list">${sessions.map((session) => {
      const name = session.deviceName || session.platform || tr('settings.sessionUnknownDevice');
      const meta = [
        session.platform || '',
        session.lastSeenAt ? tr('settings.sessionLastSeen', { time: formatSessionTime(session.lastSeenAt) }) : '',
        session.createdAt ? tr('settings.sessionCreated', { time: formatSessionTime(session.createdAt) }) : ''
      ].filter(Boolean).join(' · ');
      const isCurrent = Boolean(currentId && session.id === currentId) || session.current === true;
      return `<div class="settings-session-row">
        <div class="settings-session-copy">
          <strong>${escapeHtml(name)}</strong>
          ${isCurrent ? `<span class="settings-session-current">${escapeHtml(tr('settings.sessionCurrent'))}</span>` : ''}
          <span class="row-sub">${escapeHtml(meta)}</span>
        </div>
        <fluent-button appearance="transparent" type="button" class="ghost-btn" data-session-revoke="${escapeHtml(session.id)}">${escapeHtml(tr('settings.sessionRevoke'))}</fluent-button>
      </div>`;
    }).join('')}</div>`;
  }
  return `<div class="settings-sessions" data-settings-sessions>
    <div class="settings-sessions-head">
      <strong>${escapeHtml(tr('settings.sessions'))}</strong>
      <span class="muted tiny">${escapeHtml(tr('settings.sessionsHint'))}</span>
    </div>
    ${state.sessionsError && sessions.length > 0 ? `<p class="form-error">${escapeHtml(state.sessionsError)}</p>` : ''}
    ${body}
    <div class="settings-sessions-actions">
      <fluent-button appearance="transparent" type="button" class="ghost-btn" data-session-revoke-all>${escapeHtml(tr('settings.sessionRevokeAll'))}</fluent-button>
    </div>
  </div>`;
}

// Web host only: the desktop equivalent of these choices is the 显示 group.
function renderPreferences({ active = false } = {}) {
  const settingsDescription = tr('settings.pageDescription');
  // The form is itself the rail item (`.settings-form`); wrapping it in another
  // section would register two entries for one block.
  return `<form class="panel settings-form" data-web-settings-form data-draft-key="preferences" data-settings-section="preferences"${active ? ' data-settings-active' : ''}>
        <div class="panel-head"><h2 class="panel-title">${escapeHtml(tr('management.section.preferences'))}</h2><span class="panel-meta tiny">${escapeHtml(settingsDescription)}</span></div>
        <div class="form-grid">
          <label class="field"><span>${tr('settings.language')}</span><fluent-dropdown name="language">${settingsOptionList(LANGUAGE_OPTIONS, appState().prefs.language || 'auto')}</fluent-dropdown></label>
          <label class="field"><span>${tr('settings.theme')}</span><fluent-dropdown name="theme">${settingsOptionList(THEME_OPTIONS, appState().prefs.theme || 'system')}</fluent-dropdown></label>
          <label class="field"><span>${tr('desktop.settings.reduceMotion')}</span><fluent-dropdown name="reduceMotion">${settingsOptionList([['system', tr('desktop.settings.motionSystem')], ['on', tr('desktop.settings.motionOn')], ['off', tr('desktop.settings.motionOff')]], appState().prefs.reduceMotion || 'system')}</fluent-dropdown></label>
          <label class="field"><span>${tr('settings.currency')}</span><fluent-dropdown name="currency">${settingsOptionList(CURRENCY_OPTIONS, appState().prefs.currency || 'USD')}</fluent-dropdown></label>
          <label class="field"><span>${tr('settings.homeLimitAccountCount')}</span><input name="homeLimitAccountCount" type="number" min="1" max="12" step="1" value="${clampHomeLimitAccountCount(appState().prefs.homeLimitAccountCount, 3)}" /></label>
          <fluent-text-input class="field field-wide" name="secret" type="password" autocomplete="off" spellcheck="false" value="${escapeHtml(appState().secret || '')}">${tr('settings.secret')}</fluent-text-input>
        </div>
        <p class="muted tiny settings-form-hint">${escapeHtml(tr('settings.authHint'))}</p>
        ${renderSessions()}
        <div class="drawer-actions settings-actions"><fluent-button appearance="primary" type="submit" class="primary-btn" data-settings-submit disabled>${escapeHtml(tr('settings.savePage'))}</fluent-button><fluent-button appearance="transparent" type="button" class="ghost-btn" data-web-signout>${escapeHtml(tr('settings.signOut'))}</fluent-button></div>
      </form>`;
}

/**
 * @param {object} [sections]
 * @param {string} [sections.consumption]  The 消费 section body, rendered by app.js
 *        because its subscriptions/pricing renderers share app state.
 */
export function renderSettingsPage({ consumption = '' } = {}) {
  const desktopHost = isCapable('desktopSettings');
  const owner = appState().authorization?.authenticated === true;
  const capabilities = appState().authorization?.capabilities || {};
  // The host decides whether a section exists at all; the Hub's capabilities
  // only ever narrow that further. Gating on capability alone is what left a
  // client-mode desktop showing a Hub it does not administer.
  const accountsVisible = canRenderManagementSection('accounts') && capabilities.hubAccounts !== false;
  const consumptionVisible = canRenderManagementSection('consumption')
    && (capabilities.subscriptions !== false || (capabilities.pricing !== false && owner));
  const currentSection = appState().prefs.managementSection || 'accounts';
  // The active marker is a web-host routing concern. On desktop the rail also
  // owns the device groups (显示/行为/连接) that have no route, so it keeps
  // remembering the last clicked section instead.
  const active = (id) => (!desktopHost && currentSection === id ? { active: true } : {});
  return `${pageIntro(desktopHost ? tr('settings.desktopDescription') : tr('page.settings.description'))}
    <div class="settings-layout">
      ${accountsVisible ? section('accounts', tr('management.section.accounts'), renderAccounts(), active('accounts')) : ''}
      ${consumptionVisible && consumption ? section('consumption', tr('management.section.consumption'), consumption, active('consumption')) : ''}
      ${canRenderManagementSection('preferences')
        ? renderPreferences({ active: active('preferences').active === true })
        : ''}
      ${desktopHost
        ? `<div class="settings-desktop-stack" data-desktop-settings data-draft-key="desktop-settings">${renderDesktopSettings(appState().desktopSettings || {}, appState().desktopInfo || {})}</div>`
        : ''}
      ${!desktopHost && owner
        ? section('advanced', tr('management.section.advanced'), renderTransferPanel(), { active: currentSection === 'advanced' })
        : ''}
    </div>`;
}
