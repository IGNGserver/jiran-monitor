/** Browser-only controls. The shared app calls this only for capabilities.pwa. */
export function setupBrowserPwa({ translate, hasDraft, canInstall, install, confirmUpdate }) {
  const root = document.documentElement;
  root.dataset.browserPwa = '';
  const dialog = document.getElementById('pwaHelp');
  const notice = document.getElementById('pwaUpdate');
  let registration = null;
  let requestedUpdate = false;
  let waiting = null;
  const dirtyFields = new Set();
  const refresh = () => {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    document.querySelectorAll('[data-pwa-help]').forEach((entry) => { entry.textContent = translate(standalone ? 'pwa.manage' : entry.closest('.page-commands') ? 'pwa.install' : 'pwa.title'); });
    const button = dialog?.querySelector('[data-browser-install]');
    if (button) button.hidden = standalone || !canInstall();
    const status = document.getElementById('pwaHelpStatus');
    if (status) status.textContent = translate(standalone ? 'pwa.status.installed' : !window.isSecureContext ? 'pwa.status.insecure' : 'pwa.status.hint');
    dialog?.querySelectorAll('[data-pwa-update]').forEach((button) => { button.hidden = !waiting; });
  };
  const offer = () => {
    waiting = registration?.waiting || null;
    if (notice) notice.hidden = !waiting || !navigator.serviceWorker.controller;
    refresh();
  };
  document.addEventListener('click', async (event) => {
    if (event.target.closest('[data-pwa-help]')) { refresh(); dialog?.showModal(); }
    if (event.target.closest('[data-pwa-close]')) dialog?.close();
    if (event.target.closest('[data-browser-install]')) void install().finally(refresh);
    if (event.target.closest('[data-pwa-update]')) {
      if (!waiting || requestedUpdate) return;
      const dirty = hasDraft() || [...dirtyFields].some((field) => field.isConnected && field.value);
      if (dirty && !await confirmUpdate(translate('pwa.updateDraft'))) return;
      if (!waiting || waiting.state !== 'installed') return;
      requestedUpdate = true;
      notice?.querySelectorAll('button').forEach((button) => { button.disabled = true; });
      waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
    }
    if (event.target.closest('[data-pwa-later]') && notice) notice.hidden = true;
  });
  document.addEventListener('input', (event) => {
    const field = event.target;
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      if (field.type === 'search' || field.closest('.scope-commandbar')) return;
      if (field.value) dirtyFields.add(field); else dirtyFields.delete(field);
    }
  });
  // Pinch zoom must not trigger a layout reset. Keyboard and split-screen
  // changes do resize the visible window and its overlay containing blocks.
  const viewport = window.visualViewport;
  const fitViewport = () => {
    if (viewport && viewport.scale !== 1) return;
    root.style.setProperty('--browser-viewport-height', `${viewport?.height || window.innerHeight}px`);
    root.style.setProperty('--browser-viewport-top', `${viewport?.offsetTop || 0}px`);
  };
  fitViewport();
  viewport?.addEventListener('resize', fitViewport);
  viewport?.addEventListener('scroll', fitViewport);
  window.addEventListener('resize', fitViewport);
  if ('serviceWorker' in navigator && window.isSecureContext && document.querySelector('meta[name="jiran-pwa-build"]')) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (requestedUpdate) window.location.reload();
    });
    void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then((value) => {
      registration = value;
      offer();
      const found = () => value.installing?.addEventListener('statechange', offer);
      found();
      value.addEventListener('updatefound', found);
      void value.update().catch(() => {});
    }).catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && navigator.onLine) void registration?.update().catch(() => {});
    });
  }
  refresh();
  return { refresh };
}
