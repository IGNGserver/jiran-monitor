'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createMacosGlassApi,
  applyMacosGlass,
  clearMacosGlass,
  syncMacosMinimizeBacking,
  restoreMacosMinimizeBacking,
  clearMacosMinimizeBacking
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
  const NSVIEW_CLASS = 0x7001n;
  const BACKING_ALLOC = 0x7002n;
  const BACKING_VIEW = 0x7003n;
  const BACKING_LAYER = 0x7004n;
  const VEV_CLASS = 0x8001n;
  const VIBRANT_VIEW = 0x8002n;
  const NSSTRING_CLASS = 0x9001n;
  const NSOBJECT_CLASS = 0x9002n;
  const CENTER_CLASS = 0x9003n;
  const DEFAULT_CENTER = 0x9004n;
  const CATRANSACTION_CLASS = 0x9005n;
  const OBSERVER_CLASS = 0x9006n;
  const OBSERVER_ALLOC = 0x9007n;
  const OBSERVER_INSTANCE = 0x9008n;

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
  let backingSuperview = 0n;
  let released = 0;
  let backingAllocCount = 0;
  let backingReleased = 0;
  let glassHidden = false;
  let vibrantHidden = false;
  let backingHidden = false;
  let nextCbId = 0xA000n;
  let nextColorId = 0xB000n;
  const calls = [];
  const registeredCallbacks = new Map();
  const methodImps = new Map();
  const observers = [];
  const createdStrings = new Map();
  const srgbColors = new Map();
  const cgColors = new Map();
  const windowCornerRadius = options.windowCornerRadius ?? 16;
  const hasPrivateCornerRadius = options.hasPrivateCornerRadius !== false;
  const supportsClearColor = options.supportsClearColor !== false;
  const enableMinimizeBridge = options.enableMinimizeBridge === true;
  let hasVibrantView = options.hasVibrantView === true;

  const koffi = {
    struct: (name, fields) => ({ kind: 'struct', name, fields }),
    pointer: (type) => ({ kind: 'pointer', type }),
    out: (type) => ({ kind: 'out', type }),
    ...(enableMinimizeBridge ? {
      proto: (sig) => ({ kind: 'proto', sig }),
      register: (fn) => {
        const ptr = nextCbId;
        nextCbId += 1n;
        registeredCallbacks.set(ptr, fn);
        return ptr;
      },
      address: (ptr) => ptr
    } : {}),
    load: () => ({
      func(fnName, retType, _argTypes) {
        if (fnName === 'objc_getClass') {
          return (name) => {
            if (name === 'NSGlassEffectView') return GLASS_CLASS;
            if (name === 'NSColor') return supportsClearColor ? NSCOLOR_CLASS : 0n;
            if (!enableMinimizeBridge) return 0n;
            if (name === 'NSView') return NSVIEW_CLASS;
            if (name === 'NSVisualEffectView') return VEV_CLASS;
            if (name === 'NSString') return NSSTRING_CLASS;
            if (name === 'NSObject') return NSOBJECT_CLASS;
            if (name === 'NSNotificationCenter') return CENTER_CLASS;
            if (name === 'CATransaction') return CATRANSACTION_CLASS;
            return 0n;
          };
        }
        if (enableMinimizeBridge && fnName === 'objc_lookUpClass') {
          return () => 0n;
        }
        if (enableMinimizeBridge && fnName === 'objc_allocateClassPair') {
          return () => OBSERVER_CLASS;
        }
        if (enableMinimizeBridge && fnName === 'objc_registerClassPair') {
          return () => {};
        }
        if (enableMinimizeBridge && fnName === 'class_addMethod') {
          return (_cls, selPtr, imp) => {
            methodImps.set(namesBySelector.get(selPtr), registeredCallbacks.get(imp));
            return true;
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
            const allowDestroyed = new Set([GLASS_VIEW, BACKING_VIEW, DEFAULT_CENTER]);
            assert.ok(!destroyed || allowDestroyed.has(recv), `destroyed window/view dereferenced via ${name}`);
            calls.push([name, recv, ...args]);

            if (isStructReturn && name === 'bounds' && recv === CONTENT_VIEW) {
              return { origin: { x: 0, y: 0 }, size: { width: 1120, height: 740 } };
            }
            if (name === 'window' && recv === NATIVE_VIEW) return NATIVE_WINDOW;
            if (name === 'contentView' && recv === NATIVE_WINDOW) return CONTENT_VIEW;
            if (name === 'vibrantView' && recv === NATIVE_WINDOW) return hasVibrantView ? VIBRANT_VIEW : 0n;
            if (name === 'subviews' && recv === CONTENT_VIEW) return 0x3100n;
            if (name === 'count' && recv === 0x3100n) return 0n;
            if (name === 'alloc' && recv === GLASS_CLASS) return GLASS_ALLOC;
            if (name === 'initWithFrame:' && recv === GLASS_ALLOC) return GLASS_VIEW;
            if (name === 'alloc' && recv === NSVIEW_CLASS) { backingAllocCount += 1; return BACKING_ALLOC; }
            if (name === 'initWithFrame:' && recv === BACKING_ALLOC) return BACKING_VIEW;
            if (name === 'alloc' && recv === OBSERVER_CLASS) return OBSERVER_ALLOC;
            if (name === 'init' && recv === OBSERVER_ALLOC) return OBSERVER_INSTANCE;
            if (name === 'defaultCenter' && recv === CENTER_CLASS) return DEFAULT_CENTER;
            if (name === 'stringWithUTF8String:' && recv === NSSTRING_CLASS) {
              const ptr = nextColorId;
              nextColorId += 1n;
              createdStrings.set(ptr, args[0]);
              return ptr;
            }
            if (name === 'clearColor' && recv === NSCOLOR_CLASS) return CLEAR_COLOR;
            if (name === 'colorWithSRGBRed:green:blue:alpha:' && recv === NSCOLOR_CLASS) {
              const nsColor = nextColorId;
              const cgColor = nextColorId + 1n;
              nextColorId += 2n;
              srgbColors.set(nsColor, args);
              cgColors.set(cgColor, args);
              return nsColor;
            }
            if (name === 'CGColor' && srgbColors.has(recv)) return recv + 1n;
            if (name === 'layer' && recv === BACKING_VIEW) return BACKING_LAYER;
            if (name === 'superview' && recv === GLASS_VIEW) return glassSuperview;
            if (name === 'superview' && recv === BACKING_VIEW) return backingSuperview;
            if (name === 'addSubview:positioned:relativeTo:' && recv === CONTENT_VIEW) {
              if (args[0] === GLASS_VIEW) glassSuperview = CONTENT_VIEW;
              if (args[0] === BACKING_VIEW) backingSuperview = CONTENT_VIEW;
            }
            if (name === 'removeFromSuperview' && recv === GLASS_VIEW) glassSuperview = 0n;
            if (name === 'removeFromSuperview' && recv === BACKING_VIEW) backingSuperview = 0n;
            if (name === 'release' && recv === GLASS_VIEW) released += 1;
            if (name === 'release' && recv === BACKING_VIEW) backingReleased += 1;
            if (name === 'isHidden') {
              if (recv === GLASS_VIEW) return glassHidden;
              if (recv === VIBRANT_VIEW) return vibrantHidden;
              if (recv === BACKING_VIEW) return backingHidden;
            }
            if (name === 'setHidden:') {
              if (recv === GLASS_VIEW) glassHidden = Boolean(args[0]);
              if (recv === VIBRANT_VIEW) vibrantHidden = Boolean(args[0]);
              if (recv === BACKING_VIEW) backingHidden = Boolean(args[0]);
            }
            if (name === 'addObserver:selector:name:object:' && recv === DEFAULT_CENTER) {
              observers.push({
                observer: args[0],
                selName: namesBySelector.get(args[1]),
                notifName: createdStrings.get(args[2]),
                object: args[3]
              });
            }
            if (name === 'removeObserver:' && recv === DEFAULT_CENTER) {
              observers.length = 0;
            }
            if (name === 'object' && recv === 0xD001n) return NATIVE_WINDOW;
            if (name === '_cornerRadius' && recv === NATIVE_WINDOW) {
              return windowCornerRadius;
            }
            if (name === 'respondsToSelector:') {
              const targetSel = namesBySelector.get(args[0]);
              if (targetSel === '_cornerRadius') return hasPrivateCornerRadius;
              return [
                'setStyle:',
                'setCornerRadius:',
                'setMasksToBounds:',
                'setOpaque:',
                'setBackgroundColor:',
                'superview',
                'vibrantView',
                'subviews',
                'isHidden',
                'setHidden:',
                'setWantsLayer:',
                'layer',
                'CGColor'
              ].includes(targetSel);
            }
            return 0n;
          };
        }
        throw new Error(`unexpected objc fn: ${fnName}`);
      }
    })
  };

  function postWindowNotification(notifName) {
    for (const entry of [...observers]) {
      if (entry.notifName !== notifName) continue;
      const fn = methodImps.get(entry.selName);
      if (fn) fn(entry.observer, 0n, 0xD001n);
    }
  }

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
      BACKING_VIEW,
      BACKING_LAYER,
      VIBRANT_VIEW,
      CLEAR_COLOR
    },
    getReleased: () => released,
    getBackingStats: () => ({
      allocCount: backingAllocCount,
      released: backingReleased,
      superview: backingSuperview,
      backingHidden,
      glassHidden,
      vibrantHidden,
      observerCount: observers.length,
      cgColors
    }),
    setVibrantView: (active) => { hasVibrantView = Boolean(active); },
    postWindowNotification,
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

test('minimize backing hides NSGlassEffectView and inserts solid backing across Light and Dark themes', () => {
  const harness = createMockObjcHarness({ enableMinimizeBridge: true, windowCornerRadius: 16 });
  const api = createMacosGlassApi(harness.koffi);
  const win = harness.makeWindow({ fullScreen: false });
  const { CONTENT_VIEW, BACKING_VIEW, BACKING_LAYER, NATIVE_WINDOW, CLEAR_COLOR } = harness.constants;

  let surfaceHex = '#f5f5f5';
  let restoreCalls = 0;
  assert.equal(applyMacosGlass(win, 'liquid-glass', { platform: 'darwin', api }), true);
  assert.equal(syncMacosMinimizeBacking(win, {
    platform: 'darwin',
    api,
    getBackgroundHex: () => surfaceHex,
    onRestore: () => { restoreCalls += 1; }
  }), true);
  assert.equal(harness.getBackingStats().observerCount, 2);

  harness.postWindowNotification('NSWindowWillMiniaturizeNotification');
  let stats = harness.getBackingStats();
  assert.equal(stats.glassHidden, true, 'liquid glass view is hidden while minimized');
  assert.equal(stats.backingHidden, false, 'solid backing view is shown while minimized');
  assert.equal(stats.superview, CONTENT_VIEW);
  assert.equal(stats.allocCount, 1);

  const bgCalls = harness.calls.filter(([name, recv]) => name === 'setBackgroundColor:' && recv === BACKING_LAYER);
  assert.equal(bgCalls.length, 1);
  const lightRgba = stats.cgColors.get(bgCalls[0][2]);
  assert.ok(Math.abs(lightRgba[0] - 0xf5 / 255) < 1e-6 && lightRgba[3] === 1.0);
  assert.ok(harness.calls.some(([name]) => name === 'flush'), 'CATransaction flush runs before minimize capture');
  assert.ok(harness.calls.some(([name, recv, arg]) => name === 'setCornerRadius:' && recv === BACKING_LAYER && arg === 16));
  assert.ok(harness.calls.some(([name, recv, arg]) => name === 'setMasksToBounds:' && recv === BACKING_LAYER && arg === true));

  harness.postWindowNotification('NSWindowDidDeminiaturizeNotification');
  stats = harness.getBackingStats();
  assert.equal(stats.glassHidden, false, 'liquid glass view is unhidden after deminiaturize');
  assert.equal(stats.backingHidden, true);
  assert.equal(stats.superview, 0n, 'backing view is removed from contentView on restore');
  assert.equal(restoreCalls, 1);
  assert.deepEqual(harness.calls.filter(([name, recv]) => name === 'setBackgroundColor:' && recv === NATIVE_WINDOW).at(-1), [
    'setBackgroundColor:',
    NATIVE_WINDOW,
    CLEAR_COLOR
  ]);

  // Second minimize after theme switched to Dark reuses the retained backing view and updates color.
  surfaceHex = '#141414';
  harness.postWindowNotification('NSWindowWillMiniaturizeNotification');
  stats = harness.getBackingStats();
  assert.equal(stats.allocCount, 1, 'reuses lazily allocated backing view across minimizes');
  const latestDarkCg = harness.calls.filter(([name, recv]) => name === 'setBackgroundColor:' && recv === BACKING_LAYER).at(-1)[2];
  const darkRgba = stats.cgColors.get(latestDarkCg);
  assert.ok(Math.abs(darkRgba[0] - 0x14 / 255) < 1e-6 && darkRgba[3] === 1.0);
  assert.ok(harness.calls.some(([name, recv, arg]) => name === 'addSubview:positioned:relativeTo:' && recv === CONTENT_VIEW && arg === BACKING_VIEW));
});

test('minimize backing protects vibrancy windows, supports reveal fallback, and detaches cleanly', () => {
  const harness = createMockObjcHarness({ enableMinimizeBridge: true, hasVibrantView: true });
  const api = createMacosGlassApi(harness.koffi);
  const win = harness.makeWindow();
  let restoreCalls = 0;

  assert.equal(syncMacosMinimizeBacking(win, {
    platform: 'darwin',
    api,
    getBackgroundHex: () => '#141414',
    onRestore: () => { restoreCalls += 1; }
  }), true);

  harness.postWindowNotification('NSWindowWillMiniaturizeNotification');
  assert.equal(harness.getBackingStats().vibrantHidden, true, 'Electron vibrantView is hidden while minimized');
  assert.equal(harness.getBackingStats().backingHidden, false);

  // Toggling liquid-glass -> vibrancy via clearMacosGlass(..., { keepMinimizeBacking: true }) retains observer.
  assert.equal(clearMacosGlass(win, { platform: 'darwin', api, keepMinimizeBacking: true }), false);
  assert.equal(harness.getBackingStats().observerCount, 2);

  // Reveal safeguard restores hidden vibrantView if Notification was missed.
  assert.equal(restoreMacosMinimizeBacking(win, { platform: 'darwin', api }), true);
  assert.equal(harness.getBackingStats().vibrantHidden, false);
  assert.equal(restoreCalls, 1);
  assert.equal(restoreMacosMinimizeBacking(win, { platform: 'darwin', api }), false);

  // Disabling glass releases backing view and removes NSNotificationCenter observer.
  assert.equal(clearMacosMinimizeBacking(win, { platform: 'darwin', api }), true);
  assert.equal(harness.getBackingStats().released, 1);
  assert.equal(harness.getBackingStats().observerCount, 0);
});

test('closing a minimized window releases views and observer without touching destroyed pointers', () => {
  const harness = createMockObjcHarness({ enableMinimizeBridge: true, hasVibrantView: true });
  const api = createMacosGlassApi(harness.koffi);
  const win = harness.makeWindow();

  assert.equal(applyMacosGlass(win, 'liquid-glass', { platform: 'darwin', api }), true);
  assert.equal(syncMacosMinimizeBacking(win, {
    platform: 'darwin',
    api,
    getBackgroundHex: () => '#f5f5f5'
  }), true);
  assert.equal(win.closedListenerCount(), 1);

  harness.postWindowNotification('NSWindowWillMiniaturizeNotification');
  assert.equal(harness.getBackingStats().glassHidden, true);

  win.emitClosed();
  assert.equal(harness.getReleased(), 1);
  assert.equal(harness.getBackingStats().released, 1);
  assert.equal(harness.getBackingStats().superview, 0n);
  assert.equal(harness.getBackingStats().observerCount, 0);

  assert.equal(clearMacosGlass(win, { platform: 'darwin', api }), false);
  assert.equal(clearMacosMinimizeBacking(win, { platform: 'darwin', api }), false);
  assert.equal(restoreMacosMinimizeBacking(win, { platform: 'darwin', api }), false);
});
