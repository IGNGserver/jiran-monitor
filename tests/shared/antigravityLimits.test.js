'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { fetchAntigravityLimits } = require('../../src/shared/limitCollector');

const SUMMARY_URL = '/v1internal:retrieveUserQuotaSummary';
const CODE_ASSIST_URL = '/v1internal:loadCodeAssist';

function quotaSummaryPayload({ includeGemini = true, sessionRemaining = 0.4 } = {}) {
  const groups = [];
  if (includeGemini) {
    groups.push({
      displayName: 'Gemini Models',
      buckets: [
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.8, resetTime: '2026-09-19T00:00:00Z' },
        { bucketId: 'gemini-5h', window: '5h', remainingFraction: sessionRemaining, resetTime: '2026-09-12T05:00:00Z' }
      ]
    });
  }
  groups.push({
    displayName: 'Claude and GPT models',
    buckets: [
      { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.6, resetTime: '2026-09-19T00:00:00Z' }
    ]
  });
  return { groups };
}

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

function requestHost(url) {
  return new URL(String(url)).hostname;
}

test('fetchAntigravityLimits uses the OAuth cloud quota summary adapter', async () => {
  const requests = [];
  const result = (await fetchAntigravityLimits({
    antigravityAccessToken: 'agy-access-token',
    antigravityProjectId: 'project-1'
  }, {
    now: () => Date.parse('2026-09-12T00:00:00Z'),
    antigravityCloudBaseUrls: ['https://quota.example.test'],
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith(CODE_ASSIST_URL)) return jsonResponse({});
      return jsonResponse({ email: 'cloud@example.com', ...quotaSummaryPayload() });
    }
  }))[0];

  const summaryRequest = requests.find((request) => request.url.endsWith(SUMMARY_URL));
  assert.equal(summaryRequest.url, 'https://quota.example.test/v1internal:retrieveUserQuotaSummary');
  assert.equal(summaryRequest.init.method, 'POST');
  assert.equal(summaryRequest.init.headers.authorization, 'Bearer agy-access-token');
  // Cloud Code gates the quota endpoints on the Antigravity Hub client family.
  assert.match(summaryRequest.init.headers['user-agent'], /^antigravity\/hub\//);
  assert.deepEqual(JSON.parse(summaryRequest.init.body), { project: 'project-1' });
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'oauth');
  assert.equal(result.sourceDetail, 'managed');
  assert.equal(result.credentialOrigin, 'manual');
  assert.equal(result.accountEmail, 'cloud@example.com');
  assert.deepEqual(result.windows.map((window) => window.label), [
    'Gemini 5-hour', 'Gemini weekly', 'Claude/GPT weekly'
  ]);
  assert.equal(Math.round(result.windows[0].usedPercent), 60);
  assert.equal(result.windows[1].remainingPercent, 80);
});

test('fetchAntigravityLimits prefers production over the daily sandbox endpoint', async () => {
  const requests = [];
  const result = (await fetchAntigravityLimits({
    antigravityAccessToken: 'agy-access-token'
  }, {
    antigravityCloudBaseUrls: ['https://prod.example.test', 'https://sandbox.example.test'],
    fetch: async (url) => {
      requests.push(String(url));
      if (requestHost(url) === 'sandbox.example.test') {
        // The daily channel can serve a reduced summary (Claude/GPT only); a
        // non-empty response must not shadow the production answer.
        return jsonResponse({
          groups: [{
            displayName: 'Claude and GPT models',
            buckets: [{ bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1 }]
          }]
        });
      }
      if (String(url).endsWith(CODE_ASSIST_URL)) return jsonResponse({});
      return jsonResponse(quotaSummaryPayload());
    }
  }))[0];

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.windows.map((window) => window.label), [
    'Gemini 5-hour', 'Gemini weekly', 'Claude/GPT weekly'
  ]);
  assert.ok(requests.length > 0);
  assert.ok(requests.every((url) => requestHost(url) === 'prod.example.test'));
});

test('fetchAntigravityLimits falls back to the sandbox only when production fails', async () => {
  const requests = [];
  const result = (await fetchAntigravityLimits({
    antigravityAccessToken: 'agy-access-token'
  }, {
    antigravityCloudBaseUrls: ['https://prod.example.test', 'https://sandbox.example.test'],
    fetch: async (url) => {
      requests.push(String(url));
      if (requestHost(url) === 'prod.example.test') {
        throw new Error('network down');
      }
      if (String(url).endsWith(CODE_ASSIST_URL)) return jsonResponse({});
      return jsonResponse(quotaSummaryPayload());
    }
  }))[0];

  assert.equal(result.status, 'ok');
  assert.equal(requestHost(requests[0]), 'prod.example.test');
  assert.equal(requestHost(requests[1]), 'sandbox.example.test');
  assert.deepEqual(result.windows.map((window) => window.label), [
    'Gemini 5-hour', 'Gemini weekly', 'Claude/GPT weekly'
  ]);
});

test('fetchAntigravityLimits reads the account plan from loadCodeAssist with paidTier first', async () => {
  const result = (await fetchAntigravityLimits({
    antigravityAccessToken: 'agy-access-token'
  }, {
    antigravityCloudBaseUrls: ['https://quota.example.test'],
    fetch: async (url) => {
      if (String(url).endsWith(CODE_ASSIST_URL)) {
        // currentTier.id alone reports free-tier for paid Google AI accounts.
        return jsonResponse({
          currentTier: { id: 'free-tier', name: 'Antigravity' },
          paidTier: { id: 'g1-ultra-lite-tier', name: 'Google AI Ultra' }
        });
      }
      return jsonResponse(quotaSummaryPayload());
    }
  }))[0];

  assert.equal(result.planLabel, 'Ultra');
  assert.equal(result.accountLabel, 'Ultra');
});

test('fetchAntigravityLimits suppresses a Free plan label contradicted by a measured five-hour window', async () => {
  const freeTier = async (summary) => (await fetchAntigravityLimits({
    antigravityAccessToken: 'agy-access-token'
  }, {
    antigravityCloudBaseUrls: ['https://quota.example.test'],
    fetch: async (url) => {
      if (String(url).endsWith(CODE_ASSIST_URL)) {
        return jsonResponse({ currentTier: { id: 'free-tier', name: 'Antigravity' } });
      }
      return jsonResponse(summary);
    }
  }))[0];

  const withSession = await freeTier(quotaSummaryPayload());
  assert.equal(withSession.planLabel, '');
  assert.equal(withSession.accountLabel, '');

  const weeklyOnly = await freeTier({
    groups: [{
      displayName: 'Gemini Models',
      buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 1 }]
    }]
  });
  assert.equal(weeklyOnly.planLabel, 'Free');
});

test('fetchAntigravityLimits labels a hosted-domain free tier as Workspace', async () => {
  const payload = Buffer.from(JSON.stringify({ email: 'u@corp.example', hd: 'corp.example' })).toString('base64');
  const idToken = `header.${payload}.signature`;
  const result = (await fetchAntigravityLimits({
    antigravityAccessToken: 'agy-access-token',
    antigravityIdToken: idToken
  }, {
    antigravityCloudBaseUrls: ['https://quota.example.test'],
    fetch: async (url) => {
      if (String(url).endsWith(CODE_ASSIST_URL)) {
        return jsonResponse({ currentTier: { id: 'free-tier', name: 'Antigravity' } });
      }
      return jsonResponse({
        groups: [{
          displayName: 'Gemini Models',
          buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 1 }]
        }]
      });
    }
  }))[0];

  assert.equal(result.planLabel, 'Workspace');
});

test('fetchAntigravityLimits returns notConfigured when probe says LS not running', async () => {
  const result = await fetchAntigravityLimits({}, {
    antigravityProbe: async () => {
      const err = new Error('not running');
      err.status = 'notConfigured';
      throw err;
    }
  });
  assert.equal(result.provider, 'antigravity');
  assert.equal(result.status, 'notConfigured');
  assert.equal(result.windows.length, 0);
});

test('fetchAntigravityLimits returns ok with 3 weekly windows when probe succeeds', async () => {
  const result = await fetchAntigravityLimits({}, {
    antigravityProbe: async () => ({
      accountPlan: 'Pro',
      accountEmail: 'a@b.com',
      pools: [
        { name: 'Gemini Pro',   remainingFraction: 0.5, resetTime: '2026-06-03T02:00:00Z' },
        { name: 'Gemini Flash', remainingFraction: 0.9, resetTime: '2026-06-03T01:00:00Z' },
        { name: 'Claude',       remainingFraction: 0.7, resetTime: '2026-06-03T04:00:00Z' }
      ]
    })
  });
  assert.equal(result.provider, 'antigravity');
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'rpc');
  assert.equal(result.accountLabel, 'Pro');
  assert.deepEqual(result.windows.map((w) => w.label), ['Gemini Pro', 'Gemini Flash', 'Claude']);
  for (const window of result.windows) {
    assert.equal(window.kind, 'weekly');
    assert.equal(window.windowMinutes, null);
  }
  assert.equal(Math.round(result.windows[0].usedPercent), 50);
  assert.equal(Math.round(result.windows[1].usedPercent), 10);
  assert.equal(Math.round(result.windows[2].usedPercent), 30);
});

test('fetchAntigravityLimits maps unauthorized errors', async () => {
  const result = await fetchAntigravityLimits({}, {
    antigravityProbe: async () => {
      const err = new Error('401');
      err.status = 'unauthorized';
      throw err;
    }
  });
  assert.equal(result.status, 'unauthorized');
});

test('fetchAntigravityLimits extracts email from antigravityIdToken JWT', async () => {
  const payload = Buffer.from(JSON.stringify({ email: 'jwt-user@google.com' })).toString('base64');
  const mockIdToken = `header.${payload}.signature`;
  const result = (await fetchAntigravityLimits({
    antigravityAccessToken: 'agy-access-token',
    antigravityIdToken: mockIdToken
  }, {
    now: () => Date.parse('2026-09-12T00:00:00Z'),
    antigravityCloudBaseUrls: ['https://quota.example.test'],
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        response: {
          groups: [{
            displayName: 'Gemini',
            buckets: [{ bucketId: 'weekly', remainingFraction: 0.8, resetTime: '2026-09-19T00:00:00Z' }]
          }]
        }
      })
    })
  }))[0];

  assert.equal(result.status, 'ok');
  assert.equal(result.accountEmail, 'jwt-user@google.com');
});
