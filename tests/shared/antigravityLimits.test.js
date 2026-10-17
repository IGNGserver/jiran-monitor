'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  fetchAntigravityLimits,
  ANTIGRAVITY_CLOUD_BASE_URLS,
  ANTIGRAVITY_CLOUD_USER_AGENT,
  ANTIGRAVITY_HUB_CLIENT_VERSION,
  ANTIGRAVITY_MIN_HUB_CLIENT_VERSION
} = require('../../src/shared/limitCollector');

const SUMMARY_URL = '/v1internal:retrieveUserQuotaSummary';
const MODEL_QUOTA_URL = '/v1internal:retrieveUserQuota';
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

test('the default host order puts the daily inference host first and production last', () => {
  // Production's Gemini counters went stale on 2026-10-17 while the daily host
  // kept metering real consumption; see ANTIGRAVITY_CLOUD_BASE_URLS.
  assert.deepEqual(ANTIGRAVITY_CLOUD_BASE_URLS, [
    'https://daily-cloudcode-pa.googleapis.com',
    'https://daily-cloudcode-pa.sandbox.googleapis.com',
    'https://cloudcode-pa.googleapis.com'
  ]);
});

test('the Cloud Code user agent is an Antigravity Hub identity at or above the model-gating floor', () => {
  const version = (value) => value.split('.').map(Number);
  const [major, minor, patch] = version(ANTIGRAVITY_HUB_CLIENT_VERSION);
  const [floorMajor, floorMinor, floorPatch] = version(ANTIGRAVITY_MIN_HUB_CLIENT_VERSION);
  // Cloud Code hides Gemini 4 Argon from clients below 2.23.0.
  assert.equal(ANTIGRAVITY_MIN_HUB_CLIENT_VERSION, '2.23.0');
  assert.ok(
    major > floorMajor
    || (major === floorMajor && (minor > floorMinor || (minor === floorMinor && patch >= floorPatch))),
    `${ANTIGRAVITY_HUB_CLIENT_VERSION} is below ${ANTIGRAVITY_MIN_HUB_CLIENT_VERSION}`
  );
  assert.match(ANTIGRAVITY_CLOUD_USER_AGENT, new RegExp(`^antigravity/hub/${ANTIGRAVITY_HUB_CLIENT_VERSION.replaceAll('.', '\\.')} (darwin|linux|windows)/(arm64|amd64)$`));
});

test('fetchAntigravityLimits does not let a summary without the Gemini group shadow a later host', async () => {
  const requests = [];
  const result = (await fetchAntigravityLimits({
    antigravityAccessToken: 'agy-access-token'
  }, {
    antigravityCloudBaseUrls: ['https://first.example.test', 'https://second.example.test'],
    fetch: async (url) => {
      requests.push(String(url));
      if (String(url).endsWith(CODE_ASSIST_URL)) return jsonResponse({});
      if (requestHost(url) === 'first.example.test') {
        return jsonResponse({
          groups: [{
            displayName: 'Claude and GPT models',
            buckets: [{ bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1 }]
          }]
        });
      }
      return jsonResponse(quotaSummaryPayload());
    }
  }))[0];

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.windows.map((window) => window.label), [
    'Gemini 5-hour', 'Gemini weekly', 'Claude/GPT weekly'
  ]);
  // Follow-up reads come from the host that answered the summary.
  assert.ok(requests.filter((url) => !url.endsWith(SUMMARY_URL))
    .every((url) => requestHost(url) === 'second.example.test'));
});

test('fetchAntigravityLimits keeps a partial summary when no host serves the Gemini group', async () => {
  const result = (await fetchAntigravityLimits({
    antigravityAccessToken: 'agy-access-token'
  }, {
    antigravityCloudBaseUrls: ['https://first.example.test', 'https://second.example.test'],
    fetch: async (url) => {
      if (String(url).endsWith(CODE_ASSIST_URL)) return jsonResponse({});
      if (requestHost(url) === 'second.example.test') throw new Error('network down');
      return jsonResponse(quotaSummaryPayload({ includeGemini: false }));
    }
  }))[0];

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.windows.map((window) => window.label), ['Claude/GPT weekly']);
});

test('fetchAntigravityLimits tries the next host after a 403 but stops on a 401', async () => {
  const hosts = ['https://first.example.test', 'https://second.example.test'];
  const run = async (status) => {
    const summaryHosts = [];
    const result = (await fetchAntigravityLimits({ antigravityAccessToken: 'agy-access-token' }, {
      antigravityCloudBaseUrls: hosts,
      fetch: async (url) => {
        if (String(url).endsWith(SUMMARY_URL)) summaryHosts.push(requestHost(url));
        if (requestHost(url) === 'first.example.test') return { ok: false, status, json: async () => ({}) };
        if (String(url).endsWith(CODE_ASSIST_URL)) return jsonResponse({});
        return jsonResponse(quotaSummaryPayload());
      }
    }))[0];
    return { result, summaryHosts };
  };

  const forbidden = await run(403);
  assert.equal(forbidden.result.status, 'ok');
  assert.deepEqual(forbidden.summaryHosts, ['first.example.test', 'second.example.test']);

  const unauthorized = await run(401);
  assert.equal(unauthorized.result.status, 'unauthorized');
  assert.deepEqual(unauthorized.summaryHosts, ['first.example.test']);
});

test('fetchAntigravityLimits falls back to the next host only when the first fails', async () => {
  const requests = [];
  const result = (await fetchAntigravityLimits({
    antigravityAccessToken: 'agy-access-token'
  }, {
    antigravityCloudBaseUrls: ['https://daily.example.test', 'https://prod.example.test'],
    fetch: async (url) => {
      requests.push(String(url));
      if (requestHost(url) === 'daily.example.test') {
        throw new Error('network down');
      }
      if (String(url).endsWith(CODE_ASSIST_URL)) return jsonResponse({});
      return jsonResponse(quotaSummaryPayload());
    }
  }))[0];

  assert.equal(result.status, 'ok');
  assert.equal(requestHost(requests[0]), 'daily.example.test');
  assert.equal(requestHost(requests[1]), 'prod.example.test');
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

  // Both Ultra plans are named "Google AI Ultra"; only the id names the lower one.
  assert.equal(result.planLabel, 'Ultra Lite');
  assert.equal(result.accountLabel, 'Ultra Lite');
});

test('fetchAntigravityLimits keeps the paid tier name when the tier id is not a known plan', async () => {
  const planFor = async (paidTier) => (await fetchAntigravityLimits({
    antigravityAccessToken: 'agy-access-token'
  }, {
    antigravityCloudBaseUrls: ['https://quota.example.test'],
    fetch: async (url) => {
      if (String(url).endsWith(CODE_ASSIST_URL)) {
        return jsonResponse({ currentTier: { id: 'free-tier', name: 'Antigravity' }, paidTier });
      }
      return jsonResponse(quotaSummaryPayload());
    }
  }))[0].planLabel;

  assert.equal(await planFor({ id: 'g1-pro-tier', name: 'Google AI Pro' }), 'Pro');
  assert.equal(await planFor({ id: 'g1-ultra-tier', name: 'Google AI Ultra' }), 'Ultra');
  assert.equal(await planFor({ id: 'G1-ULTRA-LITE-TIER', name: 'Google AI Ultra' }), 'Ultra Lite');
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

  // A disabled five-hour bucket (it stops applying once the weekly limit is
  // hit) measures nothing, so it must not contradict a Free tier.
  const disabledSession = await freeTier({
    groups: [{
      displayName: 'Gemini Models',
      buckets: [
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0 },
        { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1, disabled: true }
      ]
    }]
  });
  assert.equal(disabledSession.planLabel, 'Free');
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

// Shapes below are trimmed from a live Ultra (`g1-ultra-lite-tier`) answer of
// the daily host on 2026-10-17: Argon's per-model bucket equals the Gemini
// five-hour bucket, because Ultra draws Argon from the Gemini pool.
function ultraDailySummary() {
  return {
    groups: [
      {
        displayName: 'Gemini Models',
        description: 'Models within this group: Gemini Flash, Gemini Pro',
        buckets: [
          { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', resetTime: '2026-10-24T01:16:00Z', remainingFraction: 0.74201816 },
          { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', resetTime: '2026-10-17T16:16:00Z', remainingFraction: 0.7981962 }
        ]
      },
      {
        displayName: 'Claude and GPT models',
        description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
        buckets: [
          { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', resetTime: '2026-10-19T02:40:24Z', remainingFraction: 0.34724215 },
          { bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining', window: '5h', resetTime: '2026-10-17T19:17:00Z', remainingFraction: 1 }
        ]
      }
    ]
  };
}

async function fetchWithModelQuota(modelQuota, { summary = ultraDailySummary(), failModelQuota = false } = {}) {
  const requests = [];
  const result = (await fetchAntigravityLimits({ antigravityAccessToken: 'agy-access-token' }, {
    now: () => Date.parse('2026-10-17T14:17:00Z'),
    antigravityCloudBaseUrls: ['https://daily.example.test'],
    fetch: async (url) => {
      requests.push(String(url));
      if (String(url).endsWith(CODE_ASSIST_URL)) {
        return jsonResponse({ currentTier: { id: 'free-tier' }, paidTier: { id: 'g1-ultra-lite-tier', name: 'Google AI Ultra' } });
      }
      if (String(url).endsWith(MODEL_QUOTA_URL)) {
        if (failModelQuota) return { ok: false, status: 500, json: async () => ({}) };
        return jsonResponse(modelQuota);
      }
      return jsonResponse(summary);
    }
  }))[0];
  return { result, requests };
}

test('fetchAntigravityLimits adds no Argon row when Argon draws from the Gemini pool', async () => {
  const { result, requests } = await fetchWithModelQuota({
    buckets: [
      { tokenType: 'WTUS', modelId: 'gemini-3.8-flash-high', remainingFraction: 0.7981962, resetTime: '2026-10-17T16:16:00Z' },
      { tokenType: 'WTUS', modelId: 'gemini-4-argon-high', remainingFraction: 0.7981962, resetTime: '2026-10-17T16:16:00Z' },
      { tokenType: 'WTUS', modelId: 'gemini-4-argon-low', remainingFraction: 0.7981962, resetTime: '2026-10-17T16:16:00Z' },
      { tokenType: 'WTUS', modelId: 'claude-opus-4-6-thinking', remainingFraction: 0.34724215, resetTime: '2026-10-19T02:40:24Z' }
    ]
  });

  assert.ok(requests.some((url) => url === 'https://daily.example.test/v1internal:retrieveUserQuota'));
  assert.equal(result.planLabel, 'Ultra Lite');
  assert.deepEqual(result.windows.map((window) => window.label), [
    'Gemini 5-hour', 'Gemini weekly', 'Claude/GPT 5-hour', 'Claude/GPT weekly'
  ]);
  assert.equal(result.windows[1].remainingPercent, 74.202);
});

test('fetchAntigravityLimits shows a separately metered Argon pool beside Gemini', async () => {
  const { result } = await fetchWithModelQuota({
    buckets: [
      { modelId: 'gemini-3.8-flash-high', remainingFraction: 0.7981962, resetTime: '2026-10-17T16:16:00Z' },
      { modelId: 'gemini-4-argon-medium', remainingFraction: 0.55, resetTime: '2026-10-22T09:00:00Z' },
      { modelId: 'gemini-4-argon-high', remainingFraction: 0.5, resetTime: '2026-10-22T09:00:00Z' }
    ]
  });

  assert.deepEqual(result.windows.map((window) => window.label), [
    'Gemini 5-hour', 'Gemini weekly', 'Argon weekly', 'Claude/GPT 5-hour', 'Claude/GPT weekly'
  ]);
  const argon = result.windows[2];
  assert.equal(argon.kind, 'weekly');
  assert.equal(argon.remainingPercent, 50);
  assert.equal(argon.resetsAt, '2026-10-22T09:00:00.000Z');
});

test('fetchAntigravityLimits shows no Argon row for an account without Argon access', async () => {
  // Pro accounts without the entitlement get no Argon bucket at all.
  const { result } = await fetchWithModelQuota({
    buckets: [{ modelId: 'gemini-3.8-flash-high', remainingFraction: 1, resetTime: '2026-10-17T19:17:00Z' }]
  });
  assert.ok(result.windows.every((window) => !/argon/i.test(window.label)));
});

test('fetchAntigravityLimits keeps the summary windows when the per-model quota read fails', async () => {
  const { result } = await fetchWithModelQuota(null, { failModelQuota: true });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.windows.map((window) => window.label), [
    'Gemini 5-hour', 'Gemini weekly', 'Claude/GPT 5-hour', 'Claude/GPT weekly'
  ]);
});
