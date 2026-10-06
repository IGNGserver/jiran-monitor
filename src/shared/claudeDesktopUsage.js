'use strict';

/**
 * Claude Desktop (Local Agent / Cowork) session usage parser.
 *
 * Reads Local Agent transcripts under Claude Desktop app data
 * (`local-agent-mode-sessions` / `claude-code-sessions`) and aggregates
 * assistant-message `usage` fields. Regular claude.ai chat is out of scope.
 *
 * Returns data shaped like a tokscale JSON response so it can be fed
 * directly into extractUsageFromTokscale or merged alongside tokscale results.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { dayKeyOf, monthKeyOf, normalizeTimeZone } = require('./fleetTimeZone');

const CLIENT_ID = 'claude-desktop';
const SESSION_ROOT_NAMES = ['local-agent-mode-sessions', 'claude-code-sessions'];

function numberValue(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 0 && numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function rowTotal(row) {
  return row.input + row.output + row.cacheRead + row.cacheWrite;
}

function normalizedModelId(value) {
  return String(value || '').trim().toLowerCase();
}

function dirExists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch (_) {
    return false;
  }
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (_) {
    return false;
  }
}

// Cost is an estimate from a model-price catalog, never a provider invoice.
// Return null rather than silently undercount when a row uses a token category
// whose rate is unavailable (notably cache writes for some custom prices).
function estimatedRowCost(row, pricingByModel) {
  const pricing = pricingByModel?.[normalizedModelId(row.model)];
  if (!pricing || typeof pricing !== 'object') return null;
  const components = [
    [row.input, pricing.inputCostPerToken],
    [row.output, pricing.outputCostPerToken],
    [row.cacheRead, pricing.cacheReadInputTokenCost],
    [row.cacheWrite, pricing.cacheCreationInputTokenCost]
  ];
  let cost = 0;
  for (const [tokens, unitCost] of components) {
    if (!tokens) continue;
    if (!Number.isFinite(Number(unitCost)) || Number(unitCost) < 0) return null;
    cost += tokens * Number(unitCost);
  }
  return cost;
}

function platformOf(options = {}) {
  return options.platform || process.platform;
}

function envOf(options = {}) {
  return options.env || process.env;
}

/**
 * Discover Claude Desktop app-data roots for the host platform.
 * Local Agent / Cowork sessions live under these roots; ordinary chat does not.
 */
function discoverDesktopAppRoots(options = {}) {
  const home = options.homeDir || os.homedir();
  const env = envOf(options);
  const platform = platformOf(options);
  const includeMissing = options.includeMissing === true;
  const candidates = [];

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    candidates.push(
      path.join(localAppData, 'Claude-3p'),
      path.join(localAppData, 'Claude')
    );
    // MSIX / Store installs sometimes keep LocalState under Packages.
    const packages = path.join(localAppData, 'Packages');
    if (dirExists(packages)) {
      try {
        for (const entry of fs.readdirSync(packages, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          if (!/claude/i.test(entry.name)) continue;
          candidates.push(
            path.join(packages, entry.name, 'LocalCache', 'Local', 'Claude'),
            path.join(packages, entry.name, 'LocalCache', 'Local', 'Claude-3p'),
            path.join(packages, entry.name, 'LocalState')
          );
        }
      } catch (_) {
        // ignore unreadable Packages dir
      }
    }
  } else if (platform === 'darwin') {
    candidates.push(
      path.join(home, 'Library', 'Application Support', 'Claude-3p'),
      path.join(home, 'Library', 'Application Support', 'Claude')
    );
  } else {
    candidates.push(
      path.join(home, '.config', 'Claude-3p'),
      path.join(home, '.config', 'Claude'),
      path.join(home, '.local', 'share', 'Claude-3p'),
      path.join(home, '.local', 'share', 'Claude')
    );
  }

  const seen = new Set();
  const roots = [];
  for (const candidate of candidates) {
    const key = path.normalize(candidate).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (includeMissing || dirExists(candidate)) roots.push(candidate);
  }
  return roots;
}

/**
 * Watchable session containers under each app root. Presence alone is enough
 * for waiting/missing status; empty containers simply yield zero usage.
 */
function desktopSessionWatchDirs(options = {}) {
  const includeMissing = options.includeMissing === true;
  const dirs = [];
  const seen = new Set();
  for (const appRoot of discoverDesktopAppRoots(options)) {
    for (const name of SESSION_ROOT_NAMES) {
      const dir = path.join(appRoot, name);
      const key = path.normalize(dir).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (includeMissing || dirExists(dir)) dirs.push(dir);
    }
  }
  return dirs;
}

function isAuditJsonl(filePath) {
  return path.basename(filePath).toLowerCase() === 'audit.jsonl';
}

function collectJsonlUnderProjects(projectsDir, out) {
  const stack = [projectsDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.jsonl')) continue;
      if (isAuditJsonl(full)) continue;
      out.push(full);
    }
  }
}

function findProjectsJsonlFiles(sessionRoot) {
  const files = [];
  const stack = [sessionRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === '.claude') {
        const projectsDir = path.join(full, 'projects');
        if (dirExists(projectsDir)) collectJsonlUnderProjects(projectsDir, files);
        continue;
      }
      // Stay inside Desktop session trees; skip Electron/cache-like noise.
      if (entry.name === 'Cache' || entry.name === 'Code Cache' || entry.name === 'GPUCache') continue;
      if (entry.name === 'IndexedDB' || entry.name === 'Local Storage' || entry.name === 'Session Storage') continue;
      stack.push(full);
    }
  }
  return files;
}

function sessionHomeFromJsonl(filePath) {
  // .../<sessionHome>/.claude/projects/<encoded-cwd>/<session>.jsonl
  let dir = path.dirname(filePath);
  while (dir && path.basename(dir) !== '.claude') {
    const parent = path.dirname(dir);
    if (parent === dir) return '';
    dir = parent;
  }
  if (path.basename(dir) !== '.claude') return '';
  return path.dirname(dir);
}

function loadSessionMeta(sessionHome) {
  if (!sessionHome) return null;
  const metaPath = `${sessionHome}.json`;
  if (!fileExists(metaPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch (_) {
    return null;
  }
}

function looksLikeSandboxPath(value) {
  const text = String(value || '');
  return /Claude-3p|Claude[/\\]local-agent|local-agent-mode-sessions|claude-code-sessions|Application Support[/\\]Claude/i.test(text);
}

function projectLabelFromMeta(meta, cwd) {
  const title = String(meta?.title || '').trim();
  if (title) return title;

  const folders = Array.isArray(meta?.userSelectedFolders) ? meta.userSelectedFolders : [];
  for (const folder of folders) {
    const base = path.basename(String(folder || '').trim());
    if (base) return base;
  }

  const approved = Array.isArray(meta?.userApprovedFileAccessPaths) ? meta.userApprovedFileAccessPaths : [];
  for (const approvedPath of approved) {
    const text = String(approvedPath || '').trim();
    if (!text || looksLikeSandboxPath(text)) continue;
    const base = path.basename(text);
    if (base) return base;
  }

  const cwdText = String(cwd || meta?.cwd || '').trim();
  if (cwdText && !looksLikeSandboxPath(cwdText)) {
    const base = path.basename(cwdText);
    if (base) return base;
  }

  const processName = String(meta?.processName || meta?.vmProcessName || '').trim();
  if (processName) return processName;
  return 'Claude Desktop';
}

function collectSessionRows(filePath, options = {}) {
  const sessionId = options.sessionId || path.basename(filePath, path.extname(filePath));
  const projectLabel = String(options.projectLabel || '').trim();
  const content = String(fs.readFileSync(filePath, 'utf8') || '');
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const msgGroups = new Map();

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type !== 'assistant') continue;
      const msg = obj.message;
      if (!msg || !msg.usage) continue;
      const msgId = msg.id;
      if (!msgId) continue;

      const model = msg.model || obj._channelModelId || 'unknown';
      const u = msg.usage;
      const input = numberValue(u.input_tokens || u.inputTokens);
      const output = numberValue(u.output_tokens || u.outputTokens);
      const cacheRead = numberValue(u.cache_read_input_tokens || u.cacheReadInputTokens);
      const cacheWrite = numberValue(u.cache_creation_input_tokens || u.cacheCreationInputTokens);
      const createdAt = timestampMs(obj.timestamp || obj._createdAt || obj.createdAt || obj.created_at);

      if (!msgGroups.has(msgId)) msgGroups.set(msgId, []);
      msgGroups.get(msgId).push({
        sessionId,
        model,
        input,
        output,
        cacheRead,
        cacheWrite,
        createdAt,
        projectLabel
      });
    } catch (_) {
      // skip malformed lines
    }
  }

  // Collapse each message group: take the entry with the largest total tokens
  // (multiple chunks share a message.id for thinking/tool_use/text splits).
  const collapsed = [];
  for (const chunks of msgGroups.values()) {
    if (chunks.length === 0) continue;
    chunks.sort((a, b) => rowTotal(b) - rowTotal(a));
    const row = { ...chunks[0] };
    row.createdAt = Math.max(0, ...chunks.map((chunk) => chunk.createdAt || 0));
    row.messages = 1;
    collapsed.push(row);
  }
  return collapsed;
}

/**
 * Read every Desktop Local Agent session exactly once per collection tick.
 */
function collectClaudeDesktopRows(options = {}) {
  const sessionRoots = Array.isArray(options.sessionRoots)
    ? options.sessionRoots
    : desktopSessionWatchDirs(options);
  const appRoots = Array.isArray(options.roots) ? options.roots : null;
  const roots = sessionRoots.length
    ? sessionRoots
    : (appRoots || discoverDesktopAppRoots(options)).flatMap((appRoot) => (
      SESSION_ROOT_NAMES.map((name) => path.join(appRoot, name)).filter(dirExists)
    ));

  const metaCache = new Map();
  const rows = [];
  const seenFiles = new Set();

  for (const root of roots) {
    if (!dirExists(root)) continue;
    for (const filePath of findProjectsJsonlFiles(root)) {
      const key = path.normalize(filePath).toLowerCase();
      if (seenFiles.has(key)) continue;
      seenFiles.add(key);
      try {
        const sessionHome = sessionHomeFromJsonl(filePath);
        let meta = null;
        if (sessionHome) {
          if (!metaCache.has(sessionHome)) metaCache.set(sessionHome, loadSessionMeta(sessionHome));
          meta = metaCache.get(sessionHome);
        }
        const projectLabel = projectLabelFromMeta(meta, null);
        rows.push(...collectSessionRows(filePath, {
          sessionId: path.basename(filePath, path.extname(filePath)),
          projectLabel
        }));
      } catch (_) {
        // skip unreadable files
      }
    }
  }
  return rows;
}

function windowStartMs(windows) {
  return Math.max(0, timestampMs(windows.todayStart), timestampMs(windows.monthStart), timestampMs(windows.allTimeSince));
}

/**
 * Build a tokscale-compatible JSON object from Claude Desktop Local Agent data.
 */
function buildTokscaleJson(windows = {}, options = {}) {
  const sinceMs = windowStartMs(windows);
  const untilMs = Number(windows.untilMs || 0);
  // A fleet-calendar window is expressed as zone day/month keys rather than
  // epoch starts: a row belongs to the calendar day it falls on in the active
  // zone, which is exact even when that day's midnight is not the machine's.
  const todayKey = String(windows.todayKey || '');
  const monthKey = String(windows.monthKey || '');
  const timeZone = normalizeTimeZone(options.timeZone || windows.timeZone);
  const entries = [];
  let allInput = 0;
  let allOutput = 0;
  let allCacheRead = 0;
  let allCacheWrite = 0;
  let allMessages = 0;
  let allCost = 0;

  const allRows = (Array.isArray(options.rows) ? options.rows : collectClaudeDesktopRows(options))
    .filter((row) => {
      if (!row.createdAt) {
        // An undated row can only be placed in the unbounded all-time window.
        if ((sinceMs || todayKey || monthKey) && options.includeUndated !== true) return false;
      } else if (todayKey || monthKey) {
        const key = dayKeyOf(new Date(row.createdAt), timeZone);
        if (todayKey ? key !== todayKey : key.slice(0, 7) !== monthKey) return false;
      } else if (sinceMs && row.createdAt < sinceMs) {
        return false;
      }
      if (untilMs && row.createdAt && row.createdAt > untilMs) return false;
      return true;
    });

  const bySessionModel = new Map();
  for (const row of allRows) {
    const key = `${row.sessionId || 'unknown'}\u0000${row.model}`;
    if (!bySessionModel.has(key)) {
      bySessionModel.set(key, {
        sessionId: row.sessionId || 'unknown',
        model: row.model,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        messages: 0,
        cost: 0,
        startedAt: 0,
        lastUsedAt: 0,
        projectLabel: row.projectLabel || ''
      });
    }
    const m = bySessionModel.get(key);
    const cost = estimatedRowCost(row, options.pricingByModel);
    m.input += row.input;
    m.output += row.output;
    m.cacheRead += row.cacheRead;
    m.cacheWrite += row.cacheWrite;
    m.messages += Number(row.messages || 1);
    m.cost += cost === null ? 0 : cost;
    if (row.projectLabel && !m.projectLabel) m.projectLabel = row.projectLabel;
    if (row.createdAt && (!m.startedAt || row.createdAt < m.startedAt)) m.startedAt = row.createdAt;
    if (row.createdAt > m.lastUsedAt) m.lastUsedAt = row.createdAt;
  }

  for (const m of bySessionModel.values()) {
    entries.push({
      client: CLIENT_ID,
      mergedClients: null,
      sessionId: m.sessionId,
      model: m.model,
      provider: 'anthropic',
      input: m.input,
      output: m.output,
      cacheRead: m.cacheRead,
      cacheWrite: m.cacheWrite,
      reasoning: 0,
      messageCount: m.messages,
      cost: m.cost,
      startedAt: m.startedAt ? new Date(m.startedAt).toISOString() : '',
      lastUsedAt: m.lastUsedAt ? new Date(m.lastUsedAt).toISOString() : '',
      projectLabel: m.projectLabel || '',
      performance: null
    });
    allInput += m.input;
    allOutput += m.output;
    allCacheRead += m.cacheRead;
    allCacheWrite += m.cacheWrite;
    allMessages += m.messages;
    allCost += m.cost;
  }

  return {
    groupBy: 'client,session,model',
    entries,
    totalInput: allInput,
    totalOutput: allOutput,
    totalCacheRead: allCacheRead,
    totalCacheWrite: allCacheWrite,
    totalMessages: allMessages,
    totalCost: allCost,
    processingTimeMs: 0
  };
}

function buildClaudeDesktopHistoryGraph(options = {}) {
  const byDate = new Map();
  const timeZone = normalizeTimeZone(options.timeZone);
  const rows = Array.isArray(options.rows) ? options.rows : collectClaudeDesktopRows(options);
  for (const row of rows) {
    const date = row.createdAt ? dayKeyOf(new Date(row.createdAt), timeZone) : '';
    if (!date) continue;
    let day = byDate.get(date);
    if (!day) {
      day = { date, clients: [] };
      byDate.set(date, day);
    }
    const modelId = normalizedModelId(row.model) || 'unknown';
    let client = day.clients.find((entry) => entry.modelId === modelId);
    if (!client) {
      client = {
        client: CLIENT_ID,
        modelId,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: 0,
        messages: 0
      };
      day.clients.push(client);
    }
    const cost = estimatedRowCost(row, options.pricingByModel);
    client.tokens.input += row.input;
    client.tokens.output += row.output;
    client.tokens.cacheRead += row.cacheRead;
    client.tokens.cacheWrite += row.cacheWrite;
    client.cost += cost === null ? 0 : cost;
    client.messages += 1;
  }
  return { contributions: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

function buildClaudeDesktopPeriods(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const timeZone = normalizeTimeZone(options.timeZone);
  const rows = Array.isArray(options.rows) ? options.rows : collectClaudeDesktopRows(options);
  const buildOptions = { rows, pricingByModel: options.pricingByModel, timeZone };

  return {
    today: buildTokscaleJson({ todayKey: dayKeyOf(now, timeZone) }, buildOptions),
    month: buildTokscaleJson({ monthKey: monthKeyOf(now, timeZone) }, buildOptions),
    allTime: buildTokscaleJson({ allTimeSince: options.allTimeSince }, { ...buildOptions, includeUndated: true })
  };
}

function buildClaudeDesktopRangeJson(range, options = {}) {
  const rows = Array.isArray(options.rows) ? options.rows : collectClaudeDesktopRows(options);
  return buildTokscaleJson({
    allTimeSince: range?.startMs || 0,
    untilMs: range?.endMs || 0
  }, {
    rows,
    pricingByModel: options.pricingByModel,
    includeUndated: false
  });
}

/**
 * Resolve a Local Agent session transcript path by session id (jsonl basename).
 * Accepts optional `id@suffix` forms and strips the suffix.
 */
function resolveClaudeDesktopSessionFile(sessionId, options = {}) {
  const raw = String(sessionId || '').trim();
  if (!raw) return '';
  const id = raw.includes('@') ? raw.slice(0, raw.indexOf('@')) : raw;
  if (!id) return '';

  const sessionRoots = Array.isArray(options.sessionRoots)
    ? options.sessionRoots
    : desktopSessionWatchDirs(options);

  for (const root of sessionRoots) {
    for (const filePath of findProjectsJsonlFiles(root)) {
      if (path.basename(filePath, path.extname(filePath)) === id) return filePath;
    }
  }
  return '';
}

module.exports = {
  CLIENT_ID,
  SESSION_ROOT_NAMES,
  discoverDesktopAppRoots,
  desktopSessionWatchDirs,
  collectSessionRows,
  collectClaudeDesktopRows,
  estimatedRowCost,
  buildTokscaleJson,
  buildClaudeDesktopHistoryGraph,
  buildClaudeDesktopPeriods,
  buildClaudeDesktopRangeJson,
  resolveClaudeDesktopSessionFile,
  projectLabelFromMeta
};
