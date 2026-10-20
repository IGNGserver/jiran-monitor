export const ALL_DEVICES_OPTION_VALUE = 'scope:all';
export const ALL_PROVIDERS_OPTION_VALUE = 'scope:all-providers';
const DEVICE_OPTION_PREFIX = 'scope:device:';

export function deviceOptionValue(deviceId) {
  return `${DEVICE_OPTION_PREFIX}${String(deviceId ?? '')}`;
}

export function deviceIdFromOptionValue(value) {
  const optionValue = String(value ?? '');
  return optionValue === ALL_DEVICES_OPTION_VALUE
    ? ''
    : optionValue.startsWith(DEVICE_OPTION_PREFIX)
      ? optionValue.slice(DEVICE_OPTION_PREFIX.length)
      : '';
}

export const CLIENT_LABELS = {
  claude: 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  hermes: 'Hermes',
  gemini: 'Gemini',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  antigravity: 'Antigravity',
  cline: 'Cline',
  kilocode: 'Kilo Code',
  kimi: 'Kimi',
  qwen: 'Qwen',
  grok: 'Grok Build',
  copilot: 'GitHub Copilot',
  pi: 'Pi',
  zed: 'Zed',
  micode: 'MiMo Code',
  zcode: 'ZCode',
  kiro: 'Kiro',
  codebuddy: 'CodeBuddy',
  workbuddy: 'WorkBuddy',
  commandcode: 'Command Code',
  qodercn: 'Qoder CN',
  reasonix: 'Reasonix',
  'deepseek-harness': 'DeepSeek Harness',
  proma: 'Proma',
  deepseek: 'DeepSeek',
  minimax: 'Minimax',
  mimo: 'MiMo',
  zai: 'GLM',
  zaiteam: 'GLM Team',
  volcengine: 'Volcengine',
  qoder: 'Qoder',
  ollama: 'Ollama',
  doubao: 'Doubao',
  moonshot: 'Moonshot',
  xai: 'xAI',
  meta: 'Meta',
  mistral: 'Mistral',
  cohere: 'Cohere',
  xiaomi: 'Xiaomi',
  openrouter: 'OpenRouter',
  roocode: 'Roo Code',
  amp: 'Amp',
  droid: 'Droid',
  mux: 'Mux',
  kilo: 'Kilo CLI',
  crush: 'Crush',
  goose: 'Goose',
  codebuff: 'Codebuff',
  freebuff: 'Freebuff',
  trae: 'Trae',
  warp: 'Warp',
  gjc: 'Gajae-Code',
  jcode: 'Jcode',
  junie: 'Junie',
  opencodereview: 'OpenCodeReview',
  'devin-cli': 'Devin CLI',
  'devin-desktop': 'Devin Desktop',
  senpi: 'Senpi',
  augment: 'Augment Code',
  kimchi: 'Kimchi',
  'prime-agent': 'Prime Agent',
  cherrystudio: 'Cherry Studio',
  mcode: 'MiniMax Code',
  fx: 'Fx',
  lmstudio: 'LM Studio',
  unsloth: 'Unsloth',
  hindsight: 'Hindsight'
};

export const CLIENT_COLORS = {
  claude: '#cc7c5e',
  'claude-desktop': '#d4927a',
  codex: '#49a3b0',
  hermes: '#d4af37',
  gemini: '#4285f4',
  antigravity: '#4285f4',
  cline: '#323B43',
  kimi: '#16191e',
  grok: '#000000',
  copilot: '#000000',
  deepseek: '#4d6bfe',
  'deepseek-harness': '#4d6bfe',
  cursor: '#000000',
  opencode: '#000000',
  openclaw: '#ff4d4d',
  xai: '#000000',
  meta: '#1d65c1',
  mistral: '#fa520f',
  qwen: '#615ced',
  pi: '#000',
  zed: '#4173e7',
  kilocode: '#F8F676',
  micode: '#000000',
  zcode: '#000000',
  kiro: '#9046FF',
  codebuddy: '#6C4DFF',
  workbuddy: '#0DC8A5',
  commandcode: '#4D8CFF',
  qodercn: '#2ADB5C',
  reasonix: '#4D6BFE',
  proma: '#000000',
  moonshot: '#16191e',
  zai: '#000000',
  zaiteam: '#000000',
  cohere: '#39594d',
  xiaomi: '#ff6700',
  minimax: '#f23f5d',
  doubao: '#1E37FC',
  volcengine: '#006EFF',
  qoder: '#2ADB5C',
  ollama: '#888888',
  openrouter: '#6b57ff',
  roocode: '#7c3aed',
  amp: '#f34e3f',
  droid: '#000000',
  mux: '#5b21b6',
  kilo: '#F8F676',
  crush: '#7d5cff',
  goose: '#000000',
  codebuff: '#4d8cff',
  freebuff: '#22c55e',
  trae: '#0ea5e9',
  warp: '#01a4ff',
  gjc: '#f59e0b',
  jcode: '#6366f1',
  junie: '#fe2857',
  opencodereview: '#0ea5e9',
  'devin-cli': '#111827',
  'devin-desktop': '#111827',
  senpi: '#8b5cf6',
  augment: '#ff5c35',
  kimchi: '#e11d48',
  'prime-agent': '#0f766e',
  cherrystudio: '#ff5a5f',
  mcode: '#f23f5d',
  fx: '#3b82f6',
  lmstudio: '#5a67d8',
  unsloth: '#22d3ee',
  hindsight: '#a855f7',
  default: '#6ab4f0'
};

export const PROVIDER_LABELS = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  deepseek: 'DeepSeek',
  minimax: 'Minimax',
  mimo: 'MiMo',
  grok: 'Grok',
  copilot: 'GitHub Copilot',
  kiro: 'Kiro',
  zai: 'GLM',
  zaiteam: 'GLM Team',
  volcengine: 'Volcengine',
  qoder: 'Qoder',
  commandcode: 'Command Code',
  kilocode: 'Kilo Code',
  gemini: 'Gemini',
  kimi: 'Kimi',
  ollama: 'Ollama',
  openrouter: 'OpenRouter',
  amp: 'Amp',
  sakana: 'Sakana (Fugu)',
  warp: 'Warp / Oz',
  cline: 'Cline',
  droid: 'Droid (Factory)',
  thirdparty: 'Third-party'
};

export const HUB_ACCOUNT_PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'antigravity', label: 'Antigravity (AGY)' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'copilot', label: 'GitHub Copilot' },
  { id: 'minimax', label: 'Minimax' },
  { id: 'mimo', label: 'MiMo' },
  { id: 'kimi', label: 'Kimi' },
  { id: 'zai', label: 'GLM' },
  { id: 'zaiteam', label: 'GLM Team' },
  { id: 'volcengine', label: 'Volcengine' },
  { id: 'qoder', label: 'Qoder' },
  { id: 'commandcode', label: 'Command Code' },
  // Must list every provider whose LIMIT_PROVIDER_SOURCE_CAPABILITIES entry says
  // authority:'hub' + manual:true — a provider that is implemented but missing
  // here is unreachable from the accounts UI, which is exactly how amp/sakana
  // shipped unusable. tests/hub/webDataHelpers.test.js asserts the two agree.
  { id: 'cursor', label: 'Cursor' },
  { id: 'grok', label: 'Grok / xAI' },
  { id: 'warp', label: 'Warp / Oz' },
  { id: 'cline', label: 'Cline' },
  { id: 'kilocode', label: 'Kilo Code' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'droid', label: 'Droid (Factory)' },
  { id: 'amp', label: 'Amp' },
  { id: 'sakana', label: 'Sakana (Fugu)' },
  { id: 'ollama', label: 'Ollama' },
  { id: 'thirdparty', label: 'Third-party' }
];

// Providers whose Hub credential is obtained by completing a browser sign-in,
// never by typing a token (the Hub-side OAuth session in `src/hub/oauthService.js`
// is the only supported shape). The accounts UI keeps these on the browser-login
// wizard for both add and edit, so the manual `authJson` / `endpoint+csrfToken`
// shapes are unreachable by design. This must match the provider set
// `oauthService.startSession` accepts; a provider added there belongs here too.
export const BROWSER_LOGIN_PROVIDERS = ['codex', 'antigravity'];

export function isBrowserLoginProvider(provider) {
  return BROWSER_LOGIN_PROVIDERS.includes(String(provider || '').trim().toLowerCase());
}

const FALLBACK_MODEL_COLORS = ['#6ab4f0', '#cc7c5e', '#a57df0', '#49a3b0', '#f0d66a', '#f06a7b'];

const ICON_ALIASES = {
  hermes: 'hermes-agent',
  mimo: 'xiaomi',
  micode: 'xiaomi',
  grok: 'grok',
  zai: 'zai',
  zaiteam: 'zai',
  thirdparty: 'openrouter',
  // Without these the dashboard requested /icons/clients/<id>.svg for ids the
  // server does not ship and the request 404s on every re-render (sendJson sets
  // cache-control: no-store). The desktop client already aliases them the same way.
  kimi: 'moonshot',
  zcode: 'zai',
  'claude-desktop': 'claude',
  // Clients that share a brand with an already-shipped mark. Keeping these as
  // aliases avoids shipping duplicate artwork for one logo, and the icon test
  // requires every alias target to exist.
  mcode: 'minimax',
  kilo: 'kilocode',
  freebuff: 'codebuff',
  'devin-cli': 'devin',
  'devin-desktop': 'devin'
};

export function clientLabel(id) {
  return CLIENT_LABELS[id] || id || 'Unknown';
}

export function clientColor(id) {
  return CLIENT_COLORS[id] || CLIENT_COLORS.default;
}

// The icon base is injected by the host so the same module works in the Hub
// (served over HTTP at /icons/clients/) and in Electron (packaged asset tree).
// The Hub default keeps an unconfigured host working unchanged.
let iconBasePath = '/icons/clients';

export function configureIconBase(basePath) {
  const next = String(basePath || '').trim().replace(/\/+$/, '');
  iconBasePath = next || '/icons/clients';
}

export function clientIconFile(id) {
  return `${ICON_ALIASES[id] || id}.svg`;
}

export function clientIconPath(id) {
  return `${iconBasePath}/${clientIconFile(id)}`;
}

export function modelVendorFor(model) {
  const name = String(model || '').toLowerCase();
  if (/^(cursor-)?auto$/.test(name)) return 'cursor';
  if (/claude|anthropic|sonnet|opus|haiku/.test(name)) return 'claude';
  if (/gpt|openai|codex|^o[134](?:-|$)|o[134]-(mini|pro|preview)|chatgpt/.test(name)) return 'codex';
  if (/gemini|gemma|google/.test(name)) return 'gemini';
  if (/grok|xai/.test(name)) return 'xai';
  if (/deepseek/.test(name)) return 'deepseek';
  if (/llama|meta/.test(name)) return 'meta';
  if (/mistral|mixtral|codestral/.test(name)) return 'mistral';
  if (/qwen|qwq|qvq/.test(name)) return 'qwen';
  if (/kimi|moonshot/.test(name)) return 'moonshot';
  if (/chatglm|\bglm-|\bzai\b|z\.ai|zhipu/.test(name)) return 'zai';
  if (/cohere|command-r/.test(name)) return 'cohere';
  if (/mimo|xiaomi/.test(name)) return 'xiaomi';
  if (/minimax|\babab/.test(name)) return 'minimax';
  if (/doubao|\bseed(?:-|$)/.test(name)) return 'doubao';
  if (/^big-pickle$/.test(name)) return 'opencode';
  return null;
}

export function modelColor(model) {
  const vendor = modelVendorFor(model);
  if (vendor && CLIENT_COLORS[vendor]) return CLIENT_COLORS[vendor];
  const name = String(model || '').toLowerCase();
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return FALLBACK_MODEL_COLORS[Math.abs(hash) % FALLBACK_MODEL_COLORS.length];
}

export function platformLabel(platform) {
  const value = String(platform || '').toLowerCase();
  if (value.includes('darwin') || value.includes('mac')) return 'macOS';
  if (value.includes('win')) return 'Windows';
  if (value.includes('linux')) return 'Linux';
  return platform || '—';
}

export function devicePlatformLabel(platform, osName, osVersion) {
  const base = platformLabel(platform);
  const name = String(osName || '').trim() || base;
  const version = String(osVersion || '').trim();
  return [name, version].filter(Boolean).join(' ') || '—';
}

export function countActiveDays(daily, window = 'all') {
  let days = Array.isArray(daily) ? daily.slice() : [];
  if (window === 'year' && days.length) {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - 365);
    const cut = cutoff.toISOString().slice(0, 10);
    days = days.filter((day) => String(day?.date || '') >= cut);
  }
  return days.filter((day) => Number(day?.tokens || 0) > 0 || Number(day?.cost || 0) > 0).length;
}

export function heatmapValue(day, metric = 'tokens') {
  if (metric === 'cost') return Math.max(0, Number(day?.cost || 0));
  return Math.max(0, Number(day?.tokens || 0));
}



export function limitRemainingTone(remaining) {
  if (remaining == null || remaining === '') return 'unknown';
  const value = Number(remaining);
  if (!Number.isFinite(value)) return 'unknown';
  if (value < 20) return 'critical';
  if (value < 50) return 'warn';
  return 'ok';
}

export function limitAttentionLevel(card) {
  if (!card) return 'none';
  if (card.stale) return 'stale';
  const status = String(card.status || '').toLowerCase();
  if (status === 'ok' || status === 'disabled') return 'none';
  if (status === 'unauthorized') return 'critical';
  if (status === 'notconfigured') return 'warn';
  if (status === 'sourceratelimited' || status === 'ratelimited') return 'warn';
  if (status === 'unavailable' || status === 'error') return 'warn';
  return 'warn';
}

export function clampHomeLimitAccountCount(value, fallback = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.max(1, Math.min(12, Math.floor(Number(fallback)) || 3));
  return Math.max(1, Math.min(12, Math.floor(n)));
}

// Appearance choices, as `[value, label]` pairs for `settingsOptionList()`.
// The Hub renders them in its 偏好 section and the desktop in 显示, so one copy
// is what keeps the two dropdowns offering the same set — a currency or locale
// present on one surface and missing on the other reads as a broken setting.
// The labels are the option's own names, deliberately untranslated.
export const LANGUAGE_OPTIONS = Object.freeze([
  ['auto', 'Auto'],
  ['en', 'English'],
  ['zh-CN', '简体中文'],
  ['zh-TW', '繁體中文'],
  ['ja', '日本語'],
  ['ko', '한국어']
]);
export const THEME_OPTIONS = Object.freeze([
  ['system', 'System'],
  ['light', 'Light'],
  ['dark', 'Dark']
]);
export const CURRENCY_OPTIONS = Object.freeze([
  ['USD', 'USD'],
  ['CNY', 'CNY'],
  ['TWD', 'TWD'],
  ['HKD', 'HKD']
]);

export function personalWorkspaceLabel(locale = 'en') {
  const lang = String(locale || 'en').toLowerCase();
  if (lang.startsWith('zh')) return lang.includes('tw') || lang.includes('hk') ? '個人' : '个人';
  if (lang.startsWith('ja')) return '個人';
  if (lang.startsWith('ko')) return '개인';
  return 'Personal';
}

export function providerPlanLabel(provider) {
  const planLabel = String(provider?.planLabel || '').trim();
  if (planLabel) return planLabel;
  const plan = String(provider?.plan || provider?.planType || '').trim();
  if (plan) return plan;
  // legacy: some providers stuffed plan into accountLabel while email was the identity
  if (provider?.accountEmail && provider?.accountLabel && provider.accountLabel !== provider.accountEmail) {
    return String(provider.accountLabel).trim();
  }
  return '';
}

export function providerDisplayName(provider, peers = [], locale = 'en') {
  const id = String(provider?.provider || '').toLowerCase();
  const email = String(provider?.accountEmail || '').trim();
  const accountName = String(provider?.accountName || '').trim();
  const accountLabel = String(provider?.accountLabel || '').trim();
  const workspaceKind = String(provider?.workspaceKind || '').trim().toLowerCase();
  let workspace = accountName;
  if (!workspace && workspaceKind === 'personal') workspace = personalWorkspaceLabel(locale);

  if (id === 'codex') {
    if (email && workspace) {
      const sameEmail = (peers || []).filter((p) => String(p?.accountEmail || '').trim().toLowerCase() === email.toLowerCase()).length > 1;
      return sameEmail ? `${email} · ${workspace}` : email;
    }
    return email || workspace || accountLabel || 'Codex';
  }

  if (id === 'antigravity') {
    const rawLabel = accountLabel.toLowerCase();
    const isGeneric = !accountLabel || rawLabel === 'antigravity' || rawLabel === 'antigravity remote';
    const specificLabel = isGeneric ? '' : accountLabel;
    if (email && workspace) {
      const sameEmail = (peers || []).filter((p) => String(p?.accountEmail || '').trim().toLowerCase() === email.toLowerCase()).length > 1;
      return sameEmail ? `${email} · ${workspace}` : email;
    }
    return email || workspace || specificLabel || (PROVIDER_LABELS[id] || id || 'Account');
  }

  if (email && workspace) {
    const sameEmail = (peers || []).filter((p) => String(p?.accountEmail || '').trim().toLowerCase() === email.toLowerCase()).length > 1;
    return sameEmail ? `${email} · ${workspace}` : (accountName || email);
  }

  return accountName || accountLabel || email || (PROVIDER_LABELS[id] || id || 'Account');
}

export function statusRows(stats, locale = 'en') {
  return limitCards(stats, locale).map((card) => ({
    ...card,
    health: card.stale ? 'stale' : (String(card.status || '').toLowerCase() === 'ok' ? 'ok' : 'warn')
  }));
}

export function agentRuntimeLabel(runtime) {
  const raw = String(runtime || '').trim();
  if (!raw) return '';
  const value = raw.toLowerCase();
  // The wire value stays `electron-widget` so an older Hub keeps recognising
  // it; only the label this client renders was renamed.
  if (value === 'widget' || value.includes('electron') || value.includes('widget')) return 'desktop';
  if (value.includes('headless') || value === 'agent') return 'headless-agent';
  if (value.includes('embedded')) return 'legacy';
  return raw;
}

export function clientStatusEntries(status) {
  if (!status || typeof status !== 'object') return [];
  return Object.entries(status)
    .map(([client, state]) => ({
      client: String(client || '').trim(),
      state: String(state || '').trim().toLowerCase()
    }))
    .filter((row) => row.client && ['active', 'waiting', 'missing'].includes(row.state))
    .sort((a, b) => a.client.localeCompare(b.client));
}

export function wslStatusSummary(status) {
  if (!status || typeof status !== 'object') return null;
  const state = String(status.state || '').trim().toLowerCase();
  if (!['active', 'no-data', 'not-running', 'not-installed', 'disabled'].includes(state)) return null;
  const ids = (arr) => (Array.isArray(arr) ? arr.map((id) => String(id || '').trim()).filter(Boolean) : []);
  return {
    state,
    detected: ids(status.detected),
    withData: ids(status.withData)
  };
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function tokenMetricFields(period = {}, prefix = '') {
  const fields = prefix
    ? {
        cacheReadTokens: `${prefix}CacheReads`,
        cacheWriteTokens: `${prefix}CacheWrites`,
        outputTokens: `${prefix}Outputs`
      }
    : {
        cacheReadTokens: 'cacheReadTokens',
        cacheWriteTokens: 'cacheWriteTokens',
        outputTokens: 'outputTokens'
      };
  const cacheReadTokens = numberValue(period[fields.cacheReadTokens]);
  const cacheWriteTokens = numberValue(period[fields.cacheWriteTokens]);
  const outputTokens = numberValue(period[fields.outputTokens]);
  const totalTokens = numberValue(period.totalTokens);
  const inputTokens = Math.max(0, totalTokens - outputTokens);
  const cacheInputTokens = Math.min(inputTokens, cacheReadTokens + cacheWriteTokens);
  const uncachedInputTokens = Math.max(0, inputTokens - cacheInputTokens);
  return {
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    uncachedInputTokens,
    cacheHitPercent: inputTokens > 0 ? (cacheReadTokens / inputTokens) * 100 : null
  };
}

export function periodTokenMetrics(period = {}) {
  return tokenMetricFields(period);
}

export function tokenMetricsForRow(period = {}, kind = 'client', key = '', rowTokens) {
  const prefix = kind === 'model' ? 'model' : (kind === 'client' ? 'client' : '');
  if (kind === 'session') {
    const session = period?.sessions?.[key] || {};
    return tokenMetricFields({
      totalTokens: session.totalTokens,
      cacheReadTokens: session.cacheReadTokens,
      cacheWriteTokens: session.cacheWriteTokens,
      outputTokens: session.outputTokens
    });
  }
  return tokenMetricFields({
    totalTokens: rowTokens ?? (kind === 'model' ? period?.models?.[key] : period?.clients?.[key]),
    [`${prefix}CacheReads`]: period?.[`${prefix}CacheReads`]?.[key],
    [`${prefix}CacheWrites`]: period?.[`${prefix}CacheWrites`]?.[key],
    [`${prefix}Outputs`]: period?.[`${prefix}Outputs`]?.[key]
  }, prefix);
}

export function periodActivityCounts(period = {}) {
  return {
    projects: Object.keys(period?.projects || {}).length,
    sessions: Object.keys(period?.sessions || {}).length,
    tools: Object.keys(period?.clients || {}).length,
    models: Object.keys(period?.models || {}).length
  };
}

// Per-client measurement provenance. Only the client axis carries this: a model
// or project row can mix an exact client's tokens with an estimated one, so it
// inherits no label rather than claiming one it cannot support.
export function clientMeasurementFields(period, client) {
  const measurement = period?.clientMeasurements?.[client] || {};
  const credits = Number(period?.clientCredits?.[client] || measurement.meters?.credits?.value || 0) || 0;
  return {
    estimated: measurement.tokens === 'estimated' || period?.clientEstimated?.[client] === true,
    credits
  };
}

export function deviceBreakdownRows(device, periodKey = 'today') {
  const period = device?.periods?.[periodKey] || {};
  const totalTokens = Math.max(0, Number(period.totalTokens || 0));
  const totalCost = Math.max(0, Number(period.costUsd || 0));
  const tools = mapRows(period.clients, period.clientCosts, {
    labelFor: clientLabel,
    colorFor: clientColor
  }).map((row) => {
    const modelMap = period.clientModels?.[row.key] || {};
    const modelCostMap = period.clientModelCosts?.[row.key] || {};
    const models = mapRows(modelMap, modelCostMap, {
      labelFor: (id) => id,
      colorFor: modelColor
    }).map((model) => ({
      ...model,
      metrics: tokenMetricsForRow(period, 'model', model.key, model.value),
      percent: row.value > 0 ? (model.value / row.value) * 100 : 0
    }));
    return {
      ...row,
      ...clientMeasurementFields(period, row.key),
      client: row.key,
      metrics: tokenMetricsForRow(period, 'client', row.key, row.value),
      percent: totalTokens > 0 ? (row.value / totalTokens) * 100 : 0,
      models
    };
  });
  const models = mapRows(period.models, period.modelCosts, {
    labelFor: (id) => id,
    colorFor: modelColor
  }).map((row) => ({
    ...row,
    metrics: tokenMetricsForRow(period, 'model', row.key, row.value),
    percent: totalTokens > 0 ? (row.value / totalTokens) * 100 : 0
  }));
  return { totalTokens, totalCost, tools, models };
}

export function mapRows(mapTokens = {}, mapCosts = {}, { labelFor, colorFor } = {}) {
  return Object.entries(mapTokens)
    .map(([key, value]) => ({
      key,
      name: labelFor ? labelFor(key) : key,
      value: Number(value || 0),
      cost: Number(mapCosts?.[key] || 0),
      color: colorFor ? colorFor(key) : clientColor(key)
    }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
}

export function toolRows(period) {
  const tokenRows = mapRows(period?.clients, period?.clientCosts, {
    labelFor: clientLabel,
    colorFor: clientColor
  });
  const creditOnly = Object.keys(period?.clientCredits || {})
    .filter((key) => !tokenRows.some((row) => row.key === key))
    .map((key) => ({ key, name: clientLabel(key), value: 0, cost: 0, color: clientColor(key) }));
  return [...tokenRows, ...creditOnly].map((row) => ({
    ...row,
    ...clientMeasurementFields(period, row.key),
    metrics: tokenMetricsForRow(period, 'client', row.key, row.value)
  }));
}

export function modelRows(period) {
  return mapRows(period?.models, period?.modelCosts, {
    labelFor: (id) => id,
    colorFor: modelColor
  }).map((row) => ({ ...row, metrics: tokenMetricsForRow(period, 'model', row.key, row.value) }));
}

export function projectRows(period, { incomplete = false } = {}) {
  const rows = Object.entries(period?.projects || {})
    .map(([key, project]) => {
      const clients = Object.keys(project?.clients || {});
      const topClient = clients
        .map((id) => ({ id, value: Number(project?.clients?.[id] || 0) }))
        .sort((a, b) => b.value - a.value)[0];
      return {
        key,
        name: project?.label || key,
        value: Number(project?.tokens || 0),
        cost: Number(project?.costUsd || 0),
        color: topClient ? clientColor(topClient.id) : CLIENT_COLORS.default,
        clients,
        sub: clients.map(clientLabel).join(' · ')
      };
    })
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  return { rows, incomplete: Boolean(incomplete) };
}

export const MAX_SESSION_ROWS = 200;

export function sessionRows(period, { limit = MAX_SESSION_ROWS } = {}) {
  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : MAX_SESSION_ROWS;
  // Sort lightweight candidates before formatting the visible page. A local
  // all-time archive can contain thousands of sessions; only 200 are displayed.
  const candidates = Object.entries(period?.sessions || {})
    .map(([key, session]) => ({
      key, session, value: Number(session?.totalTokens || 0),
      time: Date.parse(session?.lastUsedAt || session?.startedAt || 0)
    }))
    .filter(row => !(row.value <= 0))
    .sort((a, b) => b.time - a.time || b.value - a.value);
  const rows = candidates.slice(0, max)
    .map(({ key, session, value }) => {
      const client = session?.client || '';
      const models = Object.keys(session?.models || {});
      return {
        key,
        name: `${clientLabel(client)}${models[0] ? ` · ${models[0]}` : ''}`,
        value,
        cost: Number(session?.costUsd || 0),
        color: clientColor(client),
        client,
        sub: [
          session?.projectLabel || '',
          session?.sessionId || key,
          Number(session?.messageCount || 0) > 0 ? `${Number(session.messageCount)} msgs` : ''
        ].filter(Boolean).join(' · '),
        messageCount: Number(session?.messageCount || 0),
        projectLabel: session?.projectLabel || '',
        lastUsedAt: session?.lastUsedAt || session?.startedAt || '',
        metrics: tokenMetricsForRow(period, 'session', key)
      };
    });
  return {
    rows,
    total: Math.max(candidates.length, Number(period?.sessionsTotal || 0)),
    truncated: Math.max(candidates.length, Number(period?.sessionsTotal || 0)) > max
  };
}

export function deviceRows(stats, periodKey) {
  return (stats?.devices || [])
    .map((device) => {
      const period = device?.periods?.[periodKey] || {};
      return {
        key: device.deviceId,
        name: device.hostname || device.deviceId || 'device',
        value: Number(period.totalTokens || 0),
        cost: Number(period.costUsd || 0),
        color: device.stale ? '#8c97a7' : '#73bdf5',
        stale: Boolean(device.stale),
        platform: device.platform || '',
        osName: device.osName || '',
        osVersion: device.osVersion || '',
        platformDisplay: devicePlatformLabel(device.platform, device.osName, device.osVersion),
        updatedAt: device.updatedAt || device.receivedAt || '',
        receivedAt: device.receivedAt || '',
        hostname: device.hostname || '',
        deviceId: device.deviceId || '',
        agentRuntime: device.agentRuntime || '',
        agentRuntimeLabel: agentRuntimeLabel(device.agentRuntime),
        clientStatus: device.clientStatus || {},
        wslStatus: device.wslStatus || null,
        periodWindows: device.periodWindows || null,
        projectsEnabled: device.projectsEnabled !== false,
        periods: device.periods || {},
        limits: device.limits || null,
        raw: device
      };
    })
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
}

export function limitCards(stats, locale = 'en') {
  const providers = stats?.limits?.providers || [];
  return providers.map((provider, index) => {
    const id = String(provider?.provider || '').toLowerCase();
    const peers = providers.filter((p) => String(p?.provider || '').toLowerCase() === id);
    // Providers that report a balance object already get its own row below, so a
    // credits window that only carries an absolute count would duplicate it.
    const providerBalance = Number(provider?.balance?.amount);
    const balanceRowCoversCount = Number.isFinite(providerBalance);
    const windows = (provider?.windows || []).map((window) => {
      const remaining = Number.isFinite(Number(window.remainingPercent))
        ? Number(window.remainingPercent)
        : (Number.isFinite(Number(window.usedPercent)) ? 100 - Number(window.usedPercent) : null);
      // Windows whose unit is an amount (Codex credits) report `remaining` as a
      // count without any percentage, matching how the dashboard renders them.
      const count = Number(window.remaining);
      const countValue = remaining == null && !balanceRowCoversCount && Number.isFinite(count) ? String(count) : '';
      const metric = String(window.metric || '').toLowerCase() === 'credits' ? 'credits' : '';
      const showMeter = window.showMeter === false ? false : remaining != null;
      return {
        kind: window.kind || 'window',
        label: window.label || window.kind || 'Window',
        remaining,
        used: remaining == null ? null : 100 - remaining,
        resetsAt: window.resetsAt || '',
        value: window.value || countValue,
        metric,
        showMeter,
        detail: String(window.detail || '').trim()
      };
    });

    if (provider?.balanceUsd !== null && provider?.balanceUsd !== undefined && Number.isFinite(Number(provider.balanceUsd))) {
      const amount = Math.max(0, Number(provider.balanceUsd || 0));
      windows.push({
        kind: 'balanceUsd',
        label: 'Balance (USD)',
        remaining: null,
        used: null,
        resetsAt: '',
        value: `$${amount.toFixed(2)}`,
        metric: 'currency',
        showMeter: false,
        detail: ''
      });
    }

    if (provider?.balance && provider.balance.amount !== null && provider.balance.amount !== undefined && Number.isFinite(Number(provider.balance.amount))) {
      const amount = Math.max(0, Number(provider.balance.amount || 0));
      const spend = Math.max(0, Number(provider.balance.monthSpend || 0));
      const todaySpend = Math.max(0, Number(provider.balance.todaySpend || 0));
      const weekSpend = Math.max(0, Number(provider.balance.weekSpend || 0));
      const allTimeSpend = Math.max(0, Number(provider.balance.allTimeSpend || 0));
      const currency = String(provider.balance.currency || '').trim();
      const total = amount + spend;
      const hasSpend = Number.isFinite(Number(provider.balance.monthSpend)) && spend > 0;
      const spendBits = [];
      if (todaySpend > 0) spendBits.push(`today ${todaySpend}${currency ? ` ${currency}` : ''}`);
      if (weekSpend > 0) spendBits.push(`week ${weekSpend}${currency ? ` ${currency}` : ''}`);
      if (hasSpend) spendBits.push(`month ${spend}${currency ? ` ${currency}` : ''}`);
      if (allTimeSpend > 0) spendBits.push(`all-time ${allTimeSpend}${currency ? ` ${currency}` : ''}`);
      windows.push({
        kind: 'balance',
        label: 'Balance',
        remaining: hasSpend && total > 0 ? (amount / total) * 100 : null,
        used: hasSpend && total > 0 ? (spend / total) * 100 : null,
        resetsAt: '',
        value: `${amount}${currency ? ` ${currency}` : ''}`.trim(),
        metric: 'currency',
        showMeter: hasSpend && total > 0,
        detail: spendBits.join(' · ')
      });
    }

    const resetCredits = provider?.resetCredits || provider?.rateLimitResetCredits || null;
    if (resetCredits && typeof resetCredits === 'object') {
      const available = Number(resetCredits.availableCount ?? resetCredits.available ?? resetCredits.remaining);
      const total = Number(resetCredits.totalCount ?? resetCredits.total ?? resetCredits.limit);
      const hasAvailable = Number.isFinite(available) && available > 0;
      const hasTotal = Number.isFinite(total) && total > 0;
      if (hasAvailable || hasTotal) {
        const parts = [];
        if (Number.isFinite(available)) parts.push(String(available));
        if (Number.isFinite(total)) parts.push(`/ ${total}`);
        windows.push({
          kind: 'resetCredits',
          label: 'Reset credits',
          remaining: hasAvailable && hasTotal ? (available / total) * 100 : null,
          used: null,
          resetsAt: '',
          value: parts.join(' '),
          metric: 'resets',
          showMeter: hasAvailable && hasTotal,
          detail: ''
        });
      }
    }

    const lowest = windows
      .map((window) => (window.showMeter === false ? null : window.remaining))
      .filter((value) => value != null)
      .sort((a, b) => a - b)[0];
    const plan = providerPlanLabel(provider);
    const name = providerDisplayName(provider, peers, locale);
    return {
      key: `${id}:${provider.accountKey || index}`,
      provider: id,
      name,
      accountEmail: provider.accountEmail || '',
      accountName: provider.accountName || '',
      accountLabel: provider.accountLabel || '',
      accountKey: provider.accountKey || '',
      workspaceKind: provider.workspaceKind || '',
      plan,
      source: provider.source || '',
      status: provider.status || 'unknown',
      stale: Boolean(provider.stale),
      // When the provider snapshot was last refreshed. The limits page shows it so
      // a stale quota reading is obvious without guessing from the badge alone.
      updatedAt: provider.updatedAt || '',
      color: clientColor(id),
      windows,
      lowestRemaining: lowest ?? 100
    };
  }).sort((a, b) => a.lowestRemaining - b.lowestRemaining || a.name.localeCompare(b.name));
}

export function historyDaily(history, range = 30) {
  const daily = Array.isArray(history?.daily) ? history.daily : [];
  const num = Number(range);
  return Number.isFinite(num) && num > 0 ? daily.slice(-num) : daily.slice();
}
