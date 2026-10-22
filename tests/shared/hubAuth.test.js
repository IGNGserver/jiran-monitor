'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  AUTHENTICATED_SCOPE,
  createHubAuthPolicy,
  ingestCredentialEntries,
  requestCredential,
  secretMatches
} = require('../../src/shared/hubAuth');

function request(secret, url = 'https://hub.example/api/stats') {
  return new Request(url, { headers: secret ? { authorization: `Bearer ${secret}` } : {} });
}

test('the single owner secret authenticates every Hub route', () => {
  const policy = createHubAuthPolicy({ ownerSecret: 'owner-secret' });
  const result = policy.authorize(request('owner-secret'), AUTHENTICATED_SCOPE);
  assert.deepEqual(result.principal, { id: 'owner', authenticated: true });
  assert.equal(policy.authorize(request('owner-secret'), AUTHENTICATED_SCOPE, { ingest: true }).ok, true);
  assert.equal(policy.authorize(request('wrong'), AUTHENTICATED_SCOPE).status, 401);
});

test('an unconfigured local Hub has an implicit local owner', () => {
  const policy = createHubAuthPolicy();
  assert.equal(policy.authorize(request(''), AUTHENTICATED_SCOPE).principal.authenticated, true);
  assert.equal(policy.summary.ownerConfigured, false);
});

test('query string secrets are rejected instead of assigned a weaker role', () => {
  const policy = createHubAuthPolicy({ ownerSecret: 'owner' });
  const result = policy.authorize(new Request('https://hub.example/api/stats?secret=owner'), AUTHENTICATED_SCOPE);
  assert.equal(result.status, 401);
  assert.equal(result.error, 'unauthorized');
});

test('legacy split configuration cannot create a second permission class', () => {
  const policy = createHubAuthPolicy({
    ownerSecret: 'owner',
    adminSecret: 'old-admin',
    viewerSecret: 'old-viewer',
    ingestCredentials: { laptop: 'old-device' }
  });
  assert.equal(policy.authorize(request('owner'), AUTHENTICATED_SCOPE).ok, true);
  assert.equal(policy.authorize(request('old-admin'), AUTHENTICATED_SCOPE).status, 401);
  assert.equal(policy.authorize(request('old-viewer'), AUTHENTICATED_SCOPE).status, 401);
  assert.equal(policy.authorize(request('old-device'), AUTHENTICATED_SCOPE).status, 401);
});

test('viewer/device-only configuration fails closed', () => {
  assert.throws(
    () => createHubAuthPolicy({ viewerSecret: 'viewer' }),
    (error) => error?.code === 'owner_secret_required'
  );
  assert.throws(
    () => createHubAuthPolicy({ ingestCredentials: { laptop: 'device' } }),
    (error) => error?.code === 'owner_secret_required'
  );
});

test('credential parsing and comparison remain defensive', () => {
  assert.deepEqual(ingestCredentialEntries('{"dev":"secret"}'), [{ deviceId: 'dev', secret: 'secret' }]);
  assert.throws(() => ingestCredentialEntries('{bad'), /valid JSON/);
  assert.equal(requestCredential(request('secret')).source, 'authorization');
  assert.equal(secretMatches('same', 'same'), true);
  assert.equal(secretMatches('same', 'different'), false);
});

test('device session tokens authenticate from a bearer header or the session cookie', () => {
  const seen = [];
  const policy = createHubAuthPolicy({
    ownerSecret: 'owner-secret',
    resolveSession: (token) => {
      seen.push(token);
      return token === 'jrs_device' ? { sessionId: 'session-1' } : null;
    }
  });
  const bearer = policy.authorize(request('jrs_device'), AUTHENTICATED_SCOPE);
  assert.equal(bearer.ok, true);
  assert.deepEqual(bearer.principal.session, { sessionId: 'session-1' });

  const cookie = new Request('https://hub.example/api/stats', {
    headers: { cookie: 'theme=dark; jiran_session=jrs_device' }
  });
  const cookieResult = policy.authorize(cookie, AUTHENTICATED_SCOPE);
  assert.equal(cookieResult.ok, true);
  assert.equal(cookieResult.principal.session.sessionId, 'session-1');
  assert.deepEqual(seen, ['jrs_device', 'jrs_device']);
});

test('a revoked or unknown session token falls back to the owner-secret check and fails', () => {
  const policy = createHubAuthPolicy({
    ownerSecret: 'owner-secret',
    resolveSession: () => null
  });
  const result = policy.authorize(request('jrs_revoked'), AUTHENTICATED_SCOPE);
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  // The owner secret remains a provisioning credential during migration.
  assert.equal(policy.authorize(request('owner-secret'), AUTHENTICATED_SCOPE).ok, true);
});
