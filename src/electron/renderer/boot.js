// Desktop client boot module.
//
// Installs the IPC transport, points the client-icon resolver at the packaged
// asset tree, and then loads the shared UI. The app import is dynamic for the
// same reason as the Hub's: ES module imports evaluate before this module's
// body, and the shared UI reads prefs and credentials while it initialises, so
// the transport must be installed first.

import { createIpcTransport } from '../../shared-ui/transport/ipcTransport.js';
import { configureTransport } from '../../shared-ui/transport/index.js';
import { configureIconBase } from '../../shared-ui/core/data.js';

const bridge = window.tokenMonitor;
if (!bridge) {
  throw new Error('preload bridge is unavailable; the renderer cannot reach the main process');
}

// Icons ship with the shared UI assets. A relative path keeps `file://`
// resolution working from both the dev checkout and an asar-packed build.
configureIconBase('../../shared-ui/icons/clients');
configureTransport(createIpcTransport(bridge));

// The renderer shell owns a real client-area title bar on every desktop OS.
// Mark the platform before the shared stylesheet and app module render so the
// native chrome offsets are deterministic from first paint.
function applyWindowSurfaceClass(surface) {
  const target = document.documentElement;
  const body = document.body;
  const valid = ['regular', 'transparent', 'acrylic', 'mica', 'vibrancy', 'liquid-glass'].includes(surface) ? surface : 'regular';
  target.dataset.windowSurface = valid;
  body.dataset.windowSurface = valid;
}

try {
  const urlParams = new URLSearchParams(window.location.search);
  const initialSurface = urlParams.get('windowSurface');
  if (initialSurface) {
    applyWindowSurfaceClass(initialSurface);
  }
  const info = await bridge.getAppInfo?.();
  if (info?.platform) document.body.classList.add(`is-${info.platform === 'darwin' ? 'mac' : info.platform}`);
  if (info?.effectiveWindowSurface) {
    applyWindowSurfaceClass(info.effectiveWindowSurface);
  }
} catch (_) {
  // Platform classes are cosmetic; the shared UI still boots if app info is
  // unavailable during an early packaged launch.
}

bridge.onSettingsPush?.((settings) => {
  if (settings?.effectiveWindowSurface) {
    applyWindowSurfaceClass(settings.effectiveWindowSurface);
  }
});

await import('../../shared-ui/app.js');
