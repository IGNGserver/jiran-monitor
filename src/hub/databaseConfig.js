'use strict';

// One place resolves where the Hub's MySQL lives.
//
// The documented URL form exists because a remote/shared server is a normal
// deployment now: a single `JIRAN_DATABASE_URL` carries the target and the
// credentials, while the historical MYSQL_* variables keep working unchanged.
// Pool sizing stays on the MYSQL_* family because it is an operator tuning knob,
// not part of the target identity.
//
// Never log the resolved URL: it contains the password. describeDatabaseTarget()
// is the only string that may reach a log line or an error message.

const fs = require('node:fs');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3306;
const DEFAULT_USER = 'token_monitor';
const DEFAULT_DATABASE = 'token_monitor';

const DEFAULT_POOL = Object.freeze({
  connectionLimit: 10,
  queueLimit: 200,
  connectTimeout: 10_000,
  // A Hub is a low-traffic single-owner service: holding `connectionLimit` idle
  // sockets open is what makes several apps sharing one MySQL server run out of
  // max_connections. Two idle connections keep the common tick warm and let a
  // burst open the rest.
  maxIdle: 2,
  idleTimeout: 30_000
});

const TRANSIENT_ERROR = /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|PROTOCOL_|ER_CON_COUNT_ERROR|ER_SERVER_SHUTDOWN|POOL_ENQUEUELIMIT)/;

function configError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function nonEmpty(value) {
  const text = String(value ?? '').trim();
  return text ? text : '';
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'required', 'verify'].includes(text)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(text)) return false;
  return fallback;
}

function positiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function decodeUrlComponent(value, field) {
  try {
    return decodeURIComponent(value ?? '');
  } catch (_) {
    throw configError('database_url_invalid', `JIRAN_DATABASE_URL has an invalid ${field} encoding`);
  }
}

function hostWithoutBrackets(hostname) {
  const text = String(hostname || '');
  return text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
}

// The option form is used by tests/embedders; accept the same spellings as the
// URL/env form and never hand a bare `true`/profile string to mysql2.
function sslFromOption(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'object') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'required', 'verify'].includes(text)) return { rejectUnauthorized: true };
  if (['0', 'false', 'no', 'off', 'disabled'].includes(text)) return undefined;
  throw configError('database_ssl', `Unsupported ssl option "${value}" (use required|verify|off)`);
}

function readSslCa(readFile, caPath) {
  try {
    return readFile(caPath);
  } catch (error) {
    throw configError(
      'database_ssl_ca_unreadable',
      `Cannot read the database TLS CA at ${caPath}: ${error.message}`
    );
  }
}

function parseDatabaseUrl(raw, { env = process.env, readFile = fs.readFileSync } = {}) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw configError(
      'database_url_invalid',
      'JIRAN_DATABASE_URL is not a valid URL; expected mysql://user:password@host:3306/database'
    );
  }
  if (parsed.protocol !== 'mysql:') {
    throw configError(
      'database_url_scheme',
      `JIRAN_DATABASE_URL must use mysql:// (got ${parsed.protocol || 'no scheme'}); other engines are not supported`
    );
  }

  const user = decodeUrlComponent(parsed.username, 'user');
  const password = decodeUrlComponent(parsed.password, 'password');
  const database = decodeUrlComponent(parsed.pathname.replace(/^\/+/, ''), 'database');
  if (!user) throw configError('database_url_user_required', 'JIRAN_DATABASE_URL must include a user');
  if (!database || database.includes('/')) {
    throw configError('database_url_database_required', 'JIRAN_DATABASE_URL must include one database name');
  }

  const port = parsed.port ? Number(parsed.port) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw configError('database_url_port', 'JIRAN_DATABASE_URL has an invalid port');
  }

  const query = new Map();
  for (const [rawKey, value] of parsed.searchParams) {
    const key = rawKey.trim().toLowerCase();
    if (!['ssl', 'sslca', 'ssl-ca', 'sslrejectunauthorized', 'socket', 'socketpath'].includes(key)) {
      throw configError(
        'database_url_parameter',
        `JIRAN_DATABASE_URL does not support the "${rawKey}" parameter; allowed: ssl, sslCa, sslRejectUnauthorized, socket`
      );
    }
    query.set(key === 'ssl-ca' ? 'sslca' : key === 'socketpath' ? 'socket' : key, String(value).trim());
  }

  let ssl;
  const sslRequested = query.get('ssl') ?? nonEmpty(env.JIRAN_DATABASE_SSL);
  if (sslRequested !== '') {
    const normalized = String(sslRequested).toLowerCase();
    if (['1', 'true', 'yes', 'on', 'required', 'verify'].includes(normalized)) {
      ssl = { rejectUnauthorized: true };
    } else if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) {
      ssl = undefined;
    } else {
      throw configError('database_url_ssl', `Unsupported ssl value "${sslRequested}" (use required|verify|off)`);
    }
  }
  const caPath = query.get('sslca') || nonEmpty(env.JIRAN_DATABASE_SSL_CA);
  if (caPath) {
    ssl = { ...(ssl || { rejectUnauthorized: true }), ca: readSslCa(readFile, caPath) };
  }
  const rejectValue = query.get('sslrejectunauthorized') ?? nonEmpty(env.JIRAN_DATABASE_SSL_REJECT_UNAUTHORIZED);
  if (ssl && rejectValue !== '') ssl.rejectUnauthorized = parseBoolean(rejectValue, true);

  const socketPath = query.get('socket') || nonEmpty(env.JIRAN_DATABASE_SOCKET) || '';
  return {
    host: hostWithoutBrackets(parsed.hostname) || DEFAULT_HOST,
    port,
    user,
    password,
    database,
    socketPath,
    ssl
  };
}

function poolSettings({ env, options }) {
  const connectionLimit = positiveInteger(
    options.connectionLimit ?? env.MYSQL_CONNECTION_LIMIT,
    DEFAULT_POOL.connectionLimit
  );
  const maxIdleRaw = positiveInteger(
    options.maxIdle ?? env.MYSQL_MAX_IDLE,
    Math.min(DEFAULT_POOL.maxIdle, connectionLimit),
    { min: 0 }
  );
  return {
    connectionLimit,
    queueLimit: positiveInteger(
      options.queueLimit ?? env.MYSQL_QUEUE_LIMIT,
      DEFAULT_POOL.queueLimit,
      { min: 0 }
    ),
    connectTimeout: positiveInteger(
      options.connectTimeout ?? env.MYSQL_CONNECT_TIMEOUT_MS,
      DEFAULT_POOL.connectTimeout,
      { min: 1000 }
    ),
    maxIdle: Math.min(maxIdleRaw, connectionLimit),
    idleTimeout: positiveInteger(
      options.idleTimeout ?? env.MYSQL_IDLE_TIMEOUT_MS,
      DEFAULT_POOL.idleTimeout,
      { min: 0 }
    )
  };
}

// Explicit options win over the URL, which wins over the discrete MYSQL_*
// variables. That order lets tests and embedders point one field elsewhere
// without duplicating a URL, and lets a deployment with both a URL and the
// historical variables (docker-compose.yml still sets MYSQL_HOST) use the URL.
function resolveDatabaseConfig({ env = process.env, options = {}, readFile = fs.readFileSync } = {}) {
  const warnings = [];
  const url = nonEmpty(options.url) || nonEmpty(env.JIRAN_DATABASE_URL);
  const pool = poolSettings({ env, options });
  let connection;
  let source;

  if (url) {
    connection = parseDatabaseUrl(url, { env, readFile });
    source = 'url';
    const ignored = ['MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE']
      .filter((key) => nonEmpty(env[key]));
    if (ignored.length > 0) {
      warnings.push(`JIRAN_DATABASE_URL is set; ignoring ${ignored.join(', ')}`);
    }
  } else {
    connection = {
      host: nonEmpty(options.host) || nonEmpty(env.MYSQL_HOST) || DEFAULT_HOST,
      port: Number(options.port ?? env.MYSQL_PORT ?? DEFAULT_PORT),
      user: nonEmpty(options.user) || nonEmpty(env.MYSQL_USER) || DEFAULT_USER,
      password: options.password ?? env.MYSQL_PASSWORD ?? '',
      database: nonEmpty(options.database) || nonEmpty(env.MYSQL_DATABASE) || DEFAULT_DATABASE,
      socketPath: nonEmpty(options.socketPath) || nonEmpty(env.JIRAN_DATABASE_SOCKET),
      ssl: undefined
    };
    const sslRequested = nonEmpty(env.JIRAN_DATABASE_SSL);
    if (sslRequested) connection.ssl = { rejectUnauthorized: true };
    const caPath = nonEmpty(options.sslCa) || nonEmpty(env.JIRAN_DATABASE_SSL_CA);
    if (caPath) connection.ssl = { ...(connection.ssl || { rejectUnauthorized: true }), ca: readSslCa(readFile, caPath) };
    const reject = options.sslRejectUnauthorized ?? env.JIRAN_DATABASE_SSL_REJECT_UNAUTHORIZED;
    if (connection.ssl && reject !== undefined && reject !== '') {
      connection.ssl.rejectUnauthorized = parseBoolean(reject, true);
    }
    source = ['MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE']
      .some((key) => nonEmpty(env[key])) ? 'env' : 'default';
  }

  // Explicit per-field overrides apply on top of either form.
  for (const field of ['host', 'port', 'user', 'password', 'database', 'socketPath']) {
    if (options[field] !== undefined && options[field] !== null && options[field] !== '') {
      connection[field] = options[field];
    }
  }
  if (options.ssl !== undefined) connection.ssl = sslFromOption(options.ssl);

  if (!Number.isInteger(Number(connection.port)) || Number(connection.port) < 1 || Number(connection.port) > 65535) {
    throw configError('database_port', 'The database port must be an integer between 1 and 65535');
  }
  connection.port = Number(connection.port);
  if (!connection.user) throw configError('database_user_required', 'A database user is required');
  if (!connection.database) throw configError('database_name_required', 'A database name is required');
  if (connection.ssl && connection.ssl.rejectUnauthorized === false) {
    warnings.push('database TLS certificate verification is disabled (JIRAN_DATABASE_SSL_REJECT_UNAUTHORIZED=0)');
  }

  return {
    source,
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password,
    database: connection.database,
    socketPath: connection.socketPath || '',
    ssl: connection.ssl,
    pool,
    warnings
  };
}

function poolOptionsFromConfig(config) {
  const options = {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: config.pool.connectionLimit,
    queueLimit: config.pool.queueLimit,
    connectTimeout: config.pool.connectTimeout,
    maxIdle: config.pool.maxIdle,
    idleTimeout: config.pool.idleTimeout,
    waitForConnections: true,
    timezone: 'Z',
    decimalNumbers: true,
    dateStrings: false,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
  };
  if (config.socketPath) options.socketPath = config.socketPath;
  if (config.ssl) options.ssl = config.ssl;
  return options;
}

// The only representation safe to log or return. No password, no CA path.
function describeDatabaseTarget(config) {
  if (config.socketPath) {
    return `mysql://${encodeURIComponent(config.user)}@localhost/${config.database} (socket)`;
  }
  const host = String(config.host).includes(':') ? `[${config.host}]` : config.host;
  const tls = config.ssl ? ' tls' : '';
  return `mysql://${encodeURIComponent(config.user)}@${host}:${config.port}/${config.database}${tls}`;
}

function assertSupportedMySql(version) {
  const text = String(version || '').trim();
  if (/mariadb/i.test(text)) {
    throw configError(
      'database_server_unsupported',
      `MariaDB is not supported (server reports ${text}). Jiran's schema uses utf8mb4_0900_ai_ci and MySQL JSON functions; use MySQL 8.0 or newer.`
    );
  }
  const major = Number(text.split('.')[0]);
  if (!Number.isInteger(major) || major < 8) {
    throw configError(
      'database_server_unsupported',
      `MySQL 8.0 or newer is required (server reports ${text || 'an unknown version'}).`
    );
  }
  return text;
}

function isTransientDatabaseError(error) {
  const code = String(error?.code || '');
  if (TRANSIENT_ERROR.test(code)) return true;
  return /connection lost|connect etimedout|read econnreset|server has gone away/i.test(String(error?.message || ''));
}

// Startup only: a remote server (or the container that starts beside the Hub) may
// not be accepting connections yet. This is deliberately not a query retry —
// a transaction that lost its connection after COMMIT must not be replayed.
async function retryTransient(operation, {
  attempts = 6,
  baseMs = 1000,
  maxMs = 30_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onRetry = () => {},
  isRetryable = isTransientDatabaseError,
  random = Math.random
} = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryable(error)) throw error;
      const ceiling = Math.min(maxMs, baseMs * (2 ** (attempt - 1)));
      const delay = Math.max(0, Math.round(ceiling * (0.5 + random() * 0.5)));
      onRetry(error, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}

function poolMetrics(pool) {
  const inner = pool?.pool || pool;
  const all = Array.isArray(inner?._allConnections) ? inner._allConnections.length : null;
  const free = Array.isArray(inner?._freeConnections) ? inner._freeConnections.length : null;
  const queued = Array.isArray(inner?._connectionQueue) ? inner._connectionQueue.length : null;
  return { total: all, free, queued };
}

module.exports = {
  DEFAULT_POOL,
  assertSupportedMySql,
  describeDatabaseTarget,
  isTransientDatabaseError,
  parseDatabaseUrl,
  poolMetrics,
  poolOptionsFromConfig,
  resolveDatabaseConfig,
  retryTransient
};
