#!/usr/bin/env node
'use strict';

// Enforce the shared UI's host neutrality.
//
// src/shared-ui/ runs in two very different hosts: the Hub's browser dashboard
// and the Electron renderer. If a view reaches for a browser global or an
// Electron bridge directly, the other host breaks in a way that only shows up
// at runtime — a missing `localStorage`, a `file://` fetch that cannot resolve,
// or an IPC call in a page that has no preload. Routing every one of those
// through transport/ is what keeps one implementation viable in both, so it is
// worth a guard rather than a code-review convention.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SHARED_UI = path.join(ROOT, 'src', 'shared-ui');

// The transport layer is exactly where host access belongs — it is the seam.
// Its facade (transport/index.js) also carries browser fallbacks for hosts that
// do not override a method, so it is exempt alongside the two implementations.
// The boot modules live outside this tree by design.
const ALLOWED_HOST_ACCESS = new Set([
  // Byte-identical upstream component runtime; app code still uses transport.
  path.join('vendor', 'fluent.js'),
  path.join('transport', 'index.js'),
  path.join('transport', 'httpTransport.js'),
  path.join('transport', 'ipcTransport.js'),
  path.join('transport', 'clipboard.js')
]);

const FORBIDDEN = [
  { pattern: /\blocalStorage\b|\bsessionStorage\b/, why: 'use transport prefs/flags so the desktop host can persist to settings.json' },
  { pattern: /\bwindow\.tokenMonitor\b/, why: 'the IPC bridge belongs in transport/ipcTransport.js' },
  { pattern: /\bipcRenderer\b|\bcontextBridge\b/, why: 'the shared UI must not import Electron' },
  { pattern: /history\.(?:push|replace)State/, why: 'use the transport routing capability; file:// has no SPA fallback' },
  { pattern: /navigator\.clipboard/, why: 'use transport copyText()' },
  { pattern: /\bwindow\.confirm\b|\bwindow\.prompt\b/, why: 'use transport confirmAction()/promptAction()' },
  { pattern: /\bwindow\.open\(/, why: 'use transport openExternal()' }
];

// A bare `fetch(` is only legitimate in the HTTP transport. View code must go
// through transport.request().
const FETCH_ALLOWED = new Set([path.join('transport', 'httpTransport.js')]);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function verifySharedUiBoundary() {
  const violations = [];
  for (const file of walk(SHARED_UI)) {
    const relative = path.relative(SHARED_UI, file);
    if (ALLOWED_HOST_ACCESS.has(relative)) continue;
    const source = stripComments(fs.readFileSync(file, 'utf8'));
    const display = path.join('src', 'shared-ui', relative);

    for (const { pattern, why } of FORBIDDEN) {
      const match = source.match(pattern);
      if (match) {
        violations.push(`${display}: uses ${match[0]} — ${why}`);
      }
    }
    if (!FETCH_ALLOWED.has(relative)) {
      const fetchMatch = source.match(/(^|[^.\w])fetch\s*\(/);
      if (fetchMatch) {
        violations.push(`${display}: calls fetch() directly — use transport.request()`);
      }
    }
  }
  return violations;
}

if (require.main === module) {
  try {
    const violations = verifySharedUiBoundary();
    if (violations.length > 0) {
      console.error('Shared UI boundary violations:\n' + violations.map((v) => `  - ${v}`).join('\n'));
      process.exitCode = 1;
    } else {
      console.log('Shared UI boundary verified: no direct host access outside transport/.');
    }
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
  }
}

module.exports = { verifySharedUiBoundary };
