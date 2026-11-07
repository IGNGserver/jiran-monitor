// Pure analysis-scope transforms shared by the Hub dashboard and Electron.
// Snapshot/range selection still belongs to resolveScopePeriod(); this module only
// narrows the period that function returned and never fetches or invents facts.

export const ANALYSIS_SORTS = Object.freeze([
  'tokens-desc', 'cost-desc', 'output-desc', 'cache-desc', 'name-asc'
]);

const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const value = (input) => {
  const number = Number(input);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
};
const entries = (object) => Object.entries(object || {});
const sum = (object) => entries(object).reduce((total, [, item]) => total + value(item), 0);
const pick = (object, keys) => Object.fromEntries(keys.filter((key) => own(object, key)).map((key) => [key, object[key]]));

export function analysisFilters(prefs = {}) {
  return {
    client: String(prefs.analysisClient || '').trim(),
    model: String(prefs.analysisModel || '').trim(),
    project: String(prefs.analysisProject || '').trim()
  };
}

export function hasAnalysisFilters(prefs = {}) {
  const filters = analysisFilters(prefs);
  return Boolean(filters.client || filters.model || filters.project);
}

function sessionProjectIdentity(session, fallback = '') {
  const projectId = String(session?.projectId || '').trim();
  const deviceId = String(session?.deviceId || '').trim();
  return String(session?.projectKey || (deviceId && projectId ? `${deviceId}:${projectId}` : projectId)
    || session?.projectLabel || session?.project || fallback || '').trim();
}

function sessionMatches(session, key, filters) {
  if (filters.client && String(session?.client || '') !== filters.client) return false;
  if (filters.project) {
    const identities = new Set([
      sessionProjectIdentity(session),
      String(session?.projectId || ''),
      String(session?.projectLabel || session?.project || '')
    ]);
    if (!identities.has(filters.project)) return false;
  }
  if (filters.model && !own(session?.models, filters.model)) return false;
  return true;
}

function addMap(target, source, fraction = null) {
  for (const [key, item] of entries(source)) {
    target[key] = value(target[key]) + value(item) * (fraction === null ? 1 : fraction);
  }
}

function addNullableCost(target, key, amount) {
  if (amount === null || amount === undefined || target[key] === null) target[key] = null;
  else target[key] = value(target[key]) + value(amount);
}

function sessionModelCost(session, model, tokens = value(session?.models?.[model])) {
  if (own(session?.modelCosts, model)) {
    const exact = session.modelCosts[model];
    return { value: exact === null || exact === undefined ? null : value(exact), estimated: false };
  }
  const totalTokens = value(session?.totalTokens);
  if (!Object.keys(session?.modelCosts || {}).length && totalTokens > 0) {
    return { value: value(session?.costUsd) * tokens / totalTokens, estimated: true };
  }
  return { value: null, estimated: false };
}

// This fallback is deliberately labelled session-derived. It is used only when a
// project filter needs a joint distribution that the snapshot does not carry.
function periodFromSessions(period, sessions, filters = {}) {
  const result = {
    ...period,
    totalTokens: 0,
    costUsd: 0,
    clients: {},
    clientCosts: {},
    models: {},
    modelCosts: {},
    clientModels: {},
    clientModelCosts: {},
    projects: {},
    sessions,
    metricAvailability: { ...(period.metricAvailability || {}), components: false },
    analysisProvenance: 'session-derived'
  };
  for (const session of Object.values(sessions)) {
    const tokens = filters.model ? value(session.models?.[filters.model]) : value(session.totalTokens);
    const attributedCost = filters.model
      ? sessionModelCost(session, filters.model, tokens)
      : { value: value(session.costUsd), estimated: false };
    const cost = attributedCost.value;
    const client = String(session.client || 'unknown');
    result.totalTokens += tokens;
    if (cost === null || result.costUsd === null) result.costUsd = null;
    else result.costUsd += cost;
    result.analysisCostEstimated ||= attributedCost.estimated;
    result.clients[client] = value(result.clients[client]) + tokens;
    addNullableCost(result.clientCosts, client, cost);
    result.clientModels[client] ||= {};
    result.clientModelCosts[client] ||= {};
    const models = filters.model ? { [filters.model]: tokens } : session.models;
    addMap(result.models, models);
    addMap(result.clientModels[client], models);
    if (filters.model) {
      addNullableCost(result.modelCosts, filters.model, cost);
      addNullableCost(result.clientModelCosts[client], filters.model, cost);
    } else {
      addMap(result.modelCosts, session.modelCosts);
      addMap(result.clientModelCosts[client], session.modelCosts);
    }
    const project = sessionProjectIdentity(session);
    if (!project) continue;
    const previousProject = result.projects[project];
    result.projects[project] = {
      ...(session.project && typeof session.project === 'object' ? session.project : {}),
      projectId: session.projectId || project,
      projectKey: project,
      label: session.projectLabel || session.project || project,
      projectLabel: session.projectLabel || session.project || project,
      tokens: value(previousProject?.tokens) + tokens,
      costUsd: cost === null || previousProject?.costUsd === null ? null : value(previousProject?.costUsd) + cost
    };
  }
  return result;
}

export function filterPeriodByAnalysis(period, prefs = {}) {
  if (!period) return period;
  const filters = analysisFilters(prefs);
  if (!filters.client && !filters.model && !filters.project) return period;

  const sessions = Object.fromEntries(entries(period.sessions).filter(([key, session]) => sessionMatches(session, key, filters)));
  if (filters.project) {
    const scoped = periodFromSessions(period, sessions, filters);
    return { ...scoped, metricAvailability: { ...(scoped.metricAvailability || {}), components: false } };
  }

  const jointAvailable = Boolean(period.clientModels && Object.keys(period.clientModels).length);
  const clients = filters.client ? pick(period.clients, [filters.client]) : { ...(period.clients || {}) };
  const clientCosts = filters.client ? pick(period.clientCosts, [filters.client]) : { ...(period.clientCosts || {}) };
  let models = { ...(period.models || {}) };
  let modelCosts = { ...(period.modelCosts || {}) };
  let clientModels = filters.client ? pick(period.clientModels, [filters.client]) : { ...(period.clientModels || {}) };
  let clientModelCosts = filters.client ? pick(period.clientModelCosts, [filters.client]) : { ...(period.clientModelCosts || {}) };

  if (filters.client && !jointAvailable) {
    models = {};
    modelCosts = {};
    clientModels = {};
    clientModelCosts = {};
  }
  if (filters.model) {
    models = pick(models, [filters.model]);
    modelCosts = pick(modelCosts, [filters.model]);
    clientModels = Object.fromEntries(entries(clientModels).map(([client, map]) => [client, pick(map, [filters.model])]).filter(([, map]) => Object.keys(map).length));
    clientModelCosts = Object.fromEntries(entries(clientModelCosts).map(([client, map]) => [client, pick(map, [filters.model])]).filter(([, map]) => Object.keys(map).length));
    if (jointAvailable) {
      const tokens = Object.values(clientModels).reduce((total, map) => total + value(map?.[filters.model]), 0);
      models = tokens > 0 ? { [filters.model]: tokens } : {};
      const costMaps = Object.values(clientModelCosts);
      const unknownCost = Object.keys(clientModels).some((client) => !own(clientModelCosts[client], filters.model)
        || clientModelCosts[client][filters.model] === null || clientModelCosts[client][filters.model] === undefined);
      if (costMaps.length || Object.keys(clientModels).length) {
        modelCosts = { [filters.model]: unknownCost ? null : costMaps.reduce((total, map) => total + value(map[filters.model]), 0) };
      } else if (filters.client) modelCosts = {};
    }
  }
  if (filters.client && jointAvailable) {
    models = { ...(clientModels[filters.client] || {}) };
    const costMap = clientModelCosts[filters.client] || {};
    modelCosts = Object.fromEntries(Object.keys(models).map((model) => [model, own(costMap, model) ? costMap[model] : null]));
  }

  const result = {
    ...period,
    clients,
    clientCosts,
    models,
    modelCosts,
    clientModels,
    clientModelCosts,
    sessions,
    analysisProvenance: filters.client && !jointAvailable ? 'partial-joint' : 'snapshot'
  };
  if (filters.model) {
    result.totalTokens = filters.client && !jointAvailable ? null : sum(models);
    const unknownCost = Object.values(modelCosts).some((cost) => cost === null || cost === undefined)
      || (Object.keys(models).length > 0 && !own(modelCosts, filters.model));
    result.costUsd = filters.client && !jointAvailable ? null : unknownCost ? null : sum(modelCosts);
    result.clients = Object.fromEntries(entries(clientModels).map(([client, map]) => [client, value(map[filters.model])]).filter(([, item]) => item > 0));
    result.clientCosts = Object.fromEntries(Object.keys(result.clients).map((client) => {
      const map = clientModelCosts[client] || {};
      return [client, own(map, filters.model) ? map[filters.model] : null];
    }));
  } else if (filters.client) {
    result.totalTokens = value(period.clients?.[filters.client]);
    const rawCost = period.clientCosts?.[filters.client];
    result.costUsd = rawCost === null || rawCost === undefined ? null : value(rawCost);
  }
  if (filters.client || filters.model) {
    result.metricAvailability = { ...(period.metricAvailability || {}), components: false };
  }
  result.projects = Object.fromEntries(entries(period.projects).filter(([, project]) => {
    if (filters.client && project?.topClient && project.topClient !== filters.client && !project?.clients?.includes?.(filters.client)) return false;
    return true;
  }));
  return result;
}

export function modelAnalyticsRows(period = {}, { query = '', sort = 'tokens-desc' } = {}) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  const rows = entries(period.models).map(([key, tokens]) => {
    const componentsAvailable = period.metricAvailability?.components !== false && period.metricAvailability?.modelComponents !== false;
    const outputKnown = componentsAvailable && own(period.modelOutputs, key);
    const cacheReadKnown = componentsAvailable && own(period.modelCacheReads, key);
    const cacheWriteKnown = componentsAvailable && own(period.modelCacheWrites, key);
    const outputTokens = outputKnown ? value(period.modelOutputs[key]) : null;
    const cacheReadTokens = cacheReadKnown ? value(period.modelCacheReads[key]) : null;
    const cacheWriteTokens = cacheWriteKnown ? value(period.modelCacheWrites[key]) : null;
    const rawCost = own(period.modelCosts, key) ? period.modelCosts[key] : null;
    const cost = rawCost === null || rawCost === undefined ? null : value(rawCost);
    const inputTokens = outputKnown ? Math.max(0, value(tokens) - outputTokens) : null;
    const clients = entries(period.clientModels).filter(([, map]) => value(map?.[key]) > 0).length;
    return {
      key,
      name: key,
      value: value(tokens),
      tokens: value(tokens),
      cost,
      costEstimated: cost !== null && period.analysisCostEstimated === true,
      costProvenance: cost === null ? 'unknown' : period.analysisCostEstimated === true ? 'allocated' : 'exact',
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      uncachedInputTokens: inputTokens !== null && cacheReadKnown && cacheWriteKnown
        ? Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens) : null,
      cacheHitPercent: inputTokens !== null && inputTokens > 0 && cacheReadKnown ? (cacheReadTokens / inputTokens) * 100 : null,
      costPerMillion: cost !== null && value(tokens) > 0 ? (cost / value(tokens)) * 1_000_000 : null,
      clients,
      sessions: Object.values(period.sessions || {}).filter((session) => own(session?.models, key)).length
    };
  }).filter((row) => !needle || row.key.toLocaleLowerCase().includes(needle));
  const sorters = {
    'tokens-desc': (a, b) => b.tokens - a.tokens,
    'cost-desc': (a, b) => (b.cost ?? -1) - (a.cost ?? -1),
    'output-desc': (a, b) => (b.outputTokens ?? -1) - (a.outputTokens ?? -1),
    'cache-desc': (a, b) => (b.cacheReadTokens ?? -1) - (a.cacheReadTokens ?? -1),
    'name-asc': (a, b) => a.key.localeCompare(b.key)
  };
  const sorter = sorters[sort] || sorters['tokens-desc'];
  return rows.sort((a, b) => sorter(a, b) || a.key.localeCompare(b.key));
}

export function modelClientRows(period = {}, model) {
  const rows = entries(period.clientModels).map(([client, map]) => ({
    key: client,
    name: client,
    tokens: value(map?.[model]),
    cost: own(period.clientModelCosts?.[client], model) && period.clientModelCosts[client][model] !== null && period.clientModelCosts[client][model] !== undefined
      ? value(period.clientModelCosts[client][model]) : null,
    costEstimated: period.analysisCostEstimated === true
  })).filter((row) => row.tokens > 0 || (row.cost ?? 0) > 0);
  // A flat model total without the joint map is still useful, but it cannot be
  // assigned to clients; return no fake distribution in that case.
  return rows.sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key));
}

export function modelDeviceRows(stats, periodName, model, client = '') {
  return (stats?.devices || []).map((device) => {
    const period = device?.periods?.[periodName] || device?.[periodName] || {};
    const tokenMap = client ? period.clientModels?.[client] : period.models;
    const costMap = client ? period.clientModelCosts?.[client] : period.modelCosts;
    return {
      key: device.deviceId,
      name: device.hostname || device.deviceId,
      tokens: value(tokenMap?.[model]),
      cost: own(costMap, model) && costMap[model] !== null && costMap[model] !== undefined ? value(costMap[model]) : null,
      costEstimated: period.analysisCostEstimated === true,
      stale: Boolean(device.stale)
    };
  }).filter((row) => row.tokens > 0 || (row.cost ?? 0) > 0)
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
}

export function relatedSessions(period = {}, model, { query = '', sort = 'recent-desc' } = {}) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  const rows = entries(period.sessions).filter(([, session]) => own(session?.models, model)).map(([key, session]) => {
    const tokens = value(session.models?.[model]);
    const totalTokens = value(session.totalTokens);
    const attributedCost = sessionModelCost(session, model, tokens);
    return {
      key,
      ...session,
      tokens,
      cost: attributedCost.value,
      costEstimated: attributedCost.estimated,
      costProvenance: attributedCost.value === null ? 'unknown' : attributedCost.estimated ? 'allocated' : 'exact',
      totalTokens,
      totalCost: value(session.costUsd)
    };
  }).filter((row) => !needle || [row.key, row.sessionId, row.projectLabel, row.client]
    .some((item) => String(item || '').toLocaleLowerCase().includes(needle)));
  return rows.sort((a, b) => sort === 'tokens-desc'
    ? value(b.totalTokens) - value(a.totalTokens) || String(a.key).localeCompare(String(b.key))
    : Date.parse(b.lastUsedAt || b.startedAt || 0) - Date.parse(a.lastUsedAt || a.startedAt || 0)
      || value(b.totalTokens) - value(a.totalTokens));
}

export function modelHistoryComparison(history, model, filters = {}) {
  const scoped = filterHistoryForAnalysis(history, {
    analysisModel: model,
    analysisClient: filters.client || '',
    analysisProject: filters.project || ''
  });
  if (!scoped.available) return { daily: [], available: false, partial: false, tokenChange: null, costChange: null, days: 0, previousDays: 0 };
  const daily = scoped.daily.filter((day) => !day.analysisUnknown).map((day) => ({
    date: day.date, tokens: value(day.tokens), cost: day.cost === null || day.cost === undefined ? null : value(day.cost)
  }));
  if (!daily.length) return null;
  const days = 30;
  const current = daily.slice(-days);
  const previous = daily.slice(-(days * 2), -days);
  const total = (rows, field, nullable = false) => rows.reduce((sumValue, day) => {
    if (sumValue === null || nullable && (day[field] === null || day[field] === undefined)) return null;
    return sumValue + value(day[field]);
  }, 0);
  const change = (now, before) => now === null || before === null ? null : before > 0 ? ((now - before) / before) * 100 : (now > 0 ? null : 0);
  const tokens = total(current, 'tokens');
  const previousTokens = total(previous, 'tokens');
  const cost = total(current, 'cost', true);
  const previousCost = total(previous, 'cost', true);
  return {
    days: current.length,
    previousDays: previous.length,
    daily,
    available: true,
    partial: scoped.partial,
    tokens,
    cost,
    tokenChange: previous.length ? change(tokens, previousTokens) : null,
    costChange: previous.length ? change(cost, previousCost) : null
  };
}

// Collapse a ranked stack without losing the complete total. Keys are selected by
// the whole window for visual stability; Other is summed independently per day.
export function topNWithOther(daily, group = 'model', limit = 8, metric = 'tokens') {
  const property = group === 'model' ? 'perModel' : 'perClient';
  const totals = new Map();
  for (const day of daily || []) {
    for (const [key, row] of entries(day?.[property])) {
      const amount = metric === 'cost' ? value(row?.cost) : metric === 'activeTime' ? value(row?.activeTimeMs) : value(row?.tokens ?? row);
      totals.set(key, value(totals.get(key)) + amount);
    }
  }
  const keys = [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([key]) => key);
  const selected = new Set(keys);
  const series = [...keys, ...(totals.size > limit ? ['__other__'] : [])].map((key) => ({ key, colorIndex: key === '__other__' ? -1 : undefined }));
  const days = (daily || []).map((day) => {
    const values = {};
    for (const key of keys) values[key] = metric === 'cost' ? value(day?.[property]?.[key]?.cost) : metric === 'activeTime' ? value(day?.[property]?.[key]?.activeTimeMs) : value(day?.[property]?.[key]?.tokens ?? day?.[property]?.[key]);
    if (totals.size > limit) {
      values.__other__ = entries(day?.[property]).filter(([key]) => !selected.has(key))
        .reduce((total, [, row]) => total + (metric === 'cost' ? value(row?.cost) : metric === 'activeTime' ? value(row?.activeTimeMs) : value(row?.tokens ?? row)), 0);
    }
    return { ...day, values, total: Object.values(values).reduce((total, item) => total + item, 0) };
  });
  return { keys: series.map((item) => item.key), days, totalKeys: totals.size };
}

function csvCell(input) {
  let text = String(input ?? '');
  // Spreadsheet applications may evaluate a cell beginning with these characters.
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function filterHistoryForAnalysis(history, preferences = {}, { custom = false } = {}) {
  const daily = Array.isArray(history?.daily) ? history.daily : [];
  const filters = analysisFilters(preferences);
  if (custom || !hasAnalysisFilters(preferences)) return { daily, available: true, partial: false, activeTimeAvailable: true };
  if (filters.project) return { daily: [], available: false, partial: false, activeTimeAvailable: false, reason: 'project' };

  let partial = false;
  const filtered = daily.map((day) => {
    const blank = {
      date: day.date, tokens: 0, cost: 0, messages: 0, activeTimeMs: null,
      perClient: {}, perModel: {}, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0
    };
    if (filters.client && filters.model) {
      if (!Array.isArray(day?.facts)) {
        partial = true;
        return { ...blank, analysisUnknown: true };
      }
      const facts = day.facts.filter((fact) => fact.client === filters.client && fact.model === filters.model);
      const total = facts.reduce((out, fact) => {
        for (const key of ['tokens', 'messages']) out[key] += value(fact[key]);
        if (out.cost === null || fact.cost === null || fact.cost === undefined) out.cost = null;
        else out.cost += value(fact.cost);
        for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'outputTokens']) {
          if (out[key] === null || fact.tokenComponentsAvailable === false || fact[key] === null || fact[key] === undefined) out[key] = null;
          else out[key] += value(fact[key]);
        }
        return out;
      }, { tokens: 0, cost: 0, messages: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
      return {
        ...blank, ...total,
        perClient: { [filters.client]: total },
        perModel: { [filters.model]: total },
        metricAvailability: { components: ['cacheReadTokens', 'cacheWriteTokens', 'outputTokens'].every((key) => total[key] !== null) },
        analysisUnknown: false
      };
    }
    const property = filters.client ? 'perClient' : 'perModel';
    const key = filters.client || filters.model;
    if (!day?.[property] || typeof day[property] !== 'object') {
      partial = true;
      return { ...blank, analysisUnknown: true };
    }
    const row = day[property][key] || {};
    const componentValues = Object.fromEntries(['cacheReadTokens', 'cacheWriteTokens', 'outputTokens'].map((field) => [
      field, row[field] === null || row[field] === undefined ? (value(row.tokens) > 0 ? null : 0) : value(row[field])
    ]));
    return {
      ...blank,
      tokens: value(row.tokens),
      cost: row.cost === null || row.cost === undefined ? null : value(row.cost),
      messages: value(row.messages),
      ...componentValues,
      metricAvailability: { components: Object.values(componentValues).every((item) => item !== null) },
      [property]: { [key]: row }
    };
  });
  return { daily: filtered, available: true, partial, activeTimeAvailable: false };
}

export function toCsv(columns, rows) {
  return `\uFEFF${[columns.map((column) => csvCell(column.label)).join(','), ...rows.map((row) => columns.map((column) => csvCell(typeof column.value === 'function' ? column.value(row) : row[column.value])).join(','))].join('\r\n')}\r\n`;
}
