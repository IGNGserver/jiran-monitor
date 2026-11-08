'use strict';

function createAgentShutdown(options = {}) {
  const exit = options.exit || process.exit.bind(process);
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : 16_000;
  let shutdownPromise = null;

  function shutdown(signal) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const runtime = options.getRuntime?.();
      let timer = null;
      let timedOut = false;
      let exitCode = 0;
      try {
        const work = runtime?.shutdown
          ? Promise.resolve().then(() => runtime.shutdown())
          : Promise.resolve().then(() => runtime?.stop?.());
        const timeout = new Promise((resolve) => {
          timer = setTimer(() => {
            timedOut = true;
            resolve({ ok: false, code: 'shutdown_timeout' });
          }, timeoutMs);
        });
        const result = await Promise.race([work, timeout]);
        if (result?.ok === false) {
          exitCode = 1;
          options.logger?.warn?.(`[shutdown] final upload did not complete (${result.code || 'upload_failed'}).`);
        }
      } catch (error) {
        exitCode = 1;
        options.logger?.warn?.(`[shutdown] ${error?.message || error}`);
      } finally {
        if (timer !== null) clearTimer(timer);
        if (timedOut) {
          try { runtime?.stop?.(); } catch (_) { /* process is exiting */ }
        }
        try { options.release?.(); } catch (_) { /* process is exiting */ }
        options.logger?.log?.(`[shutdown] ${signal || 'shutdown'} complete.`);
        exit(exitCode);
      }
    })();
    return shutdownPromise;
  }

  return shutdown;
}

module.exports = { createAgentShutdown };
