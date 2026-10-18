'use strict';

// Electron exposes the native NSView handle on macOS, but not AppKit's
// NSGlassEffectView. Use the Objective-C runtime through the already bundled
// koffi dependency. The bridge is deliberately lazy and best-effort: older
// macOS versions simply fall back to Electron's documented vibrancy material.

const modeApi = require('./macosGlassMode');

let macosGlassApi = null;

function nativeHandleValue(win) {
  const handle = win.getNativeWindowHandle();
  return handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
}

function pointerKey(value) {
  return String(value);
}

function createMacosGlassApi(koffi) {
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const NSPoint = koffi.struct('TOKEN_MONITOR_NSPOINT', { x: 'double', y: 'double' });
  const NSSize = koffi.struct('TOKEN_MONITOR_NSSIZE', { width: 'double', height: 'double' });
  const NSRect = koffi.struct('TOKEN_MONITOR_NSRECT', { origin: NSPoint, size: NSSize });

  const objcGetClass = objc.func('objc_getClass', 'uintptr_t', ['str']);
  const selRegisterName = objc.func('sel_registerName', 'uintptr_t', ['str']);
  const sendPtr = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t']);
  const sendPtrRect = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', NSRect]);
  const sendRect = objc.func('objc_msgSend', NSRect, ['uintptr_t', 'uintptr_t']);
  const sendRectStret = process.arch === 'x64'
    ? objc.func('objc_msgSend_stret', 'void', [koffi.out(koffi.pointer(NSRect)), 'uintptr_t', 'uintptr_t'])
    : null;
  const sendVoid = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t']);
  const sendVoidPtrInt64Ptr = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'uintptr_t', 'int64_t', 'uintptr_t']);
  const sendVoidUint64 = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'uint64_t']);
  const sendVoidBool = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'bool']);
  const sendVoidDouble = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'double']);
  const sendVoidRect = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', NSRect]);
  const sendBoolPtr = objc.func('objc_msgSend', 'bool', ['uintptr_t', 'uintptr_t', 'uintptr_t']);

  const selectors = new Map();
  const selector = (name) => {
    if (!selectors.has(name)) selectors.set(name, selRegisterName(name));
    return selectors.get(name);
  };

  const selWindow = selector('window');
  const selContentView = selector('contentView');
  const selBounds = selector('bounds');
  const selAlloc = selector('alloc');
  const selInitWithFrame = selector('initWithFrame:');
  const selAddSubviewPositionedRelativeTo = selector('addSubview:positioned:relativeTo:');
  const selRemoveFromSuperview = selector('removeFromSuperview');
  const selSetFrame = selector('setFrame:');
  const selSetAutoresizingMask = selector('setAutoresizingMask:');
  const selSetStyle = selector('setStyle:');
  const selSetEffectIsInteractive = selector('setEffectIsInteractive:');
  const selSetCornerRadius = selector('setCornerRadius:');
  const selRespondsToSelector = selector('respondsToSelector:');
  const selRelease = selector('release');

  const glassViews = new Map();
  const liquidGlassClass = objcGetClass('NSGlassEffectView');
  const NS_WINDOW_BELOW = -1;
  const NS_VIEW_WIDTH_SIZABLE = 1n << 1n;
  const NS_VIEW_HEIGHT_SIZABLE = 1n << 4n;
  const NS_GLASS_EFFECT_STYLE_REGULAR = 1n;

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

  function removeGlass(nativeWindow) {
    const key = pointerKey(nativeWindow);
    const glassView = glassViews.get(key);
    if (!glassView) return false;
    try { sendVoid(glassView, selRemoveFromSuperview); } catch (_) {}
    // alloc/init handed us an owned (+1) reference that this map keeps for as
    // long as the glass is shown — it is what keeps the pointer valid if the
    // window's content view goes away first. Give it back once the view is out
    // of the hierarchy; without this every material switch leaked one
    // window-sized NSGlassEffectView.
    try { sendVoid(glassView, selRelease); } catch (_) {}
    glassViews.delete(key);
    return true;
  }

  function applyGlass(nativeView) {
    if (!nativeView || !liquidGlassClass) return false;
    const nativeWindow = sendPtr(nativeView, selWindow);
    const contentView = nativeWindow && sendPtr(nativeWindow, selContentView);
    if (!nativeWindow || !contentView) return false;

    const frame = contentBounds(contentView);
    const key = pointerKey(nativeWindow);
    let glassView = glassViews.get(key);
    if (!glassView) {
      glassView = sendPtr(liquidGlassClass, selAlloc);
      glassView = glassView && sendPtrRect(glassView, selInitWithFrame, frame);
      if (!glassView) return false;
      glassViews.set(key, glassView);
      sendVoidPtrInt64Ptr(contentView, selAddSubviewPositionedRelativeTo, glassView, NS_WINDOW_BELOW, nativeView);
    }

    sendVoidRect(glassView, selSetFrame, frame);
    sendVoidUint64(glassView, selSetAutoresizingMask, NS_VIEW_WIDTH_SIZABLE | NS_VIEW_HEIGHT_SIZABLE);
    if (responds(glassView, selSetStyle)) sendVoidUint64(glassView, selSetStyle, NS_GLASS_EFFECT_STYLE_REGULAR);
    if (responds(glassView, selSetEffectIsInteractive)) sendVoidBool(glassView, selSetEffectIsInteractive, true);
    if (responds(glassView, selSetCornerRadius)) sendVoidDouble(glassView, selSetCornerRadius, 14);
    return true;
  }

  return {
    apply(nativeView, style) {
      if (style === modeApi.MACOS_GLASS_LIQUID) return applyGlass(nativeView);
      const nativeWindow = nativeView && sendPtr(nativeView, selWindow);
      if (nativeWindow) removeGlass(nativeWindow);
      return true;
    },
    clear(nativeView) {
      if (!nativeView) return false;
      const nativeWindow = sendPtr(nativeView, selWindow);
      return nativeWindow ? removeGlass(nativeWindow) : false;
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

function applyMacosGlass(win, style, options = {}) {
  if ((options.platform || process.platform) !== 'darwin') return false;
  if (!win || win.isDestroyed?.()) return false;
  const api = options.api || loadMacosGlassApi();
  if (!api) return false;
  try {
    return api.apply(nativeHandleValue(win), modeApi.normalizeMacosGlassStyle(style)) === true;
  } catch (_) {
    return false;
  }
}

function clearMacosGlass(win, options = {}) {
  if ((options.platform || process.platform) !== 'darwin') return false;
  if (!win || win.isDestroyed?.()) return false;
  const api = options.api || loadMacosGlassApi();
  if (!api) return false;
  try {
    return api.clear(nativeHandleValue(win)) === true;
  } catch (_) {
    return false;
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
  macosLiquidGlassSupported
};
