#!/usr/bin/env node
'use strict';

// Build a minimal deploy zip for GitHub Release assets:
//   Jiran-Hub-Compose-<version>.zip

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const versionArg = process.argv[2] || process.env.JIRAN_VERSION || process.env.TOKEN_MONITOR_VERSION || 'latest';
const version = String(versionArg).replace(/^v/, '');
const outDir = path.join(root, 'dist-hub-compose');
const stageDir = path.join(outDir, `jiran-hub-compose-${version}`);
const zipName = `Jiran-Hub-Compose-${version}.zip`;
const zipPath = path.join(outDir, zipName);

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

const files = [
  ['docker-compose.yml', 'docker-compose.yml'],
  ['docker-compose.external-db.yml', 'docker-compose.external-db.yml'],
  ['docs/hub-compose.md', 'README.md'],
  ['.env.example', '.env.example']
];

for (const [srcRel, destName] of files) {
  const src = path.join(root, srcRel);
  if (!fs.existsSync(src)) throw new Error(`missing ${srcRel}`);
  fs.copyFileSync(src, path.join(stageDir, destName));
}

function tryExec(cmd, args, opts = {}) {
  try {
    execFileSync(cmd, args, { stdio: 'inherit', ...opts });
    return true;
  } catch {
    return false;
  }
}

function zipDir(sourceDir, destZip) {
  const parent = path.dirname(sourceDir);
  const base = path.basename(sourceDir);

  // Prefer Info-ZIP on Linux CI runners.
  if (tryExec('zip', ['-r', destZip, base], { cwd: parent })) return;

  // Windows 10+ / modern macOS ship bsdtar, which can write zip via -a.
  if (tryExec('tar', ['-a', '-cf', destZip, '-C', parent, base])) return;

  // Last resort: PowerShell Compress-Archive (Windows only).
  const ps = [
    "$ErrorActionPreference='Stop'",
    "Import-Module Microsoft.PowerShell.Archive -ErrorAction SilentlyContinue",
    `Compress-Archive -LiteralPath '${sourceDir.replace(/'/g, "''")}' -DestinationPath '${destZip.replace(/'/g, "''")}' -Force`
  ].join('; ');
  if (tryExec('powershell', ['-NoProfile', '-Command', ps])) return;

  throw new Error(`failed to create zip at ${destZip} (tried zip, tar, Compress-Archive)`);
}

if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
zipDir(stageDir, zipPath);
if (!fs.existsSync(zipPath)) throw new Error(`failed to create ${zipPath}`);
console.log(zipPath);
