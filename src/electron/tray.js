'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TOOLTIP = 'Jiran';
const MACOS_TRAY_MAX_HEIGHT = 22;

function retinaSiblingPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  const parsed = path.parse(filePath);
  if (!parsed.ext || parsed.name.endsWith('@2x')) return '';
  return path.join(parsed.dir, `${parsed.name}@2x${parsed.ext}`);
}

function trayIcon({ iconPath, templateIconPath, platform, nativeImage }) {
  const isDarwin = platform === 'darwin';
  const sourcePath = isDarwin && templateIconPath
    ? templateIconPath
    : iconPath;
  const image = nativeImage.createFromPath(sourcePath);

  if (isDarwin && templateIconPath) {
    // Preserve @1x/@2x representations: NativeImage.resize() collapses down to
    // a single 1x bitmap in Electron, which blurs Retina menu bar icons.
    const scaleFactors = typeof image.getScaleFactors === 'function' ? image.getScaleFactors() : [];
    const at2xPath = retinaSiblingPath(sourcePath);
    if (!scaleFactors.includes(2) && at2xPath && typeof image.addRepresentation === 'function' && fs.existsSync(at2xPath)) {
      image.addRepresentation({
        scaleFactor: 2,
        dataURL: `data:image/png;base64,${fs.readFileSync(at2xPath).toString('base64')}`
      });
    }
    const size = typeof image.getSize === 'function' ? image.getSize() : null;
    const result = size && size.height > 0 && size.height <= MACOS_TRAY_MAX_HEIGHT
      ? image
      : image.resize({ height: 20, quality: 'best' });
    if (typeof result.setTemplateImage === 'function') {
      result.setTemplateImage(true);
    }
    return result;
  }

  const resized = image.resize({
    ...(isDarwin ? { height: 20 } : { width: 20, height: 20 }),
    quality: 'best'
  });
  if (isDarwin && typeof resized.setTemplateImage === 'function') {
    resized.setTemplateImage(true);
  }
  return resized;
}

function translatedLabel(translate, key) {
  try {
    const value = typeof translate === 'function' ? translate(key) : '';
    return typeof value === 'string' && value.trim() ? value : key;
  } catch (_) {
    return key;
  }
}

// The tray is the only surface that stays reachable while the window is hidden, so
// it carries the two things a user needs without a window: whether collection is
// running, and a way back into the app.
function buildTrayMenuTemplate({
  translate,
  onShowWindow,
  onOpenSettings,
  onOpenView,
  onQuit,
  onToggleCollectionPaused,
  isCollectionPaused = () => false
}) {
  const paused = isCollectionPaused() === true;
  return [
    {
      label: translatedLabel(translate, 'trayMenu.showWindow'),
      click: onShowWindow
    },
    {
      label: translatedLabel(translate, paused ? 'trayMenu.resumeCollection' : 'trayMenu.pauseCollection'),
      type: 'checkbox',
      checked: paused,
      click: () => {
        if (typeof onToggleCollectionPaused === 'function') onToggleCollectionPaused();
      }
    },
    { type: 'separator' },
    ...(onOpenView
      ? [{
          label: translatedLabel(translate, 'trayMenu.openView'),
          submenu: [
            { label: translatedLabel(translate, 'nav.overview'), click: () => onOpenView('overview') },
            { label: translatedLabel(translate, 'nav.limits'), click: () => onOpenView('limits') },
            { label: translatedLabel(translate, 'nav.settings'), click: () => onOpenView('settings') }
          ]
        }]
      : []),
    {
      label: translatedLabel(translate, 'trayMenu.settings'),
      click: onOpenSettings
    },
    { type: 'separator' },
    {
      label: translatedLabel(translate, 'trayMenu.quit'),
      click: onQuit
    }
  ];
}

function createApplicationTray(options = {}) {
  const electronApi = options.electron || require('electron');
  const { Tray, Menu, nativeImage } = electronApi;
  const platform = options.platform || process.platform;
  const tray = new Tray(trayIcon({
    iconPath: options.iconPath,
    templateIconPath: options.templateIconPath,
    platform,
    nativeImage
  }));

  const showWindow = () => {
    const window = typeof options.getWindow === 'function' ? options.getWindow() : null;
    if (!window || window.isDestroyed?.()) return;
    if (window.isMinimized?.()) window.restore();
    window.show();
    window.focus?.();
  };
  const openSettings = () => {
    if (typeof options.onOpenSettings === 'function') options.onOpenSettings();
  };
  const quit = () => {
    if (typeof options.onQuit === 'function') options.onQuit();
  };
  const openView = (viewId) => {
    if (typeof options.onOpenView === 'function') options.onOpenView(viewId);
  };
  const toggleCollectionPaused = () => {
    if (typeof options.onToggleCollectionPaused === 'function') options.onToggleCollectionPaused();
  };
  // The tooltip is the only always-visible tray surface, so the live numbers ride
  // on it. It takes a function so each refresh reads current state.
  const trayTooltip = () => {
    const value = typeof options.tooltip === 'function' ? options.tooltip() : options.tooltip;
    return String(value || '').trim() || DEFAULT_TOOLTIP;
  };
  const refreshMenu = () => {
    if (tray.isDestroyed?.()) return;
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate({
      translate: options.translate,
      onShowWindow: showWindow,
      onOpenSettings: openSettings,
      onOpenView: typeof options.onOpenView === 'function' ? openView : null,
      onQuit: quit,
      onToggleCollectionPaused: toggleCollectionPaused,
      isCollectionPaused: options.isCollectionPaused
    })));
    tray.setToolTip(trayTooltip());
  };

  tray.setToolTip(trayTooltip());
  refreshMenu();
  tray.on('click', showWindow);

  return { tray, refreshMenu, showWindow };
}

module.exports = {
  buildTrayMenuTemplate,
  createApplicationTray,
  trayIcon,
  TRAY_ICON_PATH: path.join(__dirname, '..', '..', 'assets', 'icons', 'tray-token-monitorTemplate.png')
};
