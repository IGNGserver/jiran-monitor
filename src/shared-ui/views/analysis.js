import { analysisFilters, hasAnalysisFilters } from '../core/analysis.js';
import { clientLabel } from '../core/data.js';
import { tr, escapeHtml, appState, viewHelper } from '../core/viewContext.js';

const activePeriod = (...args) => viewHelper('activePeriod')(...args);
const viewStats = (...args) => viewHelper('viewStats')(...args);

function optionsFor(period, dimension) {
  if (dimension === 'client') return Object.keys(period?.clients || {});
  if (dimension === 'model') return Object.keys(period?.models || {});
  return Object.entries(period?.projects || {}).map(([key, project]) => [key, project?.projectLabel || project?.name || key]);
}

function filterSelect(dimension, selected, options, disabled) {
  const normalized = options.map((item) => Array.isArray(item) ? item : [item, dimension === 'client' ? clientLabel(item) : item])
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  const label = tr(`analysis.${dimension}`);
  return `<label class="field inline-field analysis-filter-field"><span>${escapeHtml(label)}</span><fluent-dropdown data-analysis-filter="${dimension}" ${disabled ? 'disabled' : ''}><fluent-listbox>
    <fluent-option value=""${selected ? '' : ' selected'}>${escapeHtml(tr('analysis.all', { dimension: label }))}</fluent-option>
    ${normalized.map(([value, text]) => `<fluent-option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(text)}</fluent-option>`).join('')}
  </fluent-listbox></fluent-dropdown></label>`;
}

export function renderAnalysisScopeBar() {
  const prefs = appState().prefs;
  const filters = analysisFilters(prefs);
  const rawPeriod = activePeriod({ applyAnalysis: false });
  const filtered = activePeriod();
  const custom = Boolean(appState().customPeriod);
  const active = Object.entries(filters).filter(([, value]) => value);
  const saved = Array.isArray(prefs.savedAnalysisViews) ? prefs.savedAnalysisViews : [];
  const chips = active.map(([dimension, value]) => {
    const project = rawPeriod?.projects?.[value];
    const label = dimension === 'client' ? clientLabel(value) : dimension === 'project' ? (project?.projectLabel || value) : value;
    return `<button type="button" class="analysis-chip" data-clear-analysis="${dimension}" title="${escapeHtml(tr('analysis.removeFilter'))}"><span>${escapeHtml(tr(`analysis.${dimension}`))}: ${escapeHtml(label)}</span><span aria-hidden="true">×</span></button>`;
  }).join('');
  const scopeCount = Object.keys(filtered?.models || {}).length;
  const savedOptions = saved.map((view) => `<fluent-option value="${escapeHtml(view.id)}">${escapeHtml(view.name)}</fluent-option>`).join('');
  return `<section class="analysis-scope${active.length ? ' has-filters' : ''}" aria-label="${escapeHtml(tr('analysis.title'))}">
    <div class="analysis-scope-summary">
      <fluent-button appearance="${active.length ? 'primary' : 'secondary'}" type="button" data-analysis-toggle aria-expanded="${appState().analysisFilterOpen ? 'true' : 'false'}" aria-controls="analysis-filter-panel">${escapeHtml(tr('analysis.filters'))}${active.length ? ` · ${active.length}` : ''}</fluent-button>
      <div class="analysis-chips">${chips}${active.length ? `<button type="button" class="analysis-clear" data-clear-analysis="all">${escapeHtml(tr('analysis.clear'))}</button>` : `<span class="muted tiny">${escapeHtml(tr('analysis.scopeHint'))}</span>`}</div>
      <span class="analysis-result-count muted tiny">${escapeHtml(tr('analysis.modelCount', { count: scopeCount }))}</span>
    </div>
    ${custom && hasAnalysisFilters(prefs) ? `<div class="notice warn analysis-scope-notice">${escapeHtml(tr('analysis.rangeLocalOnly'))}</div>` : ''}
    ${filtered?.analysisProvenance === 'partial-joint' ? `<div class="notice warn analysis-scope-notice">${escapeHtml(tr('analysis.noJointData'))}</div>` : ''}
    ${filtered?.analysisProvenance === 'session-derived' ? `<div class="notice analysis-scope-notice">${escapeHtml(tr('analysis.sessionDerived'))}</div>` : ''}
    <div id="analysis-filter-panel" class="analysis-filter-panel${appState().analysisFilterOpen ? '' : ' hidden'}">
      <div class="analysis-filter-grid">
        ${filterSelect('client', filters.client, optionsFor(rawPeriod, 'client'), custom)}
        ${filterSelect('model', filters.model, optionsFor(rawPeriod, 'model'), custom)}
        ${filterSelect('project', filters.project, optionsFor(rawPeriod, 'project'), custom)}
      </div>
      <div class="analysis-saved-row">
        <label class="field inline-field"><span>${escapeHtml(tr('analysis.savedViews'))}</span><fluent-dropdown data-saved-analysis-view ${saved.length ? '' : 'disabled'}><fluent-listbox><fluent-option value="">${escapeHtml(tr('analysis.chooseSaved'))}</fluent-option>${savedOptions}</fluent-listbox></fluent-dropdown></label>
        <fluent-button appearance="secondary" type="button" data-save-analysis-view>${escapeHtml(tr('analysis.saveView'))}</fluent-button>
        ${active.length ? `<fluent-button appearance="transparent" type="button" data-clear-analysis="all">${escapeHtml(tr('analysis.clear'))}</fluent-button>` : ''}
      </div>
      <div class="muted tiny">${escapeHtml(custom ? tr('analysis.customDisabled') : tr('analysis.snapshotHint'))}</div>
    </div>
  </section>`;
}

export function analysisDeviceName() {
  const id = String(appState().prefs.deviceFilter || '');
  return viewStats()?.devices?.find((device) => device.deviceId === id)?.hostname || id;
}
