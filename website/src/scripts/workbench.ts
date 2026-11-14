/**
 * 交互式产品工作台（Interactive Live Jiran Workbench）状态机与视图渲染。
 * 复刻 `src/shared-ui/` 的真实信息架构、Fluent 2 视觉层级与两条核心工程纪律：
 * 1. 单一时间范围解析器 `resolveScope()`（本周固定 ISO 周一起算，各标签数值严格隔离）；
 * 2. 交互期间自动暂缓实时流重绘（`render({ quiet: true })` 演示：指针或焦点在面板内时挂起 SSE 增量）。
 */
import {
  DAILY_SERIES_14D,
  DEMO_DEVICES,
  DEMO_MODELS,
  DEMO_PROJECTS,
  DEMO_QUOTAS,
  DEMO_SESSIONS,
  DEMO_TOOLS,
  HEATMAP_84D,
  PERIOD_META,
  USD_TO_CNY,
  type DemoCurrency,
  type DemoDeviceId,
  type DemoPeriodId,
  type DemoUsageTab,
  type DemoViewId,
} from '../data/workbench';

type LangKey = 'zh' | 'en';
type ModelSortKey = 'tokens' | 'cost' | 'costPer1M' | 'cacheHit';

interface WorkbenchState {
  lang: LangKey;
  theme: 'dark' | 'light';
  currency: DemoCurrency;
  view: DemoViewId;
  device: DemoDeviceId;
  period: DemoPeriodId;
  usageTab: DemoUsageTab;
  selectedToolId: string;
  modelQuery: string;
  modelSort: ModelSortKey;
  comparedModels: string[];
  showCsvPreview: boolean;
  openSessionId: string | null;
  selectedDeviceId: Exclude<DemoDeviceId, 'all'>;
  heatmapMetric: 'tokens' | 'cost';
  trendMetric: 'tokens' | 'cost';
  trendGroup: 'tool' | 'model';
  settingsTab: 'consumption' | 'accounts' | 'sessions';
  liveBonusTokens: number;
  queuedBonusTokens: number;
  interacting: boolean;
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 100_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtMoney(usd: number, currency: DemoCurrency): string {
  const v = currency === 'CNY' ? usd * USD_TO_CNY : usd;
  const sym = currency === 'CNY' ? '¥' : '$';
  return `${sym}${v.toFixed(v >= 100 ? 0 : 2)}`;
}

export function initWorkbench(root: HTMLElement) {
  const lang = (root.dataset.lang === 'en' ? 'en' : 'zh') as LangKey;
  const iconsJson = root.querySelector('[data-wb-icons]')?.textContent;
  const icons: Record<string, string> = iconsJson ? JSON.parse(iconsJson) : {};

  const state: WorkbenchState = {
    lang,
    theme: 'dark',
    currency: 'USD',
    view: 'overview',
    device: 'all',
    period: 'today',
    usageTab: 'tools',
    selectedToolId: 'claude',
    modelQuery: '',
    modelSort: 'tokens',
    comparedModels: ['claude-opus-4-6', 'gpt-5.4', 'gemini-3.1-pro'],
    showCsvPreview: false,
    openSessionId: 'ses_9f42a',
    selectedDeviceId: 'win-wsl',
    heatmapMetric: 'tokens',
    trendMetric: 'tokens',
    trendGroup: 'tool',
    settingsTab: 'consumption',
    liveBonusTokens: 0,
    queuedBonusTokens: 0,
    interacting: false,
  };

  const zh = state.lang === 'zh';
  const tr = (z: string, e: string) => (zh ? z : e);

  const COLOR_KEYS = new Set(['antigravity', 'qoder', 'osWindows', 'osLinux']);
  const iconImg = (slug: string, size = 16) => {
    const src = icons[slug];
    if (!src) return `<span class="wb-dot-fallback"></span>`;
    const tone = COLOR_KEYS.has(slug) ? 'color' : 'mono-dark';
    return `<img class="wb-ico" src="${esc(src)}" data-ico-tone="${tone}" data-ico-key="${esc(slug)}" alt="" width="${size}" height="${size}" decoding="async" />`;
  };

  const mainEl = root.querySelector<HTMLElement>('[data-wb-main]')!;
  const titleEl = root.querySelector<HTMLElement>('[data-wb-title]')!;
  const metaEl = root.querySelector<HTMLElement>('[data-wb-meta]')!;
  const streamDot = root.querySelector<HTMLElement>('[data-wb-stream-dot]')!;
  const streamText = root.querySelector<HTMLElement>('[data-wb-stream-text]')!;

  /** 单一范围解析器（对应真实产品 `resolveScopePeriod()`） */
  function resolveScope() {
    const pMeta = PERIOD_META[state.period];
    const devObj = state.device === 'all' ? null : DEMO_DEVICES.find((d) => d.id === state.device) ?? null;
    const devScale = devObj ? devObj.weight : 1;
    const scale = pMeta.scale * devScale;

    const tools = DEMO_TOOLS.filter((t) => state.device === 'all' || t.devices.includes(state.device)).map((t) => {
      const tokens = Math.round(t.baseTokens * scale);
      const costUsd = t.baseCostUsd * scale;
      return { ...t, tokens, costUsd };
    });

    const models = DEMO_MODELS.filter((m) => state.device === 'all' || m.devices.includes(state.device)).map((m) => {
      const tokens = Math.round(m.baseTokens * scale);
      const costUsd = m.baseCostUsd * scale;
      const cacheHitPct = Math.round(m.cacheReadRatio * 100);
      return { ...m, tokens, costUsd, cacheHitPct };
    });

    const bonus = state.period === 'today' ? Math.round(state.liveBonusTokens * devScale) : 0;
    const totalTokens = tools.reduce((s, x) => s + x.tokens, 0) + bonus;
    const totalCostUsd = tools.reduce((s, x) => s + x.costUsd, 0) + (bonus / 1_000_000) * 1.65;
    const cacheReadTokens = tools.reduce((s, x) => s + Math.round(x.tokens * x.cacheReadRatio), 0);
    const cachePct = totalTokens > 0 ? Math.round((cacheReadTokens / totalTokens) * 100) : 0;

    return {
      pMeta,
      devObj,
      scale,
      tools,
      models,
      totalTokens,
      totalCostUsd,
      cachePct,
    };
  }

  function updateChrome() {
    root.dataset.wbTheme = state.theme;
    const scope = resolveScope();

    const viewTitles: Record<DemoViewId, [string, string]> = {
      overview: ['总览', 'Overview'],
      usage: ['使用情况', 'Usage'],
      trends: ['趋势', 'Trends'],
      devices: ['设备', 'Devices'],
      limits: ['额度', 'Limits'],
      settings: ['管理', 'Management'],
    };
    const [zTitle, eTitle] = viewTitles[state.view];
    titleEl.textContent = tr(zTitle, eTitle);

    const devLabel = scope.devObj ? scope.devObj.name : tr('4 台设备', '4 devices');
    metaEl.textContent = `${zh ? scope.pMeta.windowZh : scope.pMeta.windowEn} · ${devLabel}`;

    root.querySelectorAll<HTMLElement>('[data-wb-nav]').forEach((btn) => {
      const active = btn.dataset.wbNav === state.view;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-current', active ? 'page' : 'false');
    });

    root.querySelectorAll<HTMLElement>('[data-wb-period]').forEach((btn) => {
      const active = btn.dataset.wbPeriod === state.period;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    });

    const devSelect = root.querySelector<HTMLSelectElement>('[data-wb-device]');
    if (devSelect && devSelect.value !== state.device) devSelect.value = state.device;

    const curBtn = root.querySelector<HTMLElement>('[data-wb-currency]');
    if (curBtn) curBtn.textContent = state.currency;

    const themeBtn = root.querySelector<HTMLElement>('[data-wb-theme-toggle]');
    if (themeBtn) {
      themeBtn.textContent = state.theme === 'dark' ? tr('深色', 'Dark') : tr('浅色', 'Light');
    }

    updateStreamStatus();
  }

  function updateStreamStatus() {
    if (state.queuedBonusTokens > 0) {
      streamDot.dataset.tone = 'deferred';
      streamText.textContent = tr(
        `已暂缓刷新 (+${fmtCompact(state.queuedBonusTokens)} 待回放)`,
        `Refresh deferred (+${fmtCompact(state.queuedBonusTokens)} queued)`,
      );
    } else {
      streamDot.dataset.tone = 'live';
      streamText.textContent = tr('Hub 实时流在线 · detail=slim', 'Hub stream live · detail=slim');
    }
  }

  function renderOverview(): string {
    const scope = resolveScope();
    const periodNames: Record<DemoPeriodId, [string, string]> = {
      today: ['今日', 'Day'],
      yesterday: ['昨天', 'Yesterday'],
      week: ['本周', 'Week'],
      month: ['本月', 'Month'],
      allTime: ['累计', 'Total'],
    };
    const [pZh, pEn] = periodNames[state.period];
    const pName = tr(pZh, pEn);
    const liveCount = DEMO_DEVICES.filter((d) => d.status === 'live').length;

    // 14 天 SVG 柱状图
    const maxDay = Math.max(...DAILY_SERIES_14D.map((d) => d.claude + d.codex + d.cursor + d.other));
    const barsSvg = DAILY_SERIES_14D.map((d, i) => {
      const sum = (d.claude + d.codex + d.cursor + d.other) * (scope.devObj ? scope.devObj.weight : 1);
      const maxScaled = maxDay * (scope.devObj ? scope.devObj.weight : 1);
      const h = Math.max(8, Math.round((sum / Math.max(0.1, maxScaled)) * 86));
      const x = i * 26 + 8;
      const y = 96 - h;
      const isToday = i === DAILY_SERIES_14D.length - 1;
      return `<g class="wb-spark-bar">
        <title>${d.day}: ${sum.toFixed(1)}M tokens</title>
        <rect x="${x}" y="${y}" width="16" height="${h}" rx="3" fill="${isToday ? 'var(--wb-brand)' : 'var(--wb-bar)'}" opacity="${isToday ? '1' : '0.78'}" />
      </g>`;
    }).join('');

    const topToolsHtml = scope.tools.slice(0, 5).map((t) => {
      const share = scope.totalTokens > 0 ? Math.round((t.tokens / scope.totalTokens) * 100) : 0;
      const rightMeta = t.nativeCredits
        ? `<span class="wb-credits-pill">${t.nativeCredits} Credits</span>`
        : `<span>${fmtMoney(t.costUsd, state.currency)}</span>`;
      return `<button type="button" class="wb-row-btn" data-wb-jump-tool="${esc(t.id)}">
        <div class="wb-row-top">
          <span class="wb-row-name">${iconImg(t.iconSlug, 16)}<span>${esc(t.name)}</span></span>
          <span class="wb-row-val mono">${fmtCompact(t.tokens)}</span>
        </div>
        <div class="wb-row-sub">
          <span class="mono">${share}% · ${t.provenance === 'estimated' ? tr('本地推算', 'Reconstructed') : tr('精确计数', 'Exact')}</span>
          <span class="mono">${rightMeta}</span>
        </div>
        <div class="wb-meter"><span style="width:${Math.max(4, share)}%;background:${t.color}"></span></div>
      </button>`;
    }).join('');

    const topModelsHtml = scope.models.slice(0, 5).map((m) => {
      const share = scope.totalTokens > 0 ? Math.round((m.tokens / scope.totalTokens) * 100) : 0;
      return `<button type="button" class="wb-row-btn" data-wb-jump-models="1">
        <div class="wb-row-top">
          <span class="wb-row-name"><span class="wb-swatch" style="background:${m.color}"></span><span class="mono">${esc(m.label)}</span></span>
          <span class="wb-row-val mono">${fmtCompact(m.tokens)}</span>
        </div>
        <div class="wb-row-sub">
          <span class="mono">${share}% · ${tr('缓存', 'Cache')} ${m.cacheHitPct}%</span>
          <span class="mono">${fmtMoney(m.costUsd, state.currency)}</span>
        </div>
        <div class="wb-meter"><span style="width:${Math.max(4, share)}%;background:${m.color}"></span></div>
      </button>`;
    }).join('');

    const tightLimitsHtml = DEMO_QUOTAS.slice(0, 4).map((q) => {
      const w = q.windows[0];
      const tone = w.remainPct < 20 ? 'bad' : w.remainPct < 50 ? 'warn' : 'good';
      return `<button type="button" class="wb-limit-mini" data-wb-goto="limits">
        <div class="wb-row-top">
          <span class="wb-row-name">${iconImg(q.iconSlug, 15)}<span>${esc(q.provider)}</span></span>
          <span class="wb-tone wb-tone--${tone} mono">${w.remainPct}%</span>
        </div>
        <div class="wb-meter"><span class="wb-fill--${tone}" style="width:${w.remainPct}%"></span></div>
        <div class="wb-row-sub">
          <span>${esc(zh ? w.labelZh : w.labelEn)}</span>
          <span class="mono">${esc(zh ? w.resetZh : w.resetEn)}</span>
        </div>
      </button>`;
    }).join('');

    const devicesMiniHtml = DEMO_DEVICES.map((d) => {
      const dTokens = Math.round(25_880_000 * scope.pMeta.scale * d.weight);
      return `<button type="button" class="wb-dev-mini" data-wb-pick-device="${d.id}">
        <span class="wb-status-dot wb-status-dot--${d.status}"></span>
        <span class="wb-dev-mini__body">
          <span class="wb-dev-mini__name">${esc(d.name)}${d.wsl ? ' <em class="wb-wsl-tag">WSL2</em>' : ''}</span>
          <span class="wb-dev-mini__sub">${esc(zh ? d.lastSeenZh : d.lastSeenEn)} · ${d.status === 'live' ? tr('在线', 'Live') : tr('离线 (>10m)', 'Stale (>10m)')}</span>
        </span>
        <span class="mono wb-dev-mini__tok">${fmtCompact(dTokens)}</span>
      </button>`;
    }).join('');

    const heatCells = HEATMAP_84D.map((lv, idx) => {
      const cls = state.heatmapMetric === 'cost' ? `wb-hcell wb-hcell--cost-${lv}` : `wb-hcell wb-hcell--tok-${lv}`;
      return `<span class="${cls}" title="Day #${idx + 1} · Level ${lv}"></span>`;
    }).join('');

    return `
      <div class="wb-hero-strip">
        <div class="wb-hero-cell wb-hero-cell--primary">
          <span class="wb-cell-k">${esc(pName)} · Token</span>
          <strong class="wb-hero-big mono">${fmtCompact(scope.totalTokens)}</strong>
          <span class="wb-cell-sub">${tr(`其中缓存重读 ${scope.cachePct}%`, `${scope.cachePct}% cache re-reads`)}</span>
        </div>
        <div class="wb-hero-cell">
          <span class="wb-cell-k">${esc(pName)} · ${tr('等效费用', 'Cost')}</span>
          <strong class="wb-hero-mid mono">${fmtMoney(scope.totalCostUsd, state.currency)}</strong>
          <span class="wb-cell-sub">${tr('models.dev 单价账本', 'models.dev rate ledger')}</span>
        </div>
        <div class="wb-hero-cell">
          <span class="wb-cell-k">${tr('设备车队', 'Devices')}</span>
          <strong class="wb-hero-mid mono">${liveCount} / ${DEMO_DEVICES.length}</strong>
          <span class="wb-cell-sub">${tr('1 台逾 10m 置灰', '1 stale (>10m)')}</span>
        </div>
        <div class="wb-hero-cell">
          <span class="wb-cell-k">${tr('实时状态', 'Stream')}</span>
          <strong class="wb-hero-mid wb-tone--good">${tr('在线', 'Live')}</strong>
          <span class="wb-cell-sub mono">SSE · slim</span>
        </div>
      </div>

      <div class="wb-overview-grid">
        <div class="wb-overview-main">
          <section class="wb-panel">
            <div class="wb-panel-head">
              <h4>${tr('近期活动 (14 日)', 'Recent activity (14d)')}</h4>
              <div class="wb-pills-inline mono">
                <span>${tr('活跃天', 'Active')} ${scope.pMeta.activeDays}d</span>
                <span>${tr('连胜', 'Streak')} ${scope.pMeta.streakDays}d</span>
                <span>${tr('峰值', 'Peak')} ${esc(zh ? scope.pMeta.peakZh : scope.pMeta.peakEn)}</span>
              </div>
            </div>
            <svg class="wb-spark-svg" viewBox="0 0 372 102" role="img" aria-label="14-day token trend">
              ${barsSvg}
            </svg>
          </section>

          <div class="wb-dual-panels">
            <section class="wb-panel">
              <div class="wb-panel-head">
                <h4>${tr('常用工具', 'Top tools')}</h4>
                <span class="wb-panel-hint">${tr('点击穿透', 'Click to inspect')}</span>
              </div>
              <div class="wb-stack">${topToolsHtml}</div>
            </section>

            <section class="wb-panel">
              <div class="wb-panel-head">
                <h4>${tr('常用模型', 'Top models')}</h4>
                <span class="wb-panel-hint">${tr('点击对比', 'Compare')}</span>
              </div>
              <div class="wb-stack">${topModelsHtml}</div>
            </section>
          </div>
        </div>

        <aside class="wb-overview-side">
          <section class="wb-panel">
            <div class="wb-panel-head">
              <h4>${tr('紧张额度', 'Tightest limits')}</h4>
              <button type="button" class="wb-link-btn" data-wb-goto="limits">${tr('全部 26 源 →', 'All 26 →')}</button>
            </div>
            <div class="wb-stack">${tightLimitsHtml}</div>
          </section>

          <section class="wb-panel">
            <div class="wb-panel-head">
              <h4>${tr('设备状态', 'Devices')}</h4>
              <button type="button" class="wb-link-btn" data-wb-goto="devices">${tr('详情 →', 'Inspect →')}</button>
            </div>
            <div class="wb-stack">${devicesMiniHtml}</div>
          </section>
        </aside>
      </div>

      <section class="wb-panel wb-heatmap-panel">
        <div class="wb-panel-head">
          <h4>${tr('活跃摘要 · 近 12 周热力图', 'Activity summary · 12-week heatmap')}</h4>
          <div class="wb-seg">
            <button type="button" class="${state.heatmapMetric === 'tokens' ? 'is-active' : ''}" data-wb-heat="tokens">Token</button>
            <button type="button" class="${state.heatmapMetric === 'cost' ? 'is-active' : ''}" data-wb-heat="cost">${tr('费用', 'Cost')}</button>
          </div>
        </div>
        <div class="wb-heatmap-grid">${heatCells}</div>
      </section>
    `;
  }

  function renderUsage(): string {
    const scope = resolveScope();
    const tabs: { id: DemoUsageTab; z: string; e: string }[] = [
      { id: 'tools', z: '工具 (Tools)', e: 'Tools' },
      { id: 'models', z: '模型工作台 (Models)', e: 'Model Workspace' },
      { id: 'projects', z: '项目 (Projects)', e: 'Projects' },
      { id: 'sessions', z: '会话明细 (Sessions)', e: 'Sessions' },
    ];
    const subNav = `<div class="wb-subtabs" role="tablist">
      ${tabs
        .map(
          (tb) =>
            `<button type="button" role="tab" aria-selected="${state.usageTab === tb.id}" class="wb-subtab ${state.usageTab === tb.id ? 'is-active' : ''}" data-wb-utab="${tb.id}">${tr(tb.z, tb.e)}</button>`,
        )
        .join('')}
    </div>`;

    if (state.usageTab === 'tools') {
      const activeTool = scope.tools.find((t) => t.id === state.selectedToolId) ?? scope.tools[0];
      const toolList = scope.tools
        .map((t) => {
          const on = activeTool && t.id === activeTool.id;
          return `<button type="button" class="wb-select-item ${on ? 'is-active' : ''}" data-wb-tool="${esc(t.id)}">
            <span class="wb-row-name">${iconImg(t.iconSlug, 16)}<span>${esc(t.name)}</span></span>
            <span class="mono">${t.nativeCredits ? `<em class="wb-credits-pill">${t.nativeCredits} Cr</em> ` : ''}${fmtCompact(t.tokens)}</span>
          </button>`;
        })
        .join('');

      if (!activeTool) return subNav;
      const uncachedRatio = Math.max(0, 1 - activeTool.cacheReadRatio - activeTool.cacheWriteRatio - activeTool.outputRatio);
      const mixRows = [
        { label: tr('输入 (Input)', 'Input'), ratio: activeTool.inputRatio, color: '#479ef5' },
        { label: tr('输出 (Output)', 'Output'), ratio: activeTool.outputRatio, color: '#a58aff' },
        { label: tr('缓存读取 (Cache read)', 'Cache read'), ratio: activeTool.cacheReadRatio, color: '#3ab6ad' },
        { label: tr('缓存写入 (Cache write)', 'Cache write'), ratio: activeTool.cacheWriteRatio, color: '#e4a23b' },
        { label: tr('未缓存输入 (Uncached)', 'Uncached input'), ratio: uncachedRatio, color: '#ed7aa5' },
      ];

      return `${subNav}
        <div class="wb-master-detail">
          <div class="wb-panel wb-stack">${toolList}</div>
          <div class="wb-panel">
            <div class="wb-panel-head">
              <h4 class="wb-row-name">${iconImg(activeTool.iconSlug, 18)}<span>${esc(activeTool.name)} · ${tr('Token 构成', 'Token mix')}</span></h4>
              <span class="mono">${activeTool.nativeCredits ? `<span class="wb-credits-pill">${activeTool.nativeCredits} Credits (${tr('独立表头', 'Isolated meter')})</span>` : fmtMoney(activeTool.costUsd, state.currency)}</span>
            </div>
            <div class="wb-mix-list">
              ${mixRows
                .map(
                  (r) => `<div class="wb-mix-row">
                    <div class="wb-row-top">
                      <span>${r.label}</span>
                      <span class="mono">${fmtCompact(Math.round(activeTool.tokens * r.ratio))} (${Math.round(r.ratio * 100)}%)</span>
                    </div>
                    <div class="wb-meter"><span style="width:${Math.max(2, Math.round(r.ratio * 100))}%;background:${r.color}"></span></div>
                  </div>`,
                )
                .join('')}
            </div>
            ${
              activeTool.provenance === 'estimated'
                ? `<p class="wb-honest-note">${tr(
                    '出处披露（无 ~ 波浪号伪精确）：部分或全部数据由本地会话内容推算，工具未提供精确 token 计数；原生 Credits 保持独立计量，绝不折算进美元或总 Token。',
                    'Provenance note (no vague "~" prefix): Reconstructed from local session transcript length where exact token logs are absent; native Credits stay isolated.',
                  )}</p>`
                : `<p class="wb-honest-note wb-honest-note--ok">${tr(
                    '精确上游日志：由本地 JSONL / SQLite 会话账本直接汇总，零提示词正文离开磁盘。',
                    'Exact upstream ledger: aggregated directly from local JSONL / SQLite transcripts with zero prompt egress.',
                  )}</p>`
            }
            <div class="wb-sub-section">
              <h5>${tr('工具内模型占比', 'Model share in tool')}</h5>
              <div class="wb-chip-row mono">
                ${activeTool.modelShares.map((ms) => `<span class="wb-chip">${esc(ms.model)} · ${ms.share}%</span>`).join('')}
              </div>
            </div>
          </div>
        </div>`;
    }

    if (state.usageTab === 'models') {
      const q = state.modelQuery.trim().toLowerCase();
      const filtered = scope.models
        .filter((m) => !q || m.label.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q))
        .sort((a, b) => {
          if (state.modelSort === 'cost') return b.costUsd - a.costUsd;
          if (state.modelSort === 'costPer1M') return b.costPer1MUsd - a.costPer1MUsd;
          if (state.modelSort === 'cacheHit') return b.cacheHitPct - a.cacheHitPct;
          return b.tokens - a.tokens;
        });

      const comparedObjs = scope.models.filter((m) => state.comparedModels.includes(m.id));
      const compareCards = comparedObjs
        .map(
          (m) => `<div class="wb-cmp-card">
            <div class="wb-cmp-head">
              <span class="wb-swatch" style="background:${m.color}"></span>
              <strong class="mono">${esc(m.label)}</strong>
            </div>
            <dl class="wb-cmp-dl mono">
              <div><dt>Tokens</dt><dd>${fmtCompact(m.tokens)}</dd></div>
              <div><dt>${tr('费用', 'Cost')}</dt><dd>${fmtMoney(m.costUsd, state.currency)}</dd></div>
              <div><dt>Cost / 1M</dt><dd>${fmtMoney(m.costPer1MUsd, state.currency)}</dd></div>
              <div><dt>${tr('缓存命中', 'Cache hit')}</dt><dd>${m.cacheHitPct}%</dd></div>
            </dl>
          </div>`,
        )
        .join('');

      const csvText = [
        'model,provider,tokens,cost_usd,cost_per_1m_usd,cache_hit_pct',
        ...filtered.map(
          (m) => `${m.label},${m.provider},${m.tokens},${m.costUsd.toFixed(2)},${m.costPer1MUsd.toFixed(2)},${m.cacheHitPct}%`,
        ),
      ].join('\n');

      return `${subNav}
        <div class="wb-panel">
          <div class="wb-model-toolbar">
            <input
              type="search"
              class="wb-input"
              placeholder="${tr('筛选模型或供应商 (如 opus, gpt, deepseek)…', 'Filter model or provider (opus, gpt, deepseek)…')}"
              value="${esc(state.modelQuery)}"
              data-wb-model-search
            />
            <div class="wb-toolbar-right">
              <select class="wb-select" data-wb-model-sort aria-label="${tr('排序依据', 'Sort models')}">
                <option value="tokens" ${state.modelSort === 'tokens' ? 'selected' : ''}>${tr('按 Token 排序', 'Sort: Tokens')}</option>
                <option value="cost" ${state.modelSort === 'cost' ? 'selected' : ''}>${tr('按总费用排序', 'Sort: Cost')}</option>
                <option value="costPer1M" ${state.modelSort === 'costPer1M' ? 'selected' : ''}>${tr('按每百万成本排序', 'Sort: Cost / 1M')}</option>
                <option value="cacheHit" ${state.modelSort === 'cacheHit' ? 'selected' : ''}>${tr('按缓存命中率排序', 'Sort: Cache Hit %')}</option>
              </select>
              <button type="button" class="wb-mini-btn" data-wb-csv-toggle>${tr('导出 CSV', 'Export CSV')}</button>
            </div>
          </div>

          ${state.showCsvPreview ? `<pre class="wb-csv-box mono">${esc(csvText)}</pre>` : ''}

          <div class="wb-cmp-strip">
            <div class="wb-panel-head">
              <h4>${tr(`模型并排比较 (${comparedObjs.length}/4 已选)`, `Side-by-side comparison (${comparedObjs.length}/4 selected)`)}</h4>
              <span class="wb-panel-hint">${tr('勾选下方表格复选框调整对比项', 'Toggle checkboxes below (2–4 models)')}</span>
            </div>
            <div class="wb-cmp-grid">${compareCards}</div>
          </div>

          <div class="wb-table-wrap">
            <table class="wb-table">
              <thead>
                <tr>
                  <th>${tr('对比', 'Cmp')}</th>
                  <th>${tr('模型', 'Model')}</th>
                  <th>Tokens</th>
                  <th>${tr('费用', 'Cost')}</th>
                  <th>Cost / 1M</th>
                  <th>${tr('缓存命中', 'Cache Hit')}</th>
                  <th>${tr('客户端', 'Clients')}</th>
                </tr>
              </thead>
              <tbody>
                ${filtered
                  .map((m) => {
                    const checked = state.comparedModels.includes(m.id);
                    return `<tr>
                      <td><input type="checkbox" data-wb-cmp-check="${esc(m.id)}" ${checked ? 'checked' : ''} aria-label="Compare ${esc(m.label)}" /></td>
                      <td class="mono"><span class="wb-swatch" style="background:${m.color}"></span> ${esc(m.label)}</td>
                      <td class="mono">${fmtCompact(m.tokens)}</td>
                      <td class="mono">${fmtMoney(m.costUsd, state.currency)}</td>
                      <td class="mono">${fmtMoney(m.costPer1MUsd, state.currency)}</td>
                      <td class="mono">${m.cacheHitPct}%</td>
                      <td>${esc(m.clients.join(', '))}</td>
                    </tr>`;
                  })
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>`;
    }

    if (state.usageTab === 'projects') {
      return `${subNav}
        <div class="wb-panel">
          <div class="wb-panel-head">
            <h4>${tr('项目归属（仅保留工作目录末级文件夹名 basename）', 'Project rollups (directory basename only — full paths never leave disk)')}</h4>
          </div>
          <div class="wb-table-wrap">
            <table class="wb-table">
              <thead>
                <tr>
                  <th>${tr('项目名 (Basename)', 'Project (Basename)')}</th>
                  <th>${tr('活跃工具', 'Tools')}</th>
                  <th>${tr('主力设备', 'Primary Device')}</th>
                  <th>Tokens</th>
                  <th>${tr('缓存命中', 'Cache Hit')}</th>
                  <th>${tr('费用', 'Cost')}</th>
                </tr>
              </thead>
              <tbody>
                ${DEMO_PROJECTS.map(
                  (p) => `<tr>
                    <td class="mono"><strong>${esc(p.name)}</strong></td>
                    <td>${esc(p.client)}</td>
                    <td class="mono">${esc(p.device)}</td>
                    <td class="mono">${fmtCompact(Math.round(p.baseTokens * scope.scale))}</td>
                    <td class="mono">${p.cacheHitPct}%</td>
                    <td class="mono">${fmtMoney(p.baseCostUsd * scope.scale, state.currency)}</td>
                  </tr>`,
                ).join('')}
              </tbody>
            </table>
          </div>
        </div>`;
    }

    // Sessions sub-tab
    const activeSes = DEMO_SESSIONS.find((s) => s.id === state.openSessionId) ?? DEMO_SESSIONS[0];
    return `${subNav}
      <div class="wb-master-detail">
        <div class="wb-panel wb-stack">
          ${DEMO_SESSIONS.map((s) => {
            const on = activeSes && s.id === activeSes.id;
            return `<button type="button" class="wb-select-item ${on ? 'is-active' : ''}" data-wb-session="${esc(s.id)}">
              <div>
                <div class="wb-row-name">${iconImg(s.iconSlug, 15)}<strong>${esc(s.project)}</strong> <span class="mono wb-muted">(${esc(s.id)})</span></div>
                <div class="wb-dev-mini__sub">${esc(s.client)} · ${esc(s.model)} · ${esc(zh ? s.updatedZh : s.updatedEn)}</div>
              </div>
              <span class="mono">${fmtCompact(s.tokens)}</span>
            </button>`;
          }).join('')}
        </div>

        <div class="wb-panel">
          <div class="wb-panel-head">
            <h4>${tr('本机会话详情（仅限 5 款本地工具按需直读磁盘）', 'Local Session Details (read live on disk for 5 supported tools)')}</h4>
            <span class="wb-privacy-tag mono">${tr('0 提示词正文上传', '0 prompt text uploaded')}</span>
          </div>
          <div class="wb-table-wrap">
            <table class="wb-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>${tr('时刻', 'Time')}</th>
                  <th>${tr('输入', 'Input')}</th>
                  <th>${tr('缓存读取', 'Cache Read')}</th>
                  <th>${tr('输出', 'Output')}</th>
                  <th>${tr('等效成本', 'Cost')}</th>
                </tr>
              </thead>
              <tbody>
                ${activeSes.prompts
                  .map(
                    (pr) => `<tr>
                      <td class="mono">#0${pr.idx}</td>
                      <td class="mono">${pr.time}</td>
                      <td class="mono">${fmtCompact(pr.input)}</td>
                      <td class="mono">${fmtCompact(pr.cacheRead)}</td>
                      <td class="mono">${fmtCompact(pr.output)}</td>
                      <td class="mono">${fmtMoney(pr.costUsd, state.currency)}</td>
                    </tr>`,
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>`;
  }

  function renderTrends(): string {
    const scope = resolveScope();
    const maxSum = Math.max(...DAILY_SERIES_14D.map((d) => d.claude + d.codex + d.cursor + d.other));
    const stackedBars = DAILY_SERIES_14D.map((d, idx) => {
      const x = idx * 34 + 12;
      const scaleH = 128 / maxSum;
      const h1 = d.claude * scaleH;
      const h2 = d.codex * scaleH;
      const h3 = d.cursor * scaleH;
      const h4 = d.other * scaleH;
      let y = 142;
      const r1 = `<rect x="${x}" y="${(y -= h1).toFixed(1)}" width="20" height="${h1.toFixed(1)}" fill="#479ef5" />`;
      const r2 = `<rect x="${x}" y="${(y -= h2).toFixed(1)}" width="20" height="${h2.toFixed(1)}" fill="#3ab6ad" />`;
      const r3 = `<rect x="${x}" y="${(y -= h3).toFixed(1)}" width="20" height="${h3.toFixed(1)}" fill="#a58aff" />`;
      const r4 = `<rect x="${x}" y="${(y -= h4).toFixed(1)}" width="20" height="${h4.toFixed(1)}" rx="2" fill="#e4a23b" />`;
      return `<g><title>${d.day}</title>${r1}${r2}${r3}${r4}<text x="${x + 10}" y="158" text-anchor="middle" fill="var(--wb-muted)" font-size="9">${d.day.slice(3)}</text></g>`;
    }).join('');

    const rows =
      state.trendGroup === 'tool'
        ? scope.tools.slice(0, 5).map((t) => ({ name: t.name, tokens: t.tokens, cost: t.costUsd, color: t.color }))
        : scope.models.slice(0, 5).map((m) => ({ name: m.label, tokens: m.tokens, cost: m.costUsd, color: m.color }));

    return `
      <div class="wb-panel">
        <div class="wb-panel-head">
          <h4>${tr('每日堆叠趋势 (14D)', 'Stacked daily trend (14D)')}</h4>
          <div class="wb-toolbar-right">
            <div class="wb-seg">
              <button type="button" class="${state.trendGroup === 'tool' ? 'is-active' : ''}" data-wb-tgroup="tool">${tr('按工具', 'By tool')}</button>
              <button type="button" class="${state.trendGroup === 'model' ? 'is-active' : ''}" data-wb-tgroup="model">${tr('按模型', 'By model')}</button>
            </div>
            <div class="wb-seg">
              <button type="button" class="${state.trendMetric === 'tokens' ? 'is-active' : ''}" data-wb-tmetric="tokens">Token</button>
              <button type="button" class="${state.trendMetric === 'cost' ? 'is-active' : ''}" data-wb-tmetric="cost">${tr('费用', 'Cost')}</button>
            </div>
          </div>
        </div>
        <svg class="wb-trend-svg" viewBox="0 0 490 166" role="img" aria-label="14-day stacked breakdown">${stackedBars}</svg>
        <div class="wb-table-wrap">
          <table class="wb-table">
            <thead>
              <tr>
                <th>#</th>
                <th>${state.trendGroup === 'tool' ? tr('工具', 'Tool') : tr('模型', 'Model')}</th>
                <th>Tokens</th>
                <th>${tr('费用', 'Cost')}</th>
                <th>${tr('占比', 'Share')}</th>
              </tr>
            </thead>
            <tbody>
              ${rows
                .map((r, idx) => {
                  const pct = scope.totalTokens > 0 ? Math.round((r.tokens / scope.totalTokens) * 100) : 0;
                  return `<tr>
                    <td class="mono">0${idx + 1}</td>
                    <td><span class="wb-swatch" style="background:${r.color}"></span> ${esc(r.name)}</td>
                    <td class="mono">${fmtCompact(r.tokens)}</td>
                    <td class="mono">${fmtMoney(r.cost, state.currency)}</td>
                    <td class="mono">${pct}%</td>
                  </tr>`;
                })
                .join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  function renderDevices(): string {
    const scope = resolveScope();
    const sel = DEMO_DEVICES.find((d) => d.id === state.selectedDeviceId) ?? DEMO_DEVICES[0];
    const selTokens = Math.round(25_880_000 * scope.pMeta.scale * sel.weight);
    const selCost = 42.65 * scope.pMeta.scale * sel.weight;

    return `
      <div class="wb-kpi-row">
        <div class="wb-panel wb-kpi-card"><span class="wb-cell-k">${tr('设备概览', 'Fleet summary')}</span><strong class="mono">4</strong></div>
        <div class="wb-panel wb-kpi-card"><span class="wb-cell-k">${tr('在线 (≤10m)', 'Live (≤10m)')}</span><strong class="mono wb-tone--good">3</strong></div>
        <div class="wb-panel wb-kpi-card"><span class="wb-cell-k">${tr('离线置灰 (>10m)', 'Stale (>10m)')}</span><strong class="mono wb-tone--warn">1</strong></div>
      </div>

      <div class="wb-master-detail">
        <div class="wb-panel wb-stack">
          ${DEMO_DEVICES.map((d) => {
            const on = d.id === sel.id;
            return `<button type="button" class="wb-select-item ${on ? 'is-active' : ''}" data-wb-dev-inspect="${d.id}">
              <div class="wb-row-name">
                <span class="wb-status-dot wb-status-dot--${d.status}"></span>
                ${iconImg(d.osIcon, 15)}
                <div>
                  <div><strong>${esc(d.name)}</strong></div>
                  <div class="wb-dev-mini__sub">${esc(d.osVersion)}</div>
                </div>
              </div>
              <span class="mono wb-badge-status wb-badge-status--${d.status}">${d.status === 'live' ? tr('在线', 'Live') : tr('离线', 'Stale')}</span>
            </button>`;
          }).join('')}
        </div>

        <div class="wb-panel">
          <div class="wb-panel-head">
            <h4 class="wb-row-name">${iconImg(sel.osIcon, 18)}<span>${esc(sel.name)}</span></h4>
            <span class="mono wb-muted">${esc(zh ? sel.lastSeenZh : sel.lastSeenEn)}</span>
          </div>
          <p class="wb-dev-runtime">${esc(zh ? sel.materialZh : sel.materialEn)}</p>

          <div class="wb-dual-kpis mono">
            <div><span>Tokens</span><strong>${fmtCompact(selTokens)}</strong></div>
            <div><span>${tr('等效费用', 'Cost')}</span><strong>${fmtMoney(selCost, state.currency)}</strong></div>
            <div><span>Runtime</span><strong>${sel.runtime}</strong></div>
          </div>

          ${
            sel.wsl
              ? `<div class="wb-wsl-card">
                  <div class="wb-row-top">
                    <strong>WSL2 · ${esc(sel.wsl.distro)}</strong>
                    <span class="wb-tone wb-tone--good mono">${esc(zh ? sel.wsl.stateZh : sel.wsl.stateEn)}</span>
                  </div>
                  <p>${esc(zh ? sel.wsl.detailZh : sel.wsl.detailEn)}</p>
                </div>`
              : ''
          }

          <div class="wb-sub-section">
            <h5>${tr('工具状态 (活跃 / 等待)', 'Tool status (Active / Waiting)')}</h5>
            <div class="wb-chip-row">
              ${sel.activeTools.map((t) => `<span class="wb-chip wb-chip--active">● ${esc(t)}</span>`).join('')}
              ${sel.waitingTools.map((t) => `<span class="wb-chip">○ ${esc(t)}</span>`).join('')}
            </div>
          </div>

          <div class="wb-sub-section">
            <h5>${tr('设备已记录模型', 'Models on device')}</h5>
            <div class="wb-chip-row mono">
              ${sel.models.map((m) => `<span class="wb-chip">${esc(m)}</span>`).join('')}
            </div>
          </div>
        </div>
      </div>`;
  }

  function renderLimits(): string {
    const cards = DEMO_QUOTAS.map((q) => {
      const wins = q.windows
        .map((w) => {
          const tone = w.remainPct < 20 ? 'bad' : w.remainPct < 50 ? 'warn' : 'good';
          return `<div class="wb-qwin">
            <div class="wb-row-top">
              <span>${esc(zh ? w.labelZh : w.labelEn)}</span>
              <strong class="wb-tone wb-tone--${tone} mono">${esc(zh ? w.valueTextZh : w.valueTextEn)}</strong>
            </div>
            <div class="wb-meter"><span class="wb-fill--${tone}" style="width:${w.remainPct}%"></span></div>
            <div class="wb-row-sub">
              <span>${w.group ? esc(w.group) : ''}</span>
              <span class="mono">${esc(zh ? w.resetZh : w.resetEn)}</span>
            </div>
          </div>`;
        })
        .join('');

      const badgeTone = q.status === 'attention' ? 'bad' : q.status === 'stale' ? 'warn' : 'good';
      return `<article class="wb-panel wb-qcard">
        <div class="wb-qcard__head">
          <div class="wb-row-name">
            ${iconImg(q.iconSlug, 18)}
            <div>
              <strong>${esc(q.provider)}</strong>
              <div class="wb-dev-mini__sub">${esc(zh ? q.planZh : q.planEn)}</div>
            </div>
          </div>
          <span class="wb-tone wb-tone--${badgeTone} mono">${esc(zh ? q.statusZh : q.statusEn)}</span>
        </div>
        <div class="wb-qcard__wins">${wins}</div>
        <div class="wb-qcard__foot mono">
          <span>${esc(zh ? q.authZh : q.authEn)}</span>
          <span>${tr('更新于', 'Fetched')} ${esc(zh ? q.fetchedZh : q.fetchedEn)}</span>
        </div>
      </article>`;
    }).join('');

    return `
      <div class="wb-kpi-row">
        <div class="wb-panel wb-kpi-card"><span class="wb-cell-k">${tr('正常 (Healthy)', 'Healthy')}</span><strong class="mono wb-tone--good">5</strong></div>
        <div class="wb-panel wb-kpi-card"><span class="wb-cell-k">${tr('需要关注 (<20%)', 'Needs attention (<20%)')}</span><strong class="mono wb-tone--bad">1</strong></div>
        <div class="wb-panel wb-kpi-card"><span class="wb-cell-k">${tr('数据陈旧 (Stale)', 'Stale')}</span><strong class="mono wb-tone--warn">1</strong></div>
      </div>
      <div class="wb-qgrid">${cards}</div>`;
  }

  function renderSettings(): string {
    const nav = `<div class="wb-subtabs">
      <button type="button" class="wb-subtab ${state.settingsTab === 'consumption' ? 'is-active' : ''}" data-wb-stab="consumption">${tr('消费 · 订阅与单价对账', 'Consumption · Subscriptions & Pricing')}</button>
      <button type="button" class="wb-subtab ${state.settingsTab === 'accounts' ? 'is-active' : ''}" data-wb-stab="accounts">${tr('账号 · AES-256-GCM 凭据', 'Accounts · AES-256-GCM Vault')}</button>
      <button type="button" class="wb-subtab ${state.settingsTab === 'sessions' ? 'is-active' : ''}" data-wb-stab="sessions">${tr('偏好 · jrs_ 设备会话', 'Preferences · jrs_ Device Sessions')}</button>
    </div>`;

    if (state.settingsTab === 'consumption') {
      return `${nav}
        <div class="wb-panel">
          <div class="wb-panel-head">
            <h4>${tr('固定套餐支出 vs 实际模型等效 API 消耗', 'Recurring subscription spend vs API-equivalent consumption')}</h4>
            <span class="mono wb-tone--good">${tr('月度净节省 +$358.40', 'Net plan leverage +$358.40/mo')}</span>
          </div>
          <div class="wb-dual-kpis mono">
            <div><span>${tr('月度固定订阅折算', 'Monthly subscriptions')}</span><strong>${fmtMoney(260, state.currency)}/mo</strong></div>
            <div><span>${tr('本月 API 等效消耗', 'Month API-equiv usage')}</span><strong>${fmtMoney(618.4, state.currency)}</strong></div>
            <div><span>${tr('API 储值余额池', 'Prepaid API balances')}</span><strong>${fmtMoney(86.2, state.currency)}</strong></div>
          </div>
          <div class="wb-table-wrap">
            <table class="wb-table">
              <thead>
                <tr>
                  <th>${tr('服务商套餐', 'Plan / Top-up')}</th>
                  <th>${tr('周期', 'Cycle')}</th>
                  <th>${tr('月度折算', 'Monthly Equiv')}</th>
                  <th>${tr('下次续费', 'Next Renewal')}</th>
                </tr>
              </thead>
              <tbody>
                <tr><td>Claude Max 20x</td><td>Monthly</td><td class="mono">${fmtMoney(200, state.currency)}</td><td class="mono">2026-12-01</td></tr>
                <tr><td>ChatGPT Pro / Codex</td><td>Monthly (Shared)</td><td class="mono">${fmtMoney(40, state.currency)}</td><td class="mono">2026-11-24</td></tr>
                <tr><td>Cursor Pro</td><td>Monthly</td><td class="mono">${fmtMoney(20, state.currency)}</td><td class="mono">2026-11-18</td></tr>
              </tbody>
            </table>
          </div>
        </div>`;
    }

    if (state.settingsTab === 'accounts') {
      return `${nav}
        <div class="wb-panel">
          <div class="wb-panel-head">
            <h4>${tr('26 家额度供应商凭据管理（仅存自建 Hub）', '26 quota providers (encrypted at rest on your Hub)')}</h4>
            <span class="wb-privacy-tag mono">AES-256-GCM</span>
          </div>
          <div class="wb-stack">
            <div class="wb-select-item"><span><strong>Codex / Antigravity</strong> · ${tr('内置浏览器 OAuth 登录向导（禁用不安全手工粘贴）', 'In-dashboard OAuth browser sign-in wizard')}</span><span class="mono wb-tone--good">OAuth Ready</span></div>
            <div class="wb-select-item"><span><strong>Claude / Cursor / Kimi / ZCode</strong> · ${tr('加密会话令牌轮询，支持 JIRAN_HUB_PREVIOUS_CREDENTIAL_KEYS 平滑轮换', 'Encrypted token polling + seamless key rotation')}</span><span class="mono">Keyring v1</span></div>
            <div class="wb-select-item"><span><strong>OpenRouter / DeepSeek / Volcengine</strong> · ${tr('只读余额 API Key，绝不下发至浏览端或移动端', 'Read-only balance keys; never returned to clients')}</span><span class="mono">Write-Only</span></div>
          </div>
        </div>`;
    }

    return `${nav}
      <div class="wb-panel">
        <div class="wb-panel-head">
          <h4>${tr('已登录设备会话 (hub_sessions 仅存令牌哈希)', 'Signed-in device sessions (only SHA-256 token hashes stored)')}</h4>
        </div>
        <div class="wb-stack">
          <div class="wb-select-item"><span><strong>Chrome · macOS</strong> · <span class="mono">HttpOnly Cookie · ${tr('当前浏览器', 'This browser')}</span></span><span class="mono wb-tone--good">Active</span></div>
          <div class="wb-select-item"><span><strong>MacBook-Pro-M4 Desktop</strong> · <span class="mono">Bearer jrs_8f2a… · Electron client</span></span><span class="mono">Revocable</span></div>
          <div class="wb-select-item"><span><strong>Pixel 9 Pro · Android</strong> · <span class="mono">Bearer jrs_4c91… · Read-only HTTPS</span></span><span class="mono">Revocable</span></div>
        </div>
      </div>`;
  }

  function renderMain() {
    updateChrome();
    if (state.view === 'overview') mainEl.innerHTML = renderOverview();
    else if (state.view === 'usage') mainEl.innerHTML = renderUsage();
    else if (state.view === 'trends') mainEl.innerHTML = renderTrends();
    else if (state.view === 'devices') mainEl.innerHTML = renderDevices();
    else if (state.view === 'limits') mainEl.innerHTML = renderLimits();
    else mainEl.innerHTML = renderSettings();
  }

  // 场景预设一键导览
  root.closest('#workbench')?.querySelectorAll<HTMLButtonElement>('[data-wb-scenario]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sc = btn.dataset.wbScenario;
      root.closest('#workbench')?.querySelectorAll('[data-wb-scenario]').forEach((b) => b.classList.toggle('is-active', b === btn));
      if (sc === 'fleet') {
        state.view = 'overview';
        state.device = 'all';
        state.period = 'today';
      } else if (sc === 'models') {
        state.view = 'usage';
        state.usageTab = 'models';
        state.device = 'all';
        state.period = 'month';
      } else if (sc === 'limits') {
        state.view = 'limits';
      } else if (sc === 'wsl') {
        state.view = 'devices';
        state.selectedDeviceId = 'win-wsl';
      }
      renderMain();
    });
  });

  // 顶层与委托事件
  root.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;

    const navBtn = target.closest<HTMLElement>('[data-wb-nav]');
    if (navBtn?.dataset.wbNav) {
      state.view = navBtn.dataset.wbNav as DemoViewId;
      renderMain();
      return;
    }

    const pBtn = target.closest<HTMLElement>('[data-wb-period]');
    if (pBtn?.dataset.wbPeriod) {
      state.period = pBtn.dataset.wbPeriod as DemoPeriodId;
      renderMain();
      return;
    }

    if (target.closest('[data-wb-currency]')) {
      state.currency = state.currency === 'USD' ? 'CNY' : 'USD';
      renderMain();
      return;
    }

    if (target.closest('[data-wb-theme-toggle]')) {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      renderMain();
      return;
    }

    if (target.closest('[data-wb-pulse]')) {
      state.liveBonusTokens += state.queuedBonusTokens + 42_000;
      state.queuedBonusTokens = 0;
      renderMain();
      return;
    }

    const gotoBtn = target.closest<HTMLElement>('[data-wb-goto]');
    if (gotoBtn?.dataset.wbGoto) {
      state.view = gotoBtn.dataset.wbGoto as DemoViewId;
      renderMain();
      return;
    }

    const jumpTool = target.closest<HTMLElement>('[data-wb-jump-tool]');
    if (jumpTool?.dataset.wbJumpTool) {
      state.view = 'usage';
      state.usageTab = 'tools';
      state.selectedToolId = jumpTool.dataset.wbJumpTool;
      renderMain();
      return;
    }

    if (target.closest('[data-wb-jump-models]')) {
      state.view = 'usage';
      state.usageTab = 'models';
      renderMain();
      return;
    }

    const pickDev = target.closest<HTMLElement>('[data-wb-pick-device]');
    if (pickDev?.dataset.wbPickDevice) {
      state.view = 'devices';
      state.selectedDeviceId = pickDev.dataset.wbPickDevice as Exclude<DemoDeviceId, 'all'>;
      renderMain();
      return;
    }

    const heatBtn = target.closest<HTMLElement>('[data-wb-heat]');
    if (heatBtn?.dataset.wbHeat) {
      state.heatmapMetric = heatBtn.dataset.wbHeat as 'tokens' | 'cost';
      renderMain();
      return;
    }

    const uTab = target.closest<HTMLElement>('[data-wb-utab]');
    if (uTab?.dataset.wbUtab) {
      state.usageTab = uTab.dataset.wbUtab as DemoUsageTab;
      renderMain();
      return;
    }

    const toolSel = target.closest<HTMLElement>('[data-wb-tool]');
    if (toolSel?.dataset.wbTool) {
      state.selectedToolId = toolSel.dataset.wbTool;
      renderMain();
      return;
    }

    if (target.closest('[data-wb-csv-toggle]')) {
      state.showCsvPreview = !state.showCsvPreview;
      renderMain();
      return;
    }

    const sesBtn = target.closest<HTMLElement>('[data-wb-session]');
    if (sesBtn?.dataset.wbSession) {
      state.openSessionId = sesBtn.dataset.wbSession;
      renderMain();
      return;
    }

    const devInspect = target.closest<HTMLElement>('[data-wb-dev-inspect]');
    if (devInspect?.dataset.wbDevInspect) {
      state.selectedDeviceId = devInspect.dataset.wbDevInspect as Exclude<DemoDeviceId, 'all'>;
      renderMain();
      return;
    }

    const tg = target.closest<HTMLElement>('[data-wb-tgroup]');
    if (tg?.dataset.wbTgroup) {
      state.trendGroup = tg.dataset.wbTgroup as 'tool' | 'model';
      renderMain();
      return;
    }

    const tm = target.closest<HTMLElement>('[data-wb-tmetric]');
    if (tm?.dataset.wbTmetric) {
      state.trendMetric = tm.dataset.wbTmetric as 'tokens' | 'cost';
      renderMain();
      return;
    }

    const st = target.closest<HTMLElement>('[data-wb-stab]');
    if (st?.dataset.wbStab) {
      state.settingsTab = st.dataset.wbStab as WorkbenchState['settingsTab'];
      renderMain();
      return;
    }
  });

  root.addEventListener('change', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;

    if (target.matches('[data-wb-device]')) {
      state.device = (target as HTMLSelectElement).value as DemoDeviceId;
      renderMain();
      return;
    }

    if (target.matches('[data-wb-model-sort]')) {
      state.modelSort = (target as HTMLSelectElement).value as ModelSortKey;
      renderMain();
      return;
    }

    if (target.matches('[data-wb-cmp-check]')) {
      const id = (target as HTMLInputElement).dataset.wbCmpCheck!;
      const checked = (target as HTMLInputElement).checked;
      if (checked && !state.comparedModels.includes(id)) {
        state.comparedModels = [...state.comparedModels.slice(-3), id];
      } else if (!checked && state.comparedModels.length > 2) {
        state.comparedModels = state.comparedModels.filter((x) => x !== id);
      }
      renderMain();
    }
  });

  root.addEventListener('input', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (target?.matches('[data-wb-model-search]')) {
      const input = target as HTMLInputElement;
      const pos = input.selectionStart ?? input.value.length;
      state.modelQuery = input.value;
      renderMain();
      const fresh = root.querySelector<HTMLInputElement>('[data-wb-model-search]');
      if (fresh) {
        fresh.focus();
        fresh.setSelectionRange(pos, pos);
      }
    }
  });

  // 演示「交互期间挂起 SSE 刷新」纪律（Rule 03）
  root.addEventListener('pointerenter', () => {
    state.interacting = true;
  });
  root.addEventListener('pointerleave', () => {
    state.interacting = false;
    if (state.queuedBonusTokens > 0) {
      state.liveBonusTokens += state.queuedBonusTokens;
      state.queuedBonusTokens = 0;
      renderMain();
    }
  });

  renderMain();

  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const delta = 18_400;
      if (state.interacting || root.contains(document.activeElement)) {
        state.queuedBonusTokens += delta;
        updateStreamStatus();
      } else {
        state.liveBonusTokens += delta;
        if (state.view === 'overview' && state.period === 'today') renderMain();
      }
    }, 4200);
  }
}
