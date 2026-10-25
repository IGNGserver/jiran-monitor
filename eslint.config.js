'use strict';

const path = require('node:path');
const js = require('@eslint/js');
const globals = require('globals');
const { includeIgnoreFile } = require('@eslint/compat');

module.exports = [
  // Respect .gitignore (node_modules, dist, build, tmp, .agents, .claude, data, …)
  includeIgnoreFile(path.resolve(__dirname, '.gitignore')),
  // website/ is a standalone Astro property with its own browser conventions
  { ignores: ['website/**', 'src/shared-ui/vendor/**'] },

  js.configs.recommended,

  {
    // Default: Node CommonJS — src/**, hub, agent, scripts, tests, this config.
    // window/self are readonly because shared modules (currency, trayText,
    // windowShortcut) feature-detect them in their UMD export wrapper.
    languageOptions: {
      sourceType: 'commonjs',
      // The UMD modules (i18n, currency, trayText, …) feature-detect a browser
      // environment, so the DOM globals they guard on must be declared or every
      // `typeof document` check reads as an undefined variable.
      globals: { ...globals.node, window: 'readonly', self: 'readonly', document: 'readonly' },
    },
  },

  {
    // The desktop renderer entry is browser ESM: it imports the shared UI and
    // installs the IPC transport. The other renderer files are still UMD/CommonJS
    // and keep the block below.
    files: ['src/electron/renderer/boot.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.browser },
    },
  },

  {
    // Renderer runs in the browser; UMD modules also touch module/window.
    // boot.js is excluded: it is ESM and configured in the block above.
    files: ['src/electron/renderer/**/*.js'],
    ignores: ['src/electron/renderer/boot.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
  },


  {
    // The shared UI package is browser ESM consumed by BOTH the Hub dashboard
    // and the Electron renderer, so it may not assume either host's globals:
    // every data access goes through src/shared-ui/transport/.
    files: ['src/shared-ui/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.browser },
    },
  },

  {
    // Hub-hosted PWA assets are browser ESM (not Node CommonJS)
    files: ['src/hub/web/**/*.js'],
    ignores: ['src/hub/web/sw.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.browser },
    },
  },

  {
    files: ['src/hub/web/sw.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.serviceworker, ...globals.browser },
    },
  },

  {
    // Adjust recommended rules to the codebase's intentional idioms
    rules: {
      // CLI/terminal output parsing legitimately needs ANSI (\x1b) and NUL (\x00)
      'no-control-regex': 'off',
      // Best-effort defensive catches are deliberate
      'no-empty': ['error', { allowEmptyCatch: true }],
      // `_` is the throwaway-placeholder convention here
      'no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        // Rest-destructuring to omit keys (e.g. redacting account identity) is deliberate
        ignoreRestSiblings: true,
      }],
    },
  },
];
