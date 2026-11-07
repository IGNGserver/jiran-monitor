'use strict';

const mysql = require('mysql2/promise');
const { isDeepStrictEqual } = require('node:util');
const { emptySubscriptionDocument } = require('../shared/subscriptionDisplay');
const {
  describeDatabaseTarget,
  poolOptionsFromConfig,
  resolveDatabaseConfig
} = require('./databaseConfig');

const RESERVED_DYNAMIC_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function safeDynamicKey(value, fallback = 'unknown') {
  const key = String(value ?? '').trim();
  return key && !RESERVED_DYNAMIC_KEYS.has(key.toLowerCase()) ? key : fallback;
}

function mapNumber(map, key) {
  return hasOwn(map, key) ? number(map[key]) : 0;
}

function ensureNestedMap(map, key) {
  if (!hasOwn(map, key) || !map[key] || typeof map[key] !== 'object' || Array.isArray(map[key])) {
    map[key] = {};
  }
  return map[key];
}

// A remote database makes per-statement timing the only way to tell a slow
// query apart from a slow link. The wrapper is passive (no extra round trips),
// counts every statement, and logs only the ones over the threshold with the
// SQL text truncated — values are never logged.
function instrumentPoolQueries(pool, { slowQueryMs = 1000, logger = console } = {}) {
  const metrics = { queries: 0, slowQueries: 0, totalMs: 0, maxMs: 0 };
  const wrapped = new WeakSet();

  function record(startedAt, sql) {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    metrics.queries += 1;
    metrics.totalMs += ms;
    if (ms > metrics.maxMs) metrics.maxMs = ms;
    if (slowQueryMs > 0 && ms >= slowQueryMs) {
      metrics.slowQueries += 1;
      const text = typeof sql === 'string' ? sql : String(sql?.sql || '');
      logger.warn?.(`[mysql-slow] ${Math.round(ms)}ms ${text.replace(/\s+/g, ' ').trim().slice(0, 180)}`);
    }
  }

  function wrap(target, method) {
    const original = target?.[method];
    if (typeof original !== 'function') return;
    target[method] = async function timedStatement(sql, ...rest) {
      const startedAt = process.hrtime.bigint();
      try {
        return await original.call(this, sql, ...rest);
      } finally {
        record(startedAt, sql);
      }
    };
  }

  wrap(pool, 'query');
  wrap(pool, 'execute');
  const originalGetConnection = typeof pool.getConnection === 'function' ? pool.getConnection.bind(pool) : null;
  if (originalGetConnection) {
    pool.getConnection = async function timedGetConnection(...args) {
      const connection = await originalGetConnection(...args);
      if (connection && !wrapped.has(connection)) {
        wrapped.add(connection);
        wrap(connection, 'query');
        wrap(connection, 'execute');
      }
      return connection;
    };
  }
  pool.jiranQueryMetrics = metrics;
  return metrics;
}

function createMySqlPool(options = {}) {
  // One resolver for the URL form and the historical MYSQL_* variables. The
  // queueLimit rationale still applies: mysql2 has no acquire timeout and
  // defaults queueLimit to 0 (unbounded), so without a limit a saturated pool
  // leaves every DB-backed route hanging with no error. A bounded queue turns
  // that into a fast 503, which clients already treat as a transport failure.
  const config = resolveDatabaseConfig({ options });
  const pool = mysql.createPool(poolOptionsFromConfig(config));

  if (options.log !== false) {
    for (const warning of config.warnings) console.warn?.(`[mysql-config] ${warning}`);
    console.log?.(
      `[mysql-config] ${describeDatabaseTarget(config)} `
      + `source=${config.source} pool=${config.pool.connectionLimit} maxIdle=${config.pool.maxIdle} `
      + `connectTimeout=${config.pool.connectTimeout}ms queue=${config.pool.queueLimit}`
    );
  }
  // Redacted snapshot for /api/health-adjacent diagnostics; never the password.
  pool.jiranDatabase = Object.freeze({
    source: config.source,
    target: describeDatabaseTarget(config),
    pool: config.pool,
    tls: Boolean(config.ssl)
  });
  const slowQueryMs = Number(process.env.MYSQL_SLOW_QUERY_MS);
  instrumentPoolQueries(pool, {
    slowQueryMs: Number.isFinite(slowQueryMs) && slowQueryMs >= 0 ? slowQueryMs : 1000,
    logger: options.logger || console
  });

  if (typeof pool.on === 'function') {
    pool.on('error', (err) => {
      // Prevent unhandled pool errors from bubbling up and crashing the process
      const code = err?.code || 'UNKNOWN';
      const msg = err?.message || String(err);
      console.warn?.(`[mysql-pool] background connection error (${code}): ${msg}`);
    });
  }

  return pool;
}

function json(value) {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function date(value) {
  const parsed = new Date(value || Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function iso(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

function subscriptionDocumentRow(row) {
  if (!row) return emptySubscriptionDocument();
  return {
    version: 1,
    updatedAt: row.updated_at ? iso(row.updated_at) : '',
    subscriptions: parseJson(row.subscriptions, []) || []
  };
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pricingRow(row) {
  return {
    id: Number(row.id),
    model: row.model,
    inputPricePerMillion: Number(row.input_price_per_million),
    outputPricePerMillion: Number(row.output_price_per_million),
    cacheReadPricePerMillion: Number(row.cache_read_price_per_million),
    cacheWritePricePerMillion: Number(row.cache_write_price_per_million),
    source: row.source,
    updatedAt: iso(row.updated_at)
  };
}

function hubAccountRow(row) {
  if (!row) return null;
  return {
    id: String(row.account_id || ''),
    provider: String(row.provider || ''),
    name: String(row.name || ''),
    label: String(row.label || ''),
    accountKey: String(row.account_key || ''),
    accountEmail: String(row.account_email || ''),
    accountLabel: String(row.account_label || ''),
    enabled: Boolean(row.enabled),
    status: String(row.status || 'pending'),
    lastErrorCode: String(row.last_error_code || ''),
    lastErrorMessage: String(row.last_error_message || ''),
    lastAttemptAt: row.last_attempt_at ? iso(row.last_attempt_at) : null,
    lastSuccessAt: row.last_success_at ? iso(row.last_success_at) : null,
    nextRefreshAt: row.next_refresh_at ? iso(row.next_refresh_at) : null,
    createdAt: row.created_at ? iso(row.created_at) : null,
    updatedAt: row.updated_at ? iso(row.updated_at) : null
  };
}

function hubAccountSnapshotRow(row) {
  if (!row) return null;
  return {
    provider: parseJson(row.provider_snapshot, null),
    lastGood: parseJson(row.last_good_snapshot, null),
    updatedAt: row.updated_at ? iso(row.updated_at) : null
  };
}

function hubSessionRow(row) {
  if (!row) return null;
  return {
    sessionId: String(row.session_id || ''),
    tokenHash: String(row.token_hash || ''),
    secretFingerprint: String(row.secret_fingerprint || ''),
    deviceName: String(row.device_name || ''),
    platform: String(row.platform || ''),
    userAgent: String(row.user_agent || ''),
    persistent: Number(row.persistent) === 1,
    createdAt: row.created_at ? iso(row.created_at) : null,
    lastSeenAt: row.last_seen_at ? iso(row.last_seen_at) : null,
    expiresAt: row.expires_at ? iso(row.expires_at) : null,
    revokedAt: row.revoked_at ? iso(row.revoked_at) : null
  };
}

function allPeriodModels(record) {
  const models = new Set();
  for (const period of Object.values(record?.periods || {})) {
    for (const model of Object.keys(period?.models || {})) models.add(model);
    for (const session of Object.values(period?.sessions || {})) {
      for (const model of Object.keys(session?.models || {})) models.add(model);
    }
  }
  return models;
}

function emptyUsageRange() {
  return {
    totalTokens: 0,
    costUsd: 0,
    clients: {},
    clientCosts: {},
    clientCredits: {},
    models: {},
    modelCosts: {},
    clientModels: {},
    clientModelCosts: {},
    eventCount: 0
  };
}

function addTokenCost(mapTokens, mapCosts, key, tokens, cost) {
  const id = safeDynamicKey(key);
  mapTokens[id] = mapNumber(mapTokens, id) + tokens;
  mapCosts[id] = mapNumber(mapCosts, id) + cost;
}

// Bound both placeholder count and parameter bytes (including UTF-8 JSON). A
// single oversized row remains one statement: splitting a row would change the
// ledger. Normal event rows are also bounded by their VARCHAR column widths.
function* writeBatches(rows) {
  let batch = [];
  let bytes = 0;
  for (const row of rows) {
    const rowBytes = row.reduce((size, value) => size + 16 + (
      typeof value === 'string' ? Buffer.byteLength(value) : 8
    ), 0);
    if (batch.length && (batch.length >= 500 || bytes + rowBytes > 512 * 1024)) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(row);
    bytes += rowBytes;
  }
  if (batch.length) yield batch;
}

function placeholders(rows) {
  return rows.map((row) => `(${row.map(() => '?').join(', ')})`).join(', ');
}

function storedSnapshot(record) {
  const stored = { ...record };
  delete stored.limits;
  delete stored.limitsOnly;
  return stored;
}

function sameStoredValue(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftArray = Array.isArray(left);
  const rightArray = Array.isArray(right);
  if (leftArray || rightArray) {
    if (!leftArray || !rightArray || left.length !== right.length) return false;
  } else {
    // Normalization uses null-prototype dictionaries; MySQL JSON parses them as
    // ordinary objects. Their prototypes are not persisted content. Keep strict
    // comparison for non-JSON objects rather than treating Dates/Maps as {}.
    const leftPrototype = Object.getPrototypeOf(left);
    const rightPrototype = Object.getPrototypeOf(right);
    if ((leftPrototype !== null && leftPrototype !== Object.prototype)
      || (rightPrototype !== null && rightPrototype !== Object.prototype)) return isDeepStrictEqual(left, right);
  }
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every((key) => hasOwn(right, key) && sameStoredValue(left[key], right[key]));
}

// A snapshot is one JSON document, but only a few of its top-level keys move on
// a normal tick. JSON_SET/JSON_REMOVE let the Hub send the changed fragments
// instead of re-sending (and re-parsing) history and attribution that did not
// change. The caller still owns one serialization for the full-write fallback.
const SNAPSHOT_KEY_ORDER = new Map([['updatedAt', 0], ['receivedAt', 1]]);

function snapshotJsonPath(key) {
  // Only plain top-level identifiers are addressed; anything else falls back to
  // a full document write rather than interpolating an unchecked SQL string.
  return /^[A-Za-z0-9_]+$/.test(key) ? `'$.${key}'` : null;
}

function snapshotPatch(previous, current) {
  const keys = [...new Set([...Object.keys(previous || {}), ...Object.keys(current || {})])]
    .filter((key) => key !== 'deviceId')
    .sort((left, right) => (SNAPSHOT_KEY_ORDER.get(left) ?? 2) - (SNAPSHOT_KEY_ORDER.get(right) ?? 2)
      || left.localeCompare(right));
  const sets = [];
  const removes = [];
  for (const key of keys) {
    const path = snapshotJsonPath(key);
    if (!path) return null;
    const hasPrevious = hasOwn(previous, key) && previous[key] !== undefined;
    const hasCurrent = hasOwn(current, key) && current[key] !== undefined;
    if (!hasCurrent) {
      if (hasPrevious) removes.push(path);
      continue;
    }
    if (hasPrevious && sameStoredValue(previous[key], current[key])) continue;
    const value = current[key];
    if (value === null) {
      // JSON_SET() returns SQL NULL when its value argument is SQL NULL, which
      // would erase the column. CAST('null' AS JSON) is the JSON null literal.
      sets.push({ path, sql: 'CAST(? AS JSON)', value: 'null' });
    } else if (typeof value === 'object') {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) return null;
      sets.push({ path, sql: 'CAST(? AS JSON)', value: serialized });
    } else if (['string', 'number', 'boolean'].includes(typeof value)) {
      sets.push({ path, sql: '?', value });
    } else {
      return null;
    }
  }
  return { sets, removes };
}

async function writeSnapshotDocument(executor, table, deviceId, previous, current, serialize) {
  if (!previous) {
    await executor.execute(`INSERT INTO ${table} (device_id, snapshot_json)
      VALUES (?, ?) ON DUPLICATE KEY UPDATE snapshot_json = VALUES(snapshot_json)`, [deviceId, serialize()]);
    return;
  }
  const patch = snapshotPatch(previous, current);
  if (!patch) {
    await executor.execute(`INSERT INTO ${table} (device_id, snapshot_json)
      VALUES (?, ?) ON DUPLICATE KEY UPDATE snapshot_json = VALUES(snapshot_json)`, [deviceId, serialize()]);
    return;
  }
  if (patch.sets.length === 0 && patch.removes.length === 0) return;
  let expression = 'snapshot_json';
  const values = [];
  for (const set of patch.sets) {
    expression = `JSON_SET(${expression}, ${set.path}, ${set.sql})`;
    values.push(set.value);
  }
  if (patch.removes.length > 0) {
    expression = `JSON_REMOVE(${expression}, ${patch.removes.join(', ')})`;
  }
  await executor.execute(`UPDATE ${table} SET snapshot_json = ${expression} WHERE device_id = ?`, [...values, deviceId]);
}

const SESSION_COUNTERS = [
  ['totalTokens', 'total_tokens'], ['inputTokens', 'input_tokens'], ['outputTokens', 'output_tokens'],
  ['cacheReadTokens', 'cache_read_tokens'], ['cacheWriteTokens', 'cache_write_tokens'],
  ['reasoningTokens', 'reasoning_tokens'], ['messageCount', 'message_count']
];

function sameSession(row, summary) {
  if (!SESSION_COUNTERS.every(([field, column]) => number(row[column]) === number(summary[field]))) return false;
  // Compare at the existing DECIMAL(24,10) storage precision, without rounding
  // the value we send to MySQL or touching the immutable ledger's prices.
  if (number(row.cost_usd) !== Number(number(summary.costUsd).toFixed(10))) return false;
  if (iso(row.started_at) !== iso(summary.startedAt) || iso(row.last_used_at) !== iso(summary.lastUsedAt)) return false;
  const models = parseJson(row.models, {}) || {};
  const next = summary.models || {};
  return Object.keys(models).length === Object.keys(next).length
    && Object.keys(models).every((key) => hasOwn(next, key) && models[key] === next[key]);
}

function createRepository(pool) {
  async function listDeviceRecords(executor = pool) {
    // Do not sort the JSON snapshots in MySQL. With a large snapshot, sorting
    // the selected JSON values can exceed MySQL's sort_buffer_size even when
    // the device table itself is small. Consumers that need stable output sort
    // the normalized records in JavaScript.
    const [rows] = await executor.query(`SELECT state.snapshot_json
      FROM device_ingest_state state
      INNER JOIN devices device ON device.device_id = state.device_id
      WHERE device.deleted_at IS NULL`);
    return rows.map((row) => parseJson(row.snapshot_json, {}));
  }

  async function getDeviceRecord(deviceId, executor = pool) {
    const [rows] = await executor.execute('SELECT snapshot_json FROM device_ingest_state WHERE device_id = ?', [deviceId]);
    return rows.length ? parseJson(rows[0].snapshot_json, null) : null;
  }

  async function getActiveDeviceRecord(deviceId, executor = pool) {
    const [rows] = await executor.execute(`SELECT state.snapshot_json
      FROM device_ingest_state state
      INNER JOIN devices device ON device.device_id = state.device_id
      WHERE device.device_id = ? AND device.deleted_at IS NULL`, [deviceId]);
    return rows.length ? parseJson(rows[0].snapshot_json, null) : null;
  }

  // The ingest baseline and the device row are updated in the same transaction.
  // Locking the row before reading the baseline serializes cumulative deltas for
  // one device while leaving different devices fully concurrent.
  async function lockDevice(deviceId, executor = pool) {
    const [rows] = await executor.execute(
      'SELECT device_id FROM devices WHERE device_id = ? FOR UPDATE',
      [String(deviceId || '')]
    );
    return rows.length > 0;
  }

  // One round trip instead of lockDevice + getDeviceRecord + getIngestBaseline.
  // `FOR UPDATE` still serializes cumulative deltas for one device; the joins
  // only add rows of the same device. `active` is false for a soft-deleted
  // device whose sessions table was cleared by DELETE, which is why the caller
  // must not trust the stored session document as a mirror of the table then.
  async function lockAndLoadIngestState(deviceId, executor = pool) {
    const [rows] = await executor.execute(`SELECT device.device_id AS device_id,
        device.deleted_at AS deleted_at,
        state.snapshot_json AS display_json,
        baseline.snapshot_json AS baseline_json,
        baseline.transferred AS transferred
      FROM devices device
      LEFT JOIN device_ingest_state state ON state.device_id = device.device_id
      LEFT JOIN device_ingest_baseline baseline ON baseline.device_id = device.device_id
      WHERE device.device_id = ? FOR UPDATE`, [String(deviceId || '')]);
    if (rows.length === 0) {
      return { found: false, display: null, baseline: null, transferred: false, active: false };
    }
    const row = rows[0];
    const display = row.display_json === null || row.display_json === undefined
      ? null : parseJson(row.display_json, null);
    const storedBaseline = row.baseline_json === null || row.baseline_json === undefined
      ? null : parseJson(row.baseline_json, null);
    return {
      found: true,
      display,
      // Pre-007 databases (or a device that predates the baseline table) treated
      // the display snapshot as the baseline; keep that fallback.
      baseline: storedBaseline || display,
      transferred: Number(row.transferred) === 1,
      active: row.deleted_at === null || row.deleted_at === undefined
    };
  }

  async function saveDevice(record, executor = pool, options = {}) {
    const stored = storedSnapshot(record);
    // This option is the persisted display snapshot read under the caller's
    // transaction/device lock, never a raw cumulative upload or another device.
    const previous = options.previousRecord?.deviceId === record.deviceId
      ? storedSnapshot(options.previousRecord) : null;
    let serialized;
    const serialize = () => (serialized ??= JSON.stringify(stored));
    const columns = [
      'hostname', 'platform', 'updated_at', 'received_at', 'agent_version', 'agent_runtime',
      'tracked_clients', 'client_status', 'wsl_status', 'projects_enabled',
      'all_time_projects_omitted', 'all_time_projects_incomplete', 'sync_upload_interval_ms',
      'period_windows', 'limits'
    ];
    const values = [
      record.hostname || '', record.platform || '', date(record.updatedAt), date(record.receivedAt),
      record.agentVersion || '', record.agentRuntime || '', json(record.trackedClients), json(record.clientStatus),
      json(record.wslStatus), record.projectsEnabled ?? null, record.allTimeProjectsOmitted ?? null,
      record.allTimeProjectsIncomplete ?? null, record.syncUploadIntervalMs ?? null, json(record.periodWindows),
      null
    ];
    if (!previous || !sameStoredValue(previous.history, stored.history)) {
      columns.push('history');
      values.push(json(record.history));
    }
    if (previous) {
      await executor.execute(`UPDATE devices SET ${columns.map((column) => `${column} = ?`).join(', ')},
        deleted_at = NULL WHERE device_id = ?`, [...values, record.deviceId]);
    } else {
      await executor.execute(`INSERT INTO devices (device_id, ${columns.join(', ')})
        VALUES (?, ${columns.map(() => '?').join(', ')})
        ON DUPLICATE KEY UPDATE ${columns.map((column) => `${column} = VALUES(${column})`).join(', ')},
        deleted_at = NULL`, [record.deviceId, ...values]);
    }
    if (!previous || !sameStoredValue(previous, stored)) {
      await writeSnapshotDocument(executor, 'device_ingest_state', record.deviceId, previous, stored, serialize);
    }
    // Legacy callers still mirror display -> baseline. Ingest may explicitly
    // supply the raw cumulative record when the display is transfer-adjusted;
    // display-only updates must use baseline:false. Never clear `transferred`.
    if (options.baseline === false) return;
    const baseline = options.baseline === undefined || options.baseline === record
      ? stored : storedSnapshot(options.baseline);
    // Only a known persisted RAW baseline may authorize a skipped/partial
    // write. In particular previousRecord is not evidence: transfers deliberately
    // make display and raw differ. Unknown/first persistence keeps the upsert.
    const previousBaseline = options.previousBaseline?.deviceId === record.deviceId
      ? storedSnapshot(options.previousBaseline) : null;
    // The usual rawCumulative is a shallow clone of the unadjusted display.
    // Reuse its serialization even when those root objects are not identical,
    // and only compute it when a full write is actually chosen.
    const baselineJson = () => (sameStoredValue(stored, baseline) ? serialize() : JSON.stringify(baseline));
    await writeSnapshotDocument(executor, 'device_ingest_baseline', record.deviceId, previousBaseline, baseline, baselineJson);
  }

  async function countDevices(executor = pool) {
    const [rows] = await executor.query('SELECT COUNT(*) AS count FROM devices WHERE deleted_at IS NULL');
    return Number(rows[0]?.count || 0);
  }

  async function getPricing(models, executor = pool) {
    const ids = [...new Set(models.map((model) => String(model || '').trim()).filter(Boolean))];
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => '?').join(', ');
    const [rows] = await executor.execute(`SELECT * FROM model_pricing WHERE model IN (${placeholders})`, ids);
    return new Map(rows.map((row) => {
      const item = pricingRow(row);
      return [item.model, item];
    }));
  }

  async function listPricing(executor = pool) {
    const [rows] = await executor.query('SELECT * FROM model_pricing ORDER BY model');
    return rows.map(pricingRow);
  }

  async function listHubAccounts(executor = pool) {
    const [rows] = await executor.query(`SELECT * FROM hub_accounts
      ORDER BY provider, name, account_id`);
    return rows.map(hubAccountRow);
  }

  async function getHubAccount(accountId, executor = pool) {
    const [rows] = await executor.execute(
      'SELECT * FROM hub_accounts WHERE account_id = ?',
      [String(accountId || '')]
    );
    return hubAccountRow(rows[0]);
  }

  async function getHubAccountForUpdate(accountId, executor = pool) {
    const [rows] = await executor.execute(
      'SELECT * FROM hub_accounts WHERE account_id = ? FOR UPDATE',
      [String(accountId || '')]
    );
    return hubAccountRow(rows[0]);
  }

  async function findHubAccount(provider, accountKey = '', accountEmail = '', executor = pool) {
    const normalizedProvider = String(provider || '').trim();
    const normalizedKey = String(accountKey || '').trim();
    const normalizedEmail = String(accountEmail || '').trim().toLowerCase();
    if (!normalizedProvider || (!normalizedKey && !normalizedEmail)) return null;
    const [rows] = await executor.execute(`SELECT * FROM hub_accounts
      WHERE provider = ? AND (
        (? <> '' AND account_key = ?)
        OR (? <> '' AND account_email = ?)
      )
      ORDER BY account_id
      LIMIT 1`, [normalizedProvider, normalizedKey, normalizedKey, normalizedEmail, normalizedEmail]);
    return hubAccountRow(rows[0]);
  }

  async function createHubAccount(account, envelope, snapshot, executor = pool) {
    const now = date(account.updatedAt || Date.now());
    await executor.execute(`INSERT INTO hub_accounts (
      account_id, provider, name, label, account_key, account_email, account_label,
      enabled, status, last_error_code, last_error_message, last_attempt_at,
      last_success_at, next_refresh_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      account.id,
      account.provider,
      account.name || '',
      account.label || '',
      account.accountKey || '',
      account.accountEmail || '',
      account.accountLabel || '',
      account.enabled === false ? 0 : 1,
      account.status || 'pending',
      account.lastErrorCode || '',
      account.lastErrorMessage || '',
      account.lastAttemptAt ? date(account.lastAttemptAt) : null,
      account.lastSuccessAt ? date(account.lastSuccessAt) : null,
      account.nextRefreshAt ? date(account.nextRefreshAt) : null,
      account.createdAt ? date(account.createdAt) : now,
      now
    ]);
    await executor.execute(`INSERT INTO hub_account_credentials (
      account_id, credential_envelope, updated_at
    ) VALUES (?, ?, ?)`, [account.id, json(envelope), now]);
    await executor.execute(`INSERT INTO hub_account_limits (
      account_id, provider_snapshot, last_good_snapshot, updated_at
    ) VALUES (?, ?, ?, ?)`, [
      account.id,
      json(snapshot?.provider),
      json(snapshot?.lastGood),
      snapshot?.updatedAt ? date(snapshot.updatedAt) : now
    ]);
    return getHubAccount(account.id, executor);
  }

  async function updateHubAccount(accountId, patch, executor = pool) {
    const allowed = {
      name: 'name',
      label: 'label',
      accountKey: 'account_key',
      accountEmail: 'account_email',
      accountLabel: 'account_label',
      enabled: 'enabled',
      status: 'status',
      lastErrorCode: 'last_error_code',
      lastErrorMessage: 'last_error_message',
      lastAttemptAt: 'last_attempt_at',
      lastSuccessAt: 'last_success_at',
      nextRefreshAt: 'next_refresh_at',
      updatedAt: 'updated_at'
    };
    const entries = Object.entries(patch || {}).filter(([key, value]) => (
      allowed[key] && value !== undefined
    ));
    if (!entries.length) return getHubAccount(accountId, executor);
    const assignments = entries.map(([key]) => `${allowed[key]} = ?`);
    const values = entries.map(([key, value]) => {
      if (['lastAttemptAt', 'lastSuccessAt', 'nextRefreshAt', 'updatedAt'].includes(key)) {
        return value === null ? null : date(value);
      }
      if (key === 'enabled') return value === false ? 0 : 1;
      return value;
    });
    await executor.execute(
      `UPDATE hub_accounts SET ${assignments.join(', ')} WHERE account_id = ?`,
      [...values, String(accountId || '')]
    );
    return getHubAccount(accountId, executor);
  }

  async function deleteHubAccount(accountId, executor = pool) {
    const [result] = await executor.execute(
      'DELETE FROM hub_accounts WHERE account_id = ?',
      [String(accountId || '')]
    );
    return Number(result.affectedRows || 0) > 0;
  }

  async function getHubAccountCredential(accountId, executor = pool) {
    const [rows] = await executor.execute(
      'SELECT credential_envelope FROM hub_account_credentials WHERE account_id = ?',
      [String(accountId || '')]
    );
    return rows.length ? parseJson(rows[0].credential_envelope, null) : null;
  }

  async function replaceHubAccountCredential(accountId, envelope, executor = pool) {
    await executor.execute(`INSERT INTO hub_account_credentials (
      account_id, credential_envelope, updated_at
    ) VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE credential_envelope = VALUES(credential_envelope), updated_at = VALUES(updated_at)`, [
      String(accountId || ''),
      json(envelope),
      new Date()
    ]);
    return getHubAccountCredential(accountId, executor);
  }

  async function getHubAccountSnapshot(accountId, executor = pool) {
    const [rows] = await executor.execute(
      'SELECT provider_snapshot, last_good_snapshot, updated_at FROM hub_account_limits WHERE account_id = ?',
      [String(accountId || '')]
    );
    return hubAccountSnapshotRow(rows[0]);
  }

  async function listHubAccountSnapshots(accountIds, executor = pool) {
    const ids = [...new Set((accountIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!ids.length) return new Map();
    const placeholders = ids.map(() => '?').join(', ');
    const [rows] = await executor.execute(
      `SELECT account_id, provider_snapshot, last_good_snapshot, updated_at
       FROM hub_account_limits WHERE account_id IN (${placeholders})`,
      ids
    );
    return new Map(rows.map((row) => [String(row.account_id), hubAccountSnapshotRow(row)]));
  }

  async function saveHubAccountSnapshot(accountId, snapshot, executor = pool) {
    await executor.execute(`INSERT INTO hub_account_limits (
      account_id, provider_snapshot, last_good_snapshot, updated_at
    ) VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      provider_snapshot = VALUES(provider_snapshot),
      last_good_snapshot = VALUES(last_good_snapshot),
      updated_at = VALUES(updated_at)`, [
      String(accountId || ''),
      json(snapshot?.provider),
      json(snapshot?.lastGood),
      snapshot?.updatedAt ? date(snapshot.updatedAt) : new Date()
    ]);
    return getHubAccountSnapshot(accountId, executor);
  }

  async function appendHubAccountAudit(accountId, action, actor = '', details = null, executor = pool) {
    await executor.execute(`INSERT INTO hub_account_audit (
      account_id, action, actor, details
    ) VALUES (?, ?, ?, ?)`, [
      accountId ? String(accountId) : null,
      String(action || '').slice(0, 64),
      String(actor || '').slice(0, 255),
      json(details)
    ]);
  }

  async function listHubSessions(executor = pool) {
    const [rows] = await executor.query('SELECT * FROM hub_sessions ORDER BY last_seen_at DESC');
    return rows.map(hubSessionRow);
  }

  async function loadActiveHubSessions(executor = pool) {
    const [rows] = await executor.query(`SELECT * FROM hub_sessions
      WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP(3))`);
    return rows.map(hubSessionRow);
  }

  async function createHubSession(session, executor = pool) {
    await executor.execute(`INSERT INTO hub_sessions (
      session_id, token_hash, secret_fingerprint, device_name, platform, user_agent,
      persistent, created_at, last_seen_at, expires_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      session.sessionId,
      session.tokenHash,
      session.secretFingerprint,
      session.deviceName || '',
      session.platform || '',
      session.userAgent || '',
      session.persistent === false ? 0 : 1,
      date(session.createdAt),
      date(session.lastSeenAt),
      session.expiresAt ? date(session.expiresAt) : null,
      session.revokedAt ? date(session.revokedAt) : null
    ]);
    return { ...session, persistent: session.persistent !== false };
  }

  async function touchHubSession(sessionId, patch = {}, executor = pool) {
    const assignments = [];
    const values = [];
    if (patch.lastSeenAt !== undefined) {
      assignments.push('last_seen_at = ?');
      values.push(date(patch.lastSeenAt));
    }
    if (patch.expiresAt !== undefined) {
      assignments.push('expires_at = ?');
      values.push(patch.expiresAt ? date(patch.expiresAt) : null);
    }
    if (!assignments.length) return false;
    const [result] = await executor.execute(
      `UPDATE hub_sessions SET ${assignments.join(', ')} WHERE session_id = ? AND revoked_at IS NULL`,
      [...values, String(sessionId || '')]
    );
    return Number(result.affectedRows || 0) > 0;
  }

  async function revokeHubSession(sessionId, executor = pool) {
    const [result] = await executor.execute(
      'UPDATE hub_sessions SET revoked_at = CURRENT_TIMESTAMP(3) WHERE session_id = ? AND revoked_at IS NULL',
      [String(sessionId || '')]
    );
    return Number(result.affectedRows || 0) > 0;
  }

  async function revokeAllHubSessions(executor = pool) {
    const [result] = await executor.execute(
      'UPDATE hub_sessions SET revoked_at = CURRENT_TIMESTAMP(3) WHERE revoked_at IS NULL'
    );
    return Number(result.affectedRows || 0);
  }

  async function getSubscriptions(executor = pool) {
    const [rows] = await executor.query('SELECT updated_at, subscriptions FROM hub_subscriptions WHERE id = 1');
    return subscriptionDocumentRow(rows[0]);
  }

  async function setSubscriptions(document, baseUpdatedAt) {
    return transaction(async (connection) => {
      const [rows] = await connection.query('SELECT updated_at, subscriptions FROM hub_subscriptions WHERE id = 1 FOR UPDATE');
      const current = subscriptionDocumentRow(rows[0]);
      if (current.updatedAt !== String(baseUpdatedAt || '')) {
        const error = new Error('stale_write');
        error.code = 'stale_write';
        error.current = current;
        throw error;
      }
      const updatedAt = document.updatedAt ? date(document.updatedAt) : null;
      const values = [updatedAt, JSON.stringify(document.subscriptions || [])];
      if (rows.length === 0) {
        await connection.execute(
          'INSERT INTO hub_subscriptions (id, updated_at, subscriptions) VALUES (1, ?, ?)',
          values
        );
      } else {
        await connection.execute(
          'UPDATE hub_subscriptions SET updated_at = ?, subscriptions = ? WHERE id = 1',
          values
        );
      }
      return document;
    });
  }

  async function upsertPricing(model, prices, source, executor = pool) {
    const modelId = String(model || '').trim();
    await executor.execute(`INSERT INTO model_pricing (
      model, input_price_per_million, output_price_per_million,
      cache_read_price_per_million, cache_write_price_per_million, source
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      input_price_per_million = VALUES(input_price_per_million),
      output_price_per_million = VALUES(output_price_per_million),
      cache_read_price_per_million = VALUES(cache_read_price_per_million),
      cache_write_price_per_million = VALUES(cache_write_price_per_million), source = VALUES(source),
      updated_at = CURRENT_TIMESTAMP(3)`, [
      modelId,
      prices.inputPricePerMillion,
      prices.outputPricePerMillion,
      prices.cacheReadPricePerMillion,
      prices.cacheWritePricePerMillion,
      source
    ]);
    return (await getPricing([modelId], executor)).get(modelId);
  }

  async function insertUsageEvents(deviceId, events, executor = pool) {
    if (!events.length) return;
    const sql = `INSERT INTO usage_events (
      device_id, client, session_id, model, provider, project_id, project_label, recorded_at,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
      message_count_delta, price_input_per_million, price_output_per_million,
      price_cache_read_per_million, price_cache_write_per_million, pricing_source,
      pricing_snapshot_at, cost_usd, credits
    ) VALUES `;
    function* rows() {
      for (const event of events) yield [
        deviceId, event.client, event.sessionId, event.model, event.provider, event.projectId,
        event.projectLabel, date(event.recordedAt), event.inputTokens, event.outputTokens,
        event.cacheReadTokens, event.cacheWriteTokens, event.reasoningTokens, event.messageCount,
        event.priceInputPerMillion, event.priceOutputPerMillion, event.priceCacheReadPerMillion,
        event.priceCacheWritePerMillion, event.pricingSource, event.pricingSnapshotAt ? date(event.pricingSnapshotAt) : null,
        event.costUsd, event.credits
      ];
    }
    for (const batch of writeBatches(rows())) {
      await executor.execute(sql + placeholders(batch), batch.flat());
    }
  }

  async function replaceUsageDailyFacts(deviceId, document, executor = pool) {
    const id = String(deviceId || '').trim();
    const source = String(document?.source || 'tokscaleGraph');
    const replaceAll = document?.replaceAll === true || !Array.isArray(document?.changedDays);
    let writeDates = new Set((document?.days || []).map((day) => String(day.date).slice(0, 10)));
    const removeDates = new Set((document?.removeDays || []).map((day) => String(day).slice(0, 10)));
    if (!replaceAll) {
      // One small indexed read replaces a full delete/insert of the rolling
      // history on every collector tick. Missing partitions are backfilled once;
      // unchanged partitions are left untouched.
      const [existing] = await executor.execute(
        'SELECT DATE_FORMAT(day_key, \'%Y-%m-%d\') AS day_key FROM usage_daily_fact_days WHERE device_id = ? AND source = ?',
        [id, source]
      );
      const covered = new Set(existing.map((row) => String(row.day_key).slice(0, 10)));
      writeDates = new Set([
        ...document.changedDays.map((day) => String(day).slice(0, 10)),
        ...[...writeDates].filter((day) => !covered.has(day))
      ]);
    }
    if (replaceAll) {
      await executor.execute('DELETE FROM usage_daily_facts WHERE device_id = ? AND source = ?', [id, source]);
      await executor.execute('DELETE FROM usage_daily_fact_days WHERE device_id = ? AND source = ?', [id, source]);
    } else {
      const deleteDates = new Set([...writeDates, ...removeDates]);
      for (const batch of writeBatches([...deleteDates].map((day) => [day]))) {
        const marks = batch.map(() => '?').join(', ');
        const values = [id, source, ...batch.flat()];
        await executor.execute(`DELETE FROM usage_daily_facts WHERE device_id = ? AND source = ? AND day_key IN (${marks})`, values);
        await executor.execute(`DELETE FROM usage_daily_fact_days WHERE device_id = ? AND source = ? AND day_key IN (${marks})`, values);
      }
    }
    let factCount = 0;
    let dayCount = 0;
    function* days() {
      for (const day of document?.days || []) {
        if (!writeDates.has(String(day.date).slice(0, 10))) continue;
        dayCount += 1;
        yield [
          id, day.date, source, day.timeBasis || document.timeBasis || 'producerCalendarDay',
          String(day.timeZone ?? document.timeZone ?? ''), Number(day.factCount) || 0, day.truncated === true ? 1 : 0
        ];
      }
    }
    const daySql = `INSERT INTO usage_daily_fact_days (
      device_id, day_key, source, time_basis, time_zone, fact_count, truncated
    ) VALUES `;
    for (const batch of writeBatches(days())) {
      await executor.execute(daySql + placeholders(batch), batch.flat());
    }
    function* facts() {
      for (const fact of document?.facts || []) {
        if (!writeDates.has(String(fact.date).slice(0, 10))) continue;
        factCount += 1;
        yield [
          id, fact.date, fact.client, fact.model, fact.provider || '', fact.tokens,
          fact.outputTokens, fact.cacheReadTokens, fact.cacheWriteTokens, fact.unclassifiedTokens,
          fact.cost, fact.messages, fact.tokenComponentsAvailable === true ? 1 : 0,
          fact.provenance || 'unknown', source, fact.timeBasis || document.timeBasis || 'producerCalendarDay'
        ];
      }
    }
    const factSql = `INSERT INTO usage_daily_facts (
      device_id, day_key, client, model, provider, total_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, unclassified_tokens, cost_usd, message_count,
      token_components_available, provenance, source, time_basis
    ) VALUES `;
    for (const batch of writeBatches(facts())) {
      await executor.execute(factSql + placeholders(batch), batch.flat());
    }
    return { factCount, dayCount, truncated: document?.truncated === true };
  }

  function analyticsFilterSql(filters = {}, { events = false, alias = '' } = {}) {
    const clauses = [];
    const values = [];
    const prefix = alias ? `${alias}.` : '';
    const columns = {
      device: `${prefix}device_id`, client: `${prefix}client`, model: `${prefix}model`, provider: events ? `COALESCE(${prefix}provider, '')` : `${prefix}provider`
    };
    for (const [name, column] of Object.entries(columns)) {
      const selected = Array.isArray(filters[name]) ? filters[name] : [];
      if (!selected.length) continue;
      clauses.push(`${column} IN (${selected.map(() => '?').join(', ')})`);
      values.push(...selected);
    }
    if (events && Array.isArray(filters.project) && filters.project.length) {
      const list = filters.project.map(() => '?').join(', ');
      clauses.push(`(${prefix}project_id IN (${list}) OR ${prefix}project_label IN (${list}))`);
      values.push(...filters.project, ...filters.project);
    }
    if (events && Array.isArray(filters.session) && filters.session.length) {
      clauses.push(`${prefix}session_id IN (${filters.session.map(() => '?').join(', ')})`);
      values.push(...filters.session);
    }
    return { clauses, values };
  }

  async function queryUsageDailyFacts({ from, to, filters = {}, limit = 50_000 }, executor = pool) {
    const { clauses, values } = analyticsFilterSql(filters, { alias: 'f' });
    clauses.push('f.day_key >= ?', 'f.day_key < ?');
    values.push(from, to);
    const where = clauses.join(' AND ');
    const [rows] = await executor.execute(`SELECT
      f.device_id, DATE_FORMAT(f.day_key, '%Y-%m-%d') AS day_key, f.client, f.model, f.provider,
      f.total_tokens, f.output_tokens, f.cache_read_tokens, f.cache_write_tokens, f.unclassified_tokens,
      f.cost_usd, f.message_count, f.token_components_available, f.provenance, f.source, f.time_basis
      FROM usage_daily_facts f
      JOIN devices active_device ON active_device.device_id = f.device_id AND active_device.deleted_at IS NULL
      WHERE ${where}
      ORDER BY f.day_key, f.device_id, f.client, f.model, f.provider, f.id
      LIMIT ${Math.max(1, Math.floor(limit) + 1)}`, values);
    const dayFilters = analyticsFilterSql({ device: filters.device }, { alias: 'fd' });
    dayFilters.clauses.push('fd.day_key >= ?', 'fd.day_key < ?');
    dayFilters.values.push(from, to);
    const [days] = await executor.execute(`SELECT
      fd.device_id, DATE_FORMAT(fd.day_key, '%Y-%m-%d') AS day_key, fd.source, fd.time_basis, fd.time_zone,
      fd.fact_count, fd.truncated FROM usage_daily_fact_days fd
      JOIN devices active_device ON active_device.device_id = fd.device_id AND active_device.deleted_at IS NULL
      WHERE ${dayFilters.clauses.join(' AND ')}
      ORDER BY fd.day_key, fd.device_id, fd.source LIMIT 10001`, dayFilters.values);
    return {
      rows,
      days,
      truncated: rows.length > limit || days.length > 10000
    };
  }

  async function queryUsageEventAnalytics({ from, to, filters = {}, limit = 50_000 }, executor = pool) {
    const { clauses, values } = analyticsFilterSql(filters, { events: true, alias: 'e' });
    clauses.push('e.recorded_at >= ?', 'e.recorded_at < ?');
    values.push(date(from), date(to));
    const [rows] = await executor.execute(`SELECT
      DATE_FORMAT(e.recorded_at, '%Y-%m-%d %H:00:00.000') AS hour_bucket,
      e.device_id, e.client, e.session_id, e.model, COALESCE(e.provider, '') AS provider,
      COALESCE(e.project_id, '') AS project_id, COALESCE(e.project_label, '') AS project_label,
      SUM(e.input_tokens + e.output_tokens + e.cache_read_tokens + e.cache_write_tokens) AS total_tokens,
      SUM(e.input_tokens) AS input_tokens, SUM(e.output_tokens) AS output_tokens,
      SUM(e.cache_read_tokens) AS cache_read_tokens, SUM(e.cache_write_tokens) AS cache_write_tokens,
      0 AS unclassified_tokens, SUM(e.cost_usd) AS cost_usd,
      SUM(e.message_count_delta) AS message_count, SUM(e.credits) AS credits
      FROM usage_events e
      JOIN devices active_device ON active_device.device_id = e.device_id AND active_device.deleted_at IS NULL
      WHERE ${clauses.join(' AND ')}
      GROUP BY hour_bucket, e.device_id, e.client, e.session_id, e.model, provider, project_id, project_label
      ORDER BY hour_bucket, e.device_id, e.client, e.session_id, e.model, provider, project_id
      LIMIT ${Math.max(1, Math.floor(limit) + 1)}`, values);
    return { rows, truncated: rows.length > limit };
  }

  async function replaceSessions(deviceId, summaries, executor = pool, { previousSummaries } = {}) {
    // This is a mutable materialized view of the latest all-time snapshot, not
    // the immutable event ledger. Diff against SQL, not a process cache: rollback,
    // delete, rename and transfer must all be visible to the next replacement.
    // The caller's device lock/transaction serializes concurrent ingests.
    // Optional fast path: these must describe the actual persisted sessions,
    // NOT an ingest baseline (which survives deletion and may differ on transfer).
    // Callers unable to guarantee that provenance leave this option unset.
    let existing;
    if (previousSummaries !== undefined) {
      existing = previousSummaries.map((summary) => ({
        client: summary.client,
        session_id: summary.sessionId,
        ...Object.fromEntries(SESSION_COUNTERS.map(([field, column]) => [column, summary[field]])),
        cost_usd: Number(number(summary.costUsd).toFixed(10)),
        started_at: summary.startedAt,
        last_used_at: summary.lastUsedAt,
        models: summary.models
      }));
    } else {
      [existing] = await executor.execute('SELECT * FROM sessions WHERE device_id = ?', [deviceId]);
    }
    const key = (item) => `${item.client}\u0000${item.sessionId ?? item.session_id}`;
    const previous = new Map(existing.map((row) => [key(row), row]));
    const changed = [];
    for (const summary of summaries) {
      const row = previous.get(key(summary));
      if (!row || !sameSession(row, summary)) changed.push(summary);
      previous.delete(key(summary));
    }
    // Only missing identities are removed; a counter reset is an ordinary
    // upsert, and changing a model/timestamp without changing totals still writes.
    for (const batch of writeBatches([...previous.values()].map((row) => [row.client, row.session_id]))) {
      await executor.execute(`DELETE FROM sessions WHERE device_id = ?
        AND (client, session_id) IN (${placeholders(batch)})`, [deviceId, ...batch.flat()]);
    }
    const columns = `(device_id, client, session_id, total_tokens, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, reasoning_tokens, message_count, cost_usd,
      started_at, last_used_at, models)`;
    function* rows() {
      for (const summary of changed) yield [
          deviceId, summary.client, summary.sessionId, summary.totalTokens, summary.inputTokens,
          summary.outputTokens, summary.cacheReadTokens, summary.cacheWriteTokens, summary.reasoningTokens,
          summary.messageCount, summary.costUsd, date(summary.startedAt), date(summary.lastUsedAt),
          JSON.stringify(summary.models)
      ];
    }
    for (const batch of writeBatches(rows())) {
      await executor.execute(`INSERT INTO sessions ${columns} VALUES ${placeholders(batch)}
        ON DUPLICATE KEY UPDATE total_tokens = VALUES(total_tokens), input_tokens = VALUES(input_tokens),
          output_tokens = VALUES(output_tokens), cache_read_tokens = VALUES(cache_read_tokens),
          cache_write_tokens = VALUES(cache_write_tokens), reasoning_tokens = VALUES(reasoning_tokens),
          message_count = VALUES(message_count), cost_usd = VALUES(cost_usd), started_at = VALUES(started_at),
          last_used_at = VALUES(last_used_at), models = VALUES(models)`, batch.flat());
    }
  }

  async function getIngestBaseline(deviceId, executor = pool) {
    // Missing row = pre-baseline database (or a device that predates 007), where
    // the display snapshot WAS the baseline; falling back keeps both identical.
    const [rows] = await executor.execute(
      'SELECT snapshot_json, transferred FROM device_ingest_baseline WHERE device_id = ?',
      [deviceId]
    );
    if (rows.length === 0) return { snapshot: (await getDeviceRecord(deviceId, executor)) || null, transferred: false };
    return { snapshot: parseJson(rows[0].snapshot_json, null), transferred: Number(rows[0].transferred) === 1 };
  }

  async function saveIngestBaseline(deviceId, snapshot, { transferred = undefined } = {}, executor = pool) {
    // `transferred` is a tri-state: undefined leaves the stored flag untouched
    // (the regular ingest path), while true/false write it explicitly.
    if (transferred === undefined) {
      await executor.execute(`INSERT INTO device_ingest_baseline (device_id, snapshot_json, transferred)
        VALUES (?, ?, 0) ON DUPLICATE KEY UPDATE snapshot_json = VALUES(snapshot_json)`, [
        deviceId,
        JSON.stringify(snapshot)
      ]);
      return;
    }
    await executor.execute(`INSERT INTO device_ingest_baseline (device_id, snapshot_json, transferred)
      VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE snapshot_json = VALUES(snapshot_json), transferred = VALUES(transferred)`, [
      deviceId,
      JSON.stringify(snapshot),
      transferred ? 1 : 0
    ]);
  }

  async function moveDeviceUsageEvents(previousDeviceId, nextDeviceId, executor = pool) {
    await executor.execute('UPDATE usage_events SET device_id = ? WHERE device_id = ?', [nextDeviceId, previousDeviceId]);
    await executor.execute('UPDATE usage_daily_facts SET device_id = ? WHERE device_id = ?', [nextDeviceId, previousDeviceId]);
    await executor.execute(`INSERT INTO usage_daily_fact_days (
      device_id, day_key, source, time_basis, time_zone, fact_count, truncated
    ) SELECT ?, day_key, source, time_basis, time_zone, fact_count, truncated
      FROM usage_daily_fact_days WHERE device_id = ?
      ON DUPLICATE KEY UPDATE fact_count = usage_daily_fact_days.fact_count + VALUES(fact_count),
        truncated = GREATEST(usage_daily_fact_days.truncated, VALUES(truncated))`, [nextDeviceId, previousDeviceId]);
    await executor.execute('DELETE FROM usage_daily_fact_days WHERE device_id = ?', [previousDeviceId]);
  }

  async function mergeDeviceSessions(fromDeviceId, toDeviceId, executor = pool) {
    // Sessions present on both sides must sum, not overwrite: the primary key is
    // (device_id, client, session_id), so a plain UPDATE would collide and abort
    // the transfer. Move the rows that have no counterpart, then fold the rest
    // into the target's counters.
    await executor.execute(`UPDATE sessions s_from
      JOIN sessions s_to ON s_to.device_id = ? AND s_to.client = s_from.client AND s_to.session_id = s_from.session_id
      SET s_to.total_tokens = s_to.total_tokens + s_from.total_tokens,
          s_to.input_tokens = s_to.input_tokens + s_from.input_tokens,
          s_to.output_tokens = s_to.output_tokens + s_from.output_tokens,
          s_to.cache_read_tokens = s_to.cache_read_tokens + s_from.cache_read_tokens,
          s_to.cache_write_tokens = s_to.cache_write_tokens + s_from.cache_write_tokens,
          s_to.reasoning_tokens = s_to.reasoning_tokens + s_from.reasoning_tokens,
          s_to.message_count = s_to.message_count + s_from.message_count,
          s_to.cost_usd = s_to.cost_usd + s_from.cost_usd,
          s_to.started_at = LEAST(COALESCE(s_to.started_at, s_from.started_at), COALESCE(s_from.started_at, s_to.started_at)),
          s_to.last_used_at = GREATEST(COALESCE(s_to.last_used_at, s_from.last_used_at), COALESCE(s_from.last_used_at, s_to.last_used_at))
      WHERE s_from.device_id = ?`, [toDeviceId, fromDeviceId]);
    await executor.execute(`UPDATE sessions s_from
      LEFT JOIN sessions s_to ON s_to.device_id = ? AND s_to.client = s_from.client AND s_to.session_id = s_from.session_id
      SET s_from.device_id = ?
      WHERE s_from.device_id = ? AND s_to.device_id IS NULL`, [toDeviceId, toDeviceId, fromDeviceId]);
  }

  async function deleteDevice(deviceId, executor = pool) {
    await executor.execute('DELETE FROM sessions WHERE device_id = ?', [deviceId]);
    // DELETE is a display operation, not a counter reset. Keep both the ingest
    // baseline and immutable ledger identity so re-ingesting the same cumulative
    // snapshot produces a zero delta instead of counting its history twice.
    const [result] = await executor.execute(
      'UPDATE devices SET deleted_at = CURRENT_TIMESTAMP(3) WHERE device_id = ? AND deleted_at IS NULL',
      [deviceId]
    );
    return Number(result.affectedRows || 0) > 0;
  }

  async function renameDevice(previousDeviceId, nextDeviceId, executor = pool) {
    const previousId = String(previousDeviceId || '').trim();
    const nextId = String(nextDeviceId || '').trim();
    if (!previousId || !nextId) return { renamed: false, reason: 'device_id_required' };
    if (previousId === nextId) return { renamed: true, deviceId: nextId, unchanged: true };
    const [rows] = await executor.execute(
      'SELECT device_id FROM devices WHERE device_id IN (?, ?) FOR UPDATE',
      [previousId, nextId]
    );
    const ids = new Set(rows.map((row) => String(row.device_id)));
    if (!ids.has(previousId)) return { renamed: false, reason: 'not_found' };
    if (ids.has(nextId)) return { renamed: false, reason: 'target_exists' };
    const existing = await getDeviceRecord(previousId, executor);
    if (!existing) return { renamed: false, reason: 'baseline_missing' };

    const baseline = await getIngestBaseline(previousId, executor);
    const nextBaseline = { ...(baseline.snapshot || existing), deviceId: nextId };
    await saveDevice({ ...existing, deviceId: nextId }, executor, { baseline: nextBaseline });
    if (baseline.transferred) {
      await saveIngestBaseline(nextId, nextBaseline, { transferred: true }, executor);
    }
    await executor.execute('UPDATE usage_events SET device_id = ? WHERE device_id = ?', [nextId, previousId]);
    await executor.execute('UPDATE usage_daily_facts SET device_id = ? WHERE device_id = ?', [nextId, previousId]);
    await executor.execute('UPDATE usage_daily_fact_days SET device_id = ? WHERE device_id = ?', [nextId, previousId]);
    await executor.execute('UPDATE sessions SET device_id = ? WHERE device_id = ?', [nextId, previousId]);
    await executor.execute('DELETE FROM device_ingest_state WHERE device_id = ?', [previousId]);
    await executor.execute('DELETE FROM device_ingest_baseline WHERE device_id = ?', [previousId]);
    await executor.execute('DELETE FROM devices WHERE device_id = ?', [previousId]);
    return { renamed: true, deviceId: nextId, previousDeviceId: previousId };
  }

  async function listKnownModels(executor = pool) {
    const [rows] = await executor.query("SELECT DISTINCT model FROM usage_events WHERE model <> 'unknown' ORDER BY model");
    const models = new Set(rows.map((row) => row.model));
    for (const record of await listDeviceRecords(executor)) {
      for (const model of allPeriodModels(record)) if (model && model !== 'unknown') models.add(model);
    }
    return [...models].sort((a, b) => a.localeCompare(b));
  }

  async function aggregateUsageRange({ from, to }, executor = pool) {
    const fromAt = date(from);
    const toAt = date(to);
    const result = emptyUsageRange();
    if (!(fromAt.getTime() < toAt.getTime())) return result;

    const [rows] = await executor.execute(`
      SELECT
        client,
        model,
        COUNT(*) AS event_count,
        SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens,
        SUM(cost_usd) AS cost_usd,
        SUM(credits) AS credits
      FROM usage_events
      WHERE recorded_at >= ? AND recorded_at < ?
      GROUP BY client, model
    `, [fromAt, toAt]);

    for (const row of rows) {
      result.eventCount += number(row.event_count);
      const tokens = Math.round(number(row.tokens));
      const cost = number(row.cost_usd);
      const credits = number(row.credits);
      const client = safeDynamicKey(row.client);
      const model = safeDynamicKey(row.model);
      result.totalTokens += tokens;
      result.costUsd += cost;
      addTokenCost(result.clients, result.clientCosts, client, tokens, cost);
      addTokenCost(result.models, result.modelCosts, model, tokens, cost);
      const clientModels = ensureNestedMap(result.clientModels, client);
      const clientModelCosts = ensureNestedMap(result.clientModelCosts, client);
      clientModels[model] = mapNumber(clientModels, model) + tokens;
      clientModelCosts[model] = mapNumber(clientModelCosts, model) + cost;
      // Sparse on purpose, mirroring the live period: a client with no credit
      // meter is absent from the map, which is not the same statement as zero.
      // The per-model credit split stays in the ledger rows rather than this
      // response — no surface consumes it yet, and the range payload shape is a
      // compatibility boundary.
      if (credits > 0) {
        result.clientCredits[client] = mapNumber(result.clientCredits, client) + credits;
      }
    }
    return result;
  }

  const RETRYABLE_SQL_ERRORS = new Set([
    'PROTOCOL_CONNECTION_LOST',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
    'ER_SERVER_SHUTDOWN'
  ]);

  async function transaction(work) {
    let lastError = null;
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let connection;
      try {
        connection = await pool.getConnection();
      } catch (connErr) {
        if (attempt < maxAttempts && RETRYABLE_SQL_ERRORS.has(connErr?.code)) {
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
        throw connErr;
      }
      // Once COMMIT has been sent, its outcome is unknown to this process. A
      // retry there can duplicate append-only ledger rows (the ingest inserts
      // `usage_events` deltas), so only the work phase is retried. A failed
      // commit is reported to the caller, which retries the whole upload; that
      // is safe because the next delta is recomputed from the persisted
      // baseline (zero when the first commit did land).
      let commitStarted = false;
      let connectionDestroyed = false;
      try {
        await connection.beginTransaction();
        const result = await work(connection);
        commitStarted = true;
        await connection.commit();
        return result;
      } catch (error) {
        if (commitStarted) {
          // Leave the socket in an unknown protocol state out of the pool.
          try { connection.destroy(); connectionDestroyed = true; } catch (_) {}
        } else {
          try { await connection.rollback(); } catch (_) {}
        }
        if (!commitStarted && attempt < maxAttempts && RETRYABLE_SQL_ERRORS.has(error?.code)) {
          lastError = error;
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
        throw error;
      } finally {
        if (!connectionDestroyed) {
          try { connection.release(); } catch (_) {}
        }
      }
    }
    throw lastError;
  }

  return {
    aggregateUsageRange,
    countDevices,
    createHubSession,
    deleteDevice,
    getDeviceRecord,
    getActiveDeviceRecord,
    getHubAccount,
    getHubAccountCredential,
    getHubAccountForUpdate,
    getHubAccountSnapshot,
    getIngestBaseline,
    getPricing,
    getSubscriptions,
    insertUsageEvents,
    replaceUsageDailyFacts,
    queryUsageDailyFacts,
    queryUsageEventAnalytics,
    appendHubAccountAudit,
    createHubAccount,
    deleteHubAccount,
    findHubAccount,
    listHubAccounts,
    listHubAccountSnapshots,
    listDeviceRecords,
    listHubSessions,
    loadActiveHubSessions,
    listKnownModels,
    listPricing,
    lockAndLoadIngestState,
    lockDevice,
    mergeDeviceSessions,
    moveDeviceUsageEvents,
    renameDevice,
    replaceHubAccountCredential,
    replaceSessions,
    revokeAllHubSessions,
    revokeHubSession,
    saveHubAccountSnapshot,
    saveDevice,
    saveIngestBaseline,
    setSubscriptions,
    touchHubSession,
    transaction,
    updateHubAccount,
    upsertPricing
  };
}

module.exports = { createMySqlPool, createRepository, instrumentPoolQueries, parseJson, emptyUsageRange };
