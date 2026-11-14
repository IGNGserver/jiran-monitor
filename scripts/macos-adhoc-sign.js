'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CODESIGN_IDENTITY_LINE_RE = /^\s*\d+\)\s+[0-9A-Fa-f]{40}\s+"[^"]+"/;

function hasKeychainSigningIdentity(execFileSync = childProcess.execFileSync) {
  try {
    const output = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return CODESIGN_IDENTITY_LINE_RE.test(String(output || ''));
  } catch (_) {
    return false;
  }
}

function hasConfiguredMacSigning(env = process.env, {
  platform = process.platform,
  execFileSync = childProcess.execFileSync
} = {}) {
  if (String(env?.CSC_LINK || '').trim() || String(env?.CSC_NAME || '').trim()) {
    return true;
  }
  if (String(env?.CSC_IDENTITY_AUTO_DISCOVERY ?? '').trim().toLowerCase() === 'false') {
    return false;
  }
  if (platform !== 'darwin') {
    return false;
  }
  return hasKeychainSigningIdentity(execFileSync);
}

function resolveMacAppBundlePath(context, {
  defaultProductName = 'Jiran',
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync
} = {}) {
  const appOutDir = context?.appOutDir;
  if (!appOutDir) return null;

  const productFilename = context?.packager?.appInfo?.productFilename;
  if (productFilename) {
    return path.join(appOutDir, `${productFilename}.app`);
  }

  const preferred = path.join(appOutDir, `${defaultProductName}.app`);
  if (existsSync(preferred)) return preferred;

  try {
    const bundles = readdirSync(appOutDir).filter((entry) => entry.endsWith('.app'));
    if (bundles.length === 1) return path.join(appOutDir, bundles[0]);
  } catch (_) {
    // Fall back to preferred path so the caller's existence check reports clearly.
  }
  return preferred;
}

function adHocSignMacApp(context, {
  env = process.env,
  platform = process.platform,
  execFileSync = childProcess.execFileSync,
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync,
  log = console.log,
  defaultProductName = 'Jiran'
} = {}) {
  if (context?.electronPlatformName !== 'darwin') {
    return { signed: false, reason: 'non-darwin-target' };
  }
  if (platform !== 'darwin') {
    return { signed: false, reason: 'non-darwin-host' };
  }
  if (hasConfiguredMacSigning(env, { platform, execFileSync })) {
    return { signed: false, reason: 'signing-configured' };
  }

  const appPath = resolveMacAppBundlePath(context, { defaultProductName, existsSync, readdirSync });
  if (!appPath || !existsSync(appPath)) {
    throw new Error(`macOS app bundle not found for ad-hoc signing: ${appPath || '(missing appOutDir)'}`);
  }

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' });
  log(`[electron-builder] ad-hoc signed ${path.basename(appPath)}`);
  return { signed: true, appPath };
}

module.exports = {
  adHocSignMacApp,
  hasConfiguredMacSigning,
  hasKeychainSigningIdentity,
  resolveMacAppBundlePath
};
