'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  defaultDeviceId,
  loadDotEnv,
  normalizeHubUrl,
  parseArgs,
  parseBoolean,
  pidFilePath
} = require('../shared/config');
const { appVersion } = require('../shared/appVersion');
const { migrateLegacySharedData } = require('../shared/sharedDataMigration');
const { usageConfigFromSource } = require('../shared/collectorConfig');
const {
  readDeviceIdentity,
  renameDeviceOnHub,
  writeDeviceIdentity
} = require('../shared/deviceIdentity');
const { postSyncPayload } = require('../shared/syncPayload');
const { createSyncSummaryTransformer } = require('../shared/syncSummary');
const { withSyncUploadMetadata } = require('../shared/syncUploadSink');
const { requireSafeHubTransport } = require('../shared/hubTransport');
const { learnFleetTimeZone, resolveFleetTimeZone } = require('../shared/fleetTimeZone');
const { runAgent, runAgentOnce } = require('./runtime');

loadDotEnv();
// Merge the pre-rename `<appData>/Token Monitor` shared directory forward before
// the device identity is read — keeping the id stable is what stops the hub from
// seeing this machine as a second device after the 计然 / Jiran rename.
migrateLegacySharedData();
const args = parseArgs(process.argv.slice(2));
const allowInsecureHubHttp = parseBoolean(
  args.allowInsecureHttp ?? args['allow-insecure-http'] ?? process.env.TOKEN_MONITOR_ALLOW_INSECURE_HTTP,
  false
);
const hubUrl = requireSafeHubTransport(
  normalizeHubUrl(args.hub || args.hubUrl || process.env.TOKEN_MONITOR_HUB_URL || 'http://127.0.0.1:17321'),
  { allowInsecureHttp: allowInsecureHubHttp }
);
const secret = String(args.secret || process.env.TOKEN_MONITOR_SECRET || '').trim();
const deviceId = String(args.device || args.deviceId || process.env.TOKEN_MONITOR_DEVICE_ID || defaultDeviceId());
const once = Boolean(args.once);
const dryRun = Boolean(args['dry-run'] || args.dryRun);

// Every supported tool is always tracked; the old per-agent selection is gone.
// Warn instead of failing so an existing service file or shell script keeps
// working through the upgrade.
if (args.clients !== undefined || process.env.TOKEN_MONITOR_CLIENTS !== undefined) {
  console.warn('[config] TOKEN_MONITOR_CLIENTS/--clients is no longer supported; all supported tools are tracked.');
}

// Only identity and the tokscale timeout are still per-invocation inputs. The
// cadence knobs (mode / interval / watch / history / archive / projects / WSL /
// all-time anchor / upload interval) left with the settings surface that carried
// them; src/shared/collectorConfig.js fixes them for every runtime now.
for (const [flag, env] of [
  ['--since', 'TOKEN_MONITOR_ALL_TIME_SINCE'], ['--collectionMode', 'TOKEN_MONITOR_COLLECTION_MODE'],
  ['--interval', 'TOKEN_MONITOR_INTERVAL_MS'], ['--watch', 'TOKEN_MONITOR_WATCH'],
  ['--watchDebounceMs', 'TOKEN_MONITOR_WATCH_DEBOUNCE_MS'], ['--history', 'TOKEN_MONITOR_HISTORY_ENABLED'],
  ['--projects', 'TOKEN_MONITOR_PROJECTS_ENABLED'], ['--sessionArchive', 'TOKEN_MONITOR_SESSION_USAGE_ARCHIVE_ENABLED'],
  ['--wslScan', 'TOKEN_MONITOR_WSL_SCAN'], ['--syncUploadInterval', 'TOKEN_MONITOR_SYNC_UPLOAD_INTERVAL_MS']
]) {
  const name = flag.slice(2);
  if (args[name] !== undefined || process.env[env] !== undefined) {
    console.warn(`[config] ${env}/--${name} is no longer supported; collection is fixed and every supported tool is tracked.`);
  }
}

const usageSource = {
  commandTimeoutMs: args.timeoutMs ?? process.env.TOKEN_MONITOR_TOKSCALE_TIMEOUT_MS,
  deviceId
};
const usageSourceExtra = { anchorPersistenceEnabled: !once && !dryRun };

const usageOptions = usageConfigFromSource(usageSource, {
  ...usageSourceExtra,
  agentVersion: appVersion(),
  agentRuntime: 'headless-agent',
  reasonixNativeSessionsEnabled: true,
  dailyHistoryArchiveWriteEnabled: !dryRun,
  uploadTimeoutMs: 15 * 1000,
  onError: (error, reason) => console.error(`[${new Date().toISOString()}] (${reason}) ${error.message}`),
  logger: (message) => (dryRun ? console.error(message) : console.log(message))
});

const syncSummaryTransformer = createSyncSummaryTransformer({
  canWriteSessionUsageArchive: !dryRun,
  // The archive is keyed by the active fleet calendar; the transformer resolves
  // it per transform so a zone learned from the Hub takes effect without a
  // restart (a change also drops its in-memory copy).
  timeZone: () => resolveFleetTimeZone(),
  onArchiveError: (error, operation) => console.error(`[session-archive] ${operation} failed: ${error.message}`)
});

function summaryForSync(summary, reason, meta) {
  return syncSummaryTransformer.transform(summary, reason, meta);
}

let deviceIdentity = readDeviceIdentity();

async function postUsage(summary, context = {}) {
  const previousDeviceId = deviceIdentity.lastPostedDeviceId;
  if (previousDeviceId && previousDeviceId !== summary.deviceId) {
    await renameDeviceOnHub(
      fetch,
      hubUrl,
      secret,
      previousDeviceId,
      summary.deviceId,
      { signal: context.signal, timeoutMs: usageOptions.uploadTimeoutMs }
    );
  }
  const { response } = await postSyncPayload(fetch, `${hubUrl}/api/ingest`, {
    headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    summary,
    signal: context.signal,
    timeoutMs: usageOptions.uploadTimeoutMs,
    logger: (message) => console.warn(`[sync] ${message}`)
  });
  if (!response.ok) {
    const error = new Error(`Hub responded ${response.status}: ${(await response.text()).slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }
  deviceIdentity = { version: 1, lastPostedDeviceId: summary.deviceId };
  try { writeDeviceIdentity(summary.deviceId); }
  catch (error) { console.warn(`[identity] state write failed: ${error.message}`); }
  const payload = await response.json();
  // The Hub is the one place the fleet calendar is configured; remember what it
  // advertised so the next collector tick buckets in it. A local state-write
  // failure must not turn an accepted upload into a reported sync failure.
  try {
    if (payload && typeof payload === 'object') learnFleetTimeZone(payload.fleetTimeZone);
  } catch (error) {
    console.warn(`[fleet-timezone] could not record the Hub calendar: ${error.message}`);
  }
  return payload;
}

async function deliver(summary, context = {}) {
  const uploadSummary = withSyncUploadMetadata(summary, usageOptions.syncUploadIntervalMs);
  if (dryRun) { console.log(JSON.stringify(uploadSummary, null, 2)); return; }
  await postUsage(uploadSummary, context);
  console.log(`[${new Date().toISOString()}] posted ${summary.deviceId}: today=${summary.today.totalTokens} month=${summary.month.totalTokens} allTime=${summary.allTime.totalTokens}`);
}

function registerPidFile(stopRuntime) {
  const pidPath = pidFilePath();
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, String(process.pid), 'utf8');
  const cleanup = () => { try { fs.unlinkSync(pidPath); } catch (_) {} };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      try { stopRuntime?.(); } catch (_) {}
      cleanup();
      process.exit(0);
    });
  }
}

async function main() {
  const startupMessage = `Jiran agent device=${deviceId} hub=${hubUrl} intervalMs=${usageOptions.intervalMs} uploadIntervalMs=${usageOptions.syncUploadIntervalMs} watch=${usageOptions.watchEnabled} projects=${usageOptions.projectsEnabled ? 'on' : 'off'} history=${usageOptions.historyEnabled ? 'on' : 'off'} sessionArchive=${usageOptions.dailyHistoryArchiveEnabled ? 'on' : 'off'} limits=hub`;
  if (dryRun) console.error(startupMessage);
  else console.log(startupMessage);
  if (!secret) console.warn('Warning: TOKEN_MONITOR_SECRET is not set. Posting without authorization header.');
  // Claim archive ownership before either a one-shot or long-running scan so
  // Electron can yield before its history read-modify-write reaches disk.
  let runtimeHandle = null;
  if (!dryRun) registerPidFile(() => runtimeHandle?.stop());
  const runtimeOptions = {
    envelope: { deviceId, agentVersion: appVersion(), agentRuntime: 'headless-agent' },
    usageOptions,
    transformUsage: summaryForSync,
    syncUploadIntervalMs: usageOptions.syncUploadIntervalMs,
    uploadTimeoutMs: usageOptions.uploadTimeoutMs,
    deliver,
    dryRun,
    onRuntime: (runtime) => { runtimeHandle = runtime; },
    onError: (error, reason) => console.error(`[${new Date().toISOString()}] (${reason}) ${error.message}`)
  };
  if (once) {
    await runAgentOnce(runtimeOptions);
    return;
  }
  runtimeHandle = runAgent(runtimeOptions);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
