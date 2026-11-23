'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { TRACKED_CLIENTS } = require('../../src/shared/clientTracking');
const { LIMIT_PROVIDER_IDS } = require('../../src/shared/limitProviders');
const { MATRIX_FILE, readMatrix, matrixStats, limitProviderIcons } = require('./supportedTools');

// Client id -> icon name mappings when they differ
const CLIENT_TO_ICON = {
  'hermes': 'hermes-agent',
  'deepseek-harness': 'deepseek-harness',
  'grok': 'xai',
  'devin-cli': 'devin',
  'devin-desktop': 'devin',
  'codebuff': 'codebuff',
  'freebuff': 'codebuff',
  'pi': 'pi',
  'omp': 'pi',
  // One matrix row covers both clients: MiMo Code's brand is `mimo-code`, and
  // Qoder / Qoder CN share the `qoder` artwork.
  'micode': 'mimo-code',
  'qodercn': 'qoder'
};

// A row's icon id is not always the provider id (a row is named after its artwork), and
// GLM / GLM Team share one row, so the two are bridged here.
const MATRIX_ICON_TO_LIMIT_PROVIDERS = {
  xai: ['grok'],
  'mimo-code': ['mimo'],
  zcode: ['zai', 'zaiteam'],
  newapi: ['thirdparty']
};

// The matrix order is the order the UI lists clients in, so it stays pinned rather than
// derived. Reword or reorder a row and this fails loudly, which is the point: with no
// per-tool selection surface, the matrix is the only place a reader can verify coverage.
const supportedToolOrder = [
  'Claude Code',
  'Claude Desktop',
  'Codex',
  'OpenCode',
  'Hermes Agent',
  'OpenClaw',
  'Cursor',
  'Antigravity',
  'Cline',
  'Kimi CLI / Kimi Code',
  'Qwen CLI',
  'Grok Build',
  'GitHub Copilot',
  'Pi / Oh My Pi',
  'Zed',
  'Kilo Code',
  'Command Code',
  'MiMo Code',
  'ZCode / GLM',
  'Kiro',
  'CodeBuddy',
  'WorkBuddy',
  'Proma',
  'DeepSeek Harness',
  'Qoder / Qoder CN',
  'Reasonix',
  'Gemini CLI',
  'Roo Code',
  'Amp',
  'Droid',
  'Mux',
  'Kilo CLI',
  'Crush',
  'Goose',
  'Codebuff / Freebuff',
  'Trae',
  'Warp / Oz',
  'Gajae-Code',
  'Jcode',
  'Junie',
  'OpenCodeReview',
  'Devin CLI / Devin Desktop',
  'Senpi',
  'Augment Code',
  'Kimchi',
  'Prime Agent',
  'Cherry Studio',
  'MiniMax Code',
  'Fx',
  'LM Studio',
  'Unsloth',
  'Hindsight',
  'DeepSeek',
  'OpenRouter',
  'Minimax',
  'Volcengine',
  'Ollama',
  'Third-party APIs',
  'Sakana (Fugu)'
];

const supportedToolIdOrder = [
  'claude',
  'claude-desktop',
  'codex',
  'opencode',
  'hermes-agent',
  'openclaw',
  'cursor',
  'antigravity',
  'cline',
  'kimi',
  'qwen',
  'xai',
  'copilot',
  'pi',
  'zed',
  'kilocode',
  'commandcode',
  'mimo-code',
  'zcode',
  'kiro',
  'codebuddy',
  'workbuddy',
  'proma',
  'deepseek-harness',
  'qoder',
  'reasonix',
  'gemini',
  'roocode',
  'amp',
  'droid',
  'mux',
  'kilo',
  'crush',
  'goose',
  'codebuff',
  'trae',
  'warp',
  'gjc',
  'jcode',
  'junie',
  'opencodereview',
  'devin',
  'senpi',
  'augment',
  'kimchi',
  'prime-agent',
  'cherrystudio',
  'mcode',
  'fx',
  'lmstudio',
  'unsloth',
  'hindsight',
  'deepseek',
  'openrouter',
  'minimax',
  'volcengine',
  'ollama',
  'newapi',
  'sakana'
];

test(`every tracked client has a row in ${MATRIX_FILE}`, () => {
  const iconIds = new Set(matrixStats().iconIds);
  const missing = TRACKED_CLIENTS.split(',')
    .map((client) => client.trim())
    .filter(Boolean)
    .filter((client) => !iconIds.has(CLIENT_TO_ICON[client] || client));
  assert.deepEqual(missing, [], `Tracked clients missing from ${MATRIX_FILE}: ${missing.join(', ')}`);
});

test(`${MATRIX_FILE} keeps the pinned row order`, () => {
  const stats = matrixStats(readMatrix());
  assert.deepEqual(stats.names, supportedToolOrder, 'matrix row names drifted from the pinned order');
  assert.deepEqual(stats.iconIds, supportedToolIdOrder, 'matrix row icons drifted from the pinned order');
});

test('limit provider order follows the supported-tools matrix', () => {
  const fromMatrix = limitProviderIcons()
    .flatMap((icon) => MATRIX_ICON_TO_LIMIT_PROVIDERS[icon] || [icon]);
  assert.deepEqual(fromMatrix, [...LIMIT_PROVIDER_IDS], 'LIMIT_PROVIDER_IDS no longer matches the matrix order');
});

test(`${MATRIX_FILE} icon paths resolve relative to docs/ to compact PNGs with zero orphans`, () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const rootDir = path.join(__dirname, '..', '..');
  const docsDir = path.join(rootDir, 'docs');
  const toolsIconDir = path.join(rootDir, '.github', 'assets', 'tools-icon');
  const text = readMatrix();
  const srcs = [...text.matchAll(/<img\s+src="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(srcs.length, supportedToolIdOrder.length);

  const referenced = new Set();
  for (const src of srcs) {
    assert.ok(src.startsWith('../.github/assets/tools-icon/'), `${MATRIX_FILE}: icon path must resolve from docs/: ${src}`);
    assert.ok(src.endsWith('.png'), `${MATRIX_FILE}: icon must be a PNG badge, saw ${src}`);
    const fullPath = path.resolve(docsDir, src);
    assert.ok(fs.existsSync(fullPath), `${MATRIX_FILE}: broken relative image link ${src}`);
    const size = fs.statSync(fullPath).size;
    assert.ok(size > 200 && size <= 50 * 1024, `${src}: expected compact PNG (<=50 KB), saw ${size} B`);
    referenced.add(path.basename(fullPath));
  }

  const shipped = fs.readdirSync(toolsIconDir).sort();
  assert.deepEqual(shipped, [...referenced].sort(), '.github/assets/tools-icon/ has unreferenced orphan files');
});
