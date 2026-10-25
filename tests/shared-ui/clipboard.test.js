'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const clipboardPath = pathToFileURL(path.resolve(__dirname, '../../src/shared-ui/transport/clipboard.js')).href;

function installGlobal(name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else delete globalThis[name];
  };
}

function fakeDocument({ copied = true } = {}) {
  const textarea = {
    style: {},
    value: '',
    setAttribute() {},
    focus() {},
    select() {},
    setSelectionRange() {},
    remove() {}
  };
  const parent = {
    appendChild(node) { assert.equal(node, textarea); },
    removeChild(node) { assert.equal(node, textarea); }
  };
  return {
    activeElement: { focus() {} },
    body: parent,
    createElement(tag) {
      assert.equal(tag, 'textarea');
      return textarea;
    },
    execCommand(command) {
      assert.equal(command, 'copy');
      return copied;
    }
  };
}

test('uses the async clipboard API in a secure context', async () => {
  const { copyTextWithFallback } = await import(clipboardPath);
  const copied = [];
  const restoreNavigator = installGlobal('navigator', {
    clipboard: { writeText: async (text) => copied.push(text) }
  });
  const restoreWindow = installGlobal('window', { isSecureContext: true });
  try {
    assert.equal(await copyTextWithFallback('https://auth.example.test'), true);
    assert.deepEqual(copied, ['https://auth.example.test']);
  } finally {
    restoreWindow();
    restoreNavigator();
  }
});

test('falls back to a selection copy on an insecure page', async () => {
  const { copyTextWithFallback } = await import(clipboardPath);
  const restoreNavigator = installGlobal('navigator', {});
  const restoreWindow = installGlobal('window', { isSecureContext: false });
  const restoreDocument = installGlobal('document', fakeDocument());
  try {
    assert.equal(await copyTextWithFallback('http://hub.example.test/oauth'), true);
  } finally {
    restoreDocument();
    restoreWindow();
    restoreNavigator();
  }
});

test('falls back when the async clipboard API rejects', async () => {
  const { copyTextWithFallback } = await import(clipboardPath);
  const restoreNavigator = installGlobal('navigator', {
    clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } }
  });
  const restoreWindow = installGlobal('window', { isSecureContext: true });
  const restoreDocument = installGlobal('document', fakeDocument());
  try {
    assert.equal(await copyTextWithFallback('https://auth.example.test'), true);
  } finally {
    restoreDocument();
    restoreWindow();
    restoreNavigator();
  }
});

test('reports failure when neither clipboard path is available', async () => {
  const { copyTextWithFallback } = await import(clipboardPath);
  const restoreNavigator = installGlobal('navigator', {});
  const restoreWindow = installGlobal('window', { isSecureContext: false });
  const restoreDocument = installGlobal('document', {});
  try {
    assert.equal(await copyTextWithFallback('oauth-url'), false);
  } finally {
    restoreDocument();
    restoreWindow();
    restoreNavigator();
  }
});
