#!/usr/bin/env node
'use strict';

// Read-only WAN diagnostic. Secrets come from the environment, never arguments/output.
const { performance } = require('node:perf_hooks');

async function measureLoading({ url, samples = 3, secret = '', fetchImpl = fetch }) {
  const origin = new URL(url);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error('Use an HTTP(S) origin without credentials, query or fragment');
  }
  if (secret && origin.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
    throw new Error('Authenticated diagnostics require HTTPS or an SSH-forwarded loopback endpoint');
  }
  const count = Math.max(1, Math.min(20, Number(samples) || 3));
  const paths = ['/api/health', '/', '/ui/styles/app.css'];
  if (secret) paths.push('/api/stats/summary', '/api/stats');
  const results = [];
  for (let index = 0; index < count; index++) {
    for (const path of paths) {
      const started = performance.now();
      try {
        const response = await fetchImpl(new URL(path, origin), {
          headers: secret && path.startsWith('/api/') ? { authorization: `Bearer ${secret}` } : {},
          signal: AbortSignal.timeout(20_000)
        });
        const headersMs = performance.now() - started;
        const body = await response.arrayBuffer();
        results.push({ path, status: response.status, headersMs: Math.round(headersMs), totalMs: Math.round(performance.now() - started), decodedBytes: body.byteLength, encoding: response.headers.get('content-encoding') || 'identity', serverTiming: response.headers.get('server-timing') });
      } catch {
        results.push({ path, error: 'request_failed', totalMs: Math.round(performance.now() - started) });
      }
    }
  }
  return { origin: origin.origin, samples: count, results };
}

if (require.main === module) {
  measureLoading({ url: process.argv[2], samples: process.argv[3], secret: process.env.JIRAN_BENCH_SECRET || '' })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch(() => { console.error('Invalid diagnostic configuration; use HTTPS/loopback and JIRAN_BENCH_SECRET for protected reads.'); process.exitCode = 1; });
}

module.exports = { measureLoading };
