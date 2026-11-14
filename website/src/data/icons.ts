/**
 * 产品客户端与操作系统图标映射。
 * SVG 文件与产品共享界面 `src/shared-ui/icons/clients/` 字节级同源，经 Astro 构建为带内容哈希的静态资源，
 * 享受一年 immutable 缓存且不膨胀首屏内联 HTML 体积。
 *
 * 与 `src/shared-ui/styles/app.css` 一致：单色 `currentColor`/`#000` 图标在深色背景上提亮反白，
 * 自带品牌彩色的图标保持原色，`#fff` 单色图标在浅色工作台主题下反黑。
 */

export type IconTone = 'color' | 'mono-dark' | 'mono-light';

const rawIcons = import.meta.glob<string>('../assets/icons/clients/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
});

const bySlug: Record<string, string> = {};
for (const [path, url] of Object.entries(rawIcons)) {
  const match = path.match(/\/([^/]+)\.svg$/);
  if (match) bySlug[match[1]] = url;
}

const COLOR_SLUGS = new Set([
  'antigravity',
  'doubao',
  'os-linux',
  'os-windows',
  'qoder',
  'qodercn',
  'volcengine',
  'xiaomi',
  'zed',
]);

const MONO_LIGHT_SLUGS = new Set(['pi', 'proma']);

export function iconToneForSlug(slug: string): IconTone {
  if (COLOR_SLUGS.has(slug)) return 'color';
  if (MONO_LIGHT_SLUGS.has(slug)) return 'mono-light';
  return 'mono-dark';
}

/** 支持矩阵 59 行工具名 → 图标文件名映射 */
const TOOL_SLUG_MAP: Record<string, string> = {
  'Claude Code': 'claude',
  'Claude Desktop': 'claude',
  'Codex': 'codex',
  'OpenCode': 'opencode',
  'Hermes Agent': 'hermes-agent',
  'OpenClaw': 'openclaw',
  'Cursor': 'cursor',
  'Antigravity': 'antigravity',
  'Cline': 'cline',
  'Kimi CLI / Kimi Code': 'moonshot',
  'Qwen CLI': 'qwen',
  'Grok Build': 'grok',
  'GitHub Copilot': 'copilot',
  'Pi / Oh My Pi': 'pi',
  'Zed': 'zed',
  'Kilo Code': 'kilocode',
  'Command Code': 'commandcode',
  'MiMo Code': 'xiaomi',
  'ZCode / GLM': 'zai',
  'Kiro': 'kiro',
  'CodeBuddy': 'codebuddy',
  'WorkBuddy': 'workbuddy',
  'Proma': 'proma',
  'DeepSeek Harness': 'deepseek-harness',
  'Qoder / Qoder CN': 'qoder',
  'Reasonix': 'reasonix',
  'Gemini CLI': 'gemini',
  'Roo Code': 'roocode',
  'Amp': 'amp',
  'Droid': 'droid',
  'Mux': 'mux',
  'Kilo CLI': 'kilocode',
  'Crush': 'crush',
  'Goose': 'goose',
  'Codebuff / Freebuff': 'codebuff',
  'Trae': 'trae',
  'Warp / Oz': 'warp',
  'Gajae-Code': 'gjc',
  'Jcode': 'jcode',
  'Junie': 'junie',
  'OpenCodeReview': 'opencodereview',
  'Devin CLI / Devin Desktop': 'devin',
  'Senpi': 'senpi',
  'Augment Code': 'augment',
  'Kimchi': 'kimchi',
  'Prime Agent': 'prime-agent',
  'Cherry Studio': 'cherrystudio',
  'MiniMax Code': 'minimax',
  'Fx': 'fx',
  'LM Studio': 'lmstudio',
  'Unsloth': 'unsloth',
  'Hindsight': 'hindsight',
  'DeepSeek': 'deepseek',
  'OpenRouter': 'openrouter',
  'Minimax': 'minimax',
  'Volcengine': 'volcengine',
  'Ollama': 'ollama',
  'Third-party APIs': 'openrouter',
  'Sakana (Fugu)': 'sakana',
};

export function iconForSlug(slug: string): string | undefined {
  return bySlug[slug];
}

export function iconForTool(name: string): string | undefined {
  const slug = TOOL_SLUG_MAP[name];
  return slug ? bySlug[slug] : undefined;
}

export function iconMetaForTool(name: string): { url: string; slug: string; tone: IconTone } | undefined {
  const slug = TOOL_SLUG_MAP[name];
  const url = slug ? bySlug[slug] : undefined;
  if (!slug || !url) return undefined;
  return { url, slug, tone: iconToneForSlug(slug) };
}

export const CLIENT_ICON_URLS = {
  claude: bySlug['claude'],
  codex: bySlug['codex'],
  cursor: bySlug['cursor'],
  antigravity: bySlug['antigravity'],
  opencode: bySlug['opencode'],
  qoder: bySlug['qoder'],
  gemini: bySlug['gemini'],
  deepseek: bySlug['deepseek'],
  openrouter: bySlug['openrouter'],
  moonshot: bySlug['moonshot'],
  copilot: bySlug['copilot'],
  qwen: bySlug['qwen'],
  zai: bySlug['zai'],
  osApple: bySlug['os-apple'],
  osWindows: bySlug['os-windows'],
  osLinux: bySlug['os-linux'],
} as const;
