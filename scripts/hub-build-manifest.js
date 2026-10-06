'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'src', 'shared', 'hubBuildRegistry.json');
const REGISTRY_COMPONENTS = Object.freeze(['core', 'node-hub']);
const BUILD_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;

const CORE_SOURCE_FILES = Object.freeze([
  'src/shared/limitProviders.js',
  'src/shared/limits.js',
  'src/shared/usage.js',
  'src/shared/history.js',
  'src/shared/reasonixPaths.js',
  'src/shared/reasonixSessionGuard.js',
  'src/shared/projectKey.js',
  'src/shared/syncUploadInterval.js',
  'src/shared/subscriptionDisplay.js',
  'src/shared/currency.js',
  'src/shared/hubBuildIdentity.js',
  'src/shared/hubAuth.js',
  'src/shared/hubCapabilities.js',
  'src/shared/hubRateLimit.js',
  'src/shared/wireValidation.js'
]);
const NODE_RUNTIME_SOURCE_FILES = Object.freeze([
  'package.json',
  'src/hub/accountCrypto.js',
  'src/hub/accountService.js',
  'src/hub/oauthService.js',
  'src/hub/pricing-upstream.js',
  'src/hub/repository.js',
  'src/hub/server.js',
  'src/hub/static.js',
  'src/hub/usage-events.js',
  'src/shared/appVersion.js',
  'src/shared/ampLimits.js',
  'src/shared/antigravityProbe.js',
  'src/shared/browserUserAgent.js',
  'src/shared/claudeDesktopUsage.js',
  'src/shared/clientSyncRunners.js',
  'src/shared/clientSyncStatus.js',
  'src/shared/clientTracking.js',
  'src/shared/clineLimits.js',
  'src/shared/codexAuth.js',
  'src/shared/collector.js',
  'src/shared/commandcodeLimits.js',
  'src/shared/copilotLimits.js',
  'src/shared/http.js',
  'src/shared/hubAuth.js',
  'src/shared/hubCapabilities.js',
  'src/shared/hubRateLimit.js',
  'src/shared/config.js',
  'src/shared/cursorAuth.js',
  'src/shared/cursorProbe.js',
  'src/shared/customRange.js',
  'src/shared/dailyHistoryArchive.js',
  'src/shared/deepseekBalanceHistory.js',
  'src/shared/deepseekHarnessPaths.js',
  'src/shared/exchangeRates.js',
  'src/shared/factoryLimits.js',
  'src/shared/fleetTimeZone.js',
  'src/shared/geminiLimits.js',
  'src/shared/grokLimits.js',
  'src/shared/hashKey.js',
  'src/shared/hermesProfiles.js',
  'src/shared/kiloLimits.js',
  'src/shared/kimiLimits.js',
  'src/shared/kiroLimits.js',
  'src/shared/limitCollector.js',
  'src/shared/limitProviderSources.js',
  'src/shared/limitResetBoundary.js',
  'src/shared/limitsBurnRate.js',
  'src/shared/limitsRetryPolicy.js',
  'src/shared/limitsRuntime.js',
  'src/shared/mimoLimits.js',
  'src/shared/minimaxLimits.js',
  'src/shared/namedProfile.js',
  'src/shared/ollamaLimits.js',
  'src/shared/opencodeLimits.js',
  'src/shared/opencodeGoApi.js',
  'src/shared/opencodeProfiles.js',
  'src/shared/opencodeSession.js',
  'src/shared/opencodeWeb.js',
  'src/shared/openrouterLimits.js',
  'src/shared/osVersion.js',
  'src/shared/outboundFetch.js',
  'src/shared/probeDeadline.js',
  'src/shared/promaUsage.js',
  'src/shared/localUsageAdapters.js',
  'src/shared/qoderCnUsage.js',
  'src/shared/qoderCookieCapture.js',
  'src/shared/qoderLimits.js',
  'src/shared/reasonixFileIo.js',
  'src/shared/reasonixSessionDetail.js',
  'src/shared/reasonixSessions.js',
  'src/shared/sakanaLimits.js',
  'src/shared/selfSyncThrottle.js',
  'src/shared/sessionFiles.js',
  'src/shared/sessionUsageArchive.js',
  'src/shared/tokscaleConfig.js',
  'src/shared/tokscalePlatform.js',
  'src/shared/tokscaleSettings.js',
  'src/shared/thirdPartyLimits.js',
  'src/shared/wslUsage.js',
  'src/shared/volcengineLimits.js',
  'src/shared/wireValidation.js',
  'src/shared/warpLimits.js',
  'src/shared/zaiLimits.js',
  'src/shared/zaiTeamLimits.js'
]);
function hashInputs(inputs) {
  const hash = crypto.createHash('sha256');
  for (const input of inputs) {
    hash.update(input.name);
    hash.update('\0');
    hash.update(input.contents);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function fileInputs(relativePaths) {
  return relativePaths.map((relativePath) => ({
    name: relativePath,
    contents: fs.readFileSync(path.join(ROOT, relativePath))
  }));
}

function nodePackageBuildInput(packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))) {
  return JSON.stringify({
    dependencies: {
      dotenv: packageJson.dependencies?.dotenv || ''
    }
  });
}

function nodeLockBuildInput(packageLock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))) {
  return JSON.stringify({
    lockfileVersion: packageLock.lockfileVersion,
    dotenv: packageLock.packages?.['node_modules/dotenv'] || null
  });
}

function currentHubSourceBuildIds() {
  const nodeRuntimeFiles = NODE_RUNTIME_SOURCE_FILES.filter((name) => name !== 'package.json');
  return {
    core: hashInputs(fileInputs(CORE_SOURCE_FILES)),
    'node-hub': hashInputs([
      ...fileInputs(nodeRuntimeFiles),
      { name: 'package.node-hub.json', contents: nodePackageBuildInput() },
      { name: 'package-lock.node-hub.json', contents: nodeLockBuildInput() }
    ])
  };
}

function emptyRegistry() {
  return {
    schemaVersion: 1,
    components: {
      core: [],
      'node-hub': []
    }
  };
}

function validateRegistry(registry) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry) || registry.schemaVersion !== 1) {
    throw new Error('unsupported Hub build registry');
  }
  if (!registry.components || typeof registry.components !== 'object' || Array.isArray(registry.components)) {
    throw new Error('Hub build registry components must be an object');
  }
  const componentNames = Object.keys(registry.components).sort();
  const expectedNames = [...REGISTRY_COMPONENTS].sort();
  if (componentNames.length !== expectedNames.length
    || componentNames.some((component, index) => component !== expectedNames[index])) {
    throw new Error(`Hub build registry components must be exactly: ${REGISTRY_COMPONENTS.join(', ')}`);
  }
  for (const component of REGISTRY_COMPONENTS) {
    const entries = registry.components[component];
    if (!Array.isArray(entries)) {
      throw new Error(`Hub build registry component ${component} must be an array`);
    }
    entries.forEach((entry, index) => {
      const expectedRevision = index + 1;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || entry.revision !== expectedRevision) {
        throw new Error(`${component} revision at index ${index} must be ${expectedRevision}`);
      }
      if (typeof entry.buildId !== 'string' || !BUILD_ID_PATTERN.test(entry.buildId)) {
        throw new Error(`${component} revision ${expectedRevision} must have a valid SHA-256 build ID`);
      }
    });
  }
  return registry;
}

function readRegistry() {
  try {
    const parsed = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    return validateRegistry(parsed);
  } catch (error) {
    if (error.code === 'ENOENT') return emptyRegistry();
    throw error;
  }
}

function latestEntry(registry, component) {
  const entries = registry?.components?.[component];
  return Array.isArray(entries) && entries.length > 0 ? entries.at(-1) : null;
}

function updatedRegistry(registry, buildIds) {
  const next = JSON.parse(JSON.stringify(validateRegistry(registry || emptyRegistry())));
  for (const component of REGISTRY_COMPONENTS) {
    const current = latestEntry(next, component);
    if (current?.buildId === buildIds[component]) continue;
    next.components[component].push({
      revision: Number(current?.revision || 0) + 1,
      buildId: buildIds[component]
    });
  }
  return validateRegistry(next);
}

module.exports = {
  CORE_SOURCE_FILES,
  NODE_RUNTIME_SOURCE_FILES,
  REGISTRY_PATH,
  currentHubSourceBuildIds,
  latestEntry,
  nodeLockBuildInput,
  nodePackageBuildInput,
  readRegistry,
  updatedRegistry,
  validateRegistry,
};
