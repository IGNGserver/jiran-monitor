'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assertSupportedMySql,
  describeDatabaseTarget,
  parseDatabaseUrl,
  poolMetrics,
  poolOptionsFromConfig,
  resolveDatabaseConfig,
  retryTransient
} = require('../../src/hub/databaseConfig');

const readCa = () => '-----BEGIN CERTIFICATE-----';

test('a mysql URL carries the target and decodes credentials', () => {
  const config = resolveDatabaseConfig({
    env: { JIRAN_DATABASE_URL: 'mysql://jiran:p%24%24w%40rd@[2001:db8::5]:3307/token%2Dmonitor?ssl=required' },
    readFile: readCa
  });
  assert.equal(config.source, 'url');
  assert.equal(config.host, '2001:db8::5');
  assert.equal(config.port, 3307);
  assert.equal(config.user, 'jiran');
  assert.equal(config.password, 'p$$w@rd');
  assert.equal(config.database, 'token-monitor');
  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
});

test('the URL wins over the discrete variables and says which ones it ignored', () => {
  const config = resolveDatabaseConfig({
    env: {
      JIRAN_DATABASE_URL: 'mysql://u:p@db.example:3306/jiran',
      MYSQL_HOST: 'mysql',
      MYSQL_DATABASE: 'old',
      MYSQL_PASSWORD: 'old'
    }
  });
  assert.equal(config.host, 'db.example');
  assert.equal(config.database, 'jiran');
  assert.equal(config.password, 'p');
  assert.equal(config.warnings.length, 1);
  assert.match(config.warnings[0], /MYSQL_HOST/);
  assert.match(config.warnings[0], /MYSQL_DATABASE/);
  assert.match(config.warnings[0], /MYSQL_PASSWORD/);
});

test('discrete variables remain the default path with their historical defaults', () => {
  const config = resolveDatabaseConfig({ env: {} });
  assert.equal(config.source, 'default');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3306);
  assert.equal(config.user, 'token_monitor');
  assert.equal(config.database, 'token_monitor');
  assert.equal(config.ssl, undefined);
  assert.deepEqual(config.pool, {
    connectionLimit: 10,
    queueLimit: 200,
    connectTimeout: 10000,
    maxIdle: 2,
    idleTimeout: 30000
  });
});

test('explicit options override individual URL fields (tests and embedders)', () => {
  const config = resolveDatabaseConfig({
    env: { JIRAN_DATABASE_URL: 'mysql://u:p@db.example:3306/jiran' },
    options: { database: 'scratch', connectionLimit: 4 }
  });
  assert.equal(config.database, 'scratch');
  assert.equal(config.pool.connectionLimit, 4);
  assert.equal(config.pool.maxIdle, 2);
});

test('pool settings are bounded and read from the MYSQL_* family', () => {
  const config = resolveDatabaseConfig({
    env: {
      MYSQL_CONNECTION_LIMIT: '3',
      MYSQL_QUEUE_LIMIT: '0',
      MYSQL_CONNECT_TIMEOUT_MS: '100',
      MYSQL_MAX_IDLE: '9',
      MYSQL_IDLE_TIMEOUT_MS: '5000'
    }
  });
  assert.equal(config.pool.connectionLimit, 3);
  assert.equal(config.pool.queueLimit, 0);
  assert.equal(config.pool.connectTimeout, 1000, 'connect timeout has a floor');
  assert.equal(config.pool.maxIdle, 3, 'never more idle than the pool');
  assert.equal(config.pool.idleTimeout, 5000);
});

test('TLS ca comes from the environment or the URL and implies TLS', () => {
  const fromEnv = resolveDatabaseConfig({
    env: { MYSQL_HOST: 'db', JIRAN_DATABASE_SSL_CA: '/certs/ca.pem' },
    readFile: (path) => {
      assert.equal(path, '/certs/ca.pem');
      return 'CA';
    }
  });
  assert.deepEqual(fromEnv.ssl, { rejectUnauthorized: true, ca: 'CA' });

  const fromUrl = resolveDatabaseConfig({
    env: { JIRAN_DATABASE_URL: 'mysql://u:p@db/jiran?sslCa=/certs/ca.pem&sslRejectUnauthorized=0' },
    readFile: () => 'CA'
  });
  assert.deepEqual(fromUrl.ssl, { rejectUnauthorized: false, ca: 'CA' });
  assert.match(fromUrl.warnings.join('\n'), /verification is disabled/);

  assert.throws(
    () => resolveDatabaseConfig({
      env: { MYSQL_HOST: 'db', JIRAN_DATABASE_SSL_CA: '/nope.pem' },
      readFile: () => { throw new Error('ENOENT'); }
    }),
    /Cannot read the database TLS CA/
  );
});

test('explicit ssl options are normalized before reaching mysql2', () => {
  const on = resolveDatabaseConfig({ env: {}, options: { ssl: true } });
  assert.deepEqual(on.ssl, { rejectUnauthorized: true });
  const named = resolveDatabaseConfig({ env: {}, options: { ssl: 'required' } });
  assert.deepEqual(named.ssl, { rejectUnauthorized: true });
  const off = resolveDatabaseConfig({ env: {}, options: { ssl: 'off' } });
  assert.equal(off.ssl, undefined);
  assert.throws(
    () => resolveDatabaseConfig({ env: {}, options: { ssl: 'sometimes' } }),
    /Unsupported ssl option/
  );
});

test('malformed or unsupported URLs fail with an actionable code', () => {
  assert.throws(() => parseDatabaseUrl('not a url'), (error) => error.code === 'database_url_invalid');
  assert.throws(() => parseDatabaseUrl('postgres://u:p@h/db'), (error) => error.code === 'database_url_scheme');
  assert.throws(() => parseDatabaseUrl('mysql://db/jiran'), (error) => error.code === 'database_url_user_required');
  assert.throws(() => parseDatabaseUrl('mysql://u:p@host/'), (error) => error.code === 'database_url_database_required');
  assert.throws(
    () => parseDatabaseUrl('mysql://u:p@host/db?charset=latin1'),
    (error) => error.code === 'database_url_parameter' && /charset/.test(error.message)
  );
  assert.throws(
    () => parseDatabaseUrl('mysql://u:p@host/db?ssl=preferred'),
    (error) => error.code === 'database_url_ssl'
  );
});

test('the redacted target never contains the password', () => {
  const config = resolveDatabaseConfig({ env: { JIRAN_DATABASE_URL: 'mysql://u:s3cret@db.example:3306/jiran?ssl=required' } });
  const target = describeDatabaseTarget(config);
  assert.equal(target, 'mysql://u@db.example:3306/jiran tls');
  assert.doesNotMatch(target, /s3cret/);
  assert.doesNotMatch(target, /password/i);
});

test('socket connections are described without host or port secrets', () => {
  const config = resolveDatabaseConfig({
    env: { MYSQL_HOST: 'ignored', JIRAN_DATABASE_SOCKET: '/run/mysqld/mysqld.sock' }
  });
  assert.equal(config.socketPath, '/run/mysqld/mysqld.sock');
  assert.match(describeDatabaseTarget(config), /socket/);
  const options = poolOptionsFromConfig(config);
  assert.equal(options.socketPath, '/run/mysqld/mysqld.sock');
});

test('server preflight accepts MySQL 8 and rejects everything else', () => {
  assert.equal(assertSupportedMySql('8.4.8'), '8.4.8');
  assert.equal(assertSupportedMySql('8.0.36-0ubuntu0.22.04.1'), '8.0.36-0ubuntu0.22.04.1');
  assert.throws(() => assertSupportedMySql('10.11.6-MariaDB'), (error) => error.code === 'database_server_unsupported');
  assert.throws(() => assertSupportedMySql('5.7.44'), (error) => error.code === 'database_server_unsupported');
  assert.throws(() => assertSupportedMySql(''), (error) => error.code === 'database_server_unsupported');
});

test('pool metrics tolerate the promise-pool wrapper and missing internals', () => {
  assert.deepEqual(poolMetrics(null), { total: null, free: null, queued: null });
  const pool = { pool: { _allConnections: [1, 2], _freeConnections: [1], _connectionQueue: [] } };
  assert.deepEqual(poolMetrics(pool), { total: 2, free: 1, queued: 0 });
});

test('startup retry only replays transient connection failures', async () => {
  const delays = [];
  let calls = 0;
  const result = await retryTransient(async () => {
    calls += 1;
    if (calls < 3) {
      const error = new Error('connect ECONNREFUSED');
      error.code = 'ECONNREFUSED';
      throw error;
    }
    return 'ready';
  }, {
    attempts: 4,
    baseMs: 100,
    sleep: async (ms) => { delays.push(ms); },
    random: () => 0
  });
  assert.equal(result, 'ready');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [50, 100]);

  let attempts = 0;
  await assert.rejects(
    () => retryTransient(async () => {
      attempts += 1;
      const error = new Error('bad credentials');
      error.code = 'ER_ACCESS_DENIED_ERROR';
      throw error;
    }, { attempts: 5, sleep: async () => {} }),
    /bad credentials/
  );
  assert.equal(attempts, 1);

  let exhausted = 0;
  await assert.rejects(
    () => retryTransient(async () => {
      exhausted += 1;
      const error = new Error('lost');
      error.code = 'PROTOCOL_CONNECTION_LOST';
      throw error;
    }, { attempts: 3, baseMs: 1, sleep: async () => {} }),
    /lost/
  );
  assert.equal(exhausted, 3);
});
