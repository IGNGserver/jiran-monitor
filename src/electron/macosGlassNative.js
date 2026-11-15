'use strict';

// Electron exposes the native NSView handle on macOS, but not AppKit's
// NSGlassEffectView. Use the Objective-C runtime through the already bundled
// koffi dependency. The bridge is deliberately lazy and best-effort: older
// macOS versions simply fall back to Electron's documented vibrancy material.

const modeApi = require('./macosGlassMode');

let macosGlassApi = null;
const OBSERVER_CLASS_NAME = 'JiranWindowMinimizeObserver';
const OBSERVER_DISPATCH_SYMBOL = Symbol.for('jiran.macosMinimizeObserverByClass');
const DEFAULT_BACKING_HEX = '#f5f5f5';
const KOFFI_RECT_TYPES = new WeakMap();

function getRectStructTypes(koffi) {
  let cached = KOFFI_RECT_TYPES.get(koffi);
  if (!cached) {
    const NSPoint = koffi.struct('TOKEN_MONITOR_NSPOINT', { x: 'double', y: 'double' });
    const NSSize = koffi.struct('TOKEN_MONITOR_NSSIZE', { width: 'double', height: 'double' });
    const NSRect = koffi.struct('TOKEN_MONITOR_NSRECT', { origin: NSPoint, size: NSSize });
    cached = { NSPoint, NSSize, NSRect };
    KOFFI_RECT_TYPES.set(koffi, cached);
  }
  return cached;
}

function getObserverDispatchStore() {
  if (!globalThis[OBSERVER_DISPATCH_SYMBOL]) {
    globalThis[OBSERVER_DISPATCH_SYMBOL] = new Map();
  }
  return globalThis[OBSERVER_DISPATCH_SYMBOL];
}

function parseHexColor(hex, fallback = DEFAULT_BACKING_HEX) {
  const source = typeof hex === 'string' ? hex.trim() : '';
  const normalized = /^#[0-9a-f]{6}$/i.test(source) ? source : fallback;
  return {
    red: Number.parseInt(normalized.slice(1, 3), 16) / 255,
    green: Number.parseInt(normalized.slice(3, 5), 16) / 255,
    blue: Number.parseInt(normalized.slice(5, 7), 16) / 255
  };
}

function nativeHandleValue(win) {
  const handle = win.getNativeWindowHandle();
  return handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
}

function pointerKey(value) {
  return String(value);
}

function createMacosGlassApi(koffi) {
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const { NSRect } = getRectStructTypes(koffi);

  const objcGetClass = objc.func('objc_getClass', 'uintptr_t', ['str']);
  const selRegisterName = objc.func('sel_registerName', 'uintptr_t', ['str']);
  const sendPtr = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t']);
  const sendPtrStr = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'str']);
  const sendPtrUint64 = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'uint64_t']);
  const sendPtrDoubles4 = objc.func('objc_msgSend', 'uintptr_t', [
    'uintptr_t',
    'uintptr_t',
    'double',
    'double',
    'double',
    'double'
  ]);
  const sendPtrRect = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', NSRect]);
  const sendRect = objc.func('objc_msgSend', NSRect, ['uintptr_t', 'uintptr_t']);
  const sendRectStret = process.arch === 'x64'
    ? objc.func('objc_msgSend_stret', 'void', [koffi.out(koffi.pointer(NSRect)), 'uintptr_t', 'uintptr_t'])
    : null;
  const sendVoid = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t']);
  const sendVoidPtr = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'uintptr_t']);
  const sendVoidPtrInt64Ptr = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'uintptr_t', 'int64_t', 'uintptr_t']);
  const sendVoidPtrPtrPtrPtr = objc.func('objc_msgSend', 'void', [
    'uintptr_t',
    'uintptr_t',
    'uintptr_t',
    'uintptr_t',
    'uintptr_t',
    'uintptr_t'
  ]);
  const sendVoidInt64 = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'int64_t']);
  const sendVoidUint64 = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'uint64_t']);
  const sendVoidBool = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'bool']);
  const sendVoidDouble = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'double']);
  const sendVoidRect = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', NSRect]);
  const sendDouble = objc.func('objc_msgSend', 'double', ['uintptr_t', 'uintptr_t']);
  const sendUint64 = objc.func('objc_msgSend', 'uint64_t', ['uintptr_t', 'uintptr_t']);
  const sendBool = objc.func('objc_msgSend', 'bool', ['uintptr_t', 'uintptr_t']);
  const sendBoolPtr = objc.func('objc_msgSend', 'bool', ['uintptr_t', 'uintptr_t', 'uintptr_t']);

  function optionalObjcFunc(name, retType, argTypes) {
    try {
      return objc.func(name, retType, argTypes);
    } catch (_) {
      return null;
    }
  }

  const selectors = new Map();
  const selector = (name) => {
    if (!selectors.has(name)) selectors.set(name, selRegisterName(name));
    return selectors.get(name);
  };

  const selWindow = selector('window');
  const selContentView = selector('contentView');
  const selSuperview = selector('superview');
  const selBounds = selector('bounds');
  const selAlloc = selector('alloc');
  const selInitWithFrame = selector('initWithFrame:');
  const selAddSubviewPositionedRelativeTo = selector('addSubview:positioned:relativeTo:');
  const selRemoveFromSuperview = selector('removeFromSuperview');
  const selSetFrame = selector('setFrame:');
  const selSetAutoresizingMask = selector('setAutoresizingMask:');
  const selSetStyle = selector('setStyle:');
  const selSetCornerRadius = selector('setCornerRadius:');
  const selSetOpaque = selector('setOpaque:');
  const selSetBackgroundColor = selector('setBackgroundColor:');
  const selClearColor = selector('clearColor');
  const selPrivateCornerRadius = selector('_cornerRadius');
  const selRespondsToSelector = selector('respondsToSelector:');
  const selRelease = selector('release');
  const selInit = selector('init');
  const selVibrantView = selector('vibrantView');
  const selSubviews = selector('subviews');
  const selCount = selector('count');
  const selObjectAtIndex = selector('objectAtIndex:');
  const selIsKindOfClass = selector('isKindOfClass:');
  const selIsHidden = selector('isHidden');
  const selSetHidden = selector('setHidden:');
  const selSetWantsLayer = selector('setWantsLayer:');
  const selLayer = selector('layer');
  const selSetMasksToBounds = selector('setMasksToBounds:');
  const selColorWithSRGBRedGreenBlueAlpha = selector('colorWithSRGBRed:green:blue:alpha:');
  const selCGColor = selector('CGColor');
  const selBegin = selector('begin');
  const selCommit = selector('commit');
  const selFlush = selector('flush');
  const selSetDisableActions = selector('setDisableActions:');
  const selDefaultCenter = selector('defaultCenter');
  const selAddObserverSelectorNameObject = selector('addObserver:selector:name:object:');
  const selRemoveObserver = selector('removeObserver:');
  const selObject = selector('object');
  const selStringWithUTF8String = selector('stringWithUTF8String:');
  const selWillMiniaturize = selector('handleWillMiniaturize:');
  const selDidDeminiaturize = selector('handleDidDeminiaturize:');

  const glassViews = new Map();
  const minimizeStates = new Map();
  const liquidGlassClass = objcGetClass('NSGlassEffectView');
  const nsVisualEffectClass = objcGetClass('NSVisualEffectView');
  const nsViewClass = objcGetClass('NSView');
  const nsColorClass = objcGetClass('NSColor');
  const nsStringClass = objcGetClass('NSString');
  const nsObjectClass = objcGetClass('NSObject');
  const notificationCenterClass = objcGetClass('NSNotificationCenter');
  const caTransactionClass = objcGetClass('CATransaction');
  const NS_WINDOW_BELOW = -1;
  const NS_VIEW_WIDTH_SIZABLE = 1n << 1n;
  const NS_VIEW_HEIGHT_SIZABLE = 1n << 4n;
  // AppKit NSGlassEffectViewStyleRegular = 0 (1 is the thinner Clear style).
  const NS_GLASS_EFFECT_STYLE_REGULAR = 0;
  const DEFAULT_WINDOW_CORNER_RADIUS = 16;

  function responds(object, sel) {
    return Boolean(object && sendBoolPtr(object, selRespondsToSelector, sel));
  }

  function contentBounds(contentView) {
    try {
      let bounds;
      if (sendRectStret) {
        bounds = {};
        sendRectStret(bounds, contentView, selBounds);
      } else {
        bounds = sendRect(contentView, selBounds);
      }
      if (bounds && bounds.size) return bounds;
    } catch (_) {
      // Some Electron/macOS combinations do not expose NSRect through FFI.
    }
    return { origin: { x: 0, y: 0 }, size: { width: 0, height: 0 } };
  }

  function removeGlassByKey(key) {
    if (!key) return false;
    const glassView = glassViews.get(key);
    if (!glassView) return false;
    glassViews.delete(key);
    try { sendVoid(glassView, selRemoveFromSuperview); } catch (_) {}
    // alloc/init handed us an owned (+1) reference that this map keeps for as
    // long as the glass is shown — it is what keeps the pointer valid if the
    // window's content view goes away first. Give it back once the view is out
    // of the hierarchy; without this every material switch leaked one
    // window-sized NSGlassEffectView.
    try { sendVoid(glassView, selRelease); } catch (_) {}
    return true;
  }

  function ensureWindowTransparentBacking(nativeWindow) {
    if (responds(nativeWindow, selSetOpaque)) {
      sendVoidBool(nativeWindow, selSetOpaque, false);
    }
    const clearColor = nsColorClass && selClearColor ? sendPtr(nsColorClass, selClearColor) : 0;
    if (clearColor && responds(nativeWindow, selSetBackgroundColor)) {
      sendVoidPtr(nativeWindow, selSetBackgroundColor, clearColor);
    }
  }

  function resolveWindowCornerRadius(nativeWindow, fullScreen = false) {
    if (fullScreen) return 0;
    try {
      if (responds(nativeWindow, selPrivateCornerRadius)) {
        const radius = sendDouble(nativeWindow, selPrivateCornerRadius);
        if (Number.isFinite(radius) && radius >= 0) return radius;
      }
    } catch (_) {}
    return DEFAULT_WINDOW_CORNER_RADIUS;
  }

  function applyGlass(nativeView, options = {}) {
    if (!nativeView || !liquidGlassClass) return false;
    const nativeWindow = sendPtr(nativeView, selWindow);
    const contentView = nativeWindow && sendPtr(nativeWindow, selContentView);
    if (!nativeWindow || !contentView) return false;

    ensureWindowTransparentBacking(nativeWindow);
    const frame = contentBounds(contentView);
    const key = pointerKey(nativeWindow);
    let glassView = glassViews.get(key);
    if (glassView && responds(glassView, selSuperview) && sendPtr(glassView, selSuperview) !== contentView) {
      removeGlassByKey(key);
      glassView = 0;
    }
    if (!glassView) {
      glassView = sendPtr(liquidGlassClass, selAlloc);
      glassView = glassView && sendPtrRect(glassView, selInitWithFrame, frame);
      if (!glassView) return false;
      glassViews.set(key, glassView);
      // Electron's native handle on macOS is BridgedContentView (= contentView),
      // so pass nil (0) for relativeTo to insert below all contentView subviews.
      sendVoidPtrInt64Ptr(contentView, selAddSubviewPositionedRelativeTo, glassView, NS_WINDOW_BELOW, 0);
    }

    sendVoidRect(glassView, selSetFrame, frame);
    sendVoidUint64(glassView, selSetAutoresizingMask, NS_VIEW_WIDTH_SIZABLE | NS_VIEW_HEIGHT_SIZABLE);
    if (responds(glassView, selSetStyle)) sendVoidInt64(glassView, selSetStyle, NS_GLASS_EFFECT_STYLE_REGULAR);
    if (responds(glassView, selSetCornerRadius)) {
      sendVoidDouble(glassView, selSetCornerRadius, resolveWindowCornerRadius(nativeWindow, options.fullScreen === true));
    }
    return true;
  }

  function withDisabledLayerActions(fn) {
    if (!caTransactionClass) return fn();
    sendVoid(caTransactionClass, selBegin);
    try {
      sendVoidBool(caTransactionClass, selSetDisableActions, true);
      return fn();
    } finally {
      try { sendVoid(caTransactionClass, selCommit); } catch (_) {}
      try { sendVoid(caTransactionClass, selFlush); } catch (_) {}
    }
  }

  function applySolidBackingAppearance(backingView, nativeWindow, frame, hexColor, fullScreen) {
    if (!backingView) return;
    sendVoidRect(backingView, selSetFrame, frame);
    sendVoidUint64(backingView, selSetAutoresizingMask, NS_VIEW_WIDTH_SIZABLE | NS_VIEW_HEIGHT_SIZABLE);
    if (responds(backingView, selSetWantsLayer)) sendVoidBool(backingView, selSetWantsLayer, true);
    const layer = responds(backingView, selLayer) ? sendPtr(backingView, selLayer) : 0;
    if (layer && nsColorClass) {
      const { red, green, blue } = parseHexColor(hexColor);
      const nsColor = sendPtrDoubles4(nsColorClass, selColorWithSRGBRedGreenBlueAlpha, red, green, blue, 1.0);
      const cgColor = nsColor && responds(nsColor, selCGColor) ? sendPtr(nsColor, selCGColor) : 0;
      if (cgColor) sendVoidPtr(layer, selSetBackgroundColor, cgColor);
      const radius = resolveWindowCornerRadius(nativeWindow, fullScreen === true);
      if (responds(layer, selSetCornerRadius)) sendVoidDouble(layer, selSetCornerRadius, radius);
      if (responds(layer, selSetMasksToBounds)) sendVoidBool(layer, selSetMasksToBounds, radius > 0);
    }
    if (responds(backingView, selSetHidden)) sendVoidBool(backingView, selSetHidden, false);
  }

  function collectActiveEffectViews(nativeWindow, contentView, key, excludeView) {
    const collected = [];
    const seen = new Set();
    const pushIfEffectView = (view) => {
      if (!view || view === excludeView) return;
      const viewKey = pointerKey(view);
      if (seen.has(viewKey)) return;
      seen.add(viewKey);
      collected.push(view);
    };

    pushIfEffectView(glassViews.get(key));
    if (responds(nativeWindow, selVibrantView)) {
      pushIfEffectView(sendPtr(nativeWindow, selVibrantView));
    }

    if ((nsVisualEffectClass || liquidGlassClass) && responds(contentView, selSubviews)) {
      const subviews = sendPtr(contentView, selSubviews);
      if (subviews) {
        const count = Number(sendUint64(subviews, selCount));
        for (let index = 0; index < count; index += 1) {
          const child = sendPtrUint64(subviews, selObjectAtIndex, BigInt(index));
          if (!child || child === excludeView) continue;
          const isVisualEffect = Boolean(
            nsVisualEffectClass && responds(child, selIsKindOfClass) && sendBoolPtr(child, selIsKindOfClass, nsVisualEffectClass)
          );
          const isLiquidGlass = Boolean(
            liquidGlassClass && responds(child, selIsKindOfClass) && sendBoolPtr(child, selIsKindOfClass, liquidGlassClass)
          );
          if (isVisualEffect || isLiquidGlass) pushIfEffectView(child);
        }
      }
    }
    return collected;
  }

  function hideViewsForMinimize(state, views) {
    const recorded = new Set(state.hiddenViews.map(pointerKey));
    for (const view of views) {
      if (!view || recorded.has(pointerKey(view))) continue;
      if (!responds(view, selSetHidden)) continue;
      if (responds(view, selIsHidden) && sendBool(view, selIsHidden)) continue;
      sendVoidBool(view, selSetHidden, true);
      state.hiddenViews.push(view);
      recorded.add(pointerKey(view));
    }
  }

  function unhideSuppressedViews(state) {
    for (const view of state.hiddenViews.splice(0)) {
      if (view && responds(view, selSetHidden)) {
        try { sendVoidBool(view, selSetHidden, false); } catch (_) {}
      }
    }
  }

  function createNotificationObserverBridge() {
    if (
      !notificationCenterClass
      || !nsStringClass
      || !nsObjectClass
      || typeof koffi.proto !== 'function'
      || typeof koffi.register !== 'function'
      || typeof koffi.address !== 'function'
    ) {
      return null;
    }

    const objcLookUpClass = optionalObjcFunc('objc_lookUpClass', 'uintptr_t', ['str']);
    const objcAllocateClassPair = optionalObjcFunc('objc_allocateClassPair', 'uintptr_t', ['uintptr_t', 'str', 'size_t']);
    const objcRegisterClassPair = optionalObjcFunc('objc_registerClassPair', 'void', ['uintptr_t']);
    const classAddMethod = optionalObjcFunc('class_addMethod', 'bool', ['uintptr_t', 'uintptr_t', 'uintptr_t', 'str']);
    if (!objcAllocateClassPair || !objcRegisterClassPair || !classAddMethod) return null;

    const dispatchStore = getObserverDispatchStore();
    const existingClass = objcLookUpClass ? objcLookUpClass(OBSERVER_CLASS_NAME) : 0;
    let dispatch = existingClass ? dispatchStore.get(String(existingClass)) : null;

    if (!dispatch) {
      const obsCls = existingClass || objcAllocateClassPair(nsObjectClass, OBSERVER_CLASS_NAME, 0);
      if (!obsCls) return null;

      dispatch = {
        observer: 0,
        willHandlers: new Map(),
        didHandlers: new Map(),
        onWillCb: null,
        onDidCb: null
      };

      if (!existingClass) {
        const handlerProto = koffi.proto('void (uintptr_t, uintptr_t, uintptr_t)');
        const handlerPtrType = koffi.pointer(handlerProto);
        dispatch.onWillCb = koffi.register((_self, _cmd, notification) => {
          const notifWin = notification ? sendPtr(notification, selObject) : 0;
          const fn = notifWin ? dispatch.willHandlers.get(pointerKey(notifWin)) : null;
          if (typeof fn === 'function') fn();
        }, handlerPtrType);
        dispatch.onDidCb = koffi.register((_self, _cmd, notification) => {
          const notifWin = notification ? sendPtr(notification, selObject) : 0;
          const fn = notifWin ? dispatch.didHandlers.get(pointerKey(notifWin)) : null;
          if (typeof fn === 'function') fn();
        }, handlerPtrType);

        const addedWill = classAddMethod(obsCls, selWillMiniaturize, koffi.address(dispatch.onWillCb), 'v@:@');
        const addedDid = classAddMethod(obsCls, selDidDeminiaturize, koffi.address(dispatch.onDidCb), 'v@:@');
        if (!addedWill || !addedDid) return null;
        objcRegisterClassPair(obsCls);
      }

      const allocatedObserver = sendPtr(obsCls, selAlloc);
      dispatch.observer = allocatedObserver && sendPtr(allocatedObserver, selInit);
      if (!dispatch.observer) return null;
      dispatchStore.set(String(obsCls), dispatch);
    }

    const center = sendPtr(notificationCenterClass, selDefaultCenter);
    if (!center) return null;

    return {
      attach(key, willHandler, didHandler) {
        const wasEmpty = dispatch.willHandlers.size === 0 && dispatch.didHandlers.size === 0;
        dispatch.willHandlers.set(key, willHandler);
        dispatch.didHandlers.set(key, didHandler);
        if (wasEmpty) {
          const willName = sendPtrStr(nsStringClass, selStringWithUTF8String, 'NSWindowWillMiniaturizeNotification');
          const didName = sendPtrStr(nsStringClass, selStringWithUTF8String, 'NSWindowDidDeminiaturizeNotification');
          if (willName) sendVoidPtrPtrPtrPtr(center, selAddObserverSelectorNameObject, dispatch.observer, selWillMiniaturize, willName, 0);
          if (didName) sendVoidPtrPtrPtrPtr(center, selAddObserverSelectorNameObject, dispatch.observer, selDidDeminiaturize, didName, 0);
        }
      },
      detach(key) {
        const removedWill = dispatch.willHandlers.delete(key);
        const removedDid = dispatch.didHandlers.delete(key);
        if ((removedWill || removedDid) && dispatch.willHandlers.size === 0 && dispatch.didHandlers.size === 0) {
          try { sendVoidPtr(center, selRemoveObserver, dispatch.observer); } catch (_) {}
        }
      }
    };
  }

  let observerBridge = null;
  let observerBridgeInitialized = false;
  function getObserverBridge() {
    if (!observerBridgeInitialized) {
      observerBridgeInitialized = true;
      try {
        observerBridge = createNotificationObserverBridge();
      } catch (_) {
        observerBridge = null;
      }
    }
    return observerBridge;
  }

  function ensureBackingView(state, frame) {
    if (state.backingView) return state.backingView;
    if (!nsViewClass) return 0;
    const allocated = sendPtr(nsViewClass, selAlloc);
    const backingView = allocated && sendPtrRect(allocated, selInitWithFrame, frame);
    if (!backingView) return 0;
    state.backingView = backingView;
    return backingView;
  }

  function beginMinimizeBacking(state) {
    if (!state || !state.nativeWindow || !state.contentView) return false;
    // Switch inside an action-free CATransaction and flush immediately so AppKit's
    // pre-minimize backing capture sees the opaque solid view instead of deactivated blur.
    return withDisabledLayerActions(() => {
      const frame = contentBounds(state.contentView);
      const backingView = ensureBackingView(state, frame);
      if (!backingView) return false;
      const hexColor = typeof state.getBackgroundHex === 'function' ? state.getBackgroundHex() : DEFAULT_BACKING_HEX;
      applySolidBackingAppearance(backingView, state.nativeWindow, frame, hexColor, state.fullScreen);
      sendVoidPtrInt64Ptr(state.contentView, selAddSubviewPositionedRelativeTo, backingView, NS_WINDOW_BELOW, 0);
      const effectViews = collectActiveEffectViews(state.nativeWindow, state.contentView, state.key, backingView);
      hideViewsForMinimize(state, effectViews);
      state.suppressed = true;
      return true;
    });
  }

  function endMinimizeBacking(state, options = {}) {
    if (!state) return false;
    const wasSuppressed = state.suppressed || state.hiddenViews.length > 0;
    if (!wasSuppressed) return false;
    withDisabledLayerActions(() => {
      unhideSuppressedViews(state);
      if (state.backingView) {
        if (responds(state.backingView, selSetHidden)) {
          try { sendVoidBool(state.backingView, selSetHidden, true); } catch (_) {}
        }
        try { sendVoid(state.backingView, selRemoveFromSuperview); } catch (_) {}
      }
      ensureWindowTransparentBacking(state.nativeWindow);
      state.suppressed = false;
    });
    if (options.invokeCallback !== false && typeof state.onRestore === 'function') {
      try { state.onRestore(); } catch (_) {}
    }
    return true;
  }

  function removeMinimizeByKey(key, options = {}) {
    if (!key) return false;
    const state = minimizeStates.get(key);
    if (!state) return false;
    minimizeStates.delete(key);
    if (observerBridge) observerBridge.detach(key);
    if (options.windowDestroyed !== true) {
      endMinimizeBacking(state, { invokeCallback: false });
    } else {
      state.hiddenViews.length = 0;
      state.suppressed = false;
    }
    if (state.backingView) {
      const view = state.backingView;
      state.backingView = 0;
      try { sendVoid(view, selRemoveFromSuperview); } catch (_) {}
      try { sendVoid(view, selRelease); } catch (_) {}
    }
    return true;
  }

  function syncMinimizeBacking(nativeView, options = {}) {
    if (!nativeView || !nsViewClass) return false;
    const bridge = getObserverBridge();
    if (!bridge) return false;
    const nativeWindow = sendPtr(nativeView, selWindow);
    const contentView = nativeWindow && sendPtr(nativeWindow, selContentView);
    if (!nativeWindow || !contentView) return false;

    const key = pointerKey(nativeWindow);
    let state = minimizeStates.get(key);
    if (!state) {
      state = {
        key,
        nativeWindow,
        contentView,
        backingView: 0,
        suppressed: false,
        hiddenViews: [],
        fullScreen: options.fullScreen === true,
        getBackgroundHex: typeof options.getBackgroundHex === 'function' ? options.getBackgroundHex : null,
        onRestore: typeof options.onRestore === 'function' ? options.onRestore : null
      };
      minimizeStates.set(key, state);
      bridge.attach(
        key,
        () => beginMinimizeBacking(state),
        () => endMinimizeBacking(state, { invokeCallback: true })
      );
    } else {
      state.contentView = contentView;
      state.fullScreen = options.fullScreen === true;
      if (typeof options.getBackgroundHex === 'function') state.getBackgroundHex = options.getBackgroundHex;
      if (typeof options.onRestore === 'function') state.onRestore = options.onRestore;
    }

    if (state.suppressed) {
      beginMinimizeBacking(state);
    }
    return true;
  }

  return {
    apply(nativeView, style, options = {}) {
      if (style === modeApi.MACOS_GLASS_LIQUID) return applyGlass(nativeView, options);
      const nativeWindow = nativeView && sendPtr(nativeView, selWindow);
      if (nativeWindow) removeGlassByKey(pointerKey(nativeWindow));
      return true;
    },
    clear(nativeView) {
      if (!nativeView) return false;
      const nativeWindow = sendPtr(nativeView, selWindow);
      return nativeWindow ? removeGlassByKey(pointerKey(nativeWindow)) : false;
    },
    syncMinimizeBacking(nativeView, options = {}) {
      return syncMinimizeBacking(nativeView, options);
    },
    restoreMinimizeBacking(nativeView) {
      if (!nativeView) return false;
      const nativeWindow = sendPtr(nativeView, selWindow);
      const state = nativeWindow ? minimizeStates.get(pointerKey(nativeWindow)) : null;
      return state ? endMinimizeBacking(state, { invokeCallback: true }) : false;
    },
    clearMinimizeBacking(nativeView) {
      if (!nativeView) return false;
      const nativeWindow = sendPtr(nativeView, selWindow);
      return nativeWindow ? removeMinimizeByKey(pointerKey(nativeWindow), { windowDestroyed: false }) : false;
    },
    windowKeyFor(nativeView) {
      if (!nativeView) return null;
      const nativeWindow = sendPtr(nativeView, selWindow);
      return nativeWindow ? pointerKey(nativeWindow) : null;
    },
    clearByKey(key, options = {}) {
      const removedGlass = removeGlassByKey(key);
      const removedMinimize = removeMinimizeByKey(key, options);
      return removedGlass || removedMinimize;
    },
    supported: Boolean(liquidGlassClass)
  };
}

function loadMacosGlassApi() {
  if (macosGlassApi !== null) return macosGlassApi;
  if (process.platform !== 'darwin') {
    macosGlassApi = false;
    return macosGlassApi;
  }
  try {
    macosGlassApi = createMacosGlassApi(require('koffi'));
  } catch (_) {
    macosGlassApi = false;
  }
  return macosGlassApi;
}

const trackedWindowCleanups = new WeakMap();

function clearTrackedWindow(win) {
  const entry = trackedWindowCleanups.get(win);
  if (!entry?.key || typeof entry.api?.clearByKey !== 'function') return false;
  const pendingKey = entry.key;
  const pendingApi = entry.api;
  entry.key = null;
  entry.hasGlass = false;
  entry.hasMinimize = false;
  try {
    return pendingApi.clearByKey(pendingKey, { windowDestroyed: true }) === true;
  } catch (_) {
    return false;
  }
}

function registerWindowCleanup(win, api, key, kind = 'glass') {
  if (!win || !api || !key || typeof api.clearByKey !== 'function') return;
  let entry = trackedWindowCleanups.get(win);
  if (!entry) {
    entry = { api, key, hasGlass: false, hasMinimize: false, cleanupInstalled: false };
    trackedWindowCleanups.set(win, entry);
  } else {
    entry.api = api;
    entry.key = key;
  }
  if (kind === 'minimize') entry.hasMinimize = true;
  else entry.hasGlass = true;
  if (!entry.cleanupInstalled && typeof win.once === 'function') {
    entry.cleanupInstalled = true;
    win.once('closed', () => {
      clearTrackedWindow(win);
      trackedWindowCleanups.delete(win);
    });
  }
}

function clearTrackedCleanupKind(win, kind) {
  const entry = trackedWindowCleanups.get(win);
  if (!entry) return;
  if (kind === 'minimize') entry.hasMinimize = false;
  else entry.hasGlass = false;
  if (!entry.hasGlass && !entry.hasMinimize) entry.key = null;
}

function applyMacosGlass(win, style, options = {}) {
  if ((options.platform || process.platform) !== 'darwin') return false;
  if (!win || win.isDestroyed?.()) return false;
  const api = options.api || loadMacosGlassApi();
  if (!api) return false;
  try {
    const normalizedStyle = modeApi.normalizeMacosGlassStyle(style);
    const nativeView = nativeHandleValue(win);
    const ok = api.apply(nativeView, normalizedStyle, {
      fullScreen: options.fullScreen ?? Boolean(win.isFullScreen?.())
    }) === true;
    if (ok && normalizedStyle === modeApi.MACOS_GLASS_LIQUID) {
      const key = typeof api.windowKeyFor === 'function' ? api.windowKeyFor(nativeView) : null;
      if (key) registerWindowCleanup(win, api, key, 'glass');
    } else if (ok) {
      clearTrackedCleanupKind(win, 'glass');
    }
    return ok;
  } catch (_) {
    return false;
  }
}

function clearMacosGlass(win, options = {}) {
  if ((options.platform || process.platform) !== 'darwin') return false;
  if (!win) return false;
  if (win.isDestroyed?.()) return clearTrackedWindow(win);
  const api = options.api || loadMacosGlassApi();
  if (!api) return false;
  try {
    const nativeView = nativeHandleValue(win);
    const cleared = api.clear(nativeView) === true;
    clearTrackedCleanupKind(win, 'glass');
    if (options.keepMinimizeBacking !== true && typeof api.clearMinimizeBacking === 'function') {
      api.clearMinimizeBacking(nativeView);
      clearTrackedCleanupKind(win, 'minimize');
    }
    return cleared;
  } catch (_) {
    return clearTrackedWindow(win);
  }
}

function syncMacosMinimizeBacking(win, options = {}) {
  if ((options.platform || process.platform) !== 'darwin') return false;
  if (!win || win.isDestroyed?.()) return false;
  const api = options.api || loadMacosGlassApi();
  if (!api || typeof api.syncMinimizeBacking !== 'function') return false;
  try {
    const nativeView = nativeHandleValue(win);
    const ok = api.syncMinimizeBacking(nativeView, {
      fullScreen: options.fullScreen ?? Boolean(win.isFullScreen?.()),
      getBackgroundHex: options.getBackgroundHex,
      onRestore: options.onRestore
    }) === true;
    if (ok) {
      const key = typeof api.windowKeyFor === 'function' ? api.windowKeyFor(nativeView) : null;
      if (key) registerWindowCleanup(win, api, key, 'minimize');
    }
    return ok;
  } catch (_) {
    return false;
  }
}

function restoreMacosMinimizeBacking(win, options = {}) {
  if ((options.platform || process.platform) !== 'darwin') return false;
  if (!win || win.isDestroyed?.()) return false;
  const api = options.api || loadMacosGlassApi();
  if (!api || typeof api.restoreMinimizeBacking !== 'function') return false;
  try {
    return api.restoreMinimizeBacking(nativeHandleValue(win)) === true;
  } catch (_) {
    return false;
  }
}

function clearMacosMinimizeBacking(win, options = {}) {
  if ((options.platform || process.platform) !== 'darwin') return false;
  if (!win) return false;
  if (win.isDestroyed?.()) return clearTrackedWindow(win);
  const api = options.api || loadMacosGlassApi();
  if (!api || typeof api.clearMinimizeBacking !== 'function') return false;
  try {
    const cleared = api.clearMinimizeBacking(nativeHandleValue(win)) === true;
    clearTrackedCleanupKind(win, 'minimize');
    return cleared;
  } catch (_) {
    return clearTrackedWindow(win);
  }
}

function macosLiquidGlassSupported(options = {}) {
  const api = options.api || loadMacosGlassApi();
  return Boolean(api?.supported);
}

module.exports = {
  createMacosGlassApi,
  loadMacosGlassApi,
  applyMacosGlass,
  clearMacosGlass,
  syncMacosMinimizeBacking,
  restoreMacosMinimizeBacking,
  clearMacosMinimizeBacking,
  macosLiquidGlassSupported
};
