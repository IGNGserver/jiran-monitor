'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CREDENTIALS_VERSION = 1;
const SETTINGS_MIGRATION_VERSION = 1;
const LEGACY_LOCAL_LIMIT_CREDENTIALS_MIGRATION_VERSION = 1;
const REMOVED_HUB_CREDENTIALS_MIGRATION_VERSION = 1;

const CREDENTIAL_SETTING_PATHS = Object.freeze({
  secret: ['hub', 'clientSecret'],
  // The long-lived, revocable device session. It is a credential but not the
  // owner secret, so losing this file no longer hands over the whole Hub.
  sessionToken: ['hub', 'sessionToken']
});

const REMOVED_HUB_CREDENTIAL_SETTING_KEYS = Object.freeze([
  'hubAdminSecret'
]);

const LEGACY_LOCAL_LIMIT_CREDENTIAL_PATHS = Object.freeze([
  ['providers', 'claude', 'accessToken'],
  ['providers', 'cursor', 'sessionToken'],
  ['providers', 'grok', 'bearerToken'],
  ['providers', 'warp', 'apiKey'],
  ['providers', 'cline', 'apiKey'],
  ['providers', 'gemini', 'accessToken'],
  ['providers', 'gemini', 'refreshToken'],
  ['providers', 'kilocode', 'apiKey'],
  ['providers', 'droid', 'apiKey'],
  ['providers', 'droid', 'refreshToken'],
  ['providers', 'claude', 'refreshToken'],
  ['providers', 'claude', 'webCookie'],
  ['providers', 'opencode', 'cookie'],
  ['providers', 'opencode', 'profiles'],
  ['providers', 'openrouter', 'profiles'],
  ['providers', 'deepseek', 'apiKey'],
  ['providers', 'minimax', 'apiKey'],
  ['providers', 'copilot', 'apiToken'],
  ['providers', 'zai', 'apiKey'],
  ['providers', 'zaiTeam', 'apiKey'],
  ['providers', 'zaiTeam', 'organizationId'],
  ['providers', 'zaiTeam', 'projectId'],
  ['providers', 'volcengine', 'accessKeyId'],
  ['providers', 'volcengine', 'secretAccessKey'],
  ['providers', 'qoder', 'cookie'],
  ['providers', 'commandcode', 'apiKey'],
  ['providers', 'commandcode', 'cookie'],
  ['providers', 'amp', 'apiKey'],
  ['providers', 'sakana', 'sessionCookie'],
  ['providers', 'kimi', 'apiKey'],
  ['providers', 'kimi', 'webAccessToken'],
  ['providers', 'kimi', 'refreshToken'],
  ['providers', 'ollama', 'cookie'],
  ['providers', 'thirdparty', 'profiles'],
  ['providers', 'mimo', 'accounts'],
  ['providers', 'qoder', 'autoCache']
]);

const REMOVED_HUB_CREDENTIAL_PATHS = Object.freeze([
  ['hub', 'hostSecret'],
  ['hub', 'adminSecret'],
  ['hub', 'accountCredentialKey'],
  ['hub', 'ingestCredentials'],
  ['hub', 'remoteAdminSecret']
]);

function emptyDocument() {
  return { version: CREDENTIALS_VERSION, credentials: {}, migrations: {} };
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function credentialValuePresent(value) {
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return isObject(value) && Object.keys(value).length > 0;
}

function valueAt(root, segments) {
  let current = root;
  for (const segment of segments) {
    if (!isObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function setValueAt(root, segments, value) {
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (!isObject(current[segment])) current[segment] = {};
    current = current[segment];
  }
  current[segments.at(-1)] = cloneJson(value);
}

function deleteValueAt(root, segments) {
  const parents = [];
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (!isObject(current?.[segment])) return;
    parents.push([current, segment]);
    current = current[segment];
  }
  delete current[segments.at(-1)];
  for (let index = parents.length - 1; index >= 0; index -= 1) {
    const [parent, segment] = parents[index];
    if (Object.keys(parent[segment]).length > 0) break;
    delete parent[segment];
  }
}

function normalizeDocument(value) {
  if (!isObject(value)) throw new Error('Credential store must contain a JSON object');
  if (value.version !== CREDENTIALS_VERSION) {
    throw new Error(`Unsupported credential store version: ${String(value.version)}`);
  }
  return {
    ...cloneJson(value),
    version: CREDENTIALS_VERSION,
    credentials: isObject(value.credentials) ? cloneJson(value.credentials) : {},
    migrations: isObject(value.migrations) ? cloneJson(value.migrations) : {}
  };
}

function readRegularFileNoFollow(filePath, options = {}) {
  const fsApi = options.fs || fs;
  const constants = fsApi.constants || fs.constants;
  const description = options.description || 'File';
  const noFollow = constants.O_NOFOLLOW || 0;
  let descriptor = null;
  let pathStat = null;
  try {
    if (!noFollow) {
      pathStat = fsApi.lstatSync(filePath);
      if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
        throw new Error(`${description} must be a regular file`);
      }
    }
    descriptor = fsApi.openSync(filePath, constants.O_RDONLY | noFollow);
    const descriptorStat = fsApi.fstatSync(descriptor);
    if (!descriptorStat.isFile()) throw new Error(`${description} must be a regular file`);
    if (pathStat && (pathStat.dev !== descriptorStat.dev || pathStat.ino !== descriptorStat.ino)) {
      throw new Error(`${description} changed while it was being opened`);
    }
    if (options.mode !== undefined && process.platform !== 'win32') {
      fsApi.fchmodSync(descriptor, options.mode);
    }
    return fsApi.readFileSync(descriptor, options.encoding || 'utf8');
  } catch (error) {
    if (error?.code === 'ELOOP') {
      const symlinkError = new Error(`${description} must be a regular file`);
      symlinkError.cause = error;
      throw symlinkError;
    }
    throw error;
  } finally {
    if (descriptor !== null) {
      try { fsApi.closeSync(descriptor); } catch (_) {}
    }
  }
}

function writePrivateJsonAtomic(filePath, value, options = {}) {
  const fsApi = options.fs || fs;
  const constants = fsApi.constants || fs.constants;
  const directory = path.dirname(filePath);
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor = null;
  let directoryDescriptor = null;
  let renamed = false;
  fsApi.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    descriptor = fsApi.openSync(temporary, 'wx', 0o600);
    fsApi.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    if (process.platform !== 'win32') fsApi.fchmodSync(descriptor, 0o600);
    fsApi.fsyncSync(descriptor);
    fsApi.closeSync(descriptor);
    descriptor = null;
    fsApi.renameSync(temporary, filePath);
    renamed = true;
    if (process.platform !== 'win32') {
      directoryDescriptor = fsApi.openSync(directory, constants.O_RDONLY);
      fsApi.fsyncSync(directoryDescriptor);
      fsApi.closeSync(directoryDescriptor);
      directoryDescriptor = null;
    }
  } catch (error) {
    if (renamed) error.atomicWriteCommitted = true;
    if (descriptor !== null) {
      try { fsApi.closeSync(descriptor); } catch (_) {}
    }
    if (directoryDescriptor !== null) {
      try { fsApi.closeSync(directoryDescriptor); } catch (_) {}
    }
    try { fsApi.rmSync(temporary, { force: true }); } catch (_) {}
    throw error;
  }
}

function stripCredentialSettings(settings) {
  const clean = { ...(settings || {}) };
  for (const key of [...Object.keys(CREDENTIAL_SETTING_PATHS), ...REMOVED_HUB_CREDENTIAL_SETTING_KEYS]) {
    delete clean[key];
  }
  return clean;
}

function hasCredentialSettings(settings) {
  return [...Object.keys(CREDENTIAL_SETTING_PATHS), ...REMOVED_HUB_CREDENTIAL_SETTING_KEYS]
    .some((key) => Object.hasOwn(settings || {}, key));
}

function credentialSettingsForRenderer(settings, options = {}) {
  const exposed = new Set(options.expose || []);
  const out = {};
  for (const key of Object.keys(CREDENTIAL_SETTING_PATHS)) {
    out[key] = exposed.has(key) ? cloneJson(settings?.[key]) : '';
  }
  return out;
}

function persistSettingsAndCredentials({
  store,
  settingsPath,
  settings,
  previousSettings,
  writeSettings = writePrivateJsonAtomic
}) {
  const previousDocument = store.readDocument();
  let credentialsCommitted = false;
  let settingsCommitted = false;
  try {
    try {
      store.replaceSettingsCredentials(settings, previousDocument);
      credentialsCommitted = true;
    } catch (error) {
      credentialsCommitted = error?.atomicWriteCommitted === true;
      throw error;
    }
    try {
      writeSettings(settingsPath, stripCredentialSettings(settings));
      settingsCommitted = true;
    } catch (error) {
      settingsCommitted = error?.atomicWriteCommitted === true;
      throw error;
    }
    return true;
  } catch (error) {
    const rollbackErrors = [];
    if (credentialsCommitted) {
      try { store.writeDocument(previousDocument); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (settingsCommitted) {
      try { writeSettings(settingsPath, stripCredentialSettings(previousSettings)); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length > 0) {
      const rollbackDetail = rollbackErrors.map((rollbackError) => rollbackError?.message || String(rollbackError)).join('; ');
      const combined = new Error(`${error?.message || error}; rollback failed: ${rollbackDetail}`);
      combined.cause = error;
      throw combined;
    }
    throw error;
  }
}

class CredentialStore {
  constructor(dataDir, options = {}) {
    this.fs = options.fs || fs;
    this.filePath = options.filePath || path.join(dataDir, 'credentials.json');
  }

  readDocument() {
    let raw;
    try {
      raw = readRegularFileNoFollow(this.filePath, {
        fs: this.fs,
        description: 'Credential store',
        encoding: 'utf8',
        mode: 0o600
      });
    } catch (error) {
      if (error.code === 'ENOENT') return emptyDocument();
      throw error;
    }
    return normalizeDocument(JSON.parse(raw));
  }

  writeDocument(document) {
    const normalized = normalizeDocument(document);
    writePrivateJsonAtomic(this.filePath, normalized, { fs: this.fs });
    return normalized;
  }

  settingsCredentials(document = this.readDocument()) {
    const out = {};
    for (const [key, segments] of Object.entries(CREDENTIAL_SETTING_PATHS)) {
      const value = valueAt(document.credentials, segments);
      if (credentialValuePresent(value)) out[key] = cloneJson(value);
    }
    return out;
  }

  migrateLegacySettings(legacySettings) {
    const document = this.readDocument();
    if (Number(document.migrations.settings || 0) >= SETTINGS_MIGRATION_VERSION) {
      return { migrated: false, document };
    }
    let found = false;
    for (const [key, segments] of Object.entries(CREDENTIAL_SETTING_PATHS)) {
      const value = legacySettings?.[key];
      if (!credentialValuePresent(value)) continue;
      found = true;
      if (!credentialValuePresent(valueAt(document.credentials, segments))) {
        setValueAt(document.credentials, segments, value);
      }
    }
    if (!found) return { migrated: false, document };
    document.migrations.settings = SETTINGS_MIGRATION_VERSION;
    return { migrated: true, document: this.writeDocument(document) };
  }

  replaceSettingsCredentials(settings, baseDocument = this.readDocument()) {
    const document = normalizeDocument(baseDocument);
    for (const [key, segments] of Object.entries(CREDENTIAL_SETTING_PATHS)) {
      const value = settings?.[key];
      if (credentialValuePresent(value)) setValueAt(document.credentials, segments, value);
      else deleteValueAt(document.credentials, segments);
    }
    document.migrations.settings = SETTINGS_MIGRATION_VERSION;
    return this.writeDocument(document);
  }

  clearLegacyLocalLimitCredentials() {
    const document = this.readDocument();
    if (
      Number(document.migrations.localLimitCredentials || 0)
      >= LEGACY_LOCAL_LIMIT_CREDENTIALS_MIGRATION_VERSION
    ) {
      return { cleared: false, document };
    }
    for (const segments of LEGACY_LOCAL_LIMIT_CREDENTIAL_PATHS) {
      deleteValueAt(document.credentials, segments);
    }
    document.migrations.localLimitCredentials = LEGACY_LOCAL_LIMIT_CREDENTIALS_MIGRATION_VERSION;
    return { cleared: true, document: this.writeDocument(document) };
  }

  clearRemovedHubCredentials() {
    const document = this.readDocument();
    if (
      Number(document.migrations.removedHubCredentials || 0)
      >= REMOVED_HUB_CREDENTIALS_MIGRATION_VERSION
    ) {
      return { cleared: false, document };
    }
    for (const segments of REMOVED_HUB_CREDENTIAL_PATHS) {
      deleteValueAt(document.credentials, segments);
    }
    document.migrations.removedHubCredentials = REMOVED_HUB_CREDENTIALS_MIGRATION_VERSION;
    return { cleared: true, document: this.writeDocument(document) };
  }
}

module.exports = {
  CREDENTIAL_SETTING_PATHS,
  CREDENTIALS_VERSION,
  CredentialStore,
  credentialSettingsForRenderer,
  hasCredentialSettings,
  persistSettingsAndCredentials,
  readRegularFileNoFollow,
  stripCredentialSettings,
  writePrivateJsonAtomic
};
