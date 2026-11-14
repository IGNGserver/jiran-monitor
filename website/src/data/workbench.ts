/**
 * 官网交互式产品工作台（Interactive Workbench）的模拟车队数据。
 * 数据结构与口径严格对齐真实产品 `src/shared-ui/`：
 * - 时间范围通过单一 `resolveWorkbenchScope()` 解析，模拟真实 `resolveScopePeriod()`，本周固定 ISO 周一起算；
 * - Qoder 的 `credits` 原生计量与估算 Token 严格分账，估算 Token 不加 `~` 前缀，而在 Token 构成下方以文字披露；
 * - 超过 10 分钟未上报心跳的设备标为 `stale`（离线灰点），历史账本不丢失；
 * - 会话详情仅展示本机按需读取的提示词级 Token 明细，零提示词正文上传。
 */

export type DemoPeriodId = 'today' | 'yesterday' | 'week' | 'month' | 'allTime';
export type DemoDeviceId = 'all' | 'mac-m4' | 'win-wsl' | 'gpu-srv' | 'arch-tp';
export type DemoViewId = 'overview' | 'usage' | 'trends' | 'devices' | 'limits' | 'settings';
export type DemoUsageTab = 'tools' | 'models' | 'projects' | 'sessions';
export type DemoCurrency = 'USD' | 'CNY';

export interface DemoDevice {
  id: Exclude<DemoDeviceId, 'all'>;
  name: string;
  osIcon: 'osApple' | 'osWindows' | 'osLinux';
  osVersion: string;
  runtime: 'desktop' | 'headless-agent';
  materialZh: string;
  materialEn: string;
  status: 'live' | 'stale';
  lastSeenZh: string;
  lastSeenEn: string;
  weight: number;
  wsl?: {
    distro: string;
    stateZh: string;
    stateEn: string;
    detailZh: string;
    detailEn: string;
  };
  activeTools: string[];
  waitingTools: string[];
  models: string[];
}

export interface DemoToolRow {
  id: string;
  name: string;
  iconSlug: string;
  color: string;
  /** 今日全车队基准 Token（百万为单位前的整数） */
  baseTokens: number;
  baseCostUsd: number;
  inputRatio: number;
  outputRatio: number;
  cacheReadRatio: number;
  cacheWriteRatio: number;
  provenance: 'exact' | 'estimated';
  nativeCredits?: number;
  devices: Exclude<DemoDeviceId, 'all'>[];
  modelShares: { model: string; share: number }[];
}

export interface DemoModelRow {
  id: string;
  label: string;
  provider: string;
  color: string;
  baseTokens: number;
  baseCostUsd: number;
  inputRatio: number;
  outputRatio: number;
  cacheReadRatio: number;
  cacheWriteRatio: number;
  costPer1MUsd: number;
  deltaPct: number;
  clients: string[];
  devices: Exclude<DemoDeviceId, 'all'>[];
  dailySpark: number[];
}

export interface DemoProjectRow {
  name: string;
  client: string;
  device: string;
  baseTokens: number;
  baseCostUsd: number;
  cacheHitPct: number;
  sessions: number;
}

export interface DemoSessionRow {
  id: string;
  project: string;
  client: string;
  iconSlug: string;
  model: string;
  device: string;
  updatedZh: string;
  updatedEn: string;
  tokens: number;
  costUsd: number;
  hasLocalDetail: boolean;
  prompts: { idx: number; time: string; input: number; cacheRead: number; output: number; costUsd: number }[];
}

export interface DemoQuotaWindow {
  labelZh: string;
  labelEn: string;
  remainPct: number;
  valueTextZh: string;
  valueTextEn: string;
  resetZh: string;
  resetEn: string;
  group?: string;
}

export interface DemoQuotaCard {
  id: string;
  provider: string;
  iconSlug: string;
  planZh: string;
  planEn: string;
  authZh: string;
  authEn: string;
  status: 'healthy' | 'attention' | 'stale';
  statusZh: string;
  statusEn: string;
  fetchedZh: string;
  fetchedEn: string;
  windows: DemoQuotaWindow[];
}

export const USD_TO_CNY = 7.24;

export const PERIOD_META: Record<
  DemoPeriodId,
  {
    scale: number;
    windowZh: string;
    windowEn: string;
    activeDays: number;
    streakDays: number;
    peakZh: string;
    peakEn: string;
    activeHours: number;
  }
> = {
  today: {
    scale: 1,
    windowZh: '今日 · 2026-11-14 (Asia/Shanghai)',
    windowEn: 'Day · 2026-11-14 (Asia/Shanghai)',
    activeDays: 1,
    streakDays: 19,
    peakZh: '14:00–16:00',
    peakEn: '14:00–16:00',
    activeHours: 6.4,
  },
  yesterday: {
    scale: 0.86,
    windowZh: '昨天 · 2026-11-13 (/api/usage/range)',
    windowEn: 'Yesterday · 2026-11-13 (/api/usage/range)',
    activeDays: 1,
    streakDays: 18,
    peakZh: '2026-11-13',
    peakEn: '2026-11-13',
    activeHours: 5.8,
  },
  week: {
    scale: 5.45,
    windowZh: '本周 · 周一起算 11-09 → 11-14 (ISO Mon)',
    windowEn: 'Week · ISO Mon 11-09 → 11-14',
    activeDays: 6,
    streakDays: 19,
    peakZh: '周三 29.4M',
    peakEn: 'Wed 29.4M',
    activeHours: 34.2,
  },
  month: {
    scale: 18.8,
    windowZh: '本月 · 2026-11-01 → 11-14',
    windowEn: 'Month · 2026-11-01 → 11-14',
    activeDays: 14,
    streakDays: 19,
    peakZh: '11-06 · 34.1M',
    peakEn: 'Nov 06 · 34.1M',
    activeHours: 96.5,
  },
  allTime: {
    scale: 142.6,
    windowZh: '累计 · 2026-03 → 2026-11',
    windowEn: 'Total · 2026-03 → 2026-11',
    activeDays: 214,
    streakDays: 19,
    peakZh: '10-24 · 48.7M',
    peakEn: 'Oct 24 · 48.7M',
    activeHours: 1184,
  },
};

export const DEMO_DEVICES: DemoDevice[] = [
  {
    id: 'mac-m4',
    name: 'MacBook-Pro-M4',
    osIcon: 'osApple',
    osVersion: 'macOS 15.4 · arm64',
    runtime: 'desktop',
    materialZh: '桌面端 · 液态玻璃材质 (utilityProcess 隔离采集)',
    materialEn: 'Desktop · Liquid Glass (utilityProcess collector)',
    status: 'live',
    lastSeenZh: '12 秒前',
    lastSeenEn: '12s ago',
    weight: 0.44,
    activeTools: ['Claude Code', 'Cursor', 'Antigravity', 'Codex', 'Claude Desktop'],
    waitingTools: ['Zed', 'Warp / Oz'],
    models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'gpt-5.4', 'gemini-3.1-pro'],
  },
  {
    id: 'win-wsl',
    name: 'Win11-Workstation',
    osIcon: 'osWindows',
    osVersion: 'Windows 11 24H2 + WSL2',
    runtime: 'desktop',
    materialZh: '桌面端 · 云母 Mica 材质 + 连接中枢模式',
    materialEn: 'Desktop · Mica material + Hub client mode',
    status: 'live',
    lastSeenZh: '28 秒前',
    lastSeenEn: '28s ago',
    weight: 0.31,
    wsl: {
      distro: 'Ubuntu-24.04',
      stateZh: '运行中发行版自动扫描已激活 (\\\\wsl$)',
      stateEn: 'Running distro auto-scan active (\\\\wsl$)',
      detailZh: '不唤醒已停止发行版；直接合并 WSL 家目录文件日志与 Qoder Linux 适配器。',
      detailEn: 'Never wakes stopped distros; merges \\\\wsl$ file transcripts & Qoder Linux adapter.',
    },
    activeTools: ['Cursor', 'Qoder / Qoder CN', 'Claude Code (WSL)', 'OpenCode (WSL)'],
    waitingTools: ['GitHub Copilot', 'Cline'],
    models: ['claude-sonnet-4-6', 'gpt-5.4', 'qwen3-coder-plus', 'deepseek-v3.2'],
  },
  {
    id: 'gpu-srv',
    name: 'Ubuntu-GPU-Node',
    osIcon: 'osLinux',
    osVersion: 'Ubuntu 24.04 LTS · x86_64',
    runtime: 'headless-agent',
    materialZh: '无头采集器 · systemd 常驻 (node src/agent/agent.js)',
    materialEn: 'Headless agent · systemd service (node src/agent/agent.js)',
    status: 'live',
    lastSeenZh: '41 秒前',
    lastSeenEn: '41s ago',
    weight: 0.19,
    activeTools: ['Codex', 'OpenCode', 'Gemini CLI', 'DeepSeek Harness'],
    waitingTools: ['Hermes Agent'],
    models: ['gpt-5.4', 'gemini-3.1-pro', 'deepseek-v3.2', 'glm-5'],
  },
  {
    id: 'arch-tp',
    name: 'ThinkPad-Arch',
    osIcon: 'osLinux',
    osVersion: 'Arch Linux · Kernel 6.14',
    runtime: 'desktop',
    materialZh: '桌面端 · 静默逾 10 分钟诚实置灰，历史账本完整保留',
    materialEn: 'Desktop · Silent >10m marked Stale honestly; ledger preserved',
    status: 'stale',
    lastSeenZh: '28 分钟前',
    lastSeenEn: '28m ago',
    weight: 0.06,
    activeTools: ['OpenCode', 'Zed'],
    waitingTools: ['Claude Code', 'Qwen CLI'],
    models: ['claude-sonnet-4-6', 'deepseek-v3.2'],
  },
];

export const DEMO_TOOLS: DemoToolRow[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    iconSlug: 'claude',
    color: '#e08666',
    baseTokens: 9_840_000,
    baseCostUsd: 18.64,
    inputRatio: 0.09,
    outputRatio: 0.06,
    cacheReadRatio: 0.78,
    cacheWriteRatio: 0.07,
    provenance: 'exact',
    devices: ['mac-m4', 'win-wsl', 'arch-tp'],
    modelShares: [
      { model: 'claude-opus-4-6', share: 58 },
      { model: 'claude-sonnet-4-6', share: 42 },
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    iconSlug: 'codex',
    color: '#38bdf8',
    baseTokens: 5_620_000,
    baseCostUsd: 9.42,
    inputRatio: 0.14,
    outputRatio: 0.08,
    cacheReadRatio: 0.74,
    cacheWriteRatio: 0.04,
    provenance: 'exact',
    devices: ['mac-m4', 'gpu-srv'],
    modelShares: [{ model: 'gpt-5.4', share: 100 }],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    iconSlug: 'cursor',
    color: '#94a3b8',
    baseTokens: 3_480_000,
    baseCostUsd: 6.18,
    inputRatio: 0.16,
    outputRatio: 0.09,
    cacheReadRatio: 0.69,
    cacheWriteRatio: 0.06,
    provenance: 'exact',
    devices: ['mac-m4', 'win-wsl'],
    modelShares: [
      { model: 'claude-sonnet-4-6', share: 64 },
      { model: 'gpt-5.4', share: 36 },
    ],
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    iconSlug: 'antigravity',
    color: '#479ef5',
    baseTokens: 2_760_000,
    baseCostUsd: 4.55,
    inputRatio: 0.15,
    outputRatio: 0.10,
    cacheReadRatio: 0.71,
    cacheWriteRatio: 0.04,
    provenance: 'exact',
    devices: ['mac-m4'],
    modelShares: [
      { model: 'gemini-3.1-pro', share: 72 },
      { model: 'claude-sonnet-4-6', share: 28 },
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    iconSlug: 'opencode',
    color: '#a78bfa',
    baseTokens: 1_940_000,
    baseCostUsd: 2.38,
    inputRatio: 0.18,
    outputRatio: 0.11,
    cacheReadRatio: 0.66,
    cacheWriteRatio: 0.05,
    provenance: 'exact',
    devices: ['win-wsl', 'gpu-srv', 'arch-tp'],
    modelShares: [
      { model: 'deepseek-v3.2', share: 61 },
      { model: 'claude-sonnet-4-6', share: 39 },
    ],
  },
  {
    id: 'qoder',
    name: 'Qoder / Qoder CN',
    iconSlug: 'qoder',
    color: '#34d399',
    baseTokens: 1_280_000,
    baseCostUsd: 0,
    inputRatio: 0.62,
    outputRatio: 0.38,
    cacheReadRatio: 0,
    cacheWriteRatio: 0,
    provenance: 'estimated',
    nativeCredits: 120,
    devices: ['win-wsl'],
    modelShares: [{ model: 'qwen3-coder-plus', share: 100 }],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    iconSlug: 'gemini',
    color: '#60a5fa',
    baseTokens: 960_000,
    baseCostUsd: 1.48,
    inputRatio: 0.21,
    outputRatio: 0.09,
    cacheReadRatio: 0.70,
    cacheWriteRatio: 0,
    provenance: 'exact',
    devices: ['gpu-srv'],
    modelShares: [{ model: 'gemini-3.1-pro', share: 100 }],
  },
];

export const DEMO_MODELS: DemoModelRow[] = [
  {
    id: 'claude-opus-4-6',
    label: 'claude-opus-4-6',
    provider: 'Anthropic',
    color: '#e08666',
    baseTokens: 5_710_000,
    baseCostUsd: 13.82,
    inputRatio: 0.08,
    outputRatio: 0.06,
    cacheReadRatio: 0.79,
    cacheWriteRatio: 0.07,
    costPer1MUsd: 2.42,
    deltaPct: 14,
    clients: ['Claude Code'],
    devices: ['mac-m4', 'win-wsl'],
    dailySpark: [42, 58, 51, 66, 74, 88, 79, 92, 85, 96],
  },
  {
    id: 'gpt-5.4',
    label: 'gpt-5.4',
    provider: 'OpenAI',
    color: '#38bdf8',
    baseTokens: 6_870_000,
    baseCostUsd: 11.64,
    inputRatio: 0.14,
    outputRatio: 0.08,
    cacheReadRatio: 0.74,
    cacheWriteRatio: 0.04,
    costPer1MUsd: 1.69,
    deltaPct: 9,
    clients: ['Codex', 'Cursor'],
    devices: ['mac-m4', 'win-wsl', 'gpu-srv'],
    dailySpark: [50, 48, 62, 71, 69, 77, 84, 80, 91, 89],
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'claude-sonnet-4-6',
    provider: 'Anthropic',
    color: '#a78bfa',
    baseTokens: 7_890_000,
    baseCostUsd: 10.91,
    inputRatio: 0.12,
    outputRatio: 0.08,
    cacheReadRatio: 0.74,
    cacheWriteRatio: 0.06,
    costPer1MUsd: 1.38,
    deltaPct: -4,
    clients: ['Claude Code', 'Cursor', 'Antigravity', 'OpenCode'],
    devices: ['mac-m4', 'win-wsl', 'arch-tp'],
    dailySpark: [68, 72, 65, 79, 83, 76, 88, 84, 79, 82],
  },
  {
    id: 'gemini-3.1-pro',
    label: 'gemini-3.1-pro',
    provider: 'Google',
    color: '#479ef5',
    baseTokens: 2_950_000,
    baseCostUsd: 4.38,
    inputRatio: 0.17,
    outputRatio: 0.10,
    cacheReadRatio: 0.71,
    cacheWriteRatio: 0.02,
    costPer1MUsd: 1.48,
    deltaPct: 22,
    clients: ['Antigravity', 'Gemini CLI'],
    devices: ['mac-m4', 'gpu-srv'],
    dailySpark: [24, 31, 29, 38, 45, 52, 49, 61, 67, 72],
  },
  {
    id: 'deepseek-v3.2',
    label: 'deepseek-v3.2',
    provider: 'DeepSeek',
    color: '#2dd4bf',
    baseTokens: 1_820_000,
    baseCostUsd: 0.94,
    inputRatio: 0.22,
    outputRatio: 0.13,
    cacheReadRatio: 0.65,
    cacheWriteRatio: 0,
    costPer1MUsd: 0.52,
    deltaPct: 18,
    clients: ['OpenCode', 'DeepSeek Harness'],
    devices: ['win-wsl', 'gpu-srv', 'arch-tp'],
    dailySpark: [18, 22, 27, 25, 34, 39, 44, 41, 48, 53],
  },
  {
    id: 'qwen3-coder-plus',
    label: 'qwen3-coder-plus',
    provider: 'Alibaba',
    color: '#34d399',
    baseTokens: 1_280_000,
    baseCostUsd: 0.96,
    inputRatio: 0.58,
    outputRatio: 0.42,
    cacheReadRatio: 0,
    cacheWriteRatio: 0,
    costPer1MUsd: 0.75,
    deltaPct: 6,
    clients: ['Qoder / Qoder CN'],
    devices: ['win-wsl'],
    dailySpark: [15, 19, 17, 23, 21, 28, 26, 30, 29, 33],
  },
];

export const DEMO_PROJECTS: DemoProjectRow[] = [
  { name: 'jiran-monitor', client: 'Claude Code · Codex', device: 'MacBook-Pro-M4', baseTokens: 10_420_000, baseCostUsd: 19.15, cacheHitPct: 79, sessions: 18 },
  { name: 'cuda-kernel-lab', client: 'Codex · Gemini CLI', device: 'Ubuntu-GPU-Node', baseTokens: 6_380_000, baseCostUsd: 10.48, cacheHitPct: 73, sessions: 11 },
  { name: 'edge-gateway-rs', client: 'Cursor · OpenCode (WSL)', device: 'Win11-Workstation', baseTokens: 5_640_000, baseCostUsd: 8.72, cacheHitPct: 71, sessions: 14 },
  { name: 'agent-eval-suite', client: 'Antigravity · Qoder CN', device: 'MacBook-Pro-M4', baseTokens: 3_440_000, baseCostUsd: 4.30, cacheHitPct: 68, sessions: 9 },
];

export const DEMO_SESSIONS: DemoSessionRow[] = [
  {
    id: 'ses_9f42a',
    project: 'jiran-monitor',
    client: 'Claude Code',
    iconSlug: 'claude',
    model: 'claude-opus-4-6',
    device: 'MacBook-Pro-M4',
    updatedZh: '3 分钟前',
    updatedEn: '3m ago',
    tokens: 1_482_000,
    costUsd: 3.46,
    hasLocalDetail: true,
    prompts: [
      { idx: 1, time: '14:12:08', input: 18_400, cacheRead: 214_000, output: 4_820, costUsd: 0.54 },
      { idx: 2, time: '14:15:41', input: 9_200, cacheRead: 368_000, output: 6_190, costUsd: 0.78 },
      { idx: 3, time: '14:19:03', input: 6_850, cacheRead: 412_000, output: 8_440, costUsd: 1.06 },
      { idx: 4, time: '14:24:29', input: 5_120, cacheRead: 431_000, output: 7_930, costUsd: 1.08 },
    ],
  },
  {
    id: 'ses_7c18b',
    project: 'cuda-kernel-lab',
    client: 'Codex',
    iconSlug: 'codex',
    model: 'gpt-5.4',
    device: 'Ubuntu-GPU-Node',
    updatedZh: '11 分钟前',
    updatedEn: '11m ago',
    tokens: 964_000,
    costUsd: 1.72,
    hasLocalDetail: true,
    prompts: [
      { idx: 1, time: '13:52:10', input: 24_100, cacheRead: 280_000, output: 5_900, costUsd: 0.58 },
      { idx: 2, time: '13:58:44', input: 12_400, cacheRead: 318_000, output: 6_420, costUsd: 0.61 },
      { idx: 3, time: '14:04:19', input: 8_900, cacheRead: 308_000, output: 4_280, costUsd: 0.53 },
    ],
  },
  {
    id: 'ses_3e90d',
    project: 'edge-gateway-rs',
    client: 'OpenCode',
    iconSlug: 'opencode',
    model: 'deepseek-v3.2',
    device: 'Win11-Workstation (WSL2)',
    updatedZh: '24 分钟前',
    updatedEn: '24m ago',
    tokens: 618_000,
    costUsd: 0.34,
    hasLocalDetail: true,
    prompts: [
      { idx: 1, time: '13:31:02', input: 31_000, cacheRead: 242_000, output: 7_100, costUsd: 0.16 },
      { idx: 2, time: '13:39:55', input: 19_500, cacheRead: 310_000, output: 8_400, costUsd: 0.18 },
    ],
  },
];

export const DEMO_QUOTAS: DemoQuotaCard[] = [
  {
    id: 'q-cursor',
    provider: 'Cursor',
    iconSlug: 'cursor',
    planZh: 'Pro · 月度订阅 ($20/月)',
    planEn: 'Pro · Monthly ($20/mo)',
    authZh: 'Hub 加密凭据',
    authEn: 'Hub encrypted session',
    status: 'attention',
    statusZh: '需要关注 (<20%)',
    statusEn: 'Needs attention (<20%)',
    fetchedZh: '1 分钟前',
    fetchedEn: '1m ago',
    windows: [
      {
        labelZh: '每月额度',
        labelEn: 'Monthly allowance',
        remainPct: 16,
        valueTextZh: '剩余 $3.20 / $20.00',
        valueTextEn: '$3.20 / $20.00 left',
        resetZh: '4 天后重置',
        resetEn: 'Resets in 4d',
      },
      {
        labelZh: '按量附加池',
        labelEn: 'On-demand cap',
        remainPct: 82,
        valueTextZh: '剩余 $41.00 / $50.00',
        valueTextEn: '$41.00 / $50.00 left',
        resetZh: '月初重置',
        resetEn: 'Monthly reset',
      },
    ],
  },
  {
    id: 'q-claude',
    provider: 'Claude Code',
    iconSlug: 'claude',
    planZh: 'Max 20x · 主力账号 ($200/月)',
    planEn: 'Max 20x · Primary ($200/mo)',
    authZh: 'Hub 定时轮询',
    authEn: 'Hub scheduled probe',
    status: 'healthy',
    statusZh: '正常',
    statusEn: 'Healthy',
    fetchedZh: '45 秒前',
    fetchedEn: '45s ago',
    windows: [
      {
        labelZh: '5 小时滚动窗口',
        labelEn: '5-hour rolling',
        remainPct: 68,
        valueTextZh: '剩余 68%',
        valueTextEn: '68% remaining',
        resetZh: '1 小时 42 分后重置',
        resetEn: 'Resets in 1h 42m',
      },
      {
        labelZh: '每周总额度',
        labelEn: 'Weekly window',
        remainPct: 54,
        valueTextZh: '剩余 54%',
        valueTextEn: '54% remaining',
        resetZh: '周一 09:00 重置',
        resetEn: 'Resets Mon 09:00',
      },
    ],
  },
  {
    id: 'q-codex',
    provider: 'Codex',
    iconSlug: 'codex',
    planZh: 'ChatGPT Pro · 浏览器 OAuth 向导',
    planEn: 'ChatGPT Pro · Browser OAuth wizard',
    authZh: 'OAuth 授权',
    authEn: 'OAuth sign-in',
    status: 'healthy',
    statusZh: '正常',
    statusEn: 'Healthy',
    fetchedZh: '1 分钟前',
    fetchedEn: '1m ago',
    windows: [
      {
        labelZh: '5 小时额度',
        labelEn: '5-hour window',
        remainPct: 81,
        valueTextZh: '剩余 81%',
        valueTextEn: '81% remaining',
        resetZh: '3 小时 15 分后重置',
        resetEn: 'Resets in 3h 15m',
      },
      {
        labelZh: '每周额度',
        labelEn: 'Weekly window',
        remainPct: 72,
        valueTextZh: '剩余 72%',
        valueTextEn: '72% remaining',
        resetZh: '4 天 6 小时后重置',
        resetEn: 'Resets in 4d 6h',
      },
    ],
  },
  {
    id: 'q-antigravity',
    provider: 'Antigravity',
    iconSlug: 'antigravity',
    planZh: 'Workspace · 模型分组配额 (OAuth)',
    planEn: 'Workspace · Model-grouped quotas (OAuth)',
    authZh: 'OAuth 授权',
    authEn: 'OAuth sign-in',
    status: 'healthy',
    statusZh: '正常',
    statusEn: 'Healthy',
    fetchedZh: '2 分钟前',
    fetchedEn: '2m ago',
    windows: [
      {
        group: 'Gemini 3.1 Pro',
        labelZh: 'Gemini 3.1 · 5h',
        labelEn: 'Gemini 3.1 · 5h',
        remainPct: 74,
        valueTextZh: '剩余 74%',
        valueTextEn: '74% remaining',
        resetZh: '2 小时 08 分后重置',
        resetEn: 'Resets in 2h 08m',
      },
      {
        group: 'Claude Sonnet 4.6',
        labelZh: 'Claude Sonnet · 5h',
        labelEn: 'Claude Sonnet · 5h',
        remainPct: 49,
        valueTextZh: '剩余 49%',
        valueTextEn: '49% remaining',
        resetZh: '1 小时 19 分后重置',
        resetEn: 'Resets in 1h 19m',
      },
    ],
  },
  {
    id: 'q-qoder',
    provider: 'Qoder / Qoder CN',
    iconSlug: 'qoder',
    planZh: 'Pro · 原生积分账本',
    planEn: 'Pro · Native Credits meter',
    authZh: '精确积分计量',
    authEn: 'Exact credits meter',
    status: 'healthy',
    statusZh: '正常',
    statusEn: 'Healthy',
    fetchedZh: '2 分钟前',
    fetchedEn: '2m ago',
    windows: [
      {
        labelZh: '专属积分 (Credits)',
        labelEn: 'Plan Credits',
        remainPct: 62,
        valueTextZh: '620 / 1,000 Credits',
        valueTextEn: '620 / 1,000 Credits',
        resetZh: '16 天后重置',
        resetEn: 'Resets in 16d',
      },
    ],
  },
  {
    id: 'q-openrouter',
    provider: 'OpenRouter',
    iconSlug: 'openrouter',
    planZh: 'Pay-as-you-go · API 储值余额',
    planEn: 'Pay-as-you-go · Prepaid API balance',
    authZh: 'API Key (AES-256-GCM)',
    authEn: 'API Key (AES-256-GCM)',
    status: 'healthy',
    statusZh: '正常',
    statusEn: 'Healthy',
    fetchedZh: '3 分钟前',
    fetchedEn: '3m ago',
    windows: [
      {
        labelZh: '账户可用余额',
        labelEn: 'Available balance',
        remainPct: 76,
        valueTextZh: '$48.60 / $64.00',
        valueTextEn: '$48.60 / $64.00',
        resetZh: '储值账本已关联',
        resetEn: 'Linked to top-up ledger',
      },
    ],
  },
  {
    id: 'q-kimi',
    provider: 'Kimi CLI / Kimi Code',
    iconSlug: 'moonshot',
    planZh: '开发套餐 · 探测缓存陈旧示例',
    planEn: 'Dev Plan · Stale probe example',
    authZh: '待刷新会话',
    authEn: 'Session refresh pending',
    status: 'stale',
    statusZh: '数据陈旧',
    statusEn: 'Stale',
    fetchedZh: '46 分钟前',
    fetchedEn: '46m ago',
    windows: [
      {
        labelZh: '每周额度',
        labelEn: 'Weekly window',
        remainPct: 41,
        valueTextZh: '上次读数 41%',
        valueTextEn: 'Last read 41%',
        resetZh: '前往「管理 → 账号」刷新',
        resetEn: 'Refresh in Management → Accounts',
      },
    ],
  },
];

/** 14 天每日柱状序列（按工具分组占比：Claude / Codex / Cursor / Other） */
export const DAILY_SERIES_14D: { day: string; claude: number; codex: number; cursor: number; other: number }[] = [
  { day: '11-01', claude: 6.2, codex: 3.8, cursor: 2.4, other: 2.9 },
  { day: '11-02', claude: 5.1, codex: 3.1, cursor: 1.9, other: 2.2 },
  { day: '11-03', claude: 8.4, codex: 4.9, cursor: 3.1, other: 3.6 },
  { day: '11-04', claude: 9.1, codex: 5.4, cursor: 3.4, other: 3.9 },
  { day: '11-05', claude: 7.8, codex: 4.6, cursor: 2.8, other: 3.2 },
  { day: '11-06', claude: 13.6, codex: 8.2, cursor: 5.1, other: 5.8 },
  { day: '11-07', claude: 10.2, codex: 6.1, cursor: 3.8, other: 4.3 },
  { day: '11-08', claude: 6.9, codex: 4.2, cursor: 2.5, other: 2.8 },
  { day: '11-09', claude: 9.6, codex: 5.8, cursor: 3.6, other: 4.1 },
  { day: '11-10', claude: 11.4, codex: 6.7, cursor: 4.2, other: 4.9 },
  { day: '11-11', claude: 12.1, codex: 7.1, cursor: 4.5, other: 5.2 },
  { day: '11-12', claude: 10.8, codex: 6.4, cursor: 3.9, other: 4.5 },
  { day: '11-13', claude: 8.9, codex: 5.2, cursor: 3.2, other: 3.8 },
  { day: '11-14', claude: 9.8, codex: 5.6, cursor: 3.5, other: 7.0 },
];

/** 12 周 × 7 天（84 格）热力图强度等级 0..4（确定性生成，无运行期随机闪烁） */
export const HEATMAP_84D: number[] = [
  1, 2, 3, 2, 4, 1, 0,
  2, 3, 2, 3, 3, 2, 1,
  1, 2, 4, 3, 2, 1, 1,
  3, 4, 3, 2, 4, 2, 0,
  2, 2, 3, 4, 3, 1, 2,
  1, 3, 3, 2, 3, 2, 1,
  2, 4, 4, 3, 4, 2, 1,
  3, 3, 2, 4, 3, 3, 2,
  2, 3, 4, 4, 3, 2, 1,
  3, 4, 3, 4, 4, 2, 2,
  2, 3, 4, 3, 4, 3, 2,
  3, 4, 4, 3, 3, 4, 4,
];
