'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream');
const { corsHeaders, responseTimingHeaders, negotiateEncoding } = require('../shared/http');

const BUILT_WEB_ROOT = path.join(__dirname, '../../dist/web');
const DEFAULT_WEB_ROOT = fs.existsSync(path.join(BUILT_WEB_ROOT, 'index.html')) ? BUILT_WEB_ROOT : path.join(__dirname, 'web');
// The dashboard's UI lives in a shared package so the Electron desktop client
// renders the exact same code. Only the shell, PWA assets and the boot module
// stay under src/hub/web; everything reusable is served from here.
const SHARED_UI_ROOT = path.join(__dirname, '..', 'shared-ui');

const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()'
});

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function contentTypeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function cacheControlFor(filePath, { revalidate = false } = {}) {
  if (/[/\\]assets[/\\][\w-]+-[A-Z0-9]{8}\.(js|css)$/.test(filePath)) return 'public, max-age=31536000, immutable';
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html' || ext === '.webmanifest' || path.basename(filePath) === 'sw.js') {
    return 'no-cache';
  }
  // The shared UI is deployed from the same source tree as the Hub and its
  // module URLs are intentionally stable. Revalidate those modules so a normal
  // HTTP browser cannot keep an older renderer after a Hub update; the service
  // worker still provides an explicit offline cache when available.
  if (revalidate && (ext === '.js' || ext === '.css')) return 'no-cache';
  if (ext === '.js' || ext === '.css' || ext === '.png' || ext === '.svg' || ext === '.webp' || ext === '.ico') {
    return 'public, max-age=3600';
  }
  return 'no-store';
}

/**
 * Decode + segment-walk the URL path. Any `..` that would climb above the
 * web root is rejected (null). path.posix.normalize alone is not enough:
 * `/../secret` normalizes to `/secret`, which would otherwise be served.
 */
function normalizeRequestPath(pathname) {
  let raw;
  try {
    raw = decodeURIComponent(String(pathname || '/'));
  } catch {
    return null;
  }
  if (!raw || raw.includes('\0')) return null;

  const parts = raw.split('/');
  const stack = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    // Windows drive / absolute segments must never appear in a URL path.
    if (part.includes('\\') || part.includes(':')) return null;
    stack.push(part);
  }
  return stack.length === 0 ? '/' : `/${stack.join('/')}`;
}

function resolveWebFile(webRoot, pathname) {
  const root = path.resolve(webRoot || DEFAULT_WEB_ROOT);
  const normalized = normalizeRequestPath(pathname);
  if (!normalized) return null;

  const relative = normalized === '/' ? 'index.html' : normalized.slice(1);
  const candidate = path.resolve(root, relative);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) return null;
  return candidate;
}

async function fileExists(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

async function resolveStaticAsset(webRoot, pathname) {
  const direct = resolveWebFile(webRoot, pathname);
  if (!direct) return null;

  const directStat = await fileExists(direct);
  if (directStat) return { filePath: direct, stat: directStat };

  // SPA-style directory indexes (e.g. /icons/ -> not used, but /foo/ works).
  if (!path.extname(direct)) {
    const indexPath = path.join(direct, 'index.html');
    const indexStat = await fileExists(indexPath);
    if (indexStat) return { filePath: indexPath, stat: indexStat };
  }

  // Client-side routes fall back to the shell for non-file GET navigation.
  if (!path.extname(pathname) || pathname === '/') {
    const shell = resolveWebFile(webRoot, '/index.html');
    const shellStat = shell ? await fileExists(shell) : null;
    if (shellStat) return { filePath: shell, stat: shellStat };
  }

  return null;
}

function sendFile(res, filePath, stat, { method = 'GET', revalidate = false } = {}) {
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  const compressible = /\.(?:html|js|css|json|svg|webmanifest)$/.test(filePath);
  const encoding = compressible && stat.size >= 1024 ? negotiateEncoding(res) : null;
  const headers = corsHeaders({
    ...SECURITY_HEADERS,
    ...responseTimingHeaders(res),
    'content-type': contentTypeFor(filePath),
    etag,
    vary: 'accept-encoding',
    ...(encoding ? { 'content-encoding': encoding } : { 'content-length': stat.size }),
    'cache-control': cacheControlFor(filePath, { revalidate })
  });

  if (path.basename(filePath) === 'sw.js') {
    headers['service-worker-allowed'] = '/';
  }

  const validators = String(res.req?.headers?.['if-none-match'] || '').split(',').map((value) => value.trim());
  if (validators.includes(etag) || validators.includes('*')) {
    delete headers['content-length'];
    res.writeHead(304, headers);
    res.end();
    return true;
  }

  if (method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return true;
  }

  res.writeHead(200, headers);
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(500, corsHeaders({
        ...SECURITY_HEADERS,
        'content-type': 'text/plain; charset=utf-8'
      }));
    }
    res.end();
  });
  if (encoding) {
    const compressor = encoding === 'br'
      ? zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })
      : zlib.createGzip();
    pipeline(stream, compressor, res, () => {});
  } else {
    pipeline(stream, res, () => {});
  }
  return true;
}

async function tryServeStatic(req, res, { webRoot = DEFAULT_WEB_ROOT } = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const host = req.headers?.host || 'localhost';
  const url = new URL(req.url || '/', `http://${host}`);
  if (url.pathname.startsWith('/api/')) return false;

  // /ui/* is the shared UI package (same files the Electron renderer loads).
  if (url.pathname === '/ui' || url.pathname.startsWith('/ui/')) {
    const rest = url.pathname.slice('/ui'.length) || '/';
    const asset = await resolveStaticAsset(SHARED_UI_ROOT, rest);
    if (asset) return sendFile(res, asset.filePath, asset.stat, { method: req.method, revalidate: true });
    return false;
  }

  // Client icons live in the shared package but keep their historical public
  // path so existing dashboards, cached HTML and the PWA manifest are unaffected.
  if (url.pathname.startsWith('/icons/clients/')) {
    const rest = url.pathname.slice('/icons/clients'.length);
    const asset = await resolveStaticAsset(path.join(SHARED_UI_ROOT, 'icons', 'clients'), rest);
    if (asset) return sendFile(res, asset.filePath, asset.stat, { method: req.method });
    return false;
  }

  let asset = await resolveStaticAsset(webRoot, url.pathname);
  // A tab with pre-bundle cached HTML still asks for the stable boot entry.
  // Keep that compatibility route alongside the hashed production graph.
  if (!asset && url.pathname === '/js/boot.js') {
    asset = await resolveStaticAsset(path.join(__dirname, 'web'), url.pathname);
  }
  if (!asset) return false;
  return sendFile(res, asset.filePath, asset.stat, {
    method: req.method,
    revalidate: url.pathname === '/js/boot.js'
  });
}

module.exports = {
  DEFAULT_WEB_ROOT,
  SHARED_UI_ROOT,
  MIME_TYPES,
  SECURITY_HEADERS,
  contentTypeFor,
  normalizeRequestPath,
  resolveWebFile,
  resolveStaticAsset,
  tryServeStatic
};
