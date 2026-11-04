'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createMySqlPool } = require('../src/hub/repository');
const { assertSupportedMySql, retryTransient } = require('../src/hub/databaseConfig');
const { loadDotEnv, projectRoot } = require('../src/shared/config');

function migrationFiles(directory = path.join(projectRoot(), 'migrations')) {
  return fs.readdirSync(directory)
    .filter((file) => /^\d+_.+\.sql$/i.test(file))
    .sort((a, b) => a.localeCompare(b));
}

function statements(sql) {
  return String(sql).split(/;\s*(?:\r?\n|$)/).map((statement) => statement.trim()).filter(Boolean);
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
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const [appliedRows] = await connection.query('SELECT name FROM schema_migrations');
    const applied = new Set(appliedRows.map((row) => row.name));
    for (const file of migrationFiles(directory)) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(directory || path.join(projectRoot(), 'migrations'), file), 'utf8');
      try {
        for (const statement of statements(sql)) await connection.query(statement);
        await connection.execute('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
      } catch (error) {
        throw new Error(`Migration ${file} failed: ${error.message}`, { cause: error });
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
