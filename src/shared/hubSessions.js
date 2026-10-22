'use strict';

// Device sessions are deliberately separate from the operator's JIRAN_SECRET.
// A client stores an opaque, per-device token; the Hub stores only its hash, so
// a database dump cannot be replayed and revoking one device does not require
// rotating the owner secret (which also derives the account-encryption key).

const crypto = require('node:crypto');

const SESSION_TOKEN_PREFIX = 'jrs_';
const SESSION_COOKIE_NAME = 'jiran_session';
// RFC 6265bis' __Host- prefix requires Secure, Path=/ and no Domain. Browsers
// only accept it on HTTPS; plain-HTTP LAN hubs use the unprefixed name.
const SESSION_COOKIE_HOST_NAME = '__Host-jiran_session';
// Chrome caps persistent cookie expiry at 400 days. We issue this on login and
// renew it whenever the browser asks for its current session, so an actively
// used dashboard never reaches the cap.
const SESSION_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

function sessionTokenHash(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function sessionSecretFingerprint(secret) {
  return crypto.createHash('sha256')
    .update(`jiran-session:${String(secret || '')}`, 'utf8')
    .digest('hex');
}

function parseCookieHeader(value) {
  const cookies = Object.create(null);
  for (const part of String(value || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (!name || Object.hasOwn(cookies, name)) continue;
    const raw = part.slice(index + 1).trim();
    try {
      cookies[name] = decodeURIComponent(raw);
    } catch (_) {
      cookies[name] = raw;
    }
  }
  return cookies;
}

function requestHeader(request, name) {
  const headers = request?.headers;
  if (typeof headers?.get === 'function') return headers.get(name);
  return headers?.[name] ?? headers?.[name.toLowerCase()];
}

/** The raw session token carried by a request, or '' when there is none. */
function sessionTokenFromRequest(request) {
  const authorization = String(requestHeader(request, 'authorization') || '');
  if (authorization.toLowerCase().startsWith('bearer ')) {
    const token = authorization.slice(7).trim();
    if (token.startsWith(SESSION_TOKEN_PREFIX)) return token;
  }
  const explicit = String(requestHeader(request, 'x-jiran-session') || '').trim();
  if (explicit.startsWith(SESSION_TOKEN_PREFIX)) return explicit;
  const cookies = parseCookieHeader(requestHeader(request, 'cookie'));
  const value = cookies[SESSION_COOKIE_HOST_NAME] || cookies[SESSION_COOKIE_NAME] || '';
  return String(value).startsWith(SESSION_TOKEN_PREFIX) ? value : '';
}

function sessionCookieName({ secure = false } = {}) {
  return secure ? SESSION_COOKIE_HOST_NAME : SESSION_COOKIE_NAME;
}

/**
 * Build a Set-Cookie value. `remember` false omits Max-Age so the browser drops
 * it at the end of its session, matching the old "Remember on this device"
 * checkbox without putting the token anywhere script-readable.
 */
function createSessionCookie(token, { secure = false, remember = true } = {}) {
  const value = String(token || '').trim();
  if (!value) return '';
  const name = sessionCookieName({ secure });
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (secure) attributes.push('Secure');
  if (remember) attributes.push(`Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`);
  return attributes.join('; ');
}

function clearSessionCookie({ secure = false } = {}) {
  const name = sessionCookieName({ secure });
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? '; Secure' : ''}`;
}

/**
 * Logout should remove both possible names: a browser that used the HTTP LAN
 * URL earlier may still carry the unprefixed cookie beside the HTTPS
 * `__Host-` one. Node accepts an array for Set-Cookie.
 */
function clearSessionCookies({ secure = false } = {}) {
  const values = [clearSessionCookie({ secure: false })];
  if (secure) values.push(clearSessionCookie({ secure: true }));
  return values;
}

module.exports = {
  SESSION_COOKIE_HOST_NAME,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
  SESSION_TOKEN_PREFIX,
  clearSessionCookie,
  clearSessionCookies,
  createSessionCookie,
  parseCookieHeader,
  requestHeader,
  sessionCookieName,
  sessionSecretFingerprint,
  sessionTokenFromRequest,
  sessionTokenHash
};
