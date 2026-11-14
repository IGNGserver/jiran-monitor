'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createApplicationTray, trayIcon } = require('../../src/electron/tray');

class FakeTray extends EventEmitter {
  constructor(image) {
    super();
    this.image = image;
    this.menu = null;
    this.tooltip = '';
  }

  setContextMenu(menu) { this.menu = menu; }
  setToolTip(value) { this.tooltip = value; }
}

function fakeElectron() {
  return {
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => template },
    nativeImage: {
      createFromPath: (sourcePath) => ({
        sourcePath,
        resize(options) { return { ...this, resizeOptions: options, setTemplateImage() {} }; }
      })
    }
  };
}

test('the tray carries the window, the pause switch, view jumps and quit', () => {
  const calls = [];
  const window = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus')
  };
  const labels = {
    'trayMenu.showWindow': 'Show window',
    'trayMenu.pauseCollection': 'Pause collection',
    'trayMenu.resumeCollection': 'Resume collection',
    'trayMenu.openView': 'Open view',
    'trayMenu.settings': 'Settings',
    'trayMenu.quit': 'Quit',
    'trayMenu.tooltipToday': 'Today {tokens} tokens',
    'nav.overview': 'Overview',
    'nav.limits': 'Limits',
    'nav.settings': 'Settings'
  };
  let paused = false;
  const handle = createApplicationTray({
    electron: fakeElectron(),
    platform: 'win32',
    iconPath: '/tmp/token-monitor.png',
    getWindow: () => window,
    onOpenSettings: () => calls.push('settings'),
    onQuit: () => calls.push('quit'),
    onOpenView: (view) => calls.push(`view:${view}`),
    isCollectionPaused: () => paused,
    onToggleCollectionPaused: () => { paused = true; handle.refreshMenu(); },
    tooltip: () => (paused ? 'Jiran · paused' : 'Jiran · today'),
    translate: (key) => labels[key] || key
  });

  assert.equal(handle.tray.tooltip, 'Jiran · today');
  assert.equal(handle.tray.image.sourcePath, '/tmp/token-monitor.png');
  assert.deepEqual(handle.tray.menu.map((item) => item.label || item.type), [
    'Show window', 'Pause collection', 'separator', 'Open view', 'Settings', 'separator', 'Quit'
  ]);
  assert.deepEqual(
    handle.tray.menu[3].submenu.map((item) => item.label),
    ['Overview', 'Limits', 'Settings'],
    'the tray reaches the views a hidden window cannot'
  );

  handle.tray.emit('click');
  handle.tray.menu[3].submenu[1].click();
  handle.tray.menu[4].click();
  handle.tray.menu[6].click();
  assert.deepEqual(calls, ['restore', 'show', 'focus', 'view:limits', 'settings', 'quit']);

  // Pausing must be visible in both the checkbox state and the tooltip, without
  // rebuilding the tray.
  handle.tray.menu[1].click();
  assert.equal(handle.tray.menu[1].checked, true);
  assert.equal(handle.tray.menu[1].label, 'Resume collection');
  assert.equal(handle.tray.tooltip, 'Jiran · paused');
});

test('macOS uses the template tray icon', () => {
  const handle = createApplicationTray({
    electron: fakeElectron(),
    platform: 'darwin',
    iconPath: '/tmp/app.png',
    templateIconPath: '/tmp/template.png',
    getWindow: () => null
  });
  assert.equal(handle.tray.image.sourcePath, '/tmp/template.png');
  assert.equal(handle.tray.image.resizeOptions.height, 20);
});

test('macOS preserves pre-sized Retina @2x template icons without resizing', () => {
  let resizeCalled = false;
  let templateMarked = false;
  const result = trayIcon({
    platform: 'darwin',
    iconPath: '/tmp/app.png',
    templateIconPath: '/tmp/trayTemplate.png',
    nativeImage: {
      createFromPath: (sourcePath) => ({
        sourcePath,
        getSize: () => ({ width: 20, height: 20 }),
        getScaleFactors: () => [1, 2],
        resize() {
          resizeCalled = true;
          return this;
        },
        setTemplateImage(value) {
          templateMarked = value;
        }
      })
    }
  });
  assert.equal(result.sourcePath, '/tmp/trayTemplate.png');
  assert.equal(resizeCalled, false);
  assert.equal(templateMarked, true);
});

test('macOS attaches a sibling @2x representation when createFromPath returns only 1x', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiran-tray-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const oneX = path.join(dir, 'trayTemplate.png');
  const twoX = path.join(dir, 'trayTemplate@2x.png');
  fs.writeFileSync(oneX, Buffer.from('1x'));
  fs.writeFileSync(twoX, Buffer.from('2x'));

  const reps = [];
  let resizeCalled = false;
  let templateMarked = false;
  trayIcon({
    platform: 'darwin',
    iconPath: '/tmp/app.png',
    templateIconPath: oneX,
    nativeImage: {
      createFromPath: (sourcePath) => ({
        sourcePath,
        getSize: () => ({ width: 20, height: 20 }),
        getScaleFactors: () => [1],
        addRepresentation(opts) {
          reps.push(opts);
        },
        resize() {
          resizeCalled = true;
          return this;
        },
        setTemplateImage(value) {
          templateMarked = value;
        }
      })
    }
  });

  assert.equal(resizeCalled, false);
  assert.equal(templateMarked, true);
  assert.equal(reps.length, 1);
  assert.equal(reps[0].scaleFactor, 2);
  assert.equal(reps[0].dataURL, `data:image/png;base64,${Buffer.from('2x').toString('base64')}`);
});
