'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  adHocSignMacApp,
  hasConfiguredMacSigning,
  hasKeychainSigningIdentity,
  resolveMacAppBundlePath
} = require('../../scripts/macos-adhoc-sign');
const builderConfig = require('../../scripts/electron-builder.config');

test('hasKeychainSigningIdentity parses security find-identity output conservatively', () => {
  assert.equal(
    hasKeychainSigningIdentity(() => '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Developer ID Application: Example"\n     1 valid identities found\n'),
    true
  );
  assert.equal(
    hasKeychainSigningIdentity(() => '     0 valid identities found\n'),
    false
  );
  assert.equal(
    hasKeychainSigningIdentity(() => {
      throw new Error('security unavailable');
    }),
    false
  );
});

test('hasConfiguredMacSigning honors CSC env vars, auto-discovery opt-out, and keychain identities', () => {
  assert.equal(
    hasConfiguredMacSigning({ CSC_LINK: 'base64-cert' }, { platform: 'darwin', execFileSync: () => '' }),
    true
  );
  assert.equal(
    hasConfiguredMacSigning({ CSC_NAME: 'Developer ID Application' }, { platform: 'darwin', execFileSync: () => '' }),
    true
  );
  assert.equal(
    hasConfiguredMacSigning(
      { CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
      {
        platform: 'darwin',
        execFileSync: () => {
          throw new Error('should not query keychain when auto-discovery is disabled');
        }
      }
    ),
    false
  );
  assert.equal(
    hasConfiguredMacSigning({}, { platform: 'linux', execFileSync: () => '' }),
    false
  );
  assert.equal(
    hasConfiguredMacSigning({}, {
      platform: 'darwin',
      execFileSync: () => '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: Test"\n'
    }),
    true
  );
  assert.equal(
    hasConfiguredMacSigning({}, {
      platform: 'darwin',
      execFileSync: () => '     0 valid identities found\n'
    }),
    false
  );
});

test('resolveMacAppBundlePath resolves packager filename or falls back to appOutDir bundle', (t) => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiran-resolve-app-'));
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));

  assert.equal(resolveMacAppBundlePath(null), null);
  assert.equal(
    resolveMacAppBundlePath({
      appOutDir,
      packager: { appInfo: { productFilename: 'CustomName' } }
    }),
    path.join(appOutDir, 'CustomName.app')
  );

  const customBundle = path.join(appOutDir, 'SingleBundle.app');
  fs.mkdirSync(customBundle);
  assert.equal(
    resolveMacAppBundlePath({ appOutDir }),
    customBundle
  );
});

test('adHocSignMacApp skips non-darwin targets, non-darwin hosts, and configured signing', () => {
  const failExec = () => {
    throw new Error('codesign must not run');
  };

  assert.deepEqual(
    adHocSignMacApp({ appOutDir: '/tmp/out', electronPlatformName: 'linux' }, { platform: 'darwin', execFileSync: failExec }),
    { signed: false, reason: 'non-darwin-target' }
  );
  assert.deepEqual(
    adHocSignMacApp({ appOutDir: '/tmp/out', electronPlatformName: 'mas' }, { platform: 'darwin', execFileSync: failExec }),
    { signed: false, reason: 'non-darwin-target' }
  );
  assert.deepEqual(
    adHocSignMacApp({ appOutDir: '/tmp/out', electronPlatformName: 'darwin' }, { platform: 'linux', execFileSync: failExec }),
    { signed: false, reason: 'non-darwin-host' }
  );
  assert.deepEqual(
    adHocSignMacApp(
      { appOutDir: '/tmp/out', electronPlatformName: 'darwin' },
      { platform: 'darwin', env: { CSC_LINK: 'cert-data' }, execFileSync: failExec }
    ),
    { signed: false, reason: 'signing-configured' }
  );
});

test('adHocSignMacApp fails if the expected macOS app bundle is missing', (t) => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiran-missing-app-'));
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));

  assert.throws(
    () => adHocSignMacApp(
      {
        appOutDir,
        electronPlatformName: 'darwin',
        packager: { appInfo: { productFilename: 'Jiran' } }
      },
      {
        platform: 'darwin',
        env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
        execFileSync: () => ''
      }
    ),
    /macOS app bundle not found/
  );
});

test('adHocSignMacApp signs and strictly verifies the macOS bundle when no credentials are set', (t) => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiran-adhoc-mock-'));
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));

  const appPath = path.join(appOutDir, 'Jiran.app');
  fs.mkdirSync(appPath);

  const calls = [];
  const logs = [];
  const result = adHocSignMacApp(
    {
      appOutDir,
      electronPlatformName: 'darwin',
      packager: { appInfo: { productFilename: 'Jiran' } }
    },
    {
      platform: 'darwin',
      env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
      execFileSync: (cmd, args) => calls.push([cmd, args]),
      log: (msg) => logs.push(msg)
    }
  );

  assert.deepEqual(result, { signed: true, appPath });
  assert.deepEqual(calls, [
    ['codesign', ['--force', '--deep', '--sign', '-', appPath]],
    ['codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]]
  ]);
  assert.deepEqual(logs, ['[electron-builder] ad-hoc signed Jiran.app']);
});

test(
  'electron-builder afterPack produces a valid ad-hoc signature with bundle identifier on macOS',
  { skip: process.platform !== 'darwin' ? 'requires macOS codesign toolchain' : false },
  async (t) => {
    const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiran-adhoc-real-'));
    t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));

    const appPath = path.join(appOutDir, 'Jiran.app');
    const contentsDir = path.join(appPath, 'Contents');
    const macOsDir = path.join(contentsDir, 'MacOS');
    fs.mkdirSync(macOsDir, { recursive: true });
    fs.copyFileSync('/usr/bin/true', path.join(macOsDir, 'Jiran'));
    fs.chmodSync(path.join(macOsDir, 'Jiran'), 0o755);
    fs.writeFileSync(
      path.join(contentsDir, 'Info.plist'),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '  <key>CFBundleExecutable</key>',
        '  <string>Jiran</string>',
        '  <key>CFBundleIdentifier</key>',
        '  <string>com.igng.tokenmonitor</string>',
        '  <key>CFBundlePackageType</key>',
        '  <string>APPL</string>',
        '  <key>CFBundleVersion</key>',
        '  <string>1.0.0</string>',
        '</dict>',
        '</plist>'
      ].join('\n')
    );

    const prevCscLink = process.env.CSC_LINK;
    const prevCscName = process.env.CSC_NAME;
    const prevAutoDiscovery = process.env.CSC_IDENTITY_AUTO_DISCOVERY;
    delete process.env.CSC_LINK;
    delete process.env.CSC_NAME;
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

    try {
      await builderConfig.afterPack({
        appOutDir,
        electronPlatformName: 'darwin',
        packager: { appInfo: { productFilename: 'Jiran' } }
      });
    } finally {
      if (prevCscLink === undefined) delete process.env.CSC_LINK;
      else process.env.CSC_LINK = prevCscLink;
      if (prevCscName === undefined) delete process.env.CSC_NAME;
      else process.env.CSC_NAME = prevCscName;
      if (prevAutoDiscovery === undefined) delete process.env.CSC_IDENTITY_AUTO_DISCOVERY;
      else process.env.CSC_IDENTITY_AUTO_DISCOVERY = prevAutoDiscovery;
    }

    execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'pipe' });
    const inspected = spawnSync('codesign', ['-dvv', appPath], { encoding: 'utf8' });
    assert.equal(inspected.status, 0);
    const details = `${inspected.stdout || ''}\n${inspected.stderr || ''}`;
    assert.match(details, /^Signature=adhoc$/m);
    assert.match(details, /^Identifier=com\.igng\.tokenmonitor$/m);
  }
);

test('release workflow verifies macOS code signature even when notarization secrets are absent', () => {
  const workflowPath = path.join(__dirname, '..', '..', '.github', 'workflows', 'release.yml');
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const start = workflow.indexOf('- name: Verify mac code signing and notarization');
  assert.ok(start >= 0, 'Verify mac code signing and notarization step must exist');
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n\s{6}- (?:name|uses|run):|\n\s{6}# Sign the/);
  const step = next >= 0 ? rest.slice(0, next) : rest;

  const verifyIndex = step.indexOf('codesign --verify --deep --strict --verbose=2 "$app_path"');
  const skipNotarizeIndex = step.indexOf('if [ -z "$MAC_CSC_LINK" ] || [ -z "$APPLE_API_KEY_ID" ]; then');
  assert.ok(verifyIndex >= 0, 'step must verify bundle signature with codesign --verify');
  assert.ok(skipNotarizeIndex >= 0, 'step must only skip notarization when credentials are absent');
  assert.ok(
    verifyIndex < skipNotarizeIndex,
    'codesign --verify must run before the notarization-skip guard so unsigned/unsealed builds fail CI'
  );
  assert.match(step, /Signature=adhoc/);
});
