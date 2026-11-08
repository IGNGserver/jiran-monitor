'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runMigrations, migrationFiles, migrationLockName, statements } = require('../../migrations/run');

function fakePool({ applied = [], releaseError = null, version = '8.4.8', database = 'token_monitor' } = {}) {
  const calls = [];
  const connection = {
    async execute(sql, params) {
      calls.push({ kind: 'execute', sql, params });
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
      if (sql.includes('RELEASE_LOCK')) {
        if (releaseError) throw releaseError;
        return [[{ released: 1 }], []];
      }
      return [[], []];
    },
    async query(sql) {
      calls.push({ kind: 'query', sql });
      if (sql.includes('SELECT VERSION()')) return [[{ version }], []];
      if (sql.includes('SELECT DATABASE()')) return [[{ database_name: database }], []];
      if (sql.includes('SELECT name, checksum FROM schema_migrations')) {
        return [applied.map((entry) => (typeof entry === 'string' ? { name: entry, checksum: null } : entry)), []];
      }
      return [[], []];
    },
    release() { calls.push({ kind: 'release' }); }
  };
  return { calls, async getConnection() { return connection; } };
}

test('migration runner releases the connection even if advisory-lock cleanup fails', async () => {
  const pool = fakePool({ applied: migrationFiles(), releaseError: new Error('connection lost') });
  await assert.rejects(() => runMigrations(pool), /connection lost/);
  assert.equal(pool.calls.at(-1).kind, 'release');
});

test('migration runner refuses a server the schema cannot run on', async () => {
  await assert.rejects(
    () => runMigrations(fakePool({ version: '10.11.6-MariaDB' })),
    /MariaDB is not supported/
  );
  await assert.rejects(
    () => runMigrations(fakePool({ version: '5.7.44' })),
    /MySQL 8\.0 or newer is required/
  );
  const pool = fakePool({ version: '5.7.44' });
  await assert.rejects(() => runMigrations(pool));
  assert.equal(pool.calls.some((call) => call.sql?.includes('GET_LOCK')), false);
  assert.equal(pool.calls.at(-1).kind, 'release');
});

test('migration lock is scoped by database so apps can share one server', () => {
  assert.equal(migrationLockName('jiran'), 'token-monitor-schema-migrations:jiran');
  assert.equal(migrationLockName(''), 'token-monitor-schema-migrations:default');
  assert.equal(migrationLockName('  other_db  '), 'token-monitor-schema-migrations:other_db');
  const long = migrationLockName('x'.repeat(80));
  assert.ok(long.length <= 64, 'MySQL caps GET_LOCK names at 64 characters');
  assert.match(long, /^token-monitor-schema-migrations:[0-9a-f]{16}$/);
  assert.notEqual(long, migrationLockName('y'.repeat(80)));
});

test('migration runner serializes DDL with a MySQL advisory lock and no false transaction boundary', async () => {
  const pool = fakePool();
  await runMigrations(pool);

  const lock = pool.calls.find((call) => call.sql.includes('GET_LOCK'));
  const release = pool.calls.find((call) => call.sql.includes('RELEASE_LOCK'));
  assert.deepEqual(lock.params, ['token-monitor-schema-migrations:token_monitor', 30]);
  assert.deepEqual(release.params, ['token-monitor-schema-migrations:token_monitor']);
  assert.equal(pool.calls.some((call) => call.kind === 'beginTransaction' || call.kind === 'rollback' || call.kind === 'commit'), false);
  const ddlStatement = (sql) => {
    const withoutComments = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim();
    return withoutComments.startsWith('CREATE TABLE') ? withoutComments : null;
  };
  const ddl = pool.calls.map((call) => call.kind === 'query' ? ddlStatement(call.sql) : null).filter(Boolean);
  const migrationDdlCount = migrationFiles().reduce((count, file) => {
    const sql = fs.readFileSync(path.join(__dirname, '../../migrations', file), 'utf8');
    return count + (sql.match(/CREATE TABLE IF NOT EXISTS/gi) || []).length;
  }, 1);
  assert.equal(ddl.length, migrationDdlCount);
  assert.ok(ddl.every((call) => call.includes('CREATE TABLE IF NOT EXISTS')));
  assert.deepEqual(
    pool.calls.filter((call) => call.sql?.includes('INSERT INTO schema_migrations')).map((call) => call.params[0]),
    migrationFiles()
  );
});

test('migration runner leaves already-applied files untouched', async () => {
  const pool = fakePool({ applied: migrationFiles() });
  await runMigrations(pool);
  assert.equal(pool.calls.some((call) => call.sql?.includes('INSERT INTO schema_migrations')), false);
  assert.equal(pool.calls.filter((call) => call.kind === 'query' && call.sql.startsWith('CREATE TABLE')).length, 1);
});

test('soft-delete migration is restart-safe using MySQL-supported conditional DDL', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../migrations/003_device_soft_delete.sql'), 'utf8');
  assert.doesNotMatch(sql, /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i);
  assert.match(sql, /information_schema\.COLUMNS/i);
  assert.match(sql, /PREPARE token_monitor_device_soft_delete/i);
  assert.match(sql, /ALTER TABLE `devices` ADD COLUMN `deleted_at`/i);
});

test('the usage_events range index migration is restart-safe and leading-columned', () => {
  // /api/usage/range filters on recorded_at alone, so the index has to LEAD with
  // it; the pre-existing (device_id, recorded_at) index could not serve the scan.
  const sql = fs.readFileSync(
    path.join(__dirname, '../../migrations/005_usage_events_recorded_index.sql'),
    'utf8'
  );
  // MySQL has no ADD INDEX IF NOT EXISTS, so the guard must go through
  // information_schema plus a prepared statement.
  assert.doesNotMatch(sql, /ADD\s+INDEX\s+IF\s+NOT\s+EXISTS/i);
  assert.match(sql, /information_schema\.STATISTICS/i);
  assert.match(sql, /INDEX_NAME = 'idx_usage_events_recorded'/);
  assert.match(sql, /ADD INDEX `idx_usage_events_recorded` \(`recorded_at`\)/i);
  // The covering index for the range GROUP BY.
  assert.match(sql, /ADD INDEX `idx_usage_events_recorded_client_model` \(`recorded_at`, `client`, `model`\)/i);
  assert.match(sql, /DEALLOCATE PREPARE/i);
});

test('the usage_events credit migration is restart-safe ADD COLUMN DDL', () => {
  // Migration 006 adds the ledger's credit column. MySQL has no
  // ADD COLUMN IF NOT EXISTS, so — like 003's soft-delete column — the guard has
  // to go through information_schema and a prepared statement, or re-running the
  // migration on an existing database fails the whole startup.
  const sql = fs.readFileSync(
    path.join(__dirname, '../../migrations/006_usage_events_credits.sql'),
    'utf8'
  );
  assert.doesNotMatch(sql, /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i);
  assert.match(sql, /information_schema\.COLUMNS/i);
  assert.match(sql, /TABLE_NAME = 'usage_events'/i);
  assert.match(sql, /COLUMN_NAME = 'credits'/i);
  assert.match(sql, /ALTER TABLE `usage_events` ADD COLUMN `credits` DECIMAL\(24,10\) NOT NULL DEFAULT 0/i);
  assert.match(sql, /PREPARE token_monitor_usage_events_credits/i);
  assert.match(sql, /DEALLOCATE PREPARE/i);
  // Same precision as cost_usd: a per-request credit has ~1e-9 granularity.
  assert.match(sql, /DECIMAL\(24,10\)/);
});

test('daily facts migration uses matching fractional timestamp precision', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '../../migrations/009_usage_daily_facts.sql'),
    'utf8'
  );
  assert.equal(
    (sql.match(/updated_at DATETIME\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP\(3\) ON UPDATE CURRENT_TIMESTAMP\(3\)/g) || []).length,
    2
  );
  assert.doesNotMatch(sql, /ON UPDATE CURRENT_TIMESTAMP,/i);
});

test('migration ordering is numeric and duplicate prefixes fail closed', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jiran-migration-order-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const name of ['10_ten.sql', '2_two.sql', '01_one.sql']) {
    fs.writeFileSync(path.join(directory, name), 'SELECT 1;\n');
  }
  assert.deepEqual(migrationFiles(directory), ['01_one.sql', '2_two.sql', '10_ten.sql']);
  fs.writeFileSync(path.join(directory, '002_duplicate.sql'), 'SELECT 1;\n');
  assert.throws(() => migrationFiles(directory), /unique numeric ordering prefixes/);
});

test('migration statements preserve a delimited routine body', () => {
  const parsed = statements(`CREATE TABLE routine_probe (id INT PRIMARY KEY);
DELIMITER //
CREATE PROCEDURE refresh_probe()
BEGIN
  UPDATE routine_probe SET id = id + 1;
  SELECT id FROM routine_probe;
END//
DELIMITER ;
DROP TABLE routine_probe;
`);
  assert.equal(parsed.length, 3);
  assert.match(parsed[1], /UPDATE routine_probe SET id = id \+ 1;\n\s+SELECT id FROM routine_probe;/);
  assert.match(parsed[1], /END$/);
  assert.throws(() => statements('CREATE PROCEDURE broken() SELECT 1;'), /DELIMITER/);
});

test('migration runner records SHA-256 checksums for newly applied files', async () => {
  const pool = fakePool();
  await runMigrations(pool);
  const inserts = pool.calls.filter((call) => call.sql?.includes('INSERT INTO schema_migrations'));
  assert.equal(inserts.length, migrationFiles().length);
  for (const insert of inserts) {
    const [name, checksum] = insert.params;
    const sql = fs.readFileSync(path.join(__dirname, '../../migrations', name), 'utf8');
    assert.equal(checksum, crypto.createHash('sha256').update(sql, 'utf8').digest('hex'));
  }
});

test('migration runner backfills legacy checksums once and accepts matching records', async () => {
  const names = migrationFiles();
  const pool = fakePool({ applied: names });
  await runMigrations(pool);
  const backfills = pool.calls.filter((call) => call.sql?.includes('UPDATE schema_migrations SET checksum'));
  assert.equal(backfills.length, names.length);
  assert.equal(pool.calls.some((call) => call.sql?.includes('INSERT INTO schema_migrations')), false);

  const applied = names.map((name) => ({
    name,
    checksum: crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(__dirname, '../../migrations', name), 'utf8'), 'utf8')
      .digest('hex')
  }));
  const verified = fakePool({ applied });
  await runMigrations(verified);
  assert.equal(verified.calls.some((call) => call.sql?.includes('UPDATE schema_migrations SET checksum')), false);
});

test('migration runner rejects changed or missing applied migrations before replay', async () => {
  const [name] = migrationFiles();
  const changed = fakePool({ applied: [{ name, checksum: '0'.repeat(64) }] });
  await assert.rejects(() => runMigrations(changed), /checksum does not match/);
  assert.equal(changed.calls.some((call) => call.sql?.includes('INSERT INTO schema_migrations')), false);

  const missing = fakePool({ applied: ['999_not_in_this_release.sql'] });
  await assert.rejects(() => runMigrations(missing), /Applied migration is missing/);
  assert.equal(missing.calls.some((call) => call.sql?.includes('INSERT INTO schema_migrations')), false);
});
