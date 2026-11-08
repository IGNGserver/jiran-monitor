'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createMySqlPool } = require('../src/hub/repository');
const { assertSupportedMySql, retryTransient } = require('../src/hub/databaseConfig');
const { loadDotEnv, projectRoot } = require('../src/shared/config');

function migrationFiles(directory = path.join(projectRoot(), 'migrations')) {
  const files = fs.readdirSync(directory)
    .filter((file) => /^\d+_.+\.sql$/i.test(file))
    .sort((left, right) => (
      Number(left.match(/^\d+/)[0]) - Number(right.match(/^\d+/)[0])
      || left.localeCompare(right)
    ));
  for (let index = 1; index < files.length; index += 1) {
    if (Number(files[index - 1].match(/^\d+/)[0]) === Number(files[index].match(/^\d+/)[0])) {
      throw new Error(`Migrations must have unique numeric ordering prefixes: ${files[index - 1]}, ${files[index]}`);
    }
  }
  return files;
}

function statements(sql) {
  const text = String(sql);
  if (!/^\s*DELIMITER\s+\S+/im.test(text)) {
    if (/\bCREATE\s+(?:DEFINER\s*=\s*\S+\s+)?(?:PROCEDURE|FUNCTION|TRIGGER|EVENT)\b/i.test(text)) {
      throw new Error('Routine migrations must use explicit DELIMITER directives');
    }
    return text.split(/;\s*(?:\r?\n|$)/).map((statement) => statement.trim()).filter(Boolean);
  }

  // mysql-client DELIMITER directives keep routine bodies intact while retaining
  // one statement per connection.query(). Directives must be on their own line;
  // ordinary migrations keep the original line-oriented semicolon behaviour.
  const result = [];
  let delimiter = ';';
  let buffer = '';
  for (const line of text.split(/(?<=\n)/)) {
    const directive = line.match(/^\s*DELIMITER\s+(\S+)\s*(?:\r?\n)?$/i);
    if (directive) {
      if (buffer.trim()) throw new Error('DELIMITER cannot appear inside an unfinished migration statement');
      delimiter = directive[1];
      continue;
    }
    buffer += line;
    const trimmed = buffer.trimEnd();
    if (!trimmed.endsWith(delimiter)) continue;
    const statement = trimmed.slice(0, -delimiter.length).trim();
    if (statement) result.push(statement);
    buffer = '';
  }
  if (buffer.trim()) result.push(buffer.trim());
  return result;
}

function migrationChecksum(sql) {
  return crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
}

const MIGRATION_LOCK_NAME = 'token-monitor-schema-migrations';
const MIGRATION_LOCK_TIMEOUT_SECONDS = 30;

// GET_LOCK() is server-wide, not per schema. Two apps sharing one MySQL server
// (the reason JIRAN_DATABASE_URL exists) must not serialize each other's
// migrations, so the lock is scoped by the database the connection selected.
// MySQL caps a lock name at 64 characters; a long database name is hashed so the
// advisory lock keeps working instead of failing (or being truncated by the
// server in a way two schemas could collide on).
function migrationLockName(databaseName) {
  const suffix = String(databaseName || '').trim() || 'default';
  const name = `${MIGRATION_LOCK_NAME}:${suffix}`;
  if (name.length <= 64) return name;
  const digest = crypto.createHash('sha1').update(suffix).digest('hex').slice(0, 16);
  return `${MIGRATION_LOCK_NAME}:${digest}`;
}

async function runMigrations(pool, directory) {
  const connection = await pool.getConnection();
  let lockAcquired = false;
  let lockName = migrationLockName('');
  try {
    // Fail on a server the schema cannot work on before holding the lock or
    // writing anything: the DDL depends on MySQL 8 JSON/collation features.
    const [versionRows] = await connection.query('SELECT VERSION() AS version');
    assertSupportedMySql(versionRows?.[0]?.version);
    const [databaseRows] = await connection.query('SELECT DATABASE() AS database_name');
    lockName = migrationLockName(databaseRows?.[0]?.database_name);

    const [lockRows] = await connection.execute(
      'SELECT GET_LOCK(?, ?) AS acquired',
      [lockName, MIGRATION_LOCK_TIMEOUT_SECONDS]
    );
    if (Number(lockRows?.[0]?.acquired) !== 1) {
      throw new Error(`Could not acquire MySQL migration lock ${lockName} within ${MIGRATION_LOCK_TIMEOUT_SECONDS}s`);
    }
    lockAcquired = true;
    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(255) NOT NULL PRIMARY KEY,
      checksum CHAR(64) NULL,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    // Existing installations have no checksum column. MySQL 8 has no portable
    // ADD COLUMN IF NOT EXISTS, so inspect the selected schema before upgrading
    // this small runner-owned table in place.
    const [checksumColumns] = await connection.query(`SELECT COLUMN_NAME AS column_name
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations' AND COLUMN_NAME = 'checksum'`);
    if (!checksumColumns.length) {
      await connection.query('ALTER TABLE schema_migrations ADD COLUMN checksum CHAR(64) NULL AFTER name');
    }

    const migrationsDirectory = directory || path.join(projectRoot(), 'migrations');
    const migrations = migrationFiles(directory).map((name) => {
      const sql = fs.readFileSync(path.join(migrationsDirectory, name), 'utf8');
      return { name, sql, checksum: migrationChecksum(sql) };
    });
    const byName = new Map(migrations.map((migration) => [migration.name, migration]));
    const [appliedRows] = await connection.query('SELECT name, checksum FROM schema_migrations');
    const applied = new Set(appliedRows.map((row) => row.name));
    for (const row of appliedRows) {
      const migration = byName.get(row.name);
      if (!migration) throw new Error(`Applied migration is missing from this release: ${row.name}`);
      const recorded = String(row.checksum || '').trim().toLowerCase();
      if (recorded && recorded !== migration.checksum) {
        throw new Error(`Applied migration checksum does not match ${row.name}; restore the original file or reconcile the schema explicitly`);
      }
      // A pre-checksum installation has no evidence to compare. Adopt the current
      // file exactly once, then fail closed on every later content change.
      if (!recorded) {
        await connection.execute(
          'UPDATE schema_migrations SET checksum = ? WHERE name = ? AND checksum IS NULL',
          [migration.checksum, row.name]
        );
      }
    }

    for (const migration of migrations) {
      if (applied.has(migration.name)) continue;
      try {
        for (const statement of statements(migration.sql)) await connection.query(statement);
        await connection.execute(
          'INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)',
          [migration.name, migration.checksum]
        );
      } catch (error) {
        throw new Error(`Migration ${migration.name} failed: ${error.message}`, { cause: error });
      }
    }
  } finally {
    try {
      if (lockAcquired) await connection.execute('SELECT RELEASE_LOCK(?) AS released', [lockName]);
    } finally {
      connection.release();
    }
  }
}

if (require.main === module) {
  loadDotEnv();
  const pool = createMySqlPool();
  // The Docker entrypoint runs this file before the Hub; a remote/shared server
  // may still be starting. Only connection-level failures are retried here.
  retryTransient(() => runMigrations(pool), {
    attempts: 8,
    baseMs: 1000,
    maxMs: 30_000,
    onRetry: (error, attempt, delay) => {
      console.warn(`[migrate] database not ready (${error.code || error.message}); retry ${attempt} in ${delay}ms`);
    }
  })
    .then(() => { console.log('Migrations complete.'); })
    .finally(() => pool.end())
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { MIGRATION_LOCK_NAME, migrationFiles, migrationLockName, runMigrations, statements };
