# Browser installation and adaptive layout

The Hub's normal HTTPS origin is the installable application. Its stable manifest URL is
`/manifest.webmanifest`, its identity and scope are `/`, and its start URL is `/`.
There is no separate mobile or PWA deployment. Electron uses the same domain views but
never registers a service worker or renders browser installation controls.

Production builds use Workbox `injectManifest` and a versioned precache controller. Each
candidate installs a complete HTML/JavaScript/CSS graph before it can activate. A waiting
version activates only after the user chooses Update, with a confirmation when a form has
unsaved input. Keep all previous complete shell caches while any application window remains open; natural activation with no windows retires obsolete versions. The worker handles
only public shell resources: API requests, credentials and cross-origin requests never enter
Cache Storage. An offline shell does not imply offline access to usage or account data.

`src/hub/web/icons/icon-1024.png` is the opaque square master for browser icons. The build
uses Sharp to derive ordinary 192/512/1024 PNGs, separately padded maskable icons, and opaque
180/167/152 Apple Touch Icons. HTML and manifest point to content-addressed icon files;
legacy icon paths and `/apple-touch-icon.png` remain available for automatic probes. Do not
pre-round icons: the operating system supplies the mask.

The Install entry remains available before login and from the top bar. Chromium installation
uses its native prompt when available; otherwise the dialog explains the browser menu and
iOS Safari's Share > Add to Home Screen flow. An absent `beforeinstallprompt` is not an error.
New installs and existing installs must both be checked on actual iOS/iPadOS and Android
Chrome/Edge; browser emulation cannot verify the system's icon picker or launcher behavior.

The browser shell observes `visualViewport` without blocking pinch zoom. Dialogs and drawers
fit above the software keyboard and respect all four safe-area insets. Layout uses available
window width, including tablet split-screen: narrow windows show one column; wider windows
show navigation and list/detail or chart support panes. Pointer/hover capability controls
interaction size, not whether content remains accessible.

## Delivery and verification

HTML, manifests and `sw.js` use `no-store, no-cache, max-age=0, must-revalidate`. Hashed
JavaScript/CSS and content-addressed icons remain immutable. The reverse proxy/CDN must
respect these headers. If Cloudflare still overrides the origin, add a cache bypass scoped
only to the business hostname's HTML, manifest and SW paths, and make Browser TTL respect
the origin there. Do not change a whole zone's browser cache setting for this application.
After deployment inspect the public response, not only a direct origin response.

Run `npm run verify`, `npm run build:web`, and `node --test tests/web-build/assets.test.js`
in CI or a local scratch copy. Browser checks cover installation help before login, normal
navigation, all management surfaces, width/rotation/split-screen, large text, keyboard,
new-version consent, offline reopen, and authenticated API bypass. Record physical-device
icon installation separately; refreshing a previously installed app may retain its old icon.
