/**
 * 站点引用的产品事实。唯一来源是产品仓库，不在这里推断或补写能力：
 *   https://github.com/IGNGserver/jiran-monitor  （README.md / README.zh-CN.md、docs/supported-tools.md、docs/privacy.md）
 * 核对基线：main @ 8d7e29f（2026-10-25）。产品文档变化时同步更新本文件，并重跑 `pnpm test`
 * （tests/facts.spec.ts 会校验计数与矩阵行数一致）。
 */

export const REPO = 'IGNGserver/jiran-monitor';
export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases`;
export const DOCS = {
  readme: `${REPO_URL}#readme`,
  readmeZh: `${REPO_URL}/blob/main/README.zh-CN.md`,
  tools: `${REPO_URL}/blob/main/docs/supported-tools.md`,
  privacy: `${REPO_URL}/blob/main/docs/privacy.md`,
  hub: `${REPO_URL}/blob/main/docs/hub-compose.md`,
  agent: `${REPO_URL}/blob/main/docs/headless-agent.md`,
  config: `${REPO_URL}/blob/main/docs/configuration.md`,
  api: `${REPO_URL}/blob/main/docs/API.md`,
  signing: `${REPO_URL}/blob/main/docs/code-signing.md`,
  wsl: `${REPO_URL}/blob/main/docs/wsl-sqlite-setup.md`,
  license: `${REPO_URL}/blob/main/LICENSE`,
  tokscale: 'https://github.com/junhoyeo/tokscale',
};

/** docs/supported-tools.md 的矩阵，按 UI 中的顺序。u = Token 用量，l = 订阅额度，s = 会话明细。 */
export interface Tool { name: string; u: boolean; l: boolean; s: boolean }

const row = (name: string, u: 0 | 1, l: 0 | 1, s: 0 | 1): Tool => ({ name, u: !!u, l: !!l, s: !!s });

export const TOOLS: Tool[] = [
  row('Claude Code', 1, 1, 1),
  row('Claude Desktop', 1, 0, 1),
  row('Codex', 1, 1, 1),
  row('OpenCode', 1, 1, 1),
  row('Hermes Agent', 1, 0, 0),
  row('OpenClaw', 1, 0, 0),
  row('Cursor', 1, 1, 0),
  row('Antigravity', 1, 1, 0),
  row('Cline', 1, 1, 0),
  row('Kimi CLI / Kimi Code', 1, 1, 0),
  row('Qwen CLI', 1, 0, 0),
  row('Grok Build', 1, 1, 0),
  row('GitHub Copilot', 1, 1, 0),
  row('Pi / Oh My Pi', 1, 0, 0),
  row('Zed', 1, 0, 0),
  row('Kilo Code', 1, 1, 0),
  row('Command Code', 1, 1, 0),
  row('MiMo Code', 1, 1, 0),
  row('ZCode / GLM', 1, 1, 0),
  row('Kiro', 1, 1, 0),
  row('CodeBuddy', 1, 0, 0),
  row('WorkBuddy', 1, 0, 0),
  row('Proma', 1, 0, 0),
  row('DeepSeek Harness', 1, 0, 0),
  row('Qoder / Qoder CN', 1, 1, 0),
  row('Reasonix', 1, 0, 1),
  row('Gemini CLI', 1, 1, 0),
  row('Roo Code', 1, 0, 0),
  row('Amp', 1, 1, 0),
  row('Droid', 1, 1, 0),
  row('Mux', 1, 0, 0),
  row('Kilo CLI', 1, 0, 0),
  row('Crush', 1, 0, 0),
  row('Goose', 1, 0, 0),
  row('Codebuff / Freebuff', 1, 0, 0),
  row('Trae', 1, 0, 0),
  row('Warp / Oz', 1, 1, 0),
  row('Gajae-Code', 1, 0, 0),
  row('Jcode', 1, 0, 0),
  row('Junie', 1, 0, 0),
  row('OpenCodeReview', 1, 0, 0),
  row('Devin CLI / Devin Desktop', 1, 0, 0),
  row('Senpi', 1, 0, 0),
  row('Augment Code', 1, 0, 0),
  row('Kimchi', 1, 0, 0),
  row('Prime Agent', 1, 0, 0),
  row('Cherry Studio', 1, 0, 0),
  row('MiniMax Code', 1, 0, 0),
  row('Fx', 1, 0, 0),
  row('LM Studio', 1, 0, 0),
  row('Unsloth', 1, 0, 0),
  row('Hindsight', 1, 0, 0),
  row('DeepSeek', 0, 1, 0),
  row('OpenRouter', 0, 1, 0),
  row('Minimax', 0, 1, 0),
  row('Volcengine', 0, 1, 0),
  row('Ollama', 0, 1, 0),
  row('Third-party APIs', 0, 1, 0),
  row('Sakana (Fugu)', 0, 1, 0),
];

/** README「Supported tools」表格中的四个数字；测试会校验它们与上面的矩阵一致。 */
export const COUNTS = {
  rows: 59,
  usage: 52,
  limits: 26,
  sessions: 5,
} as const;

export type AssetKey =
  | 'macArm' | 'macIntel' | 'winSetup' | 'winPortable' | 'appImage' | 'deb' | 'android' | 'headless' | 'hubCompose';

/** Release 资产命名规则（README「Install」与 v1.x 的实际资产名一致）。 */
export const ASSET_PATTERNS: Record<AssetKey, RegExp> = {
  macArm: /^Jiran-[\w.-]+-arm64\.dmg$/,
  macIntel: /^Jiran-[\w.-]+-x64\.dmg$/,
  winSetup: /^Jiran-Setup-[\w.-]+\.exe$/,
  winPortable: /^Jiran-(?!Setup-)[\w.-]+\.exe$/,
  appImage: /^Jiran-[\w.-]+\.AppImage$/,
  deb: /^Jiran-[\w.-]+\.deb$/,
  android: /^Jiran-Android-[\w.-]+\.apk$/,
  headless: /^Jiran-Headless-[\w.-]+\.tar\.gz$/,
  hubCompose: /^Jiran-Hub-Compose-[\w.-]+\.zip$/,
};

// Linux 安装：直接使用 Release 资产里的 .deb / AppImage。APT 仓库已于 2026-10 退役，
// 站点不再展示 apt source 片段。

export const HUB_SNIPPET = `cp .env.example .env
# JIRAN_SECRET + MySQL passwords
docker compose up -d
curl http://127.0.0.1:17321/api/health`;
