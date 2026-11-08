'use strict';

/**
 * Outbound HTTP helpers that honor standard proxy env vars.
 *
 * Node's global `fetch` (undici) does not apply HTTP(S)_PROXY by default, so
 * requests to hosts only reachable via a local proxy (common for grok.com in
 * some networks) hang until timeout. This module builds a fetch function that:
 *   - uses undici EnvHttpProxyAgent when proxy env vars are set
 *   - honors NO_PROXY and lowercase-over-uppercase env precedence
 *   - falls back to globalThis.fetch only when no proxy is configured
 *
 * No app settings / hard-coded proxy addresses — env only (CLI/systemd/shell).
 */


function cleanProxyUrl(value) {
  if (typeof value !== 'string') return '';
  let raw = value.trim();
  if (!raw) return '';
  if (
    (raw.startsWith('"') && raw.endsWith('"'))
    || (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    raw = raw.slice(1, -1).trim();
  }
  return raw;
}

/**
 * Resolve standard proxy env configuration. Lowercase variables win over
 * uppercase variants, matching undici/curl behavior. ALL_PROXY remains a
 * final fallback because it is commonly used by CLI environments.
 */
function proxyEnvValue(env, lowercaseName, uppercaseName) {
  return cleanProxyUrl(env && env[lowercaseName])
    || cleanProxyUrl(env && env[uppercaseName]);
}

function resolveProxyConfig(env = process.env) {
  // Normalize explicitly so callers can inject an env object, add ALL_PROXY,
  // and strip shell-style quotes instead of making undici read process.env.
  const allProxy = proxyEnvValue(env, 'all_proxy', 'ALL_PROXY');
  const httpProxy = proxyEnvValue(env, 'http_proxy', 'HTTP_PROXY') || allProxy;
  const httpsProxy = proxyEnvValue(env, 'https_proxy', 'HTTPS_PROXY') || httpProxy;
  const noProxy = proxyEnvValue(env, 'no_proxy', 'NO_PROXY');
  return { httpProxy, httpsProxy, noProxy };
}

function resolveProxyUrl(env = process.env) {
  return resolveProxyConfig(env).httpsProxy;
}

function globalFetch() {
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis);
  }
  throw new Error('global fetch is not available');
}

// Keep one live configuration and at most one gracefully draining predecessor.
// Arbitrary proxy env objects (including per-tenant embedders) must not grow a
// process-global Map forever. Per-call lookup below also revives an existing
// fetch closure after its former dispatcher was evicted and closed.
let currentAgent = null;
let drainingAgent = null;
const DEFAULT_AGENT_DRAIN_MS = 5_000;

function ignoreLifecycleError() {}

function destroyAgent(agent) {
  try {
    const result = agent?.destroy?.();
    if (result && typeof result.then === 'function') result.catch(ignoreLifecycleError);
  } catch (_) {
    // Shutdown is best-effort; never mask the original request/result.
  }
}

function drainAgent(agent, timeoutMs = DEFAULT_AGENT_DRAIN_MS) {
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  let timer = null;
  const complete = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    finish();
  };
  const record = {
    agent,
    done,
    destroy() {
      destroyAgent(agent);
      complete();
    }
  };
  const delay = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) >= 0
    ? Number(timeoutMs)
    : DEFAULT_AGENT_DRAIN_MS;
  // Ref'd on purpose: `resetOutboundFetchCache` awaits `done`, and an unref'd
  // deadline can leave the event loop (and that await) with nothing to fire.
  timer = setTimeout(record.destroy, delay);
  try {
    if (typeof agent?.close !== 'function') {
      record.destroy();
    } else {
      Promise.resolve(agent.close()).then(complete, () => {
        destroyAgent(agent);
        complete();
      });
    }
  } catch (_) {
    record.destroy();
  }
  return record;
}

function retireAgent(record, timeoutMs) {
  if (!record?.agent) return;
  // A second configuration change must not leave an unbounded chain of close
  // promises. The oldest dispatcher is destroyed; the newest may still drain.
  if (drainingAgent) drainingAgent.destroy();
  drainingAgent = drainAgent(record.agent, timeoutMs);
  const retained = drainingAgent;
  retained.done.then(() => {
    if (drainingAgent === retained) drainingAgent = null;
  });
}

function getProxyAgent(proxyConfig, EnvHttpProxyAgentCtor) {
  const key = JSON.stringify(proxyConfig);
  if (currentAgent && currentAgent.key === key && currentAgent.Ctor === EnvHttpProxyAgentCtor) {
    return currentAgent.agent;
  }
  const agent = new EnvHttpProxyAgentCtor(proxyConfig);
  const previous = currentAgent;
  currentAgent = { key, Ctor: EnvHttpProxyAgentCtor, agent };
  retireAgent(previous);
  return agent;
}

/**
 * Build a fetch implementation for outbound HTTPS requests.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ fetch?: typeof fetch, EnvHttpProxyAgent?: new (options: object) => unknown, undiciFetch?: typeof fetch }} [deps]
 * @returns {typeof fetch}
 */
function createOutboundFetch(env = process.env, deps = {}) {
  if (typeof deps.fetch === 'function') return deps.fetch;

  const proxyConfig = resolveProxyConfig(env);
  if (!proxyConfig.httpProxy && !proxyConfig.httpsProxy) return globalFetch();

  // Direct requests use the runtime fetch; load the external HTTP stack only
  // when a proxy actually needs its dispatcher.
  const EnvHttpProxyAgentCtor = deps.EnvHttpProxyAgent || require('undici').EnvHttpProxyAgent;
  const fetchFn = deps.undiciFetch || require('undici').fetch;
  // A configured-but-invalid proxy must fail closed. Silently falling back to
  // a direct request would violate operator intent and obscure configuration
  // errors on networks where direct access is forbidden.
  // Construct once eagerly so invalid configuration still throws at setup.
  getProxyAgent(proxyConfig, EnvHttpProxyAgentCtor);

  return (input, init = {}) => {
    const options = init && typeof init === 'object' ? { ...init } : {};
    if (options.dispatcher == null) {
      options.dispatcher = getProxyAgent(proxyConfig, EnvHttpProxyAgentCtor);
    }
    // undici prefers Uint8Array bodies over Node Buffer views in some paths.
    if (Buffer.isBuffer(options.body)) {
      options.body = new Uint8Array(options.body.buffer, options.body.byteOffset, options.body.byteLength);
    }
    return fetchFn(input, options);
  };
}

/**
 * Close the cached dispatchers with a bounded graceful-drain window. Existing
 * fetch closures resolve a fresh agent on their next call, so shutdown/tests do
 * not leave them permanently attached to a closed dispatcher.
 */
async function resetOutboundFetchCache({ drainTimeoutMs = DEFAULT_AGENT_DRAIN_MS } = {}) {
  const numericTimeout = Number(drainTimeoutMs);
  const timeoutMs = Number.isFinite(numericTimeout) && numericTimeout >= 0
    ? numericTimeout
    : DEFAULT_AGENT_DRAIN_MS;
  const previous = currentAgent;
  currentAgent = null;
  retireAgent(previous, timeoutMs);
  const draining = drainingAgent;
  if (draining) {
    // Apply the caller's shutdown deadline to an already-draining predecessor
    // as well; awaiting close() itself could otherwise wait forever.
    const timer = setTimeout(draining.destroy, timeoutMs);
    await draining.done;
    clearTimeout(timer);
  }
}

module.exports = {
  cleanProxyUrl,
  resolveProxyConfig,
  resolveProxyUrl,
  createOutboundFetch,
  resetOutboundFetchCache
};
