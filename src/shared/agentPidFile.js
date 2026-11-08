'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { pidFileCandidates, pidFilePath } = require('./config');

function parseAgentPidRecord(raw) {
  const text = String(raw ?? '').trim();
  if (/^[1-9]\d*$/.test(text)) {
    const pid = Number(text);
    if (Number.isSafeInteger(pid)) return { version: 0, pid, instanceId: null };
  }
  try {
    const value = JSON.parse(text);
    const pid = Number(value?.pid);
    if (value?.version !== 1 || !Number.isSafeInteger(pid) || pid <= 0) return null;
    if (typeof value.instanceId !== 'string' || !value.instanceId) return null;
    return {
      version: 1,
      pid,
      instanceId: value.instanceId,
      startedAt: typeof value.startedAt === 'string' ? value.startedAt : null
    };
  } catch (_) {
    return null;
  }
}

function isProcessAlive(pid, kill = process.kill.bind(process)) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    kill(Number(pid), 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this user cannot signal it. ESRCH and
    // malformed/unsupported PID errors are the only cases treated as stale.
    return error?.code === 'EPERM';
  }
}

function ownershipError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function claimAgentPidFile(options = {}) {
  const fsApi = options.fs || fs;
  const primaryPath = options.pidPath || pidFilePath(options);
  const candidates = options.pidPaths || (options.pidPath ? [primaryPath] : pidFileCandidates(options));
  const pid = Number(options.pid || process.pid);
  const instanceId = options.instanceId || crypto.randomUUID();
  const startedAt = options.startedAt || new Date().toISOString();
  const alive = options.isAlive || ((candidate) => isProcessAlive(candidate, options.kill));
  const currentRecord = `${JSON.stringify({ version: 1, pid, instanceId, startedAt })}\n`;

  function liveOwner() {
    for (const candidate of candidates) {
      let raw;
      try { raw = fsApi.readFileSync(candidate, 'utf8'); }
      catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      const record = parseAgentPidRecord(raw);
      if (!record || record.pid === pid || !alive(record.pid)) continue;
      return { ...record, pidPath: candidate };
    }
    return null;
  }

  function assertNoLiveOwner() {
    const owner = liveOwner();
    if (owner) {
      throw ownershipError(
        'agent_already_running',
        `Another Jiran agent is already running (pid ${owner.pid}, ${owner.pidPath}).`,
        owner
      );
    }
  }

  fsApi.mkdirSync(path.dirname(primaryPath), { recursive: true });

  // O_EXCL is the acquisition boundary. Reclaiming a dead owner's record uses a
  // unique rename plus a byte-for-byte comparison so a record replaced between
  // the liveness check and reclamation is never deliberately discarded.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assertNoLiveOwner();
    try {
      fsApi.writeFileSync(primaryPath, currentRecord, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      let released = false;
      return {
        pid,
        instanceId,
        pidPath: primaryPath,
        release() {
          if (released) return false;
          released = true;
          try {
            const record = parseAgentPidRecord(fsApi.readFileSync(primaryPath, 'utf8'));
            if (record?.version !== 1 || record.pid !== pid || record.instanceId !== instanceId) return false;
            fsApi.unlinkSync(primaryPath);
            return true;
          } catch (error) {
            if (error?.code === 'ENOENT') return false;
            return false;
          }
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    let observed;
    try { observed = fsApi.readFileSync(primaryPath, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const record = parseAgentPidRecord(observed);
    if (!record) {
      throw ownershipError(
        'agent_pid_invalid',
        `Cannot safely reclaim malformed agent PID file: ${primaryPath}`,
        { pidPath: primaryPath }
      );
    }
    if (record.pid !== pid && alive(record.pid)) continue;

    const quarantinePath = `${primaryPath}.reclaim.${pid}.${instanceId}.${attempt}`;
    try { fsApi.renameSync(primaryPath, quarantinePath); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    try {
      const moved = fsApi.readFileSync(quarantinePath, 'utf8');
      if (moved !== observed) {
        // Another claimant replaced the record. Restore the moved record only if
        // the primary path is still free; never overwrite a newer owner.
        try { fsApi.linkSync(quarantinePath, primaryPath); }
        catch (error) {
          if (error?.code !== 'EEXIST') throw error;
        }
      }
    } finally {
      try { fsApi.unlinkSync(quarantinePath); } catch (_) { /* best effort */ }
    }
  }

  throw ownershipError('agent_pid_busy', `Could not acquire agent PID file: ${primaryPath}`, { pidPath: primaryPath });
}

module.exports = {
  claimAgentPidFile,
  isProcessAlive,
  parseAgentPidRecord
};
