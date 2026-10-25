#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EXPECTED_SCOPE = {
  schemaVersion: 1,
  widgetModes: ['local', 'client'],
  hubDistribution: ['docker-compose'],
  embeddedWidgetHub: false,
  standaloneHubCommand: false,
  cloudflareWorker: false,
  headlessAgent: true
};

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function exists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

function fail(message) {
  throw new Error(`Product scope violation: ${message}`);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

function expectAbsent(relativePath) {
  expect(!exists(relativePath), `${relativePath} must not exist`);
}

function verifyProductScope() {
  const scope = JSON.parse(read('product-scope.json'));
  expect(JSON.stringify(scope) === JSON.stringify(EXPECTED_SCOPE), 'product-scope.json must match the approved two-mode scope');

  const packageJson = JSON.parse(read('package.json'));
  const scripts = packageJson.scripts || {};
  expect(!Object.hasOwn(scripts, 'hub'), 'package.json must not expose a standalone Hub command');
  expect(scripts.agent === 'node src/agent/agent.js', 'the headless agent entry point must remain available');
  expect(scripts['agent:once'] === 'node src/agent/agent.js --once', 'the one-shot agent entry point must remain available');
  expect(scripts['package:headless'] === 'node scripts/package-headless.js', 'the headless release package entry point must remain available');
  expect(!Object.hasOwn(scripts, 'sync:worker'), 'package.json must not expose a removed secondary Hub sync command');
  expect(scripts['verify:product-scope'] === 'node scripts/verify-product-scope.js', 'scope verification must remain wired into npm scripts');
  expect(String(scripts.verify || '').includes('verify:product-scope'), 'npm run verify must execute the product-scope guard');
  expect(!packageJson.build?.files?.includes('src/hub/**/*'), 'Electron packages must not include the Docker-only Hub source');

  const main = read('src/electron/main.js');
  expect(/const HUB_MODE_VALUES = new Set\(\['local', 'client'\]\)/.test(main), 'Electron must expose only local and client Hub modes');
  for (const marker of [
    'startEmbeddedHub',
    'stopEmbeddedHub',
    'embeddedHub',
    'startHostCollector',
    'stopHostCollector',
    'hub:getInfo',
    'regenerateHubSecret',
    'provisionHubDeviceCredential',
    'revealHubAdminCredential',
    'createHub(',
    'generateHubSecret(',
    'lanIpv4Addresses('
  ]) {
    expect(!main.includes(marker), `Electron must not contain removed Host behavior: ${marker}`);
  }
  expect(!/settings\.hubMode\s*[!=]==?\s*['"]host['"]/.test(main), 'Electron must not branch into a Host mode');
  expect(!main.includes("require('../hub/server')"), 'Electron must not import the Docker-only Hub server');

  // The sync UI now lives in the shared package, which both hosts render, so the
  // two-mode boundary is asserted there rather than in a desktop-only file.
  const desktopSettingsView = read('src/shared-ui/views/settingsDesktop.js');
  // Keep the two-mode boundary tied to the actual Fluent RadioGroup rather
  // than counting unrelated form fields that happen to share the name.
  const modeGroup = desktopSettingsView.match(/<fluent-radio-group\b[^>]*name="hubMode"[^>]*>([\s\S]*?)<\/fluent-radio-group>/);
  expect(Boolean(modeGroup), 'the sync settings UI must expose a Fluent radio group');
  const modeChoices = modeGroup ? modeGroup[1].match(/<fluent-radio\b[^>]*>/g) || [] : [];
  expect(modeChoices.length === 2, 'the sync settings UI must contain exactly two mode choices');
  const modeValues = modeChoices.map((tag) => (tag.match(/value="([^"]+)"/) || [])[1]).sort();
  expect(JSON.stringify(modeValues) === JSON.stringify(['client', 'local']), 'the only supported modes are local and client');
  expect(!desktopSettingsView.includes('value="host"'), 'the sync settings UI must not expose Host mode');
  expect(!desktopSettingsView.includes('id="hubHostFields"'), 'the sync settings UI must not contain embedded Hub fields');

  const runtimeConfig = read('src/electron/runtimeConfig.js');
  for (const marker of ['hubHostPort', 'hubHostSecret', 'hubHostAdminSecret', 'hubAccountCredentialKey']) {
    expect(!runtimeConfig.includes(marker), `runtime config must not retain removed Host setting: ${marker}`);
  }

  // No UI surface may reintroduce the removed embedded-Hub controls. Scanning the
  // whole shared package covers both hosts with one assertion.
  for (const relativePath of ['src/shared-ui/app.js', 'src/shared-ui/views/settingsDesktop.js']) {
    const source = read(relativePath);
    for (const marker of [
      'hubHost',
      'hubPortInput',
      'hubSecretInput',
      'renderHubStatus',
      'refreshHubInfo',
      'regenerateHubSecret',
      'provisionHubDeviceCredential',
      'revealHubAdminCredential',
      'onHubPush'
    ]) {
      expect(!source.includes(marker), `${relativePath} must not contain removed Host UI behavior: ${marker}`);
    }
  }

  const webData = read('src/shared-ui/core/data.js');
  expect(!webData.includes("return 'embedded-hub'"), 'Hub dashboard must not display the removed embedded runtime label');
  const androidFormatters = read('android/app/src/main/java/com/igng/tokenmonitor/android/ui/components/Formatters.kt');
  expect(!androidFormatters.includes('"embedded-hub"'), 'Android must not display the removed embedded runtime label');

  // Device data transfer is a Hub-web owner capability. The desktop client must
  // have no code path to it: no navigation destination, no desktop render site,
  // and no proxy of the endpoint through the main process.
  const desktopRouter = read('src/electron/desktopRequestRouter.js');
  expect(!desktopRouter.includes('transfer'), 'the desktop request router must not proxy device transfer');
  const navigationGroupTable = read('src/shared-ui/app.js').match(/const navGroups = \[[\s\S]*?\];/);
  expect(Boolean(navigationGroupTable), 'the shared UI must keep a navigation group table');
  expect(!navigationGroupTable[0].includes("'transfer'"), 'device transfer must not be a navigation destination');
  // Administration must stay a single destination: the accounts and consumption
  // surfaces are sections of the Management page, not their own nav entries.
  expect(/nav\.groupAdministration', \['settings'\]/.test(navigationGroupTable[0]), 'Administration must list only the Management page');
  expect(!navigationGroupTable[0].includes("'accounts'"), 'accounts must not be a navigation destination');
  const settingsView = read('src/shared-ui/views/settings.js');
  expect(/!desktopHost && owner/.test(settingsView), 'the transfer panel must render only for the web host and authenticated owner');

  expectAbsent('worker');
  expectAbsent('scripts/sync-worker-shared.js');
  expectAbsent('deploy');
  expect(exists('docs/hub-compose.md'), 'the canonical Docker Compose Hub guide must remain');
  expect(exists('docs/headless-agent.md'), 'the canonical headless agent guide must remain');
  expect(exists('scripts/package-headless.js'), 'the headless package script must remain');
  expect(exists('docker-compose.yml'), 'the root Docker Compose file must remain the only Hub distribution entry point');
  expect(exists('Dockerfile'), 'the Hub Dockerfile must remain');
  expect(exists('docker-entrypoint.sh'), 'the Hub Docker entrypoint must remain');
  expect(exists('migrations/run.js'), 'the Hub migration runner must remain');

  const composePackager = read('scripts/package-hub-compose.js');
  expect(composePackager.includes("['docker-compose.yml', 'docker-compose.yml']"), 'Hub packaging must use the root docker-compose.yml');
  expect(composePackager.includes("['docs/hub-compose.md', 'README.md']"), 'Hub packaging must use the canonical Compose documentation');
  expect(!composePackager.includes('deploy/'), 'Hub packaging must not read the removed deploy directory');

  const releaseVersion = read('scripts/verify-release-version.js');
  expect(!releaseVersion.includes('worker/'), 'release version verification must not reference a removed Hub runtime');

  const ci = read('.github/workflows/ci.yml');
  const release = read('.github/workflows/release.yml');
  expect(release.includes('package:headless'), 'release workflow must package the headless agent');
  expect(release.includes('Jiran-Headless-*.tar.gz'), 'release workflow must publish the headless agent artifact');
  for (const [name, text] of [['CI', ci], ['release workflow', release]]) {
    expect(!text.includes('sync:worker'), `${name} must not invoke the removed secondary Hub sync path`);
    expect(!text.includes('worker/src'), `${name} must not verify a removed secondary Hub source tree`);
  }

  const registry = JSON.parse(read('src/shared/hubBuildRegistry.json'));
  expect(JSON.stringify(Object.keys(registry.components || {}).sort()) === JSON.stringify(['core', 'node-hub']), 'Hub build registry must contain only core and node-hub components');
  const identity = read('src/shared/hubBuildIdentity.js');
  expect(!identity.includes('cloudflare-worker'), 'Hub build identity must not recognize the removed runtime');

  const currentSurfaceFiles = [
    'README.md',
    'README.zh-CN.md',
    'docs/supported-tools.md',
    'docs/API.md',
    'docs/configuration.md',
    'docs/hub-compose.md',
    'docs/hermes-wsl-setup.md',
    'docs/privacy.md',
    'docs/wsl-sqlite-setup.md',
    'docs/wsl-sqlite-setup.zh-CN.md',
    'website/src/i18n/content.ts',
    'website/src/data/product.ts'
  ];
  const removedSurfaceTerms = [
    'npm run hub',
    'sync:worker',
    'Cloudflare Worker',
    'Worker hub',
    'Host mode',
    'in-widget hub',
    'Node CLI hub',
    'worker/README',
    'deploy/docker-compose'
  ];
  for (const file of currentSurfaceFiles) {
    const text = read(file).toLowerCase();
    for (const term of removedSurfaceTerms) {
      expect(!text.includes(term.toLowerCase()), `${file} must not advertise removed product surface: ${term}`);
    }
  }

  const browserUserAgentTest = read('tests/shared/browserUserAgent.test.js');
  expect(!browserUserAgentTest.includes("path.join(root, 'worker', 'src')"), 'tests must not retain the removed Worker source tree');

  console.log('Product scope verified: Electron local/client modes; Docker Compose Hub only; headless agent retained.');
}

if (require.main === module) {
  try {
    verifyProductScope();
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
  }
}

module.exports = { verifyProductScope };
