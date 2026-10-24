'use strict';

const crypto = require('node:crypto');
const { fetchBufferedWithTimeout } = require('../shared/http');
const { createOutboundFetch } = require('../shared/outboundFetch');
const { decodeJwtPayload } = require('../shared/codexAuth');

// Official OpenAI Codex CLI OAuth Client ID
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';

// Antigravity CLI uses Google's installed-app OAuth flow. The callback is a
// hosted page that displays the authorization code for the user to copy, so the
// Hub accepts either that bare code or a full callback URL and binds it to this
// server-side PKCE session.
const AGY_OAUTH_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
// Google requires the installed-app client secret on both the authorization-code
// and refresh-token grants, even with PKCE. It ships with the public Antigravity
// CLI and is not a confidential secret, so it is pinned here next to the client
// id. Set AGY_OAUTH_CLIENT_SECRET to override it if Google ever rotates it.
const AGY_OAUTH_CLIENT_SECRET = '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';
const AGY_AUTH_URL = 'https://accounts.google.com/o/oauth2/auth';
const AGY_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AGY_REDIRECT_URI = 'https://antigravity.google/oauth-callback';
const AGY_SCOPE = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
  'openid'
].join(' ');

const CODEX_CALLBACK_ORIGINS = new Set(['http://localhost:1455', 'http://127.0.0.1:1455']);
const AGY_CALLBACK_ORIGINS = new Set(['https://antigravity.google']);

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_REDIRECT_URL_LENGTH = 16 * 1024;
const MAX_AUTHORIZATION_CODE_LENGTH = 2048;
const AUTHORIZATION_INPUT_HINT = 'Paste the authorization code shown on the provider page (a Google code looks like 4/0A...), or the full redirected callback URL.';

// Google authorization codes look like `4/0AX4XfWh...`; when the user copies the
// whole page excerpt instead of using the copy button, extract the code from it.
const AUTHORIZATION_CODE_PATTERN = /^[A-Za-z0-9._~+/=-]{8,}$/;
const EMBEDDED_GOOGLE_CODE_PATTERN = /4\/[A-Za-z0-9._~+/-]{20,}/;

function base64UrlEncode(buffer) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generatePkce() {
  const verifier = base64UrlEncode(crypto.randomBytes(32));
  const challenge = base64UrlEncode(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function oauthError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function tokenExpiry(tokens, nowMs = Date.now()) {
  const expiresIn = Number(tokens?.expires_in ?? tokens?.expiresIn);
  if (Number.isFinite(expiresIn) && expiresIn > 0) return nowMs + expiresIn * 1000;
  const expiresAt = Number(tokens?.expires_at ?? tokens?.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > 0) return expiresAt < 20_000_000_000 ? expiresAt * 1000 : expiresAt;
  return null;
}

function validateTokenResponse(tokens, provider, nowMs = Date.now()) {
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
    throw oauthError('token_response_invalid', `${provider} token response is invalid`);
  }
  const accessToken = String(tokens.access_token || tokens.accessToken || '').trim();
  if (!accessToken) throw oauthError('token_response_invalid', `${provider} token response has no access token`);
  return {
    accessToken,
    refreshToken: String(tokens.refresh_token || tokens.refreshToken || '').trim(),
    idToken: String(tokens.id_token || tokens.idToken || '').trim(),
    expiresAt: tokenExpiry(tokens, nowMs),
    raw: tokens
  };
}

function oauthProviderConfig(provider, env) {
  if (provider === 'codex') {
    return { clientId: CODEX_OAUTH_CLIENT_ID, clientSecret: '', tokenUrl: CODEX_TOKEN_URL, label: 'OpenAI' };
  }
  if (provider === 'antigravity') {
    return {
      clientId: AGY_OAUTH_CLIENT_ID,
      clientSecret: String(env?.AGY_OAUTH_CLIENT_SECRET || '').trim() || AGY_OAUTH_CLIENT_SECRET,
      tokenUrl: AGY_TOKEN_URL,
      label: 'Google'
    };
  }
  throw oauthError('provider_unsupported', `Unsupported OAuth provider: ${provider}`);
}

async function refreshOAuthToken(provider, refreshToken, deps = {}) {
  const token = String(refreshToken || '').trim();
  if (!token) throw oauthError('refresh_token_missing', `${provider} refresh token is missing`);
  const config = oauthProviderConfig(provider, deps.env || process.env);
  const fetchFn = deps.fetch || createOutboundFetch(deps.env || process.env, deps);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.clientId,
    refresh_token: token,
    ...(config.clientSecret ? { client_secret: config.clientSecret } : {})
  }).toString();
  let res;
  try {
    res = await fetchBufferedWithTimeout(fetchFn, config.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json'
      },
      body,
      signal: deps.signal
    }, 15000);
  } catch (error) {
    throw oauthError('refresh_network_error', `${config.label} token refresh network failed: ${error.message}`);
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const json = await res.json();
      message = json.error_description || json.error || message;
    } catch (_) {}
    throw oauthError('refresh_failed', `${config.label} token refresh failed: ${message}`);
  }
  return validateTokenResponse(await res.json(), config.label, deps.now ? deps.now() : Date.now());
}

function credentialWithOAuthTokens(provider, credential, tokens) {
  const next = {
    ...(credential && typeof credential === 'object' ? credential : {}),
    source: 'oauth',
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
    ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {})
  };
  if (provider !== 'codex') return next;

  let authJson = credential?.authJson;
  if (typeof authJson === 'string') {
    try { authJson = JSON.parse(authJson); } catch (_) { authJson = null; }
  }
  const auth = authJson && typeof authJson === 'object' && !Array.isArray(authJson)
    ? { ...authJson }
    : {};
  const oldTokens = auth.tokens && typeof auth.tokens === 'object' && !Array.isArray(auth.tokens)
    ? { ...auth.tokens }
    : {};
  auth.tokens = {
    ...oldTokens,
    access_token: tokens.accessToken,
    ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
    ...(tokens.idToken ? { id_token: tokens.idToken } : {}),
    ...(tokens.expiresAt ? { expires_at: tokens.expiresAt } : {})
  };
  next.authJson = auth;
  return next;
}

async function refreshOAuthCredential(provider, credential, deps = {}) {
  let authJson = credential?.authJson;
  if (typeof authJson === 'string') {
    try { authJson = JSON.parse(authJson); } catch (_) { authJson = null; }
  }
  const refreshToken = credential?.refreshToken || credential?.refresh_token
    || credential?.tokens?.refresh_token || authJson?.tokens?.refresh_token || authJson?.tokens?.refreshToken;
  const tokens = await refreshOAuthToken(provider, refreshToken, deps);
  return { credential: credentialWithOAuthTokens(provider, credential, tokens), tokens };
}

function createOAuthSessionManager({ now = Date.now, ttlMs = SESSION_TTL_MS } = {}) {
  const sessions = new Map();

  function cleanup() {
    const current = now();
    for (const [id, session] of sessions.entries()) {
      if (current - session.createdAt > ttlMs) {
        sessions.delete(id);
      }
    }
  }

  function startSession(provider) {
    cleanup();
    const sessionId = crypto.randomUUID();
    const state = base64UrlEncode(crypto.randomBytes(24));
    const { verifier, challenge } = generatePkce();

    let authUrl;
    if (provider === 'codex') {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: CODEX_OAUTH_CLIENT_ID,
        redirect_uri: CODEX_REDIRECT_URI,
        scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
        state,
        originator: 'codex_cli_rs'
      });
      authUrl = `${CODEX_AUTH_URL}?${params.toString()}`;
    } else if (provider === 'antigravity') {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: AGY_OAUTH_CLIENT_ID,
        redirect_uri: AGY_REDIRECT_URI,
        scope: AGY_SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state
      });
      authUrl = `${AGY_AUTH_URL}?${params.toString()}`;
    } else {
      const err = new Error(`Unsupported OAuth provider: ${provider}`);
      err.code = 'provider_unsupported';
      throw err;
    }

    sessions.set(sessionId, {
      id: sessionId,
      provider,
      verifier,
      state,
      createdAt: now()
    });

    return { sessionId, authUrl, provider };
  }

  // OAuth providers hand the user one of three shapes, and all three must work:
  //   1. a full callback URL (Codex's localhost callback, a hosted callback page),
  //   2. a schemeless URL or bare query string (`...?code=...&state=...`),
  //   3. a bare authorization code (Google's Antigravity flow shows the code on
  //      the page with a copy button and never puts it in the address bar).
  function normalizeAuthorizationInput(value) {
    return String(value || '')
      .trim()
      .replace(/^[`'"]+/, '')
      .replace(/[`'"]+$/, '')
      .replace(/[\s\u200b]+/g, ' ')
      .replace(/[.,;:。，；：]+$/, '')
      .trim();
  }

  function queryStringParams(text) {
    const cuts = [text.indexOf('?'), text.indexOf('#')].filter((index) => index >= 0);
    const start = cuts.length > 0 ? Math.min(...cuts) + 1 : 0;
    return new URLSearchParams(text.slice(start).replace(/&amp;/g, '&'));
  }

  function authorizationCodeFromText(text) {
    if (text.length <= MAX_AUTHORIZATION_CODE_LENGTH && AUTHORIZATION_CODE_PATTERN.test(text)) return text;
    const embedded = text.match(EMBEDDED_GOOGLE_CODE_PATTERN);
    return embedded ? embedded[0] : '';
  }

  function parseRedirectUrl(rawUrl, expectedState = '') {
    const raw = normalizeAuthorizationInput(rawUrl);
    if (!raw || raw.length > MAX_REDIRECT_URL_LENGTH) {
      throw oauthError('invalid_redirect_url', 'Invalid redirect URL');
    }

    let source = 'code';
    let parsed = null;
    let params;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      try {
        parsed = new URL(raw);
      } catch (_) {
        throw oauthError('invalid_redirect_url', 'Invalid redirect URL');
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw oauthError('invalid_redirect_url', 'OAuth callback must use HTTP or HTTPS');
      }
      params = parsed.searchParams;
      source = 'url';
    } else if (/(^|[?&#])code=/.test(raw)) {
      // Schemeless callback URL or a query string copied from the address bar.
      params = queryStringParams(raw);
      source = 'query';
    } else {
      const code = authorizationCodeFromText(raw);
      if (!code) throw oauthError('invalid_redirect_url', AUTHORIZATION_INPUT_HINT);
      params = new URLSearchParams({ code });
    }

    // Query params or Hash params (full callback URLs may carry either).
    let hashParams = new URLSearchParams();
    if (parsed && parsed.hash && parsed.hash.length > 1) {
      hashParams = new URLSearchParams(parsed.hash.slice(1));
    }
    const readParam = (key) => params.get(key) || hashParams.get(key) || '';

    const code = readParam('code').trim();
    const state = readParam('state').trim();
    const accessToken = readParam('access_token').trim();
    const apiKey = readParam('api_key').trim();
    const token = readParam('token').trim();
    const error = readParam('error').trim();
    const errorDescription = readParam('error_description').trim();

    if (error) {
      const err = new Error(errorDescription || `OAuth authorization failed: ${error}`);
      err.code = 'oauth_error';
      throw err;
    }

    // A URL pasted without any credential is almost always the provider's own
    // page (e.g. Google's approval page) instead of a callback: say so directly
    // instead of reporting a misleading state mismatch.
    if (source === 'url' && !code && !accessToken && !apiKey && !token && !state) {
      throw oauthError('code_missing', AUTHORIZATION_INPUT_HINT);
    }

    if (expectedState) {
      // A full callback URL must round-trip the state we issued. A pasted code
      // (or a query string without one) cannot: Google's copy-code page does not
      // echo the state, so those inputs are bound to this session by its PKCE
      // verifier and the code's single use instead — the same tradeoff gcloud
      // and the Gemini CLI make. A state that is present must still match.
      const stateRequired = source === 'url';
      if (state !== expectedState && (stateRequired || state)) {
        throw oauthError('oauth_state_mismatch', 'OAuth state mismatch. Session may have expired or was tampered.');
      }
    }

    return {
      code,
      state,
      origin: parsed ? parsed.origin : '',
      queryOnly: source !== 'url',
      source,
      accessToken,
      apiKey: apiKey || token,
      refreshToken: readParam('refresh_token'),
      idToken: readParam('id_token'),
      expiresIn: readParam('expires_in')
    };
  }

  async function exchangeCodexToken(code, verifier, deps = {}) {
    const fetchFn = deps.fetch || createOutboundFetch(deps.env || process.env, deps);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CODEX_OAUTH_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: CODEX_REDIRECT_URI
    }).toString();

    let res;
    try {
      res = await fetchBufferedWithTimeout(fetchFn, CODEX_TOKEN_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json'
        },
        body
      }, 15000);
    } catch (err) {
      const error = new Error(`OpenAI token exchange network failed: ${err.message}`);
      error.code = 'exchange_network_error';
      throw error;
    }

    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const json = await res.json();
        message = json.error_description || json.error || message;
      } catch (_) {}
      const error = new Error(`Token exchange failed: ${message}`);
      error.code = 'exchange_failed';
      throw error;
    }

    return validateTokenResponse(await res.json(), 'OpenAI', now());
  }

  async function exchangeAntigravityToken(code, verifier, deps = {}) {
    const env = deps.env || process.env;
    const fetchFn = deps.fetch || createOutboundFetch(env, deps);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: AGY_OAUTH_CLIENT_ID,
      client_secret: oauthProviderConfig('antigravity', env).clientSecret,
      code,
      code_verifier: verifier,
      redirect_uri: AGY_REDIRECT_URI
    }).toString();
    let res;
    try {
      res = await fetchBufferedWithTimeout(fetchFn, AGY_TOKEN_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json'
        },
        body
      }, 15000);
    } catch (err) {
      throw oauthError('exchange_network_error', `Google token exchange network failed: ${err.message}`);
    }
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const json = await res.json();
        message = json.error_description || json.error || message;
      } catch (_) {}
      throw oauthError('exchange_failed', `Google token exchange failed: ${message}`);
    }
    return validateTokenResponse(await res.json(), 'Google', now());
  }

  async function exchangeSession(sessionId, redirectUrl, deps = {}) {
    cleanup();
    const session = sessions.get(sessionId);
    if (!session) {
      const error = new Error('OAuth session not found or has expired. Please restart authorization.');
      error.code = 'session_expired';
      throw error;
    }

    const parsed = parseRedirectUrl(redirectUrl, session.state);
    const allowedOrigins = session.provider === 'codex' ? CODEX_CALLBACK_ORIGINS : AGY_CALLBACK_ORIGINS;
    if (!parsed.queryOnly && !allowedOrigins.has(parsed.origin)) {
      throw oauthError('oauth_redirect_mismatch', 'OAuth callback URL does not match the selected provider.');
    }

    if (session.provider === 'codex') {
      if (!parsed.code && !parsed.accessToken) {
        const error = new Error(AUTHORIZATION_INPUT_HINT);
        error.code = 'code_missing';
        throw error;
      }
      if (parsed.accessToken) {
        sessions.delete(sessionId);
        return {
          provider: 'codex',
          credential: { accessToken: parsed.accessToken, source: 'oauth' }
        };
      }
      const tokens = await exchangeCodexToken(parsed.code, session.verifier, deps);
      sessions.delete(sessionId);
      return {
        provider: 'codex',
        credential: {
          authJson: {
            tokens: {
              access_token: tokens.accessToken,
              ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
              ...(tokens.idToken ? { id_token: tokens.idToken } : {}),
              ...(tokens.raw.account_id ? { account_id: tokens.raw.account_id } : {}),
              ...(tokens.expiresAt ? { expires_at: tokens.expiresAt } : {})
            }
          },
          accessToken: tokens.accessToken,
          ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
          ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
          source: 'oauth'
        }
      };
    }

    if (session.provider === 'antigravity') {
      if (!parsed.code && !parsed.accessToken && !parsed.apiKey) {
        throw oauthError('code_missing', AUTHORIZATION_INPUT_HINT);
      }
      const tokens = parsed.code
        ? await exchangeAntigravityToken(parsed.code, session.verifier, deps)
        : {
            accessToken: parsed.apiKey || parsed.accessToken,
            refreshToken: parsed.refreshToken,
            idToken: parsed.idToken,
            expiresAt: tokenExpiry({ expires_in: parsed.expiresIn }, now())
          };
      sessions.delete(sessionId);
      let accountEmail = '';
      if (tokens.idToken) {
        const payload = decodeJwtPayload(tokens.idToken);
        accountEmail = String(payload?.email || '').trim().toLowerCase();
      }
      return {
        provider: 'antigravity',
        credential: {
          source: 'oauth',
          accessToken: tokens.accessToken,
          ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
          ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
          ...(accountEmail ? { accountEmail } : {}),
          ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {})
        }
      };
    }

    throw new Error(`Unsupported provider: ${session.provider}`);
  }

  return {
    startSession,
    parseRedirectUrl,
    parseAuthorizationInput: parseRedirectUrl,
    exchangeSession,
    _sessions: sessions
  };
}

module.exports = {
  createOAuthSessionManager,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_AUTH_URL,
  CODEX_TOKEN_URL,
  CODEX_REDIRECT_URI,
  AGY_AUTH_URL,
  AGY_OAUTH_CLIENT_ID,
  AGY_OAUTH_CLIENT_SECRET,
  AGY_TOKEN_URL,
  AGY_REDIRECT_URI,
  credentialWithOAuthTokens,
  refreshOAuthCredential,
  refreshOAuthToken
};
