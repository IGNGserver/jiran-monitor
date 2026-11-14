'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createMacosGlassApi,
  applyMacosGlass,
  clearMacosGlass
} = require('../../src/electron/macosGlassNative');

function createMockObjcHarness(options = {}) {
  const NATIVE_VIEW = 0x1001n;
  const NATIVE_WINDOW = 0x2001n;
  const CONTENT_VIEW = 0x3001n;
  const GLASS_CLASS = 0x4001n;
  const NSCOLOR_CLASS = 0x5001n;
  const CLEAR_COLOR = 0x5002n;
  const GLASS_ALLOC = 0x6001n;
  const GLASS_VIEW = 0x6002n;

  const selectorsByName = new Map();
  const namesBySelector = new Map();
  let nextSelector = 100n;

  function registerSelector(name) {
    if (!selectorsByName.has(name)) {
      const id = nextSelector;
      nextSelector += 1n;
      selectorsByName.set(name, id);
      namesBySelector.set(id, name);
    }
    return selectorsByName.get(name);
  }

  let destroyed = false;
  let glassSuperview = 0n;
  let released = 0;
  const calls = [];
  const windowCornerRadius = options.windowCornerRadius ?? 16;
  const hasPrivateCornerRadius = options.hasPrivateCornerRadius !== false;
  const supportsClearColor = options.supportsClearColor !== false;

  const koffi = {
    struct: (name, fields) => ({ kind: 'struct', name, fields }),
    pointer: (type) => ({ kind: 'pointer', type }),
    out: (type) => ({ kind: 'out', type }),
    load: () => ({
      func(fnName, retType, _argTypes) {
        if (fnName === 'objc_getClass') {
          return (name) => {
            if (name === 'NSGlassEffectView') return GLASS_CLASS;
            if (name === 'NSColor') return supportsClearColor ? NSCOLOR_CLASS : 0n;
            return 0n;
          };
        }
        if (fnName === 'sel_registerName') {
          return (name) => registerSelector(name);
        }
        if (fnName === 'objc_msgSend_stret') {
          return (outRect, recv, sel) => {
            const name = namesBySelector.get(sel);
            calls.push([name, recv]);
            if (name === 'bounds' && recv === CONTENT_VIEW) {
              outRect.origin = { x: 0, y: 0 };
              outRect.size = { width: 1120, height: 740 };
            }
          };
        }
        if (fnName === 'objc_msgSend') {
          const isStructReturn = typeof retType === 'object' && retType?.kind === 'struct';
          return (recv, sel, ...args) => {
            const name = namesBySelector.get(sel);
            assert.ok(!destroyed || recv === GLASS_VIEW, `destroyed window/view dereferenced via ${name}`);
            calls.push([name, recv, ...args]);

            if (isStructReturn && name === 'bounds' && recv === CONTENT_VIEW) {
              return { origin: { x: 0, y: 0 }, size: { width: 1120, height: 740 } };
            }
            if (name === 'window' && recv === NATIVE_VIEW) return NATIVE_WINDOW;
            if (name === 'contentView' && recv === NATIVE_WINDOW) return CONTENT_VIEW;
            if (name === 'alloc' && recv === GLASS_CLASS) return GLASS_ALLOC;
            if (name === 'initWithFrame:' && recv === GLASS_ALLOC) return GLASS_VIEW;
            if (name === 'clearColor' && recv === NSCOLOR_CLASS) return CLEAR_COLOR;
            if (name === 'superview' && recv === GLASS_VIEW) return glassSuperview;
            if (name === 'addSubview:positioned:relativeTo:' && recv === CONTENT_VIEW) {
              glassSuperview = args[0] === GLASS_VIEW ? CONTENT_VIEW : 0n;
            }
            if (name === 'removeFromSuperview' && recv === GLASS_VIEW) {
              glassSuperview = 0n;
            }
            if (name === 'release' && recv === GLASS_VIEW) {
              released += 1;
            }
            if (name === '_cornerRadius' && recv === NATIVE_WINDOW) {
              return windowCornerRadius;
            }
            if (name === 'respondsToSelector:') {
              const targetSel = namesBySelector.get(args[0]);
              if (targetSel === '_cornerRadius') return hasPrivateCornerRadius;
              return [
                'setStyle:',
                'setCornerRadius:',
                'setOpaque:',
                'setBackgroundColor:',
                'superview'
              ].includes(targetSel);
            }
            return 0n;
          };
        }
        throw new Error(`unexpected objc fn: ${fnName}`);
      }
    })
  };

  function makeWindow({ fullScreen = false } = {}) {
    const handle = Buffer.alloc(8);
    handle.writeBigUInt64LE(NATIVE_VIEW);
    const closedListeners = [];
    return {
      isDestroyed: () => destroyed,
      isFullScreen: () => fullScreen,
      getNativeWindowHandle: () => {
        if (destroyed) throw new Error('window is destroyed');
        return handle;
      },
      once: (event, cb) => {
        if (event === 'closed') closedListeners.push(cb);
      },
      emitClosed: () => {
        destroyed = true;
        for (const cb of closedListeners.splice(0)) cb();
      },
      closedListenerCount: () => closedListeners.length
    };
  }

  return {
    koffi,
    calls,
    constants: {
      NATIVE_VIEW,
      NATIVE_WINDOW,
      CONTENT_VIEW,
      GLASS_VIEW,
      CLEAR_COLOR
    },
    getReleased: () => released,
    getGlassSuperview: () => glassSuperview,
    makeWindow
  };
}

test('liquid glass bridge configures regular style, transparent window backing, nil relativeTo, and window corner radius', () => {
  const harness = createMockObjcHarness({ windowCornerRadius: 16 });
  const api = createMacosGlassApi(harness.koffi);
  const win = harness.makeWindow({ fullScreen: false });

  assert.equal(api.supported, true);
  assert.equal(applyMacosGlass(win, 'liquid-glass', { platform: 'darwin', api }), true);

  const call = (name) => harness.calls.find(([entry]) => entry === name);
  const { CONTENT_VIEW, GLASS_VIEW, NATIVE_WINDOW, CLEAR_COLOR } = harness.constants;

  assert.deepEqual(call('setOpaque:'), ['setOpaque:', NATIVE_WINDOW, false]);
  assert.deepEqual(call('setBackgroundColor:'), ['setBackgroundColor:', NATIVE_WINDOW, CLEAR_COLOR]);
  assert.deepEqual(call('addSubview:positioned:relativeTo:'), [
    'addSubview:positioned:relativeTo:',
    CONTENT_VIEW,
    GLASS_VIEW,
    -1,
    0
  ]);
  assert.deepEqual(call('setStyle:'), ['setStyle:', GLASS_VIEW, 0]);
  assert.deepEqual(call('setCornerRadius:'), ['setCornerRadius:', GLASS_VIEW, 16]);
  assert.equal(call('setEffectIsInteractive:'), undefined, 'must not call removed UIGlassEffect selector');
});

test('liquid glass zeroes cornerRadius in fullscreen and cleans up safely when window closes without redundant listeners', () => {
  const harness = createMockObjcHarness({ windowCornerRadius: 18 });
  const api = createMacosGlassApi(harness.koffi);
  let fullScreen = true;
  const win = harness.makeWindow();
  win.isFullScreen = () => fullScreen;

  assert.equal(applyMacosGlass(win, 'liquid-glass', { platform: 'darwin', api }), true);
  let cornerCalls = harness.calls.filter(([name]) => name === 'setCornerRadius:');
  assert.equal(cornerCalls.at(-1)[2], 0, 'fullscreen removes rounded mask on glass view');

  fullScreen = false;
  assert.equal(applyMacosGlass(win, 'liquid-glass', { platform: 'darwin', api }), true);
  cornerCalls = harness.calls.filter(([name]) => name === 'setCornerRadius:');
  assert.equal(cornerCalls.at(-1)[2], 18, 'leaving fullscreen restores window corner radius');

  // Toggling vibrancy <-> liquid-glass repeatedly must not stack closed listeners.
  assert.equal(clearMacosGlass(win, { platform: 'darwin', api }), true);
  assert.equal(applyMacosGlass(win, 'liquid-glass', { platform: 'darwin', api }), true);
  assert.equal(win.closedListenerCount(), 1);
  assert.equal(harness.getReleased(), 1);

  win.emitClosed();
  assert.equal(harness.getReleased(), 2, 'closed window releases retained glassView without touching destroyed window pointers');
  assert.equal(harness.getGlassSuperview(), 0n);

  // Calling clearMacosGlass after closed is a safe no-op.
  assert.equal(clearMacosGlass(win, { platform: 'darwin', api }), false);
});
