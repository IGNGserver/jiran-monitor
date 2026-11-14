'use strict';

// macOS "start at login". Electron's app.setLoginItemSettings uses SMAppService
// on macOS 13+, which neither honours `openAsHidden` nor passes `--hidden` to
// the launched binary. Managing a per-user LaunchAgent plist lets launchd pass
// `--hidden` at sign-in while normal Dock/Finder launches keep showing the UI.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LAUNCH_AGENT_LABEL = 'com.igng.tokenmonitor';
const PLIST_FILE_NAME = `${LAUNCH_AGENT_LABEL}.plist`;
const HIDDEN_LAUNCH_ARG = '--hidden';

function launchPath({ appPath = '' } = {}) {
  return String(appPath || '').trim();
}

function autostartSupported({ platform = process.platform, appPath = '' } = {}) {
  return platform === 'darwin' && Boolean(launchPath({ appPath }));
}

function plistFilePath({ env = process.env, homeDir = os.homedir() } = {}) {
  const home = String(env.HOME || homeDir || '').trim();
  return path.posix.join(home, 'Library', 'LaunchAgents', PLIST_FILE_NAME);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(value) {
  return String(value)
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function plistFileContents(executablePath, { hidden = false } = {}) {
  const args = [executablePath, ...(hidden ? [HIDDEN_LAUNCH_ARG] : [])];
  const argLines = args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCH_AGENT_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    argLines,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '</dict>',
    '</plist>',
    ''
  ].join('\n');
}

function parseProgramArguments(contents) {
  const blockMatch = contents.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!blockMatch) return null;
  const items = [];
  const stringRegex = /<string>([\s\S]*?)<\/string>/g;
  let match;
  while ((match = stringRegex.exec(blockMatch[1])) !== null) {
    items.push(unescapeXml(match[1]));
  }
  return items;
}

function readAutostartEntry(options = {}) {
  const env = options?.env || process.env;
  const homeDir = options?.homeDir || os.homedir();
  const appPath = launchPath({ appPath: options?.appPath });
  const disabled = { enabled: false, hidden: false, appPath: '' };
  if (!appPath) return disabled;
  try {
    const contents = fs.readFileSync(plistFilePath({ env, homeDir }), 'utf8');
    const labelMatch = contents.match(/<key>Label<\/key>\s*<string>([\s\S]*?)<\/string>/);
    if (!labelMatch || unescapeXml(labelMatch[1]).trim() !== LAUNCH_AGENT_LABEL) return disabled;
    if (!/<key>RunAtLoad<\/key>\s*<true\s*\/>/.test(contents)) return disabled;
    const args = parseProgramArguments(contents);
    if (!args || args[0] !== appPath) return disabled;
    const extraArgs = args.slice(1);
    if (extraArgs.length > 1 || (extraArgs.length === 1 && extraArgs[0] !== HIDDEN_LAUNCH_ARG)) {
      return disabled;
    }
    return {
      enabled: true,
      hidden: extraArgs[0] === HIDDEN_LAUNCH_ARG,
      appPath: args[0]
    };
  } catch (_) {
    return disabled;
  }
}

function isAutostartEnabled(options = {}) {
  const entry = readAutostartEntry(options);
  if (!entry.enabled) return false;
  if (options?.hidden !== undefined) return entry.hidden === Boolean(options.hidden);
  return true;
}

function setAutostartEnabled(enabled, options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const appPath = launchPath({ appPath: options.appPath });
  const filePath = plistFilePath({ env, homeDir });
  try {
    if (enabled) {
      if (!appPath) return false;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, plistFileContents(appPath, { hidden: Boolean(options.hidden) }), 'utf8');
    } else {
      fs.rmSync(filePath, { force: true });
    }
  } catch (_) { /* fall through to report the actual on-disk state */ }
  return isAutostartEnabled({ env, homeDir, appPath });
}

module.exports = {
  autostartSupported,
  plistFilePath,
  plistFileContents,
  readAutostartEntry,
  isAutostartEnabled,
  setAutostartEnabled,
  LAUNCH_AGENT_LABEL,
  PLIST_FILE_NAME,
  HIDDEN_LAUNCH_ARG
};
