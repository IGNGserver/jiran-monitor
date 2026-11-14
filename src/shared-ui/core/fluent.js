import {
  Listbox,
  Tablist, TablistTemplate, TablistStyles
} from '../vendor/fluent.js';

// Upstream 3.1.3 queues descendant connection work that may run after an
// entire template has been replaced. An unattached root has no getElementById.
// Keep the official template/behavior, but discard that obsolete work.
class WorkspaceTablist extends Tablist {
  setTabs(options) { if (this.isConnected) super.setTabs(options); }
  changeTab(previous, next) { if (this.isConnected) super.changeTab(previous, next); }
}
WorkspaceTablist.define({ name: 'tm-tablist', template: TablistTemplate, styles: TablistStyles });

// Fluent Dropdown discovers its listbox by the official fluent-listbox tag,
// so keep that tag and guard the queued callback on its shared prototype. A
// rerender can disconnect slotted options before FAST delivers old slot work.
Listbox.prototype.optionsChanged = function optionsChanged(_previous, next) {
  if (!this.isConnected || !next) return;
  next.forEach((option, index) => {
    const internals = option?.elementInternals;
    if (!internals) return;
    internals.ariaPosInSet = String(index + 1);
    internals.ariaSetSize = String(next.length);
  });
};

// UI-only behavior. No host, data, credential or persistence access belongs here.
const reduceMotion = () => {
  const preference = document.documentElement.dataset.motion || 'system';
  return preference === 'reduce'
    || (preference !== 'full' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
};
let lastView = '';
let pendingNavigation = false;
let pendingDataUpdate = false;
const animatedChartViews = new Set();
let settingsSection = '';

export function syncFluentMotion(preference = 'system') {
  const motion = preference === 'on' || preference === 'reduce'
    ? 'reduce'
    : preference === 'off' || preference === 'full'
      ? 'full'
      : 'system';
  document.documentElement.dataset.motion = motion;
}

export function animateNavigation() {
  pendingNavigation = true;
}

export function animateDataUpdate() {
  pendingDataUpdate = true;
}

const pendingRadioSync = new WeakMap();

export function setFluentRadioGroupValue(group, value) {
  if (!group) return;
  const desired = String(value ?? '');
  const applyVisualState = () => {
    const radios = [...group.querySelectorAll('fluent-radio')];
    const match = radios.find((radio) => String(radio.value ?? '') === desired) || null;
    radios.forEach((radio) => {
      const selected = radio === match;
      radio.checked = selected;
      radio.toggleAttribute?.('checked', selected);
      radio.closest?.('.choice-option, .mode-toggle')?.classList?.toggle('selected', selected);
    });
    if (match) {
      group.setAttribute?.('value', desired);
      group.initialValue = desired;
    } else {
      group.removeAttribute?.('value');
      group.initialValue = '';
    }
    return match;
  };
  const match = applyVisualState();
  const isFluentRadioGroup = 'enabledRadios' in group;
  if (!isFluentRadioGroup || (Array.isArray(group.radios) && group.radios.length > 0)) {
    group.value = match ? match.value : desired;
    return;
  }

  // Fluent RadioGroup populates `this.radios` asynchronously via FAST's task
  // queue; deferring `group.value` avoids `checkedIndex = -1` during initial render.
  const token = (pendingRadioSync.get(group) || 0) + 1;
  pendingRadioSync.set(group, token);
  let attempts = 0;
  const synchronize = () => {
    if (pendingRadioSync.get(group) !== token || !group.isConnected) return;
    if (Array.isArray(group.radios) && group.radios.length > 0) {
      const currentMatch = applyVisualState();
      group.value = currentMatch ? currentMatch.value : desired;
      return;
    }
    attempts += 1;
    if (attempts < 30 && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(synchronize);
    }
  };
  queueMicrotask(synchronize);
}

export function setFluentDropdownValue(dropdown, value) {
  const desired = String(value ?? '');
  const options = [...dropdown.querySelectorAll('fluent-option')];
  const selected = options.find((option) => option.value === desired);
  const listbox = dropdown.listbox;
  const controlSlot = dropdown.shadowRoot?.querySelector('slot[name="control"]');
  const controlReady = dropdown.control?.isConnected && controlSlot?.assignedElements().includes(dropdown.control);
  if (listbox?.isConnected && selected && listbox.contains(selected) && controlReady) {
    dropdown.value = selected?.value ?? '';
    return;
  }

  // FAST delivers the slotted listbox after the current render turn. Set the
  // option state now, then use Dropdown's public value API once its listbox is
  // and generated control are ready; calling value before control slotting
  // throws in Fluent 3.1 and can strand the selected text outside the UI.
  options.forEach((option) => { option.selected = option === selected; });
  let synchronized = false;
  let attempts = 0;
  let frame = 0;
  let timeout = 0;
  const cleanup = () => {
    if (frame) cancelAnimationFrame(frame);
    if (timeout) window.clearTimeout(timeout);
    dropdown.removeEventListener('slotchange', onSlotChange);
  };
  const synchronize = () => {
    const currentListbox = dropdown.listbox;
    const currentControlSlot = dropdown.shadowRoot?.querySelector('slot[name="control"]');
    const currentControl = dropdown.control;
    const currentControlReady = currentControl?.isConnected
      && currentControlSlot?.assignedElements().includes(currentControl);
    if (dropdown.isConnected && currentListbox?.isConnected && selected && currentListbox.contains(selected) && currentControlReady) {
      dropdown.value = selected.value;
      synchronized = true;
      cleanup();
      return;
    }
    attempts += 1;
    if (attempts < 60) frame = requestAnimationFrame(synchronize);
  };
  const onSlotChange = () => queueMicrotask(() => requestAnimationFrame(synchronize));
  dropdown.addEventListener('slotchange', onSlotChange);
  frame = requestAnimationFrame(synchronize);
  timeout = window.setTimeout(() => {
    if (!synchronized) cleanup();
  }, 1000);
}

function motionDuration(token, fallback) {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--${token}`));
  return Number.isFinite(value) ? value : fallback;
}

function motionEasing(token, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${token}`).trim() || fallback;
}

function enter(element, kind = 'fade', delay = 0) {
  if (!element || reduceMotion() || typeof element.animate !== 'function') return;
  const frames = kind === 'fade'
    ? [{ opacity: 0 }, { opacity: 1 }]
    : [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }];
  element.animate(frames, {
    duration: motionDuration(kind === 'fade' ? 'durationFast' : 'durationGentle', kind === 'fade' ? 150 : 250),
    delay,
    easing: motionEasing('curveDecelerateMax', 'cubic-bezier(0.1, 0.9, 0.2, 1)')
  });
}

function animateCharts(root) {
  if (reduceMotion() || typeof Element.prototype.animate !== 'function') return;
  const easing = motionEasing('curveDecelerateMid', 'cubic-bezier(0.1, 0.9, 0.2, 1)');
  const duration = motionDuration('durationSlow', 300);
  const bars = [...root.querySelectorAll('.chart-bar')];
  bars.forEach((bar, index) => {
    bar.animate([
      { opacity: 0, transform: 'scaleY(0.04)' },
      { opacity: 1, transform: 'scaleY(1)' }
    ], { duration, delay: Math.min(index * 12, 180), easing });
  });
  const cells = [...root.querySelectorAll('.chart-svg-heat .heat')];
  cells.forEach((cell, index) => {
    cell.animate([
      { opacity: 0, transform: 'scale(0.8)' },
      { opacity: 1, transform: 'scale(1)' }
    ], {
      duration: motionDuration('durationGentle', 250),
      delay: Math.min(index * 3, 150),
      easing
    });
  });
}

function configureTabs(root) {
  root.querySelectorAll('tm-tablist').forEach((list, listIndex) => {
    const tabs = [...list.querySelectorAll('fluent-tab')];
    tabs.forEach((tab, index) => {
      tab.id ||= `${list.id || `view-tabs-${listIndex}`}-${index}`;
    });
    const active = tabs.find((tab) => tab.classList.contains('active')) || tabs[0];
    if (active) list.activeid = active.id;
    tabs.forEach((tab) => { tab.tabIndex = tab === active ? 0 : -1; });
  });
}

function settingsNavigation(root) {
  const layout = root.querySelector('.settings-layout');
  if (!layout || layout.querySelector('.settings-section-nav')) return;
  const sections = [...layout.querySelectorAll('.settings-form, .desktop-settings-group, [data-settings-section]')];
  const nav = document.createElement('nav');
  nav.className = 'settings-section-nav';
  nav.setAttribute('aria-label', document.getElementById('pageTitle').textContent);
  const body = document.createElement('div');
  body.className = 'settings-sections';
  const activate = (section, link, nav_, body_) => {
    nav_.querySelectorAll('a').forEach((item) => item.toggleAttribute('aria-current', item === link));
    link.setAttribute('aria-current', 'location');
    body_.querySelectorAll(':scope > section, :scope > form').forEach((item) => { item.hidden = item !== section; });
    section.querySelector('h2')?.focus({ preventScroll: true });
  };
  sections.forEach((section, index) => {
    section.id = `settings-section-${section.dataset.settingsSection || section.dataset.desktopGroup || index}`;
    const link = document.createElement('a');
    link.href = `#${section.id}`;
    link.id = `nav-${section.id}`;
    link.textContent = section.querySelector('h2')?.textContent || '';
    link.className = 'settings-section-link';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      settingsSection = section.id;
      activate(section, link, nav, body);
      // The app owns routing/prefs; the rail only reports what was chosen.
      section.dispatchEvent(new CustomEvent('settings-section-change', {
        bubbles: true,
        detail: { section: section.dataset.settingsSection || section.dataset.desktopGroup || '' }
      }));
    });
    nav.append(link);
    // Retain the desktop settings boundary and per-section draft key after reparenting.
    if (section.dataset.desktopGroup) {
      section.setAttribute('data-desktop-settings', '');
      if (!section.hasAttribute('data-draft-key')) {
        section.setAttribute('data-draft-key', `desktop-settings-${section.dataset.desktopGroup}`);
      }
    }
    const title = section.querySelector('h2');
    if (title) title.tabIndex = -1;
    body.append(section);
  });
  layout.replaceChildren(nav, body);
  // The app marks which section a route asked for; the remembered click keeps
  // the desktop groups (which have no route) stable across re-renders.
  const preferred = sections.find((section) => section.hasAttribute('data-settings-active'))
    || sections.find((section) => section.id === settingsSection)
    || sections[0];
  sections.forEach((section) => { section.hidden = section !== preferred; });
  nav.querySelector(`[href="#${preferred?.id}"]`)?.setAttribute('aria-current', 'location');
}

export function finishFluentRender(root, view) {
  configureTabs(document);
  settingsNavigation(root);
  root.querySelectorAll('fluent-dropdown').forEach((dropdown) => {
    const selected = dropdown.querySelector('fluent-option[selected]');
    if (selected) setFluentDropdownValue(dropdown, selected.value);
  });
  // Use Fluent status badges and message bars while leaving domain charts and
  // data rows as semantic lists, tables, and custom visualizations.
  root.querySelectorAll('.badge:not(fluent-badge)').forEach((badge) => {
    const fluentBadge = document.createElement('fluent-badge');
    fluentBadge.appearance = 'tint';
    fluentBadge.shape = 'rounded';
    fluentBadge.size = 'small';
    fluentBadge.color = badge.classList.contains('bad') || badge.classList.contains('critical')
      ? 'danger'
      : badge.classList.contains('warn')
        ? 'warning'
        : badge.classList.contains('ok')
          ? 'success'
          : 'subtle';
    fluentBadge.className = badge.className;
    fluentBadge.style.cssText = badge.style.cssText;
    fluentBadge.append(...badge.childNodes);
    badge.replaceWith(fluentBadge);
  });
  root.querySelectorAll('.notice').forEach((notice) => {
    if (notice.tagName === 'FLUENT-MESSAGE-BAR') return;
    const message = document.createElement('fluent-message-bar');
    message.intent = notice.classList.contains('warn') ? 'warning' : notice.classList.contains('bad') ? 'error' : 'info';
    message.className = notice.className;
    message.classList.remove('muted', 'tiny');
    message.style.cssText = notice.style.cssText;
    message.setAttribute('role', notice.getAttribute('role') || 'status');
    message.append(...notice.childNodes);
    notice.replaceWith(message);
  });
  root.setAttribute('aria-busy', String(Boolean(root.querySelector('.loading-stack'))));
  const changedView = view !== lastView || pendingNavigation;
  const chartTargets = root.querySelector('.chart-bar, .chart-svg-heat .heat');
  const shouldAnimateChart = Boolean(chartTargets)
    && (changedView || !animatedChartViews.has(view));
  if (changedView) enter(root, 'enter');
  // A data update no longer replays an entrance. `render()` is already
  // write-gated on identical HTML, so by the time we get here the user did see a
  // change — but animating the container it changed is the "the page reloaded"
  // illusion, and it re-animates the very cards the user may be reading.
  if (changedView && !lastView) {
    [...root.querySelectorAll('.panel')].slice(0, 6).forEach((panel, index) => enter(panel, 'enter', index * 24));
  }
  if (shouldAnimateChart) {
    animateCharts(root);
    if (!reduceMotion()) animatedChartViews.add(view);
  }
  if (changedView || pendingDataUpdate) {
    lastView = view;
    pendingNavigation = false;
    pendingDataUpdate = false;
  }
}

export function setupFluentInteractions() {
  const mobile = window.matchMedia('(max-width: 860px)');
  const syncNav = () => {
    const open = document.getElementById('app').classList.contains('nav-open');
    document.getElementById('navigationPane')?.toggleAttribute('inert', mobile.matches && !open);
  };
  mobile.addEventListener('change', syncNav);
  syncNav();
  document.addEventListener('keydown', (event) => {
    const tab = event.target.closest('fluent-tab');
    if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const tabs = [...tab.closest('tm-tablist').querySelectorAll('fluent-tab:not([disabled])')];
      const index = tabs.indexOf(tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      const target = tabs[next];
      const data = Object.entries(target.dataset);
      target.click();
      // Application renders replace the list synchronously; focus the new tab.
      queueMicrotask(() => {
        const candidates = [...document.querySelectorAll('fluent-tab')];
        candidates.find((item) => data.every(([key, value]) => item.dataset[key] === value))?.focus();
      });
    }
    if (event.key === 'Tab' && document.getElementById('app').classList.contains('nav-open')) {
      const targets = [...document.querySelectorAll('#navigationPane a[href], #navigationPane fluent-button:not([disabled])')].filter((item) => item.getClientRects().length);
      const first = targets[0];
      const last = targets.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  document.addEventListener('toggle', (event) => {
    if (event.target.tagName !== 'DETAILS' || !event.target.open) return;
    // A detail reopened by the render snapshot already had its content painted;
    // animating it again is the "my expand was undone and redone" flash. The
    // marker is set by `restoreRenderState` for exactly this open.
    if (event.target.dataset.restoredOpen) {
      delete event.target.dataset.restoredOpen;
      return;
    }
    enter(event.target.querySelector('.usage-row-detail, .device-detail-body'), 'enter');
  }, true);
}
