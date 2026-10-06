'use strict';

const PERIODS = ['today', 'month', 'allTime'];
const { aggregateLimits, normalizeLimitsSummary } = require('./limits');
const { coerceHistory, dayKeyAddDays, localDayKey, mergeHistories } = require('./history');
const { REASONIX_CLIENT } = require('./reasonixPaths');
const { filterReasonixSyntheticSessions, isReasonixSyntheticSession } = require('./reasonixSessionGuard');
const { canonicalProjectKey, deterministicProjectLabel } = require('./projectKey');
const { normalizeSyncUploadIntervalMs, staleAfterMsForSyncUpload } = require('./syncUploadInterval');
// One validator for the wire's timeZone field: named IANA zones only, the same
// rule the collector's fleet calendar and tokscale's bucket pin use. A fixed
// offset is deliberately dropped rather than stored as if it were a zone.
const { normalizeTimeZone } = require('./fleetTimeZone');
// Only for the client-id allowlist on the per-client Qoder diagnostics map: a
// device record must not be able to invent arbitrary keys there.
const { QODER_CLIENT_IDS } = require('./qoderCnUsage');
const TOKEN_KEYS = ['totalTokens', 'total_tokens', 'totalTokenCount', 'total_token_count', 'tokens', 'tokenCount', 'token_count'];
// Additive components for a token total. `reasoning` is deliberately excluded for ordinary clients:
// OpenAI/Codex report reasoning_output_tokens WITHIN output_tokens (tokscale's `output` already
// includes it). Reasonix is the exception: its `output` and `reasoning` fields are disjoint.
const TOKEN_COMPONENT_KEYS = [
  'input', 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens',
  'output', 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens',
  'cacheRead', 'cacheReadTokens', 'cache_read_tokens',
  'cacheWrite', 'cacheWriteTokens', 'cache_write_tokens',
  'cachedTokens', 'cached_tokens',
  'cacheCreationInputTokens', 'cache_creation_input_tokens',
  'cacheReadInputTokens', 'cache_read_input_tokens',
  'totalInput', 'totalOutput', 'totalCacheRead', 'totalCacheWrite'
];
const COST_KEYS = ['costUsd', 'cost_usd', 'costUSD', 'cost', 'totalCost', 'total_cost'];
// Qoder's own credit meter, reported per request by its transcripts. It is a
// provider-published amount in a currency of its own, not a USD cost, so it gets
// its own per-client map rather than folding into `costUsd`/`clientCosts` — and
// unlike every Qoder token total it is exact, never estimated.
const CREDITS_KEYS = ['credits', 'totalCredits', 'total_credits'];
const MESSAGE_COUNT_KEYS = ['messageCount', 'message_count', 'messages', 'totalMessages', 'total_messages'];
const SESSION_ID_KEYS = ['sessionId', 'session_id', 'session', 'conversationId', 'conversation_id', 'threadId', 'thread_id'];
const INPUT_TOKEN_KEYS = ['input', 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens', 'totalInput'];
const OUTPUT_TOKEN_KEYS = ['output', 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens', 'totalOutput'];
const CACHE_READ_TOKEN_KEYS = ['cacheRead', 'cacheReadTokens', 'cache_read_tokens', 'cachedTokens', 'cached_tokens', 'cacheReadInputTokens', 'totalCacheRead'];
const CACHE_WRITE_TOKEN_KEYS = ['cacheWrite', 'cacheWriteTokens', 'cache_write_tokens', 'cacheCreationInputTokens', 'totalCacheWrite'];
const REASONING_TOKEN_KEYS = ['reasoning', 'reasoningTokens', 'reasoning_tokens'];
// Read off tokscale's per-entry `performance` block. `msPer1KTokens` is deliberately ignored:
// it is a pre-divided ratio, and only raw sums survive being added across rows and devices.
const TIMED_DURATION_KEYS = ['totalDurationMs', 'total_duration_ms', 'timedDurationMs', 'timed_duration_ms'];
const TIMED_TOKEN_KEYS = ['timedTokens', 'timed_tokens'];
const STARTED_AT_KEYS = ['startedAt', 'started_at', 'createdAt', 'created_at'];
const LAST_USED_AT_KEYS = ['lastUsedAt', 'last_used_at', 'updatedAt', 'updated_at', 'lastActivityAt', 'last_activity_at', 'timestamp'];
const GUI_SECRET_LIMIT_PROVIDERS = new Set(['copilot', 'deepseek', 'minimax']);
const RESERVED_DYNAMIC_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/[$,]/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function firstNumber(obj, keys) {
  if (!obj || typeof obj !== 'object') return 0;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const value = asNumber(obj[key]);
      if (value !== 0) return value;
    }
  }
  return 0;
}

function firstString(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const value = String(obj[key] || '').trim();
      if (value) return value;
    }
  }
  return '';
}

function tokenValue(obj) {
  const direct = firstNumber(obj, TOKEN_KEYS);
  if (direct !== 0) return direct;
  let sum = 0;
  for (const key of TOKEN_COMPONENT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) sum += asNumber(obj[key]);
  }
  return sum;
}

// Most clients expose reasoning as a subset of output, so the generic token
// total intentionally leaves it out. Reasonix stats are different: Tokscale
// emits output and reasoning as disjoint fields, so only that client adds the
// separate reasoning component to its token total.
function tokenValueForClient(obj, client) {
  const base = tokenValue(obj);
  if (client !== REASONIX_CLIENT) return base;
  const direct = firstNumber(obj, TOKEN_KEYS);
  return direct !== 0 ? base : base + Math.max(0, firstNumber(obj, REASONING_TOKEN_KEYS));
}

// The public breakdown uses one output-family bucket. Reasonix's independent reasoning
// component belongs there so cache-hit + cache-miss + output still closes over totalTokens.
function outputValueForClient(obj, client) {
  const output = Math.max(0, firstNumber(obj, OUTPUT_TOKEN_KEYS));
  return client === REASONIX_CLIENT
    ? output + Math.max(0, firstNumber(obj, REASONING_TOKEN_KEYS))
    : output;
}

function costValue(obj) {
  return firstNumber(obj, COST_KEYS);
}

function timestampMs(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;
}

function normalizeIsoTimestamp(value) {
  const ms = timestampMs(value);
  return ms > 0 ? new Date(ms).toISOString() : '';
}

// Returns a canonical ISO string only when the input is a usable timestamp.
// Used where a malformed value would silently disable period expiry.
function firstValidIso(value) {
  if (value === undefined || value === null || value === '') return '';
  const ms = timestampMs(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '';
}

function emptyPeriod() {
  return {
    capabilities: { tokenComponents: true },
    totalTokens: 0,
    costUsd: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    unclassifiedTokens: 0,
    // tokscale's per-entry `performance` block, summed. `timedDurationMs` is the sum of
    // per-message durations (NOT a wall-clock span — concurrent sessions count twice), and
    // `timedTokens` covers only the messages that carried a duration, and `timedOutputTokens`
    // is the output of the entries that carried one — an entry contributes its output exactly
    // when it contributes its duration, so numerator and denominator always describe the same
    // entries. That gate has to be applied per row: whole clients report no durations at all,
    // so anything rebuilt from period totals would let one client's output ride on another
    // client's clock.
    //
    // tokscale reports a per-entry `tokenCoverage` and this deliberately ignores it. Scaling
    // output by it assumes output is spread evenly across an entry's tokens, but output is
    // ~0.3–3% of tokens while the untimed remainder measures 3–11x an entry's entire output —
    // it is cache and input, not generation. Scaling would therefore discount output that was
    // almost certainly timed. Ignoring it also keeps this a plain integer counter that merges
    // and deltas like every other token field, instead of a ratio that has to be re-derived.
    //
    // Keep all three as raw sums: a rate is a ratio and ratios cannot be summed across devices
    // or periods, so every consumer divides at the point of display.
    timedTokens: 0,
    timedOutputTokens: 0,
    timedDurationMs: 0,
    clients: {},
    clientCosts: {},
    // Provider-published credit consumption, keyed by client. Only a client whose
    // own source reports credits appears here, so an absent client means "this
    // tool does not meter in credits" rather than zero. Kept as a raw per-client
    // sum for the same reason costUsd is: credits have no exchange rate to divide
    // by, and a sum is what lets the anchored delta and the Hub aggregation
    // treat it additively.
    clientCredits: {},
    // Common measurement metadata. Legacy clientEstimated/clientCredits remain
    // below as compatibility aliases while every host migrates to this shape.
    // `tokens` and `costUsd` describe the provenance of the corresponding
    // aggregate; native meters retain their provider unit and provenance.
    clientMeasurements: {},
    // Which clients contributed content-estimated token totals. The period-level
    // `estimated` flag says "at least one row here was estimated", which on a
    // machine tracking Claude and Qoder would brand the whole period — and every
    // client in it — as a guess. Sparse and boolean: a client is present only
    // when some of its tokens were estimated, and absent when its totals came
    // from exact provider billing.
    clientEstimated: {},
    clientCacheReads: {},
    clientCacheWrites: {},
    clientOutputs: {},
    clientUnclassifiedTokens: {},
    models: {},
    modelCosts: {},
    modelCacheReads: {},
    modelCacheWrites: {},
    modelOutputs: {},
    modelUnclassifiedTokens: {},
    clientModels: {},
    clientModelCosts: {},
    // Credits down to the client+model grain, so a range query and the event
    // ledger can both carry the exact figure without the per-client total having
    // to be split across models it cannot attribute.
    clientModelCredits: {},
    projects: Object.create(null),
    sessions: {}
  };
}

function normalizeClientName(value, options = {}) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  // These names are not client ids. Rejecting them at the normalization boundary
  // keeps every legacy plain-object map safe without changing the serialized shape
  // for ordinary client names.
  if (!options.allowReserved && RESERVED_DYNAMIC_KEYS.has(raw)) return null;
  // Desktop Local Agent / Cowork sessions are deliberately separate from
  // regular Claude Code transcripts.
  if (raw === 'claude-desktop' || raw.includes('claude-desktop') || raw.includes('claude desktop')) return 'claude-desktop';
  if (raw === 'dsh' || raw.includes('deepseek-harness') || raw.includes('deepseek harness')) return 'deepseek-harness';
  if (raw === 'deepseek') return 'deepseek';
  if (raw.includes('claude')) return 'claude';
  if (raw.includes('codex')) return 'codex';
  if (raw.includes('hermes')) return 'hermes';
  if (raw.includes('gemini')) return 'gemini';
  if (raw.includes('cursor')) return 'cursor';
  if (raw.includes('antigravity')) return 'antigravity';
  if (raw.includes('kimi')) return 'kimi';
  if (raw.includes('qwen')) return 'qwen';
  if (raw.includes('grok')) return 'grok';
  if (raw.includes('copilot')) return 'copilot';
  // tokscale 4.17 gives Oh My Pi its own `omp` client id (~/.omp/agent/sessions),
  // but the product tracks it as one `Pi / Oh My Pi` client (`pi`): that is how
  // the README, the watch path, and the WSL marker all present it. Fold the
  // upstream id back so the two roots stay one row instead of splitting.
  if (raw === 'omp' || raw === 'oh-my-pi' || raw === 'oh my pi') return 'pi';
  if (/\bpi\b/.test(raw)) return 'pi';
  if (raw.includes('zed')) return 'zed';
  if (raw.includes('kilocode')) return 'kilocode';
  if (/command[\s_-]*code/.test(raw)) return 'commandcode';
  if (raw.includes('micode')) return 'micode';
  if (raw.includes('zcode')) return 'zcode';
  if (raw.includes('kiro')) return 'kiro';
  if (raw.includes('codebuddy')) return 'codebuddy';
  if (raw.includes('workbuddy')) return 'workbuddy';
  if (raw.includes('proma')) return 'proma';
  if (raw.includes('qodercn') || raw === 'qoder-cn' || raw === 'qoder cn') return 'qodercn';
  // Must follow the `qodercn` rule above: every CN spelling contains "qoder", so
  // a substring test here would silently bill China-site usage to the
  // international client. tokscale has no Qoder entry, so these rows only ever
  // come from the project's own per-site adapter — the branch exists so that its
  // alternate spellings fold to one id instead of leaking through the slug rule.
  if (raw.includes('qoder')) return 'qoder';
  if (raw.includes('reasonix')) return 'reasonix';
  // Must precede the generic `opencode` test below: OpenCodeReview is a distinct
  // tokscale client (~/.opencodereview/sessions) whose name merely contains
  // "opencode", so the substring rule would silently fold its usage into OpenCode.
  if (raw.includes('opencodereview') || raw === 'open-code-review' || raw === 'open code review') return 'opencodereview';
  if (raw.includes('opencode')) return 'opencode';
  if (raw.includes('openclaw') || raw.includes('clawd') || raw.includes('moltbot') || raw.includes('moldbot')) return 'openclaw';
  return raw.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || null;
}

function detectClient(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return normalizeClientName(obj.client || obj.clients || obj.source || obj.platform || obj.agent || obj.tool || obj.name);
}

function normalizeModelName(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw && !RESERVED_DYNAMIC_KEYS.has(raw) ? raw : null;
}

function normalizeModelNameForClient(value, client) {
  const normalized = normalizeModelName(value);
  if (!normalized || normalizeClientName(client) !== REASONIX_CLIENT) return normalized;
  const qualified = normalized.match(/^(?:deepseek|deepseek-flash)\/(.+)$/);
  const model = qualified?.[1] || normalized;
  return RESERVED_DYNAMIC_KEYS.has(model) ? null : model;
}

function normalizeSessionId(value) {
  const raw = String(value || '').trim();
  return raw || null;
}

function normalizeProviderName(value) {
  const raw = String(value || '').trim().toLowerCase();
  const normalized = raw.replace(/[^a-z0-9_-]+/g, '-');
  return normalized && !RESERVED_DYNAMIC_KEYS.has(normalized) ? normalized : null;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function mapNumber(map, key) {
  return hasOwn(map, key) ? asNumber(map[key]) : 0;
}

function ensureNestedMap(map, key) {
  if (!hasOwn(map, key) || !map[key] || typeof map[key] !== 'object' || Array.isArray(map[key])) {
    map[key] = {};
  }
  return map[key];
}

function emptyProject(label = '') {
  return {
    label: String(label || '').trim().normalize('NFC'),
    tokens: 0,
    costUsd: 0,
    clients: Object.create(null)
  };
}

function addProjectInto(projects, rawKey, source) {
  if (!source || typeof source !== 'object') return;
  const label = String(source.label || rawKey || '').trim().normalize('NFC');
  const key = canonicalProjectKey(label || rawKey);
  if (!key) return;
  if (!hasOwn(projects, key)) projects[key] = emptyProject(label || rawKey);
  const target = projects[key];
  target.label = deterministicProjectLabel(target.label, label || rawKey);
  target.tokens += Math.max(0, Math.round(asNumber(source.tokens ?? source.totalTokens)));
  target.costUsd += asNumber(source.costUsd ?? source.cost);
  for (const [client, tokens] of Object.entries(source.clients || {})) {
    // Project client maps use a null prototype and historically retained arbitrary
    // client labels, including names such as "constructor". Keep that compatibility
    // while the ordinary token maps reject those keys at their boundary.
    const clientKey = normalizeClientName(client, { allowReserved: true });
    if (!clientKey) continue;
    target.clients[clientKey] = (hasOwn(target.clients, clientKey) ? target.clients[clientKey] : 0)
      + Math.max(0, Math.round(asNumber(tokens)));
  }
}

function normalizeProjects(value) {
  const projects = Object.create(null);
  if (!value || typeof value !== 'object') return projects;
  for (const [key, project] of Object.entries(value)) addProjectInto(projects, key, project);
  return projects;
}

function projectRollupFromSessions(sessions) {
  const projects = Object.create(null);
  for (const session of Object.values(sessions || {})) {
    if (isReasonixSyntheticSession(session)) continue;
    const label = String(session?.projectLabel || '').trim().normalize('NFC');
    const key = canonicalProjectKey(label);
    if (!key) continue;
    if (!hasOwn(projects, key)) projects[key] = emptyProject(label);
    const project = projects[key];
    project.label = deterministicProjectLabel(project.label, label);
    const tokens = Math.max(0, Math.round(asNumber(session.totalTokens)));
    project.tokens += tokens;
    project.costUsd += asNumber(session.costUsd);
    const client = normalizeClientName(session.client);
    if (client && tokens > 0) {
      project.clients[client] = (hasOwn(project.clients, client) ? project.clients[client] : 0) + tokens;
    }
  }
  return projects;
}

function applyProjectRollups(summary) {
  if (!summary || typeof summary !== 'object') return summary;
  for (const periodName of PERIODS) {
    const period = summary.periods?.[periodName] || summary[periodName];
    if (!period || typeof period !== 'object') continue;
    period.projects = projectRollupFromSessions(period.sessions);
  }
  return summary;
}

function normalizeTrackedClients(value) {
  const values = Array.isArray(value) ? value : String(value ?? '').split(',');
  return Array.from(new Set(values.map(normalizeClientName).filter(Boolean)));
}

const CLIENT_STATUS_VALUES = new Set(['active', 'waiting', 'missing']);

function normalizeClientStatus(value) {
  const status = {};
  if (!value || typeof value !== 'object') return status;
  for (const [client, state] of Object.entries(value)) {
    const name = normalizeClientName(client);
    if (name && CLIENT_STATUS_VALUES.has(state)) status[name] = state;
  }
  return status;
}

const WSL_STATUS_STATES = new Set(['active', 'no-data', 'not-running', 'not-installed', 'disabled']);

function normalizeWslStatus(value) {
  if (!value || typeof value !== 'object') return null;
  if (!WSL_STATUS_STATES.has(value.state)) return null;
  const ids = (arr) => (Array.isArray(arr) ? arr.map(normalizeClientName).filter(Boolean) : []);
  return { state: value.state, detected: ids(value.detected), withData: ids(value.withData) };
}

function validDate(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? null : date;
}

function recordDate(record) {
  return validDate(record?.updatedAt || record?.receivedAt);
}

function utcMonthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function utcDayKey(date) {
  return `${utcMonthKey(date)}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

// today/month are wall-clock windows: the device stamps each with the UTC
// instant it ends (next local midnight / next month start, computed in the
// device's own timezone). The hub expires a frozen snapshot with nowMs >= endsAt
// so an offline device's stale "today" stops counting once its day rolls over.
const WINDOW_PERIODS = ['today', 'month'];

function normalizePeriodWindows(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const periodName of WINDOW_PERIODS) {
    const window = value[periodName];
    if (!window || typeof window !== 'object') continue;
    const endsAt = normalizeIsoTimestamp(window.endsAt);
    if (!endsAt) continue;
    result[periodName] = { endsAt };
    if (window.key) result[periodName].key = String(window.key);
  }
  if (!Object.keys(result).length) return null;
  const timeZone = normalizeTimeZone(value.timeZone);
  if (timeZone) result.timeZone = timeZone;
  return result;
}

function detectModel(obj, client = detectClient(obj)) {
  if (!obj || typeof obj !== 'object') return null;
  return normalizeModelNameForClient(
    obj.model || obj.modelName || obj.model_name || obj.deployment || obj.engine,
    client
  );
}

function detectSessionId(obj) {
  return normalizeSessionId(firstString(obj, SESSION_ID_KEYS));
}

function sessionKey(client, sessionId) {
  return `${client}:${sessionId}`;
}

function looksLikeUsageRow(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (tokenValueForClient(obj, detectClient(obj)) === 0 && costValue(obj) === 0) return false;
  return Boolean(obj.client || obj.clients || obj.source || obj.platform || obj.agent || obj.tool || obj.model || obj.provider || obj.date || obj.name || detectSessionId(obj));
}

function collectUsageRows(node, rows) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) collectUsageRows(item, rows);
    return;
  }
  if (typeof node !== 'object') return;
  if (looksLikeUsageRow(node)) {
    rows.push(node);
    return;
  }
  for (const value of Object.values(node)) {
    if (value && (Array.isArray(value) || typeof value === 'object')) collectUsageRows(value, rows);
  }
}

function sessionTokenComponents(input) {
  return {
    inputTokens: Math.max(0, Math.round(firstNumber(input, INPUT_TOKEN_KEYS))),
    outputTokens: Math.max(0, Math.round(firstNumber(input, OUTPUT_TOKEN_KEYS))),
    cacheReadTokens: Math.max(0, Math.round(firstNumber(input, CACHE_READ_TOKEN_KEYS))),
    cacheWriteTokens: Math.max(0, Math.round(firstNumber(input, CACHE_WRITE_TOKEN_KEYS))),
    reasoningTokens: Math.max(0, Math.round(firstNumber(input, REASONING_TOKEN_KEYS)))
  };
}

function emptySession(client, id) {
  return {
    client,
    sessionId: id,
    totalTokens: 0,
    costUsd: 0,
    messageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    startedAt: '',
    lastUsedAt: '',
    projectId: '',
    projectLabel: '',
    models: {},
    modelCosts: {},
    // Session-level credits, mirroring costUsd/modelCosts. The Qoder adapter
    // groups each row by session and model before this sees it, so a session's
    // credit total is the sum of its own requests — not the client's total split
    // across its sessions, which is the allocation this must never become.
    credits: 0,
    modelCredits: {},
    providers: {}
  };
}

const sessionsWithLiveSource = new WeakSet();

function mergeSession(target, source) {
  target.totalTokens += Math.max(0, Math.round(asNumber(source.totalTokens)));
  target.costUsd += asNumber(source.costUsd);
  target.messageCount += Math.max(0, Math.round(asNumber(source.messageCount)));
  target.inputTokens += Math.max(0, Math.round(asNumber(source.inputTokens)));
  target.outputTokens += Math.max(0, Math.round(asNumber(source.outputTokens)));
  target.cacheReadTokens += Math.max(0, Math.round(asNumber(source.cacheReadTokens)));
  target.cacheWriteTokens += Math.max(0, Math.round(asNumber(source.cacheWriteTokens)));
  target.reasoningTokens += Math.max(0, Math.round(asNumber(source.reasoningTokens)));
  if (source.estimated === true) target.estimated = true;
  const sourceStarted = timestampMs(source.startedAt);
  const targetStarted = timestampMs(target.startedAt);
  if (sourceStarted && (!targetStarted || sourceStarted < targetStarted)) target.startedAt = new Date(sourceStarted).toISOString();
  const sourceLastUsed = timestampMs(source.lastUsedAt);
  const targetLastUsed = timestampMs(target.lastUsedAt);
  if (sourceLastUsed && sourceLastUsed > targetLastUsed) target.lastUsedAt = new Date(sourceLastUsed).toISOString();
  const sourceProjectId = String(source.projectId || '');
  if (!target.projectId && sourceProjectId) {
    target.projectId = sourceProjectId;
    target.projectLabel = String(source.projectLabel || '');
  } else if (target.projectId === sourceProjectId && !target.projectLabel && source.projectLabel) {
    target.projectLabel = String(source.projectLabel);
  }
  for (const [model, tokens] of Object.entries(source.models || {})) {
    const key = normalizeModelNameForClient(model, target.client);
    if (key) target.models[key] = mapNumber(target.models, key) + Math.max(0, Math.round(asNumber(tokens)));
  }
  for (const [model, cost] of Object.entries(source.modelCosts || {})) {
    const key = normalizeModelNameForClient(model, target.client);
    if (key) target.modelCosts[key] = mapNumber(target.modelCosts, key) + asNumber(cost);
  }
  target.credits += asNumber(source.credits);
  for (const [model, credits] of Object.entries(source.modelCredits || {})) {
    const key = normalizeModelNameForClient(model, target.client);
    if (key) target.modelCredits[key] = mapNumber(target.modelCredits, key) + asNumber(credits);
  }
  for (const [provider, tokens] of Object.entries(source.providers || {})) {
    const key = normalizeProviderName(provider);
    if (key) target.providers[key] = mapNumber(target.providers, key) + Math.max(0, Math.round(asNumber(tokens)));
  }
  const sourceArchived = source.archived === true || source.deleted === true || source.sourceDeleted === true;
  if (!sourceArchived) {
    sessionsWithLiveSource.add(target);
    delete target.archived;
  } else if (!sessionsWithLiveSource.has(target)) {
    target.archived = true;
  }
  return target;
}

function addSession(period, session) {
  const client = normalizeClientName(session?.client);
  const sessionId = normalizeSessionId(session?.sessionId);
  if (!client || client === REASONIX_CLIENT || !sessionId) return;
  const normalized = client === session.client && sessionId === session.sessionId
    ? session
    : { ...session, client, sessionId };
  if (isReasonixSyntheticSession(normalized)) return;
  const key = sessionKey(client, sessionId);
  if (!hasOwn(period.sessions, key)) period.sessions[key] = emptySession(client, sessionId);
  mergeSession(period.sessions[key], normalized);
}

function sessionFromRow(row) {
  const client = detectClient(row);
  if (!client || client === REASONIX_CLIENT || isReasonixSyntheticSession(row)) return null;
  const id = detectSessionId(row);
  if (!id) return null;
  const session = emptySession(client, id);
  if (row.estimated === true) session.estimated = true;
  session.totalTokens = Math.max(0, Math.round(tokenValueForClient(row, client)));
  session.costUsd = costValue(row);
  session.credits = Math.max(0, firstNumber(row, CREDITS_KEYS));
  session.messageCount = Math.max(0, Math.round(firstNumber(row, MESSAGE_COUNT_KEYS)));
  Object.assign(session, sessionTokenComponents(row));
  session.startedAt = normalizeIsoTimestamp(firstString(row, STARTED_AT_KEYS));
  session.lastUsedAt = normalizeIsoTimestamp(firstString(row, LAST_USED_AT_KEYS));
  session.projectId = String(row.projectId || row.project_id || '').trim();
  session.projectLabel = String(row.projectLabel || row.project_label || '').trim();
  let model = detectModel(row, client);
  if (client === 'cursor' && model === 'auto') model = 'cursor-auto';
  if (model && session.totalTokens > 0) session.models[model] = mapNumber(session.models, model) + session.totalTokens;
  if (model && session.costUsd > 0) session.modelCosts[model] = mapNumber(session.modelCosts, model) + session.costUsd;
  if (model && session.credits > 0) session.modelCredits[model] = mapNumber(session.modelCredits, model) + session.credits;
  const provider = normalizeProviderName(row.provider);
  if (provider && session.totalTokens > 0) session.providers[provider] = mapNumber(session.providers, provider) + session.totalTokens;
  return session;
}

function normalizeSession(input, fallbackKey) {
  if (!input || typeof input !== 'object') return null;
  if (isReasonixSyntheticSession(input, fallbackKey)) return null;
  const client = normalizeClientName(input.client || input.source || input.platform || input.agent || input.tool);
  const id = normalizeSessionId(input.sessionId || input.session_id || input.session || input.conversationId || input.conversation_id || input.threadId || input.thread_id || fallbackKey);
  if (!client || client === REASONIX_CLIENT || !id) return null;
  const session = emptySession(client, id);
  if (input.estimated === true) session.estimated = true;
  const components = sessionTokenComponents(input);
  Object.assign(session, components);
  const componentTotal = components.inputTokens + components.outputTokens + components.cacheReadTokens + components.cacheWriteTokens; // reasoning is a subset of output — see TOKEN_COMPONENT_KEYS
  session.totalTokens = Math.max(0, Math.round(asNumber(input.totalTokens ?? input.total_tokens ?? input.tokens ?? componentTotal)));
  session.costUsd = asNumber(input.costUsd ?? input.cost_usd ?? input.cost ?? 0);
  session.credits = Math.max(0, asNumber(input.credits ?? 0));
  session.messageCount = Math.max(0, Math.round(firstNumber(input, MESSAGE_COUNT_KEYS)));
  session.startedAt = normalizeIsoTimestamp(firstString(input, STARTED_AT_KEYS));
  session.lastUsedAt = normalizeIsoTimestamp(firstString(input, LAST_USED_AT_KEYS));
  session.projectId = String(input.projectId || input.project_id || '').trim();
  session.projectLabel = String(input.projectLabel || input.project_label || '').trim();
  if (input.models && typeof input.models === 'object') {
    for (const [model, value] of Object.entries(input.models)) {
      const key = normalizeModelNameForClient(model, client);
      if (key) session.models[key] = mapNumber(session.models, key) + Math.max(0, Math.round(asNumber(value)));
    }
  }
  if (input.modelCosts && typeof input.modelCosts === 'object') {
    for (const [model, value] of Object.entries(input.modelCosts)) {
      const key = normalizeModelNameForClient(model, client);
      if (key) session.modelCosts[key] = mapNumber(session.modelCosts, key) + asNumber(value);
    }
  }
  if (input.modelCredits && typeof input.modelCredits === 'object') {
    for (const [model, value] of Object.entries(input.modelCredits)) {
      const key = normalizeModelNameForClient(model, client);
      if (key && asNumber(value) > 0) session.modelCredits[key] = mapNumber(session.modelCredits, key) + asNumber(value);
    }
  }
  if (input.providers && typeof input.providers === 'object') {
    for (const [provider, value] of Object.entries(input.providers)) {
      const key = normalizeProviderName(provider);
      if (key) session.providers[key] = mapNumber(session.providers, key) + Math.max(0, Math.round(asNumber(value)));
    }
  }
  if (input.archived === true || input.deleted === true || input.sourceDeleted === true) session.archived = true;
  return session;
}

function normalizePeriod(input, options = {}) {
  const period = emptyPeriod();
  if (!input || typeof input !== 'object') return period;
  const projectsEnabled = options.projectsEnabled !== false;
  if (input.estimated === true) period.estimated = true;
  period.totalTokens = Math.max(0, Math.round(asNumber(input.totalTokens ?? input.total_tokens ?? 0)));
  const componentCapability = input.capabilities?.tokenComponents;
  const hasLegacyComponentShape = [
    'cacheReadTokens',
    'cache_read_tokens',
    'cacheWriteTokens',
    'cache_write_tokens',
    'outputTokens',
    'output_tokens'
  ].some((key) => hasOwn(input, key));
  // Pre-capability producers already sent the component counters on ordinary
  // periods, so their shape remains trustworthy. An aggregate-only fallback
  // has only a total; missing provenance there must not be normalized into an
  // apparently exact cache-miss split.
  period.capabilities.tokenComponents = componentCapability === true
    || (componentCapability !== false && (period.totalTokens === 0 || hasLegacyComponentShape));
  period.costUsd = asNumber(input.costUsd ?? input.cost_usd ?? input.cost ?? 0);
  period.cacheReadTokens = Math.max(0, Math.round(asNumber(input.cacheReadTokens ?? input.cache_read_tokens ?? 0)));
  period.cacheWriteTokens = Math.max(0, Math.round(asNumber(input.cacheWriteTokens ?? input.cache_write_tokens ?? 0)));
  period.outputTokens = Math.max(0, Math.round(asNumber(input.outputTokens ?? input.output_tokens ?? 0)));
  const knownComponentTokens = Math.min(
    period.totalTokens,
    period.cacheReadTokens + period.cacheWriteTokens + period.outputTokens
  );
  period.unclassifiedTokens = Math.min(
    period.totalTokens - knownComponentTokens,
    Math.max(0, Math.round(asNumber(
      input.unclassifiedTokens
      ?? input.unclassified_tokens
      ?? (period.capabilities.tokenComponents ? 0 : period.totalTokens - knownComponentTokens)
    )))
  );
  period.timedTokens = Math.max(0, Math.round(asNumber(input.timedTokens ?? input.timed_tokens ?? 0)));
  // Capped at outputTokens because the gate makes that a physical bound: output is counted
  // whole or not at all, so a period cannot have timed more output than it produced. The
  // collector satisfies this by construction, but the Hub normalizes records posted
  // by any agent, and an inflated value here divides straight into a headline tok/s.
  period.timedOutputTokens = Math.min(
    period.outputTokens,
    Math.max(0, Math.round(asNumber(input.timedOutputTokens ?? input.timed_output_tokens ?? 0)))
  );
  period.timedDurationMs = Math.max(0, Math.round(asNumber(input.timedDurationMs ?? input.timed_duration_ms ?? 0)));
  if (input.clients && typeof input.clients === 'object') {
    for (const [client, value] of Object.entries(input.clients)) {
      const key = normalizeClientName(client);
      if (key) {
        period.clients[key] = mapNumber(period.clients, key) + Math.max(0, Math.round(asNumber(value)));
        if (input.clientCacheReads?.[client]) period.clientCacheReads[key] = mapNumber(period.clientCacheReads, key) + Math.max(0, Math.round(asNumber(input.clientCacheReads[client])));
        if (input.clientCacheWrites?.[client]) period.clientCacheWrites[key] = mapNumber(period.clientCacheWrites, key) + Math.max(0, Math.round(asNumber(input.clientCacheWrites[client])));
        if (input.clientOutputs?.[client]) period.clientOutputs[key] = mapNumber(period.clientOutputs, key) + Math.max(0, Math.round(asNumber(input.clientOutputs[client])));
        const known = Math.min(
          period.clients[key],
          asNumber(period.clientCacheReads[key])
            + asNumber(period.clientCacheWrites[key])
            + asNumber(period.clientOutputs[key])
        );
        const hasExplicitUnclassified = hasOwn(input, 'clientUnclassifiedTokens');
        const unclassified = Math.min(
          period.clients[key] - known,
          Math.max(0, Math.round(asNumber(hasExplicitUnclassified
            ? input.clientUnclassifiedTokens?.[client]
            : (period.capabilities.tokenComponents ? 0 : period.clients[key] - known))))
        );
        if (unclassified > 0) period.clientUnclassifiedTokens[key] = unclassified;
      }
    }
  }
  if (input.clientCosts && typeof input.clientCosts === 'object') {
    for (const [client, value] of Object.entries(input.clientCosts)) {
      const key = normalizeClientName(client);
      if (key) period.clientCosts[key] = mapNumber(period.clientCosts, key) + asNumber(value);
    }
  }
  if (input.clientCredits && typeof input.clientCredits === 'object') {
    for (const [client, value] of Object.entries(input.clientCredits)) {
      const key = normalizeClientName(client);
      // Never negative: a credit total is a consumption amount, and a device
      // record is untrusted input that must not be able to subtract usage.
      if (key && asNumber(value) > 0) period.clientCredits[key] = mapNumber(period.clientCredits, key) + asNumber(value);
    }
  }
  if (input.clientMeasurements && typeof input.clientMeasurements === 'object') {
    for (const [client, measurement] of Object.entries(input.clientMeasurements)) {
      const key = normalizeClientName(client);
      if (!key || !measurement || typeof measurement !== 'object') continue;
      const tokens = ['exact', 'estimated', 'unknown'].includes(measurement.tokens)
        ? measurement.tokens : undefined;
      const costUsd = ['exact', 'estimated', 'unknown'].includes(measurement.costUsd)
        ? measurement.costUsd : undefined;
      const meters = {};
      for (const [meter, value] of Object.entries(measurement.meters || {})) {
        if (!value || typeof value !== 'object') continue;
        const amount = asNumber(value.value);
        const provenance = ['exact', 'estimated', 'unknown'].includes(value.provenance)
          ? value.provenance : 'unknown';
        if (amount > 0) meters[String(meter).slice(0, 32)] = { value: amount, provenance };
      }
      if (tokens || costUsd || Object.keys(meters).length) {
        period.clientMeasurements[key] = {
          ...(tokens ? { tokens } : {}),
          ...(costUsd ? { costUsd } : {}),
          ...(Object.keys(meters).length ? { meters } : {})
        };
      }
    }
  }
  // Older producers only carried the sparse estimate/credit maps. Promote them
  // at the normalization boundary so all downstream consumers can use one
  // measurement contract without making old devices resend their snapshots.
  const measurementClients = new Set([
    ...Object.keys(period.clients),
    ...Object.keys(period.clientCredits),
    ...Object.keys(period.clientMeasurements)
  ]);
  for (const client of measurementClients) {
    const measurement = period.clientMeasurements[client] || {};
    if (period.clientEstimated[client] === true || input.clientEstimated?.[client] === true) measurement.tokens = 'estimated';
    else if (!measurement.tokens) measurement.tokens = 'unknown';
    if (!measurement.costUsd) measurement.costUsd = period.clientEstimated[client] === true ? 'estimated' : 'unknown';
    const credits = period.clientCredits[client];
    if (credits > 0) {
      measurement.meters = {
        ...(measurement.meters || {}),
        credits: { value: credits, provenance: 'exact' }
      };
    }
    period.clientMeasurements[client] = measurement;
  }
  if (input.clientEstimated && typeof input.clientEstimated === 'object') {
    for (const [client, value] of Object.entries(input.clientEstimated)) {
      const key = normalizeClientName(client);
      // Strict `=== true`: a device record must not be able to smuggle a truthy
      // string or object into a flag the UI renders as a provenance marker.
      if (key && value === true) period.clientEstimated[key] = true;
    }
  }
  if (input.models && typeof input.models === 'object') {
    for (const [model, value] of Object.entries(input.models)) {
      const key = normalizeModelName(model);
      if (key) {
        period.models[key] = mapNumber(period.models, key) + Math.max(0, Math.round(asNumber(value)));
        if (input.modelCacheReads?.[model]) period.modelCacheReads[key] = mapNumber(period.modelCacheReads, key) + Math.max(0, Math.round(asNumber(input.modelCacheReads[model])));
        if (input.modelCacheWrites?.[model]) period.modelCacheWrites[key] = mapNumber(period.modelCacheWrites, key) + Math.max(0, Math.round(asNumber(input.modelCacheWrites[model])));
        if (input.modelOutputs?.[model]) period.modelOutputs[key] = mapNumber(period.modelOutputs, key) + Math.max(0, Math.round(asNumber(input.modelOutputs[model])));
        const known = Math.min(
          period.models[key],
          asNumber(period.modelCacheReads[key])
            + asNumber(period.modelCacheWrites[key])
            + asNumber(period.modelOutputs[key])
        );
        const hasExplicitUnclassified = hasOwn(input, 'modelUnclassifiedTokens');
        const unclassified = Math.min(
          period.models[key] - known,
          Math.max(0, Math.round(asNumber(hasExplicitUnclassified
            ? input.modelUnclassifiedTokens?.[model]
            : (period.capabilities.tokenComponents ? 0 : period.models[key] - known))))
        );
        if (unclassified > 0) period.modelUnclassifiedTokens[key] = unclassified;
      }
    }
  }
  if (input.modelCosts && typeof input.modelCosts === 'object') {
    for (const [model, value] of Object.entries(input.modelCosts)) {
      const key = normalizeModelName(model);
      if (key) period.modelCosts[key] = mapNumber(period.modelCosts, key) + asNumber(value);
    }
  }
  if (input.clientModels && typeof input.clientModels === 'object') {
    for (const [client, models] of Object.entries(input.clientModels)) {
      const clientKey = normalizeClientName(client);
      if (!clientKey || !models || typeof models !== 'object') continue;
      for (const [model, value] of Object.entries(models)) {
        const modelKey = normalizeModelNameForClient(model, clientKey);
        if (!modelKey) continue;
        const modelsForClient = ensureNestedMap(period.clientModels, clientKey);
        modelsForClient[modelKey] = mapNumber(modelsForClient, modelKey) + Math.max(0, Math.round(asNumber(value)));
      }
    }
  }
  if (input.clientModelCosts && typeof input.clientModelCosts === 'object') {
    for (const [client, models] of Object.entries(input.clientModelCosts)) {
      const clientKey = normalizeClientName(client);
      if (!clientKey || !models || typeof models !== 'object') continue;
      for (const [model, value] of Object.entries(models)) {
        const modelKey = normalizeModelNameForClient(model, clientKey);
        if (!modelKey) continue;
        const modelsForClient = ensureNestedMap(period.clientModelCosts, clientKey);
        modelsForClient[modelKey] = mapNumber(modelsForClient, modelKey) + asNumber(value);
      }
    }
  }
  if (input.clientModelCredits && typeof input.clientModelCredits === 'object') {
    for (const [client, models] of Object.entries(input.clientModelCredits)) {
      const clientKey = normalizeClientName(client);
      if (!clientKey || !models || typeof models !== 'object') continue;
      for (const [model, value] of Object.entries(models)) {
        const modelKey = normalizeModelNameForClient(model, clientKey);
        if (!modelKey || asNumber(value) <= 0) continue;
        const modelsForClient = ensureNestedMap(period.clientModelCredits, clientKey);
        modelsForClient[modelKey] = mapNumber(modelsForClient, modelKey) + asNumber(value);
      }
    }
  }
  if (input.sessions && typeof input.sessions === 'object') {
    for (const [key, value] of Object.entries(input.sessions)) {
      const session = normalizeSession(value, key);
      if (!session) continue;
      if (!projectsEnabled) {
        session.projectId = '';
        session.projectLabel = '';
      }
      addSession(period, session);
    }
  }
  period.projects = projectsEnabled
    ? (hasOwn(input, 'projects') ? normalizeProjects(input.projects) : projectRollupFromSessions(period.sessions))
    : Object.create(null);
  if (
    period.unclassifiedTokens > 0
    || Object.keys(period.clientUnclassifiedTokens).length > 0
    || Object.keys(period.modelUnclassifiedTokens).length > 0
  ) {
    period.capabilities.tokenComponents = false;
  }
  return period;
}

const UNATTRIBUTED_USAGE_CLIENT = '__unattributed';


function addUsageRowToPeriod(period, row, detectedClient = detectClient(row)) {
  const client = detectedClient;
  if (row?.estimated === true) period.estimated = true;
  const tokens = tokenValueForClient(row, client);
  const cost = costValue(row);
  const credits = Math.max(0, firstNumber(row, CREDITS_KEYS));
  const cacheRead = Math.max(0, Math.round(firstNumber(row, CACHE_READ_TOKEN_KEYS)));
  const cacheWrite = Math.max(0, Math.round(firstNumber(row, CACHE_WRITE_TOKEN_KEYS)));
  const output = Math.max(0, Math.round(outputValueForClient(row, client)));
  const performance = row?.performance && typeof row.performance === 'object' ? row.performance : null;
  const timedTokens = Math.max(0, Math.round(firstNumber(performance, TIMED_TOKEN_KEYS)));
  const timedDurationMs = Math.max(0, Math.round(firstNumber(performance, TIMED_DURATION_KEYS)));
  // A row contributes its output to the throughput numerator exactly when it contributes to
  // the denominator. Gating rather than scaling by tokscale's `tokenCoverage` keeps this a
  // plain counter, which is what lets it merge and delta like every other token field.
  const timedOutputTokens = timedDurationMs > 0 ? output : 0;
  let model = detectModel(row, client);
  if (client === 'cursor' && model === 'auto') model = 'cursor-auto';
  period.totalTokens += Math.max(0, Math.round(tokens));
  period.costUsd += cost;
  period.cacheReadTokens += cacheRead;
  period.cacheWriteTokens += cacheWrite;
  period.outputTokens += output;
  period.timedTokens += timedTokens;
  period.timedOutputTokens += timedOutputTokens;
  period.timedDurationMs += timedDurationMs;
  if (client && tokens > 0) {
    period.clients[client] = mapNumber(period.clients, client) + Math.round(tokens);
    // Gated on the same `tokens > 0` as the client total: a client with no
    // tokens of its own has nothing for this flag to qualify.
    if (row?.estimated === true) period.clientEstimated[client] = true;
    if (cacheRead > 0) period.clientCacheReads[client] = mapNumber(period.clientCacheReads, client) + cacheRead;
    if (cacheWrite > 0) period.clientCacheWrites[client] = mapNumber(period.clientCacheWrites, client) + cacheWrite;
    if (output > 0) period.clientOutputs[client] = mapNumber(period.clientOutputs, client) + output;
  }
  if (client && cost > 0) period.clientCosts[client] = mapNumber(period.clientCosts, client) + cost;
  // Deliberately not folded into `costUsd`: a credit is Qoder's own unit with no
  // published token or USD conversion, so adding it to a dollar total would
  // invent an exchange rate. A 0 is also not recorded — an entry that reports no
  // credit and one that reports zero credits both leave the client absent, which
  // is what lets the map stay sparse across dozens of non-credit clients.
  if (client && credits > 0) period.clientCredits[client] = mapNumber(period.clientCredits, client) + credits;
  if (client && credits > 0) {
    const measurement = period.clientMeasurements[client] || {};
    measurement.meters = {
      ...(measurement.meters || {}),
      credits: {
        value: mapNumber(period.clientCredits, client),
        provenance: row?.meterProvenance || 'exact'
      }
    };
    period.clientMeasurements[client] = measurement;
  }
  if (client && (tokens > 0 || cost > 0 || credits > 0)) {
    const measurement = period.clientMeasurements[client] || {};
    const tokenProvenance = row?.tokenProvenance || (row?.estimated === true ? 'estimated' : 'exact');
    const costProvenance = row?.costProvenance || (row?.estimated === true ? 'estimated' : 'exact');
    if (measurement.tokens !== 'estimated' || tokenProvenance === 'estimated') measurement.tokens = tokenProvenance;
    if (measurement.costUsd !== 'estimated' || costProvenance === 'estimated') measurement.costUsd = costProvenance;
    period.clientMeasurements[client] = measurement;
  }
  if (model && tokens > 0) {
    period.models[model] = mapNumber(period.models, model) + Math.round(tokens);
    if (cacheRead > 0) period.modelCacheReads[model] = mapNumber(period.modelCacheReads, model) + cacheRead;
    if (cacheWrite > 0) period.modelCacheWrites[model] = mapNumber(period.modelCacheWrites, model) + cacheWrite;
    if (output > 0) period.modelOutputs[model] = mapNumber(period.modelOutputs, model) + output;
  }
  if (model && cost > 0) period.modelCosts[model] = mapNumber(period.modelCosts, model) + cost;
  if (client && model && tokens > 0) {
    const modelsForClient = ensureNestedMap(period.clientModels, client);
    modelsForClient[model] = mapNumber(modelsForClient, model) + Math.round(tokens);
  }
  if (client && model && cost > 0) {
    const modelsForClient = ensureNestedMap(period.clientModelCosts, client);
    modelsForClient[model] = mapNumber(modelsForClient, model) + cost;
  }
  if (client && model && credits > 0) {
    const modelsForClient = ensureNestedMap(period.clientModelCredits, client);
    modelsForClient[model] = mapNumber(modelsForClient, model) + credits;
  }
  const session = sessionFromRow(row);
  if (session) addSession(period, session);
}

function fallbackUsagePeriod(json) {
  const period = emptyPeriod();
  period.totalTokens = Math.max(0, Math.round(tokenValue(json)));
  period.costUsd = costValue(json);
  // Aggregate-only Tokscale output proves the total but not how it divides
  // across cache read/write and output. Preserve that distinction through the
  // hub instead of letting normalizePeriod's zero defaults imply a cache miss.
  period.capabilities.tokenComponents = period.totalTokens === 0;
  period.unclassifiedTokens = period.totalTokens;
  return period;
}

// Build the public aggregate and exact internal per-client partitions in one
// pass. The partitions stay collector-internal; they let a watch tick replace
// only the client whose files changed without reconstructing model/cache/project
// attribution from the already-aggregated public period.
function extractUsageBundleFromTokscale(json) {
  const rows = [];
  collectUsageRows(json, rows);
  if (rows.length === 0 && json && typeof json === 'object') {
    const period = fallbackUsagePeriod(json);
    return {
      period,
      byClient: { [UNATTRIBUTED_USAGE_CLIENT]: period }
    };
  }
  const period = emptyPeriod();
  const byClient = Object.create(null);
  for (const row of rows) {
    const client = detectClient(row);
    const partitionKey = client || UNATTRIBUTED_USAGE_CLIENT;
    if (!byClient[partitionKey]) byClient[partitionKey] = emptyPeriod();
    addUsageRowToPeriod(period, row, client);
    addUsageRowToPeriod(byClient[partitionKey], row, client);
  }
  return { period, byClient };
}

function extractUsageFromTokscale(json) {
  const rows = [];
  collectUsageRows(json, rows);
  if (rows.length === 0 && json && typeof json === 'object') return fallbackUsagePeriod(json);
  const period = emptyPeriod();
  for (const row of rows) addUsageRowToPeriod(period, row);
  return period;
}

function normalizePeriodOmissionCounts(value) {
  if (!value || typeof value !== 'object') return null;
  const normalized = {};
  for (const periodName of ['today', 'month']) {
    const count = Math.max(0, Math.round(asNumber(value[periodName])));
    if (count > 0) normalized[periodName] = count;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

const QODER_CN_DIAGNOSTIC_SOURCES = new Set(['none', 'sqlite', 'transcript', 'sqlite+transcript']);
const QODER_CN_DIAGNOSTIC_USED_SOURCES = new Set(['sqlite', 'main-sqlite', 'transcript']);

function normalizeDiagnosticCount(value) {
  const number = Math.round(asNumber(value));
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, number));
}

function normalizeDiagnosticCode(value) {
  const code = String(value || '').trim();
  return /^[A-Z0-9_:-]{1,80}$/.test(code) ? code : null;
}

function normalizeQoderCnDiagnostics(input) {
  if (!input || typeof input !== 'object') return null;
  const result = {
    rootExists: input.rootExists === true,
    rootsFound: normalizeDiagnosticCount(input.rootsFound),
    candidateFiles: normalizeDiagnosticCount(input.candidateFiles),
    readFiles: normalizeDiagnosticCount(input.readFiles),
    readBytes: normalizeDiagnosticCount(input.readBytes),
    recognizedEvents: normalizeDiagnosticCount(input.recognizedEvents),
    ignoredEvents: normalizeDiagnosticCount(input.ignoredEvents),
    badJsonLines: normalizeDiagnosticCount(input.badJsonLines),
    oversizedFiles: normalizeDiagnosticCount(input.oversizedFiles),
    oversizedLines: normalizeDiagnosticCount(input.oversizedLines),
    readErrors: normalizeDiagnosticCount(input.readErrors),
    duplicateRows: normalizeDiagnosticCount(input.duplicateRows),
    transcriptRows: normalizeDiagnosticCount(input.transcriptRows),
    lastDataAt: normalizeIsoTimestamp(input.lastDataAt),
    source: QODER_CN_DIAGNOSTIC_SOURCES.has(input.source) ? input.source : 'none',
    usedSources: Array.isArray(input.usedSources)
      ? [...new Set(input.usedSources.filter((source) => QODER_CN_DIAGNOSTIC_USED_SOURCES.has(source)))]
      : [],
    estimated: input.estimated === true,
    fallback: input.fallback === true,
    truncated: input.truncated === true,
    failureCode: normalizeDiagnosticCode(input.failureCode)
  };
  if (input.legacyDb && typeof input.legacyDb === 'object') {
    result.legacyDb = {
      configured: input.legacyDb.configured !== false,
      rows: normalizeDiagnosticCount(input.legacyDb.rows),
      failed: input.legacyDb.failed === true,
      failureCode: normalizeDiagnosticCode(input.legacyDb.failureCode)
    };
  }
  if (input.mainDb && typeof input.mainDb === 'object') {
    result.mainDb = {
      configured: input.mainDb.configured !== false,
      rows: normalizeDiagnosticCount(input.mainDb.rows),
      failed: input.mainDb.failed === true,
      failureCode: normalizeDiagnosticCode(input.mainDb.failureCode)
    };
  }
  if (input.transcript && typeof input.transcript === 'object') {
    result.transcript = {
      rootExists: input.transcript.rootExists === true,
      rootsFound: normalizeDiagnosticCount(input.transcript.rootsFound),
      candidateFiles: normalizeDiagnosticCount(input.transcript.candidateFiles),
      readFiles: normalizeDiagnosticCount(input.transcript.readFiles),
      readBytes: normalizeDiagnosticCount(input.transcript.readBytes),
      recognizedEvents: normalizeDiagnosticCount(input.transcript.recognizedEvents),
      ignoredEvents: normalizeDiagnosticCount(input.transcript.ignoredEvents),
      badJsonLines: normalizeDiagnosticCount(input.transcript.badJsonLines),
      oversizedFiles: normalizeDiagnosticCount(input.transcript.oversizedFiles),
      oversizedLines: normalizeDiagnosticCount(input.transcript.oversizedLines),
      readErrors: normalizeDiagnosticCount(input.transcript.readErrors),
      lastDataAt: normalizeIsoTimestamp(input.transcript.lastDataAt),
      estimated: input.transcript.estimated === true,
      truncated: input.transcript.truncated === true,
      failureCode: normalizeDiagnosticCode(input.transcript.failureCode)
    };
  }
  return result;
}

// Per-client diagnostics for the locally parsed Qoder sites. `qoderCnDiagnostics`
// stays on the wire as the CN alias so existing consumers keep working, but a
// machine that runs both installers has to be read through this map — one field
// can only describe one site. Unknown keys are dropped rather than coerced, so
// the map can never grow past the tracked Qoder client ids.
function normalizeQoderDiagnosticsMap(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const result = {};
  for (const clientId of QODER_CLIENT_IDS) {
    if (!hasOwn(input, clientId)) continue;
    const diagnostics = normalizeQoderCnDiagnostics(input[clientId]);
    if (diagnostics) result[clientId] = diagnostics;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function normalizeDeviceOsVersion(value) {
  return String(value || '').trim().slice(0, 128);
}

function normalizeDeviceOsName(value) {
  return String(value || '').trim().slice(0, 64);
}

function normalizeDeviceRecord(record) {
  const nowIso = new Date().toISOString();
  // An unparseable updatedAt makes recordDate()/isPeriodExpired() treat the
  // device's frozen today/month windows as never expiring, so a stale snapshot is
  // summed into the fleet aggregate forever. Fall back through receivedAt to the
  // current time instead of storing garbage.
  const receivedAtIso = firstValidIso(record.receivedAt) || nowIso;
  const normalized = {
    deviceId: String(record.deviceId || record.id || 'unknown'),
    hostname: record.hostname ? String(record.hostname) : '',
    platform: record.platform ? String(record.platform) : '',
    updatedAt: firstValidIso(record.updatedAt) || receivedAtIso,
    receivedAt: receivedAtIso,
    agentVersion: record.agentVersion || '',
    agentRuntime: record.agentRuntime ? String(record.agentRuntime) : '',
    periods: {},
    limits: normalizeLimitsSummary(record.limits)
  };
  if (hasOwn(record, 'osName')) normalized.osName = normalizeDeviceOsName(record.osName);
  if (hasOwn(record, 'osVersion')) normalized.osVersion = normalizeDeviceOsVersion(record.osVersion);
  if (hasOwn(record, 'trackedClients')) normalized.trackedClients = normalizeTrackedClients(record.trackedClients);
  if (hasOwn(record, 'clientStatus')) normalized.clientStatus = normalizeClientStatus(record.clientStatus);
  if (hasOwn(record, 'wslStatus')) normalized.wslStatus = normalizeWslStatus(record.wslStatus);
  if (hasOwn(record, 'projectsEnabled')) normalized.projectsEnabled = record.projectsEnabled !== false;
  if (hasOwn(record, 'allTimeProjectsOmitted')) normalized.allTimeProjectsOmitted = record.allTimeProjectsOmitted === true;
  if (hasOwn(record, 'allTimeProjectsIncomplete')) normalized.allTimeProjectsIncomplete = record.allTimeProjectsIncomplete === true;
  if (hasOwn(record, 'sessionDetailsOmitted')) {
    const omitted = normalizePeriodOmissionCounts(record.sessionDetailsOmitted);
    if (omitted) normalized.sessionDetailsOmitted = omitted;
  }
  if (hasOwn(record, 'periodProjectsOmitted')) {
    const omitted = normalizePeriodOmissionCounts(record.periodProjectsOmitted);
    if (omitted) normalized.periodProjectsOmitted = omitted;
  }
  if (hasOwn(record, 'syncUploadIntervalMs')) normalized.syncUploadIntervalMs = normalizeSyncUploadIntervalMs(record.syncUploadIntervalMs);
  if (hasOwn(record, 'historyAvailable')) normalized.historyAvailable = record.historyAvailable === true;
  if (hasOwn(record, 'history')) {
    // Keep the historical normalized shape for existing Hub consumers: an
    // explicit null clears the archive to an empty document, while an omitted
    // field still means "no History update this tick".
    normalized.history = record.history === null
      ? { daily: [], monthly: [], summary: {} }
      : coerceHistory(record.history);
  }
  if (hasOwn(record, 'periodWindows')) {
    const windows = normalizePeriodWindows(record.periodWindows);
    if (windows) normalized.periodWindows = windows;
  }
  if (hasOwn(record, 'qoderCnDiagnostics')) {
    const diagnostics = normalizeQoderCnDiagnostics(record.qoderCnDiagnostics);
    if (diagnostics) normalized.qoderCnDiagnostics = diagnostics;
  }
  if (hasOwn(record, 'qoderDiagnostics')) {
    const diagnostics = normalizeQoderDiagnosticsMap(record.qoderDiagnostics);
    if (diagnostics) normalized.qoderDiagnostics = diagnostics;
  }
  for (const periodName of PERIODS) {
    normalized.periods[periodName] = normalizePeriod(record[periodName] || record.periods?.[periodName], {
      projectsEnabled: normalized.projectsEnabled !== false
    });
  }
  return normalized;
}

function addClientModelUsage(target, source, client) {
  const models = source.clientModels?.[client];
  const costs = source.clientModelCosts?.[client];
  for (const [model, tokens] of Object.entries(models || {})) {
    const modelKey = normalizeModelNameForClient(model, client);
    if (!modelKey) continue;
    target.models[modelKey] = mapNumber(target.models, modelKey) + tokens;
    const targetModels = ensureNestedMap(target.clientModels, client);
    targetModels[modelKey] = mapNumber(targetModels, modelKey) + tokens;

    // Model component maps are not client×model maps. They can be carried only
    // when this preserved client owns the whole source model bucket; otherwise
    // retain the model total and mark just that contribution unknown.
    if (asNumber(source.models?.[modelKey]) === asNumber(tokens)) {
      const cacheRead = Math.min(tokens, asNumber(source.modelCacheReads?.[modelKey]));
      const cacheWrite = Math.min(tokens - cacheRead, asNumber(source.modelCacheWrites?.[modelKey]));
      const output = Math.min(tokens - cacheRead - cacheWrite, asNumber(source.modelOutputs?.[modelKey]));
      const unclassified = Math.min(
        tokens - cacheRead - cacheWrite - output,
        asNumber(source.modelUnclassifiedTokens?.[modelKey])
      );
      if (cacheRead > 0) target.modelCacheReads[modelKey] = mapNumber(target.modelCacheReads, modelKey) + cacheRead;
      if (cacheWrite > 0) target.modelCacheWrites[modelKey] = mapNumber(target.modelCacheWrites, modelKey) + cacheWrite;
      if (output > 0) target.modelOutputs[modelKey] = mapNumber(target.modelOutputs, modelKey) + output;
      if (unclassified > 0) target.modelUnclassifiedTokens[modelKey] = mapNumber(target.modelUnclassifiedTokens, modelKey) + unclassified;
      if (unclassified > 0) target.capabilities.tokenComponents = false;
    } else if (tokens > 0) {
      target.modelUnclassifiedTokens[modelKey] = mapNumber(target.modelUnclassifiedTokens, modelKey) + tokens;
      target.capabilities.tokenComponents = false;
    }
  }
  for (const [model, cost] of Object.entries(costs || {})) {
    const modelKey = normalizeModelNameForClient(model, client);
    if (!modelKey) continue;
    target.modelCosts[modelKey] = mapNumber(target.modelCosts, modelKey) + cost;
    const targetCosts = ensureNestedMap(target.clientModelCosts, client);
    targetCosts[modelKey] = mapNumber(targetCosts, modelKey) + cost;
  }
  // Restored along the client×model axis only. There is no model-level credit
  // map to roll into: credits are a per-provider meter, so a model row shared by
  // Qoder and a USD-billed client would have no meaningful credit total.
  for (const [model, credits] of Object.entries(source.clientModelCredits?.[client] || {})) {
    const modelKey = normalizeModelNameForClient(model, client);
    if (!modelKey) continue;
    const targetCredits = ensureNestedMap(target.clientModelCredits, client);
    targetCredits[modelKey] = mapNumber(targetCredits, modelKey) + credits;
  }
}

function addClientSessionUsage(target, client, sessions, restoredSessions, projectsEnabled) {
  for (const [key, session] of Object.entries(sessions || {})) {
    if (session?.client !== client) continue;
    const restored = projectsEnabled ? session : { ...session, projectId: '', projectLabel: '' };
    addSession(target, restored);
    if (projectsEnabled) restoredSessions[key] = restored;
  }
}

function missingProjectAttribution(sourceProjects, restoredProjects, clients) {
  for (const [rawKey, source] of Object.entries(sourceProjects || {})) {
    const key = canonicalProjectKey(source?.label || rawKey);
    const restored = restoredProjects?.[key];
    for (const client of clients) {
      const expectedTokens = Math.max(0, Math.round(asNumber(source?.clients?.[client])));
      const restoredTokens = Math.max(0, Math.round(asNumber(restored?.clients?.[client])));
      if (restoredTokens < expectedTokens) return true;
    }
  }
  return false;
}

// True when the two records describe the same today/month window.
//
// The window's own `key` is the device-LOCAL day/month the collector stamped, and
// it is what every other window decision uses (see isPeriodExpired and
// computePeriodWindows). Comparing the UTC days of two updatedAt timestamps
// instead mis-decides for every non-UTC device, because a device-local day spans
// two UTC days: within one local day the carry was skipped (losing the frozen
// untracked-client bucket for the rest of that day) and early-morning records
// carried the previous day's bucket into the new one (double counting). The UTC
// comparison is kept only as the fallback for producers that predate
// periodWindows and therefore have no key at all.
function shouldPreservePeriod(periodName, existingRecord, incomingRecord) {
  if (periodName === 'allTime') return true;
  const existingKey = periodWindowKey(existingRecord, periodName);
  const incomingKey = periodWindowKey(incomingRecord, periodName);
  if (existingKey && incomingKey) return existingKey === incomingKey;
  const existingDate = recordDate(existingRecord);
  const incomingDate = recordDate(incomingRecord);
  if (!existingDate || !incomingDate) return false;
  if (periodName === 'today') return utcDayKey(existingDate) === utcDayKey(incomingDate);
  if (periodName === 'month') return utcMonthKey(existingDate) === utcMonthKey(incomingDate);
  return false;
}

function periodWindowKey(record, periodName) {
  const key = record?.periodWindows?.[periodName]?.key;
  return key === undefined || key === null || key === '' ? '' : String(key);
}

function preserveUntrackedClientUsage(existingRecord, incomingRecord, trackedClients) {
  const active = new Set(trackedClients || []);
  const projectsEnabled = incomingRecord.projectsEnabled !== false;
  for (const periodName of PERIODS) {
    if (!shouldPreservePeriod(periodName, existingRecord, incomingRecord)) continue;
    const source = existingRecord.periods?.[periodName] || emptyPeriod();
    const target = incomingRecord.periods?.[periodName] || emptyPeriod();
    const restoredSessions = Object.create(null);
    const preservedClients = new Set();
    incomingRecord.periods[periodName] = target;
    for (const [rawClient, tokens] of Object.entries(source.clients || {})) {
      const client = normalizeClientName(rawClient);
      if (!client || active.has(client) || hasOwn(target.clients, client)) continue;
      const cost = mapNumber(source.clientCosts, client);
      const credits = mapNumber(source.clientCredits, client);
      target.totalTokens += tokens;
      target.costUsd += cost;
      target.clients[client] = tokens;
      preservedClients.add(client);
      if (cost > 0) target.clientCosts[client] = cost;
      if (credits > 0) target.clientCredits[client] = credits;
      // A restored client keeps its provenance label, or an untracked Qoder
      // would come back looking exact after one disabled toggle.
      if (source.clientEstimated?.[client] === true) target.clientEstimated[client] = true;
      const cacheRead = Math.min(tokens, mapNumber(source.clientCacheReads, client));
      const cacheWrite = Math.min(tokens - cacheRead, mapNumber(source.clientCacheWrites, client));
      const output = Math.min(tokens - cacheRead - cacheWrite, mapNumber(source.clientOutputs, client));
      const unclassified = Math.min(
        tokens - cacheRead - cacheWrite - output,
        mapNumber(source.clientUnclassifiedTokens, client)
      );
      target.cacheReadTokens += cacheRead;
      target.cacheWriteTokens += cacheWrite;
      target.outputTokens += output;
      target.unclassifiedTokens += unclassified;
      if (cacheRead > 0) target.clientCacheReads[client] = cacheRead;
      if (cacheWrite > 0) target.clientCacheWrites[client] = cacheWrite;
      if (output > 0) target.clientOutputs[client] = output;
      if (unclassified > 0) target.clientUnclassifiedTokens[client] = unclassified;
      if (unclassified > 0) target.capabilities.tokenComponents = false;
      addClientModelUsage(target, source, client);
      addClientSessionUsage(target, client, source.sessions, restoredSessions, projectsEnabled);
    }
    if (!projectsEnabled) continue;
    const restoredProjects = projectRollupFromSessions(restoredSessions);
    for (const [key, project] of Object.entries(restoredProjects)) addProjectInto(target.projects, key, project);
    if (
      periodName === 'allTime'
      && preservedClients.size > 0
      && (existingRecord.allTimeProjectsIncomplete === true
        || existingRecord.allTimeProjectsOmitted === true
        || existingRecord.projectsEnabled === false
        || missingProjectAttribution(source.projects, restoredProjects, preservedClients))
    ) {
      incomingRecord.allTimeProjectsIncomplete = true;
    }
  }
}

function limitProviderMergeKey(provider) {
  const name = String(provider?.provider || '').trim();
  if (!name) return '';
  if (GUI_SECRET_LIMIT_PROVIDERS.has(name)) return name;
  const accountKey = String(provider?.accountKey || '').trim();
  if (accountKey) return `${name}:${accountKey}`;
  const accountEmail = String(provider?.accountEmail || '').trim().toLowerCase();
  if (accountEmail) return `${name}:email:${accountEmail}`;
  return `${name}:${String(provider?.status || '').trim()}`;
}

function isConfiguredLimitProvider(provider) {
  return Boolean(provider?.accountKey && provider.status !== 'notConfigured' && provider.status !== 'disabled');
}

function shouldKeepExistingGuiSecretProvider(existingProvider, incomingProvider, existingRecord, incomingRecord) {
  if (!existingProvider || !incomingProvider) return false;
  if (!GUI_SECRET_LIMIT_PROVIDERS.has(incomingProvider.provider)) return false;
  if (incomingProvider.status !== 'notConfigured') return false;
  if (!isConfiguredLimitProvider(existingProvider)) return false;
  const existingRuntime = String(existingRecord?.agentRuntime || '').trim();
  const incomingRuntime = String(incomingRecord?.agentRuntime || '').trim();
  return Boolean(existingRuntime && incomingRuntime && existingRuntime !== incomingRuntime);
}

function mergeDeviceLimits(existingRecord, incomingRecord) {
  const existingLimits = normalizeLimitsSummary(existingRecord?.limits);
  const incomingLimits = normalizeLimitsSummary(incomingRecord?.limits);
  if (!incomingLimits.providers.length) return incomingLimits;

  const existingByKey = new Map();
  for (const provider of existingLimits.providers) {
    const key = limitProviderMergeKey(provider);
    if (key) existingByKey.set(key, provider);
  }
  return {
    ...incomingLimits,
    providers: incomingLimits.providers.map((provider) => {
      const existing = existingByKey.get(limitProviderMergeKey(provider));
      if (shouldKeepExistingGuiSecretProvider(existing, provider, existingRecord, incomingRecord)) return existing;
      return provider;
    })
  };
}

function mergeDeviceRecord(existing, incoming) {
  const hasExisting = existing && typeof existing === 'object';
  const hasIncomingLimits = incoming && typeof incoming === 'object' && Object.prototype.hasOwnProperty.call(incoming, 'limits');
  const hasIncomingHistory = incoming && typeof incoming === 'object' && Object.prototype.hasOwnProperty.call(incoming, 'history');
  const hasIncomingTrackedClients = hasOwn(incoming, 'trackedClients');
  const normalizedIncoming = normalizeDeviceRecord(incoming || {});
  if (!hasExisting) return normalizedIncoming;

  const normalizedExisting = normalizeDeviceRecord(existing);
  if (incoming?.limitsOnly === true) {
    normalizedIncoming.periods = normalizedExisting.periods;
    // The three attribution fields describe the usage this branch is carrying
    // forward, so they have to travel with it. Scoped to `limitsOnly` on
    // purpose: a full update from an agent too old to send them is stating that
    // it has no such data, and preserving them there would strand a permanently
    // stale diagnosis on a device that changed hands.
    if (hasOwn(normalizedExisting, 'clientStatus') && !hasOwn(normalizedIncoming, 'clientStatus')) normalizedIncoming.clientStatus = normalizedExisting.clientStatus;
    if (hasOwn(normalizedExisting, 'wslStatus') && !hasOwn(normalizedIncoming, 'wslStatus')) normalizedIncoming.wslStatus = normalizedExisting.wslStatus;
    if (hasOwn(normalizedExisting, 'periodWindows')) normalizedIncoming.periodWindows = normalizedExisting.periodWindows;
    if (hasOwn(normalizedExisting, 'projectsEnabled')) normalizedIncoming.projectsEnabled = normalizedExisting.projectsEnabled;
    if (hasOwn(normalizedExisting, 'allTimeProjectsOmitted')) normalizedIncoming.allTimeProjectsOmitted = normalizedExisting.allTimeProjectsOmitted;
    if (hasOwn(normalizedExisting, 'allTimeProjectsIncomplete')) normalizedIncoming.allTimeProjectsIncomplete = normalizedExisting.allTimeProjectsIncomplete;
    if (hasOwn(normalizedExisting, 'sessionDetailsOmitted')) normalizedIncoming.sessionDetailsOmitted = normalizedExisting.sessionDetailsOmitted;
    if (hasOwn(normalizedExisting, 'periodProjectsOmitted')) normalizedIncoming.periodProjectsOmitted = normalizedExisting.periodProjectsOmitted;
    if (!hasOwn(normalizedIncoming, 'historyAvailable') && hasOwn(normalizedExisting, 'historyAvailable')) {
      normalizedIncoming.historyAvailable = normalizedExisting.historyAvailable;
    }
    if (!hasOwn(normalizedIncoming, 'syncUploadIntervalMs') && hasOwn(normalizedExisting, 'syncUploadIntervalMs')) {
      normalizedIncoming.syncUploadIntervalMs = normalizedExisting.syncUploadIntervalMs;
    }
    if (!hasOwn(normalizedIncoming, 'osVersion') && hasOwn(normalizedExisting, 'osVersion')) {
      normalizedIncoming.osVersion = normalizedExisting.osVersion;
    }
    if (!hasOwn(normalizedIncoming, 'osName') && hasOwn(normalizedExisting, 'osName')) {
      normalizedIncoming.osName = normalizedExisting.osName;
    }
  }
  if (!hasIncomingLimits) normalizedIncoming.limits = normalizedExisting.limits;
  else normalizedIncoming.limits = mergeDeviceLimits(normalizedExisting, normalizedIncoming);
  if (!hasIncomingHistory && hasOwn(normalizedExisting, 'history')) normalizedIncoming.history = normalizedExisting.history;
  if (hasIncomingTrackedClients) {
    preserveUntrackedClientUsage(normalizedExisting, normalizedIncoming, normalizedIncoming.trackedClients || []);
  }
  return normalizedIncoming;
}

// History rides along only on interval-gated collector ticks, so a later
// history-less tick would otherwise blank the local snapshot (and the trends
// dashboard with it). Carry the prior snapshot's history forward when the
// incoming one omits the field — the same preservation the hub gets from
// mergeDeviceRecord, but without normalizing the snapshot's raw period shape.
function carryDeviceHistory(previous, incoming) {
  if (!incoming || typeof incoming !== 'object') return incoming;
  if (hasOwn(incoming, 'history')) return incoming;
  if (previous && typeof previous === 'object' && hasOwn(previous, 'history')) {
    return { ...incoming, history: previous.history };
  }
  return incoming;
}

// A real calendar day or nothing. This key arrives on the wire from anything that can
// ingest, and it is consumed as a lexical maximum, so shape-only matching is not
// enough twice over: an impossible day ('2026-99-99') outranks every real one forever,
// and it makes dayKeyAddDays() build an invalid Date whose toISOString() throws —
// taking down the stats read for every device on the hub. Match the whole string, then
// confirm the day survives a UTC round trip, which is what rejects '2026-02-31'.
function calendarDayKey(value) {
  const key = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return '';
  const parsed = new Date(`${key}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === key
    ? key
    : '';
}

// Could a correct clock somewhere on Earth be naming this day right now? A zone at
// offset o reads the UTC day of now+o, and every legal o sits within [-12h, +14h], so
// the answer is exactly the UTC days this 26-hour interval touches — an envelope read
// off the offset range itself, not a tolerance around a reference day. Which is why
// neither end is a reference: the ends are 26 hours apart, so a UTC-12 reader and a
// UTC+14 producer are both correct and name days two apart. Measuring ±1 day from
// either would be both too loose and too tight — at 00:30 UTC the interval covers only
// two days, and admitting the third lets a producer one day fast take the boundary and
// zero the streak of every device that is on time.
function isPlausibleProducerDay(key, nowMs) {
  return key >= utcDayKey(new Date(nowMs - 12 * 3600000))
    && key <= utcDayKey(new Date(nowMs + 14 * 3600000));
}

// History is durable device data, not live presence. Keep a stored device's
// contributions in the aggregate while it is offline; explicit device deletion
// is the boundary that removes them. Staleness still applies independently to
// live limits and expired today/month period snapshots.
//
// The aggregate's "today" is not the aggregating machine's today. Every day key in
// a History is the *producer's* local calendar day, but this runs wherever the Hub
// happens to be: a Docker Hub can sit in another zone. Reading the wall clock
// there re-keys every
// producer's day against a boundary they never used, which sorts a device's current
// day past the rolling window (dropping it from the daily tier while the monthly
// tier still counts it) or starts the streak walk on a day that holds no data.
//
// So the end key comes from the producers themselves: each one already stamps its
// local day into periodWindows.today.key, and the aggregate takes the latest one it
// was told about — the only end key that cannot cut off a device's own current day.
// A caller that knows better (a widget aggregating its own record) may pass todayKey.
//
// Two conditions narrow which producers get that vote, and each is load-bearing.
//
// Only a device that puts days into the merge may move the boundary. One that reports
// a window but contributes nothing would otherwise push the end past every real
// device's day and zero their streak — the very failure this function exists to
// prevent — so the test is that its daily tier is non-empty, not that a `history`
// field arrived. Those are far apart on the wire: coerceHistory() turns a string, an
// array, a number and `{}` alike into an empty History, so a presence check hands a
// vote to records that describe no day at all. The `=== null` test above is still
// contractual and separate: an omitted field means this tick carried no History
// update, while an explicit null is the disabled/unavailable sentinel.
//
// And only a day some correct clock could be naming right now, because the key is a
// lexical maximum and one device with a dead RTC reporting 2099 would drag the window
// there and blank every other device's daily tier. That bound never re-keys the day —
// the whole point is that no clock here can — it only rejects what no zone explains.
//
// What each producer contributes is a lower bound on its own current day, which its
// window states in one of two ways. While the window is open that day is exactly the
// reported key. Once endsAt has passed the device has rolled over to at least the day
// after, and dropping the key there rather than advancing it is not neutral: the
// fallback would re-select the very day the window just declared finished, which is
// how a UTC+14 laptop asleep across its own midnight kept feeding a live streak to a
// Hub in another timezone for the next fourteen hours. Advancing it also retires a dormant fleet on
// its own, since a window closed long enough ago has a successor no zone has been on
// for years, and the plausibility bound drops it.
//
// When no producer passes, nothing on the wire describes today and this machine's
// clock is all there is. That is also all a pre-periodWindows agent ever offers, so a
// fleet of those keeps the best-effort local-day behaviour it has always had.
function aggregateHistory(devices, options = {}) {
  const explicitToday = calendarDayKey(options.todayKey);
  // One instant for the whole pass. Reading the clock twice lets a local midnight fall
  // between them, which would date the fallback a day behind the expiry and
  // plausibility tests it is meant to back up.
  const now = new Date();
  const nowMs = now.getTime();
  // When no producer on the wire describes today, the caller may name the
  // calendar to fall back to (the Hub's fleet zone). Absent that, this machine's
  // own day is all there is.
  const clockToday = calendarDayKey(options.fallbackTodayKey) || localDayKey(now);
  const histories = [];
  let reportedToday = '';
  for (const record of devices) {
    const normalized = options.normalized === true ? record : normalizeDeviceRecord(record);
    if (!hasOwn(normalized, 'history') || normalized.history === null) continue;
    histories.push(normalized.history);
    if (!normalized.history.daily.length) continue;
    const reported = calendarDayKey(normalized.periodWindows?.today?.key);
    if (!reported) continue;
    const floor = isPeriodExpired(normalized, 'today', nowMs)
      ? dayKeyAddDays(reported, 1)
      : reported;
    if (floor > reportedToday && isPlausibleProducerDay(floor, nowMs)) reportedToday = floor;
  }
  return mergeHistories(histories, {
    todayKey: explicitToday || reportedToday || clockToday
  });
}

// Adds every numeric field and nested map of `source` into `target` (an
// emptyPeriod()-shaped object). Shared by device aggregation and the WSL merge so
// the two never diverge on which period fields exist.
//
// `options.omitSessionDetail` skips the per-session archive and the project
// rollup. The mobile first-paint payload reads headline totals, the client/model
// split and provenance, but not session rows, and those rows are the single
// largest field on the wire (they dominate a fleet snapshot). The detail stays
// reachable through `/api/devices/:id` and `/api/sessions`; only the copy folded
// into the fleet aggregate is dropped.
function addPeriodInto(target, source, options = {}) {
  if (source.estimated === true) target.estimated = true;
  target.capabilities.tokenComponents = target.capabilities.tokenComponents === true
    && source.capabilities?.tokenComponents === true;
  target.totalTokens += source.totalTokens;
  target.costUsd += source.costUsd;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.outputTokens += source.outputTokens;
  target.unclassifiedTokens += source.unclassifiedTokens;
  target.timedTokens += source.timedTokens;
  target.timedOutputTokens += source.timedOutputTokens;
  target.timedDurationMs += source.timedDurationMs;
  for (const [rawClient, tokens] of Object.entries(source.clients)) {
    const client = normalizeClientName(rawClient);
    if (!client) continue;
    target.clients[client] = mapNumber(target.clients, client) + tokens;
    const cacheReads = mapNumber(source.clientCacheReads, client);
    const cacheWrites = mapNumber(source.clientCacheWrites, client);
    const outputs = mapNumber(source.clientOutputs, client);
    const unclassifiedTokens = mapNumber(source.clientUnclassifiedTokens, client);
    if (cacheReads) target.clientCacheReads[client] = mapNumber(target.clientCacheReads, client) + cacheReads;
    if (cacheWrites) target.clientCacheWrites[client] = mapNumber(target.clientCacheWrites, client) + cacheWrites;
    if (outputs) target.clientOutputs[client] = mapNumber(target.clientOutputs, client) + outputs;
    if (unclassifiedTokens) target.clientUnclassifiedTokens[client] = mapNumber(target.clientUnclassifiedTokens, client) + unclassifiedTokens;
  }
  for (const [rawClient, cost] of Object.entries(source.clientCosts)) {
    const client = normalizeClientName(rawClient);
    if (client) target.clientCosts[client] = mapNumber(target.clientCosts, client) + cost;
  }
  // Credits merge additively exactly like costs. That is what lets an anchored
  // watch tick derive month/allTime from the persisted anchor without special
  // casing: `deltaValue` walks this map generically (base + fresh - anchor).
  for (const [rawClient, credits] of Object.entries(source.clientCredits)) {
    const client = normalizeClientName(rawClient);
    if (client) target.clientCredits[client] = mapNumber(target.clientCredits, client) + credits;
  }
  // OR-semantics, unlike the sums around it: if either side estimated this
  // client's tokens, the combined total is not exact. The honest direction is
  // the only one that cannot under-report.
  for (const [rawClient, estimated] of Object.entries(source.clientEstimated)) {
    const client = normalizeClientName(rawClient);
    if (client && estimated === true) target.clientEstimated[client] = true;
  }
  for (const [rawClient, measurement] of Object.entries(source.clientMeasurements || {})) {
    const client = normalizeClientName(rawClient);
    if (!client || !measurement || typeof measurement !== 'object') continue;
    const targetMeasurement = target.clientMeasurements[client] || {};
    const provenanceRank = { unknown: 0, exact: 1, estimated: 2 };
    for (const field of ['tokens', 'costUsd']) {
      const sourceValue = measurement[field];
      if (!['exact', 'estimated', 'unknown'].includes(sourceValue)) continue;
      if (!targetMeasurement[field] || provenanceRank[sourceValue] > provenanceRank[targetMeasurement[field]]) {
        targetMeasurement[field] = sourceValue;
      }
    }
    for (const [meter, value] of Object.entries(measurement.meters || {})) {
      if (!value || typeof value !== 'object') continue;
      const current = targetMeasurement.meters?.[meter];
      if (!targetMeasurement.meters) targetMeasurement.meters = {};
      targetMeasurement.meters[meter] = {
        value: mapNumber(current ? { value: current.value } : {}, 'value') + asNumber(value.value),
        provenance: current?.provenance === 'estimated' || value.provenance === 'estimated'
          ? 'estimated' : (current?.provenance || value.provenance || 'unknown')
      };
    }
    target.clientMeasurements[client] = targetMeasurement;
  }
  for (const [rawModel, tokens] of Object.entries(source.models)) {
    const model = normalizeModelName(rawModel);
    if (!model) continue;
    target.models[model] = mapNumber(target.models, model) + tokens;
    const cacheReads = mapNumber(source.modelCacheReads, model);
    const cacheWrites = mapNumber(source.modelCacheWrites, model);
    const outputs = mapNumber(source.modelOutputs, model);
    const unclassifiedTokens = mapNumber(source.modelUnclassifiedTokens, model);
    if (cacheReads) target.modelCacheReads[model] = mapNumber(target.modelCacheReads, model) + cacheReads;
    if (cacheWrites) target.modelCacheWrites[model] = mapNumber(target.modelCacheWrites, model) + cacheWrites;
    if (outputs) target.modelOutputs[model] = mapNumber(target.modelOutputs, model) + outputs;
    if (unclassifiedTokens) target.modelUnclassifiedTokens[model] = mapNumber(target.modelUnclassifiedTokens, model) + unclassifiedTokens;
  }
  for (const [rawModel, cost] of Object.entries(source.modelCosts)) {
    const model = normalizeModelName(rawModel);
    if (model) target.modelCosts[model] = mapNumber(target.modelCosts, model) + cost;
  }
  for (const [rawClient, models] of Object.entries(source.clientModels)) {
    const client = normalizeClientName(rawClient);
    if (!client || !models || typeof models !== 'object') continue;
    const targetModels = ensureNestedMap(target.clientModels, client);
    for (const [rawModel, tokens] of Object.entries(models)) {
      const model = normalizeModelNameForClient(rawModel, client);
      if (model) targetModels[model] = mapNumber(targetModels, model) + tokens;
    }
  }
  for (const [rawClient, models] of Object.entries(source.clientModelCosts)) {
    const client = normalizeClientName(rawClient);
    if (!client || !models || typeof models !== 'object') continue;
    const targetCosts = ensureNestedMap(target.clientModelCosts, client);
    for (const [rawModel, cost] of Object.entries(models)) {
      const model = normalizeModelNameForClient(rawModel, client);
      if (model) targetCosts[model] = mapNumber(targetCosts, model) + cost;
    }
  }
  for (const [rawClient, models] of Object.entries(source.clientModelCredits)) {
    const client = normalizeClientName(rawClient);
    if (!client || !models || typeof models !== 'object') continue;
    const targetCredits = ensureNestedMap(target.clientModelCredits, client);
    for (const [rawModel, credits] of Object.entries(models)) {
      const model = normalizeModelNameForClient(rawModel, client);
      if (model) targetCredits[model] = mapNumber(targetCredits, model) + credits;
    }
  }
  if (!options.omitSessionDetail) {
    for (const [key, project] of Object.entries(source.projects || {})) addProjectInto(target.projects, key, project);
    for (const session of Object.values(source.sessions)) addSession(target, session);
  }
  return target;
}

// Returns a fresh period that is the sum of all non-null arguments. Inputs are
// normalized first so partial shapes (e.g. a WSL bundle period) are safe.
function mergePeriods(...periods) {
  const target = emptyPeriod();
  for (const period of periods) {
    if (period) addPeriodInto(target, normalizePeriod(period));
  }
  return target;
}

// True when a device's today/month snapshot belongs to a window that has
// already ended, so it must not be summed into the live aggregate. Uses the
// device-local endsAt when present; old agents without periodWindows fall back
// to a best-effort UTC day/month comparison against the snapshot timestamp.
// allTime is cumulative and never expires.
function isPeriodExpired(record, periodName, nowMs) {
  if (periodName === 'allTime') return false;
  const endsAt = record?.periodWindows?.[periodName]?.endsAt;
  if (endsAt) {
    const endMs = timestampMs(endsAt);
    if (endMs > 0) return nowMs >= endMs;
  }
  const recordedAt = recordDate(record);
  if (!recordedAt) return false;
  const nowDate = new Date(nowMs);
  if (periodName === 'today') return utcDayKey(recordedAt) !== utcDayKey(nowDate);
  if (periodName === 'month') return utcMonthKey(recordedAt) !== utcMonthKey(nowDate);
  return false;
}

function aggregateDevices(devices, staleAfterMs, nowMs = Date.now(), options = {}) {
  const aggregate = { updatedAt: new Date().toISOString(), periods: {}, devices: [], projectsIncomplete: false };
  const sessionDetailsOmitted = {};
  const periodProjectsOmitted = {};
  for (const periodName of PERIODS) aggregate.periods[periodName] = emptyPeriod();
  const now = nowMs;
  for (const record of devices) {
    const normalized = options.normalized === true ? record : normalizeDeviceRecord(record);
    const ageMs = now - Date.parse(normalized.receivedAt || normalized.updatedAt || 0);
    const deviceStaleAfterMs = staleAfterMsForSyncUpload(normalized.syncUploadIntervalMs, staleAfterMs);
    const stale = Number.isFinite(ageMs) && deviceStaleAfterMs > 0 ? ageMs > deviceStaleAfterMs : false;
    // Keep the device snapshot aligned with the same wall-clock expiry used by
    // the aggregate. A stale device may still be valid for the current day;
    // only a window that has actually ended is cleared from its device view.
    const periods = {};
    for (const periodName of PERIODS) {
      const expired = isPeriodExpired(normalized, periodName, now);
      periods[periodName] = expired ? emptyPeriod() : normalized.periods[periodName];
    }
    aggregate.devices.push({
      deviceId: normalized.deviceId,
      hostname: normalized.hostname,
      platform: normalized.platform,
      ...(hasOwn(normalized, 'osName') ? { osName: normalized.osName } : {}),
      ...(hasOwn(normalized, 'osVersion') ? { osVersion: normalized.osVersion } : {}),
      agentVersion: normalized.agentVersion,
      agentRuntime: normalized.agentRuntime,
      updatedAt: normalized.updatedAt,
      receivedAt: normalized.receivedAt,
      ageMs: Number.isFinite(ageMs) ? ageMs : null,
      stale,
      ...(hasOwn(normalized, 'trackedClients') ? { trackedClients: normalized.trackedClients } : {}),
      ...(hasOwn(normalized, 'clientStatus') ? { clientStatus: normalized.clientStatus } : {}),
      ...(hasOwn(normalized, 'wslStatus') ? { wslStatus: normalized.wslStatus } : {}),
      ...(hasOwn(normalized, 'projectsEnabled') ? { projectsEnabled: normalized.projectsEnabled } : {}),
      ...(hasOwn(normalized, 'allTimeProjectsOmitted') ? { allTimeProjectsOmitted: normalized.allTimeProjectsOmitted } : {}),
      ...(hasOwn(normalized, 'allTimeProjectsIncomplete') ? { allTimeProjectsIncomplete: normalized.allTimeProjectsIncomplete } : {}),
      ...(hasOwn(normalized, 'sessionDetailsOmitted') ? { sessionDetailsOmitted: normalized.sessionDetailsOmitted } : {}),
      ...(hasOwn(normalized, 'periodProjectsOmitted') ? { periodProjectsOmitted: normalized.periodProjectsOmitted } : {}),
      ...(hasOwn(normalized, 'syncUploadIntervalMs') ? { syncUploadIntervalMs: normalized.syncUploadIntervalMs } : {}),
      ...(hasOwn(normalized, 'periodWindows') ? { periodWindows: normalized.periodWindows } : {}),
      periods,
      limits: normalized.limits
    });
    if (
      normalized.allTimeProjectsOmitted === true
      || normalized.allTimeProjectsIncomplete === true
      || (normalized.projectsEnabled === false && normalized.periods.allTime.totalTokens > 0)
    ) aggregate.projectsIncomplete = true;
    for (const [periodName, count] of Object.entries(normalized.sessionDetailsOmitted || {})) {
      if (isPeriodExpired(normalized, periodName, now)) continue;
      sessionDetailsOmitted[periodName] = (sessionDetailsOmitted[periodName] || 0) + count;
    }
    for (const [periodName, count] of Object.entries(normalized.periodProjectsOmitted || {})) {
      if (isPeriodExpired(normalized, periodName, now)) continue;
      periodProjectsOmitted[periodName] = (periodProjectsOmitted[periodName] || 0) + count;
    }
    for (const periodName of PERIODS) {
      if (isPeriodExpired(normalized, periodName, now)) continue;
      addPeriodInto(aggregate.periods[periodName], normalizePeriod(normalized.periods[periodName]), options);
    }
  }
  aggregate.limits = aggregateLimits(aggregate.devices, staleAfterMs, now);
  if (Object.keys(sessionDetailsOmitted).length > 0) aggregate.sessionDetailsOmitted = sessionDetailsOmitted;
  if (Object.keys(periodProjectsOmitted).length > 0) aggregate.periodProjectsOmitted = periodProjectsOmitted;
  aggregate.devices.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  for (const periodName of PERIODS) {
    aggregate.periods[periodName].totalTokens = Math.round(aggregate.periods[periodName].totalTokens);
    aggregate.periods[periodName].costUsd = Number(aggregate.periods[periodName].costUsd.toFixed(6));
    for (const [client, cost] of Object.entries(aggregate.periods[periodName].clientCosts)) {
      aggregate.periods[periodName].clientCosts[client] = Number(cost.toFixed(6));
    }
    // Same 6-dp trim as costs: a per-request credit is ~1e-9 granularity, but a
    // month of thousands of them sums to a float whose trailing digits are
    // accumulation noise, not measurement.
    for (const [client, credits] of Object.entries(aggregate.periods[periodName].clientCredits)) {
      aggregate.periods[periodName].clientCredits[client] = Number(credits.toFixed(6));
    }
    for (const [model, cost] of Object.entries(aggregate.periods[periodName].modelCosts)) {
      aggregate.periods[periodName].modelCosts[model] = Number(cost.toFixed(6));
    }
    for (const models of Object.values(aggregate.periods[periodName].clientModelCosts)) {
      for (const [model, cost] of Object.entries(models)) {
        models[model] = Number(cost.toFixed(6));
      }
    }
    for (const models of Object.values(aggregate.periods[periodName].clientModelCredits)) {
      for (const [model, credits] of Object.entries(models)) {
        models[model] = Number(credits.toFixed(6));
      }
    }
    for (const project of Object.values(aggregate.periods[periodName].projects)) {
      project.costUsd = Number(project.costUsd.toFixed(6));
    }
    for (const session of Object.values(aggregate.periods[periodName].sessions)) {
      session.costUsd = Number(session.costUsd.toFixed(6));
      session.credits = Number(asNumber(session.credits).toFixed(6));
      for (const [model, cost] of Object.entries(session.modelCosts)) {
        session.modelCosts[model] = Number(cost.toFixed(6));
      }
      for (const [model, credits] of Object.entries(session.modelCredits || {})) {
        session.modelCredits[model] = Number(credits.toFixed(6));
      }
    }
  }
  return aggregate;
}

// Fields the first-paint payload cannot do without, per period.
//
// `sessions` and `projects` are deliberately absent: session rows alone are ~76%
// of a fleet snapshot's bytes, and the mobile surfaces that read them (the
// 会话 list and the 项目 rollup) are separate screens that pull their own
// endpoint. Keeping the list explicit is what makes a new period field a
// deliberate addition to the mobile payload instead of an accidental one.
const SUMMARY_PERIOD_FIELDS = [
  'totalTokens',
  'costUsd',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
  'unclassifiedTokens',
  'timedTokens',
  'timedOutputTokens',
  'timedDurationMs',
  'estimated',
  'capabilities'
];
const SUMMARY_PERIOD_MAPS = [
  'clients',
  'clientCosts',
  'clientCredits',
  'clientEstimated',
  'clientMeasurements',
  'models',
  'modelCosts',
  'clientModels',
  'clientModelCosts',
  'clientModelCredits',
  'clientCacheReads',
  'clientCacheWrites',
  'clientOutputs',
  'clientUnclassifiedTokens',
  'modelCacheReads',
  'modelCacheWrites',
  'modelOutputs',
  'modelUnclassifiedTokens',
  // The 项目 screen renders the aggregate project rollup from the snapshot, so it
  // has to stay. It is one copy of a client-attributed map (not the per-device
  // archive), and `periodProjectsOmitted` already bounds it.
  'projects'
];

function summaryPeriod(period = {}) {
  const projected = {};
  for (const field of SUMMARY_PERIOD_FIELDS) {
    if (period[field] !== undefined) projected[field] = period[field];
  }
  for (const map of SUMMARY_PERIOD_MAPS) {
    const value = period[map];
    if (value !== undefined) projected[map] = value;
  }
  return projected;
}

// Per-device periods in the first-paint payload are headline numbers only.
//
// Every device breakdown map (clients, models, clientModels, clientModelCosts,
// provenance) is device-detail material: the fleet list renders a device's
// totals, the comparison chart renders its totals, and the device page pulls its
// own document. Keeping the grain here cost ~90% of the remaining summary bytes
// on a fleet with a wide client×model matrix, for data no first-paint surface
// reads. `/api/stats` still carries it in full for the desktop and web hosts.
function summaryDevicePeriod(period = {}) {
  return {
    totalTokens: period.totalTokens ?? 0,
    costUsd: period.costUsd ?? 0,
    ...(period.estimated === true ? { estimated: true } : {})
  };
}

/**
 * Project an aggregate built by [aggregateDevices] down to the first-paint shape.
 *
 * Not a second measurement: every value here is a reference to a value the full
 * aggregate already computed, minus the detail collections. Callers use it on the
 * result of an `aggregateDevices(..., { omitSessionDetail: true })` pass so the
 * session fold never happens in the first place.
 */
function summarizeStats(stats = {}) {
  const periods = {};
  for (const periodName of PERIODS) periods[periodName] = summaryPeriod(stats.periods?.[periodName]);
  return {
    ...stats,
    periods,
    devices: (stats.devices || []).map((device) => {
      const devicePeriods = {};
      for (const periodName of PERIODS) devicePeriods[periodName] = summaryDevicePeriod(device.periods?.[periodName]);
      return { ...device, periods: devicePeriods };
    })
  };
}

// Exact broader-period update from a fresh --today scan. Tokens written since the
// anchor full scan belong to today AND every broader window simultaneously, and
// session logs are append-only, so base + (freshToday − anchorToday) is an
// identity, not an estimate. The anchor stops being valid once the local date
// rolls past the one it was taken on — callers must run a full scan then.
// Recurses over the union of keys so it covers every numeric field a period may
// grow (clients/models/clientModels/sessions/...) without per-field bookkeeping.
function applyPeriodDelta(base, freshToday, anchorToday) {
  const result = deltaValue(base, freshToday, anchorToday, '');
  // Older anchors may still contain the pre-native Reasonix stats-path rows.
  // They are not authoritative session detail and must not survive a warm tick
  // merely because the aggregate totals remain valid.
  if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'sessions')) {
    result.sessions = filterReasonixSyntheticSessions(result.sessions);
  }
  return result;
}

function deltaValue(base, fresh, anchor, key) {
  if (key === 'tokenComponents') {
    // A warm tick may introduce aggregate-only fallback data. Boolean
    // provenance is not arithmetically subtractable, so retain exactness only
    // while both the durable base and the fresh replacement prove it.
    return base === true && fresh === true;
  }
  if (key === 'startedAt') {
    const baseMs = timestampMs(base);
    const freshMs = timestampMs(fresh);
    if (baseMs && freshMs) return baseMs <= freshMs ? base : fresh;
    return base || fresh || '';
  }
  if (key === 'lastUsedAt') {
    const baseMs = timestampMs(base);
    const freshMs = timestampMs(fresh);
    if (baseMs && freshMs) return baseMs >= freshMs ? base : fresh;
    return base || fresh || '';
  }
  const sample = [base, fresh, anchor].find((value) => value !== undefined && value !== null);
  if (typeof sample === 'number') return Math.max(0, asNumber(base) + asNumber(fresh) - asNumber(anchor));
  if (typeof sample === 'string') return base ?? fresh;
  if (sample && typeof sample === 'object') {
    const keys = new Set([...Object.keys(base || {}), ...Object.keys(fresh || {}), ...Object.keys(anchor || {})]);
    const result = Object.getPrototypeOf(sample) === null ? Object.create(null) : {};
    for (const childKey of keys) {
      Object.defineProperty(result, childKey, {
        value: deltaValue(
          base ? base[childKey] : undefined,
          fresh ? fresh[childKey] : undefined,
          anchor ? anchor[childKey] : undefined,
          childKey
        ),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return result;
  }
  return base ?? fresh;
}

module.exports = {
  PERIODS,
  UNATTRIBUTED_USAGE_CLIENT,
  addPeriodInto,
  aggregateDevices,
  aggregateHistory,
  applyPeriodDelta,
  applyProjectRollups,
  canonicalProjectKey,
  carryDeviceHistory,
  emptyPeriod,
  extractUsageBundleFromTokscale,
  extractUsageFromTokscale,
  mergeDeviceRecord,
  mergePeriods,
  normalizeClientName,
  normalizeModelName,
  normalizeModelNameForClient,
  normalizeDeviceRecord,
  normalizePeriod,
  projectRollupFromSessions,
  summarizeStats
};
