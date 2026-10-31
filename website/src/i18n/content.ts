/**
 * 站点文案。所有产品陈述都能在产品仓库 README（main @ 8d7e29f）或 docs/ 中找到出处；
 * 标注「示意」的数字是页面动效用的演示值，不代表任何真实用量。
 * 品牌名：中文显示「计然」，英文显示「Jiran」（产品仓库命名规范）。
 */

export type Lang = 'zh' | 'en';

export const LANGS: Record<Lang, { htmlLang: string; path: string; label: string }> = {
  zh: { htmlLang: 'zh-CN', path: '/', label: '中文' },
  en: { htmlLang: 'en', path: '/en/', label: 'EN' },
};

/** 页面章节锚点，顺序与 nav.sections 对应。 */
export const SECTION_IDS = ['name', 'questions', 'rules', 'flow', 'privacy', 'sources', 'install'] as const;

/** 大写数字：账簿上防篡改的记数法，用作章节序号。 */
export const NUMERALS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌'];

const zh = {
  meta: {
    title: '计然 · 本地优先的 AI 编程工具 Token、成本与额度计量',
    description:
      '计然把你已经在用的 59 个 AI 编程工具与供应商的 Token 用量、花费与订阅额度，先在本机算清楚；多台设备可汇聚到你自己部署的 Hub。无遥测，开源（MIT）。',
    ogAlt: '计然的「刻漏」：五十九处来源的水滴，经三只青瓷壶一滴一滴计入',
  },
  nav: {
    skip: '跳到正文',
    sections: ['名', '问', '则', '汇', '界', '源', '取'],
    download: '下载',
    github: 'GitHub',
    langSwitch: 'English',
  },
  hero: {
    eyebrow: 'Jiran · 为 AI 编程工具而作的本地计量仪',
    title: '计然',
    motto: '点滴有数',
    lead:
      '每个 Token 都是一滴水，从五十九处源头落下。计然在你自己的机器上把它们一滴一滴计入：用了多少，额度还剩多少，实际花了多少钱。',
    ctaPrimary: '下载',
    ctaAll: '全部平台',
    ctaSource: '源代码',
    stats: [
      { n: '59', k: '个工具与供应商' },
      { n: '52', k: '可统计 Token' },
      { n: '26', k: '可读订阅额度' },
      { n: '0', k: '遥测与统计' },
    ],
    counterLabel: '本画面已计入',
    counterUnit: 'tokens',
    counterNote: '演示数据',
    focusLabel: '来源',
    creditsLabel: 'credits · 单独计量，不并入 Token',
    scroll: '向下',
    posterAlt: '计然「刻漏」：五十九处来源的水滴落入青瓷源壶，经平水壶匀成一滴一滴，落进受水壶；浮箭的刻度随计入的 Token 上升，经过朱砂指针',
  },
  name: {
    kicker: '名',
    title: '计之，然后了然',
    body: [
      '计然是《史记·货殖列传》里那位善于「计」的谋士。这两个字也可以读成一句话：计之，然后了然——AI 工具烧掉了多少 Token，这些订阅与调用实际花了你多少钱，一滴一滴算过，心里就有数。',
      '它在 v0.47.0-rev.36 之前叫 Token Monitor。改名不是重置：旧的用户数据目录会在首次启动时被复制过来，旧环境变量与请求头继续有效。',
    ],
    quote: '论其有余不足，则知贵贱。',
    quoteSource: '《史记·货殖列传》引计然语',
    imageAlt: '浮箭特写：刻着汉字序数的竹片从水中升起，经过一根朱砂指针',
  },
  questions: {
    kicker: '问',
    title: '三个数字，从你自己的\u200b磁盘里读出来', // \u200b：keep-all 下的断行点
    intro:
      '每个被跟踪的工具都在本机留下 transcript、会话数据库或缓存。计然读的就是这些——数据本来就在你的磁盘上，计量也就在这里完成。',
    sample: '示意数据',
    items: [
      {
        q: '我到底用了多少？',
        a: '换算成 Token 与成本，按工具、模型、设备、项目、单个会话拆分，并长期保存每日历史。',
        tag: '用量',
      },
      {
        q: '我的订阅还剩多少？',
        a: '各供应商的额度窗口——会话、周、账期、credits。额度由 Hub 探测，并把一份脱敏快照推给所有连接的设备；纯本机模式下「额度」页为空，是设计如此。',
        tag: '额度',
      },
      {
        q: '我为此付了多少钱？',
        a: '手工记账的订阅台账与模型价格表放在一起：这个套餐多少钱、何时续费、本月用量按 API 价格本应花多少。',
        tag: '花费',
      },
    ],
    usageLegend: ['Claude Code', 'Codex', 'OpenCode', '其他'],
    usageAxis: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
    quotaWindows: ['会话', '本周', '账期'],
    quotaLeft: '剩余',
    quotaReset: '后重置',
    ledger: {
      plan: '订阅',
      planValue: '$20.00 / 月',
      renew: '下次续费',
      renewValue: '11 月 3 日',
      equiv: '本月用量 · 按 API 价格',
    },
  },
  rules: {
    kicker: '则',
    title: '数字怎么来的，说清楚',
    intro: '一个把「实测」和「估算」混着显示的仪表板，比没有仪表板更糟。以下是每个界面都遵守的规则。',
    items: [
      {
        glyph: 'src',
        title: '来源和精度分开说',
        body: '某个工具从来没存过真实 Token 数时，总量按它存下的文本估算，wire 记录标 estimated；工具说明会解释来源。界面不会给数字加标记。',
        demoMeasured: '实测',
        demoEstimated: '估算',
      },
      {
        glyph: 'cr',
        title: 'credits 是独立单位',
        body: '以 credits 计费的供应商（Qoder 就是这样）给出精确的 credits，旁边的 Token 是估算数字；credits 绝不折算进 Token 总量。',
      },
      {
        glyph: '‖',
        title: '刷新不打断操作',
        body: '数据每几秒来一帧。下拉框开着、输入到一半时重绘会被推迟，展开的行与滚动位置都保留，内容没变就完全不碰 DOM。',
        demoHint: '把指针停在数字上：新帧被推迟',
        demoHeld: '已推迟',
        demoLive: '实时',
      },
      {
        glyph: 'ISO',
        title: '数字只属于问它的那个标签页',
        body: '今天、本月、全部来自采集器的固定窗口；昨日与本周是按需解析的日历区间。凡是上报总量的地方，一周都从 ISO 周一开始。',
        tabs: ['今天', '昨日', '本周', '本月', '全部'],
        tabNotes: ['采集器固定窗口', '按需解析的日历区间', '按需解析 · ISO 周一起算', '采集器固定窗口', '采集器固定窗口'],
      },
      {
        glyph: '10′',
        title: '置灰的设备是真的沉默了',
        body: '最后一次上报超过 10 分钟的设备被标记为 stale 并置灰，而不是假装它还在线。',
        demoClock: '演示时钟 ×60',
        devices: ['工作站', 'MacBook', 'WSL · Ubuntu'],
        lastSeen: '最近上报',
      },
    ],
  },
  flow: {
    kicker: '汇',
    title: '四个界面，一个产品',
    intro:
      '默认就是本机模式：打开桌面应用即开始跟踪这台设备，不需要 Hub、agent 或 .env。需要汇总多台机器时，在你自己控制的机器上用 Docker Compose 起一个 Hub。',
    surfaces: [
      { name: '桌面应用', tech: 'Electron · Windows / macOS / Linux', role: '采集本机数据并呈现完整界面', hub: '不需要' },
      { name: 'Hub', tech: 'Docker Compose + MySQL', role: '接收上报、聚合、SSE 推送，并在同一端口提供 Web 仪表板 / 可安装 PWA', hub: '—' },
      { name: 'Headless agent', tech: 'Node.js', role: '没有图形界面的采集端，用于服务器与 WSL 发行版', hub: '需要' },
      { name: 'Android', tech: 'Kotlin / Compose', role: '在手机上查看设备群组的用量与额度；不采集、不上报', hub: '需要' },
    ],
    th: ['界面', '职责', 'Hub'],
    diagram: {
      sources: '本机工具的 transcript / 会话库 / 缓存',
      collector: 'tokscale 采集器',
      collectorNote: '文件变化后 1.5 s 去抖 · 每 5 分钟完整扫描',
      ingest: 'POST /api/ingest',
      hub: 'Hub · MySQL',
      hubNote: '规范化 + 聚合',
      stream: 'SSE /api/stats/stream',
      readers: ['桌面', '浏览器', 'Android'],
      device: '一台设备',
      quota: '额度探测只在 Hub',
    },
    destinations: {
      title: '应用内的六个入口',
      items: ['总览', '使用情况', '设备', '额度', '趋势', '管理'],
      note: '桌面应用与 Hub 网页渲染的是同一套界面——一次排布的页面，两处行为一致。',
    },
  },
  privacy: {
    kicker: '界',
    title: '本地优先是架构，不是口号',
    intro:
      '没有遥测，没有统计，没有托管后端，也不向维护者发送任何东西。只有在你启用的功能里才会联网：检查更新、汇率查询、你自己部署的 Hub、你在 Hub 上配置的额度账号对应的供应商。',
    staysTitle: '永远留在这台机器上',
    stays: ['提示词与回复', '源代码与文件内容', '工作区的绝对路径', 'OAuth 凭据、access / refresh token', '供应商 Cookie 与 API key', '供应商的原始响应'],
    crossesTitle: '开启同步后，发往你自己的 Hub',
    crosses: ['设备标识与元数据', 'Token 与成本的汇总', '工具、模型、会话、项目归属', '可选的工作区文件夹名（不含绝对路径）', '你手工记下的订阅信息'],
    boundary: '设备边界',
    site: '这个网站也一样：没有统计脚本，不设 Cookie。唯一的外部请求是向 GitHub 读取最新版本号。',
    more: '完整隐私说明',
  },
  sources: {
    kicker: '源',
    title: '五十九个来源，一处定义',
    intro:
      '工具清单只在一处定义，所有运行时常驻采集全集，没有逐项开关，因此不存在「悄悄少算」的状态。没有出现在这里的工具，就是没有被跟踪。',
    filters: { all: '全部', u: 'Token 用量', l: '订阅额度', s: '会话明细' },
    legend: '圆点依次表示：Token 用量 · 订阅额度 · 会话明细',
    more: '查看完整矩阵与读取路径',
  },
  install: {
    kicker: '取',
    title: '下载，打开，它就开始计数',
    intro: '首次运行不需要任何配置。打包版会检查 GitHub Releases 并提示更新。',
    latest: '正式版',
    published: '发布于',
    fallback: '在 GitHub Releases 查看全部文件',
    detected: '根据你的系统推荐',
    platforms: [
      { id: 'mac', name: 'macOS', req: 'macOS 12+ · 已签名并公证', assets: [['macArm', 'Apple Silicon（.dmg）'], ['macIntel', 'Intel（.dmg）']] },
      { id: 'win', name: 'Windows', req: 'Windows 10 / 11 · 已代码签名', assets: [['winSetup', '安装版（.exe）'], ['winPortable', '便携版（.exe）']] },
      { id: 'linux', name: 'Linux', req: 'x64', assets: [['appImage', 'AppImage'], ['deb', 'Debian 包（.deb）']] },
      { id: 'android', name: 'Android', req: 'Hub 的读端，需要一个 Hub', assets: [['android', 'APK']] },
      { id: 'server', name: '服务器', req: 'Headless agent 需 Node.js 22.13+；Hub 用 Docker Compose', assets: [['headless', 'Headless agent（.tar.gz）'], ['hubCompose', 'Hub Compose 包（.zip）']] },
    ],
    hubTitle: '多台机器：部署一个 Hub',
    hubBody: '根目录的 docker-compose.yml 是唯一受支持的部署方式。仪表板由 Hub 在同一端口（17321）提供，可安装为 PWA；镜像 ghcr.io/igngserver/jiran-hub。',
    hubGuide: 'Hub 部署指南',
    copy: '复制',
    copied: '已复制',
    tested: '开发与验证集中在 Windows 11、Docker Compose Hub 与运行 headless agent 的 Ubuntu；其他平台尚未完整验证，可能有问题。',
  },
  footer: {
    line: '计然 · Jiran',
    tagline: '先在本机算清楚。',
    product: '产品',
    docs: '文档',
    links: {
      repo: '源代码',
      releases: '版本发布',
      tools: '支持矩阵',
      privacy: '隐私说明',
      hub: 'Hub 部署',
      agent: 'Headless agent',
      config: '配置',
      api: 'API',
    },
    credits: 'Token 计量基于 {tokscale}。产品以 {MIT} 许可开源。',
    site: '本站不使用 Cookie 与统计脚本。',
  },
  notFound: { title: '这一页没有被计入', body: '链接可能已失效。', back: '回到首页' },
};

type Content = typeof zh;

const en: Content = {
  meta: {
    title: 'Jiran · Local-first token, cost and quota metering for AI coding tools',
    description:
      'Jiran reads token usage, cost and plan quotas for 59 AI coding tools and providers from your own disk, and can gather several machines into a Hub you run yourself. No telemetry. Open source (MIT).',
    ogAlt: 'The Jiran clepsydra: drops from fifty-nine sources counted, one by one, through three celadon vessels',
  },
  nav: {
    skip: 'Skip to content',
    sections: ['Name', 'Ask', 'Rules', 'Flow', 'Edge', 'Sources', 'Get'],
    download: 'Download',
    github: 'GitHub',
    langSwitch: '中文',
  },
  hero: {
    eyebrow: '计然 · A local meter for AI coding tools',
    title: 'Jiran',
    motto: 'Every drop, counted.',
    lead:
      'Every token is a drop, and they fall from fifty-nine sources. Jiran counts them drop by drop on your own machine — what you used, what is left of your plan, and what it actually cost.',
    ctaPrimary: 'Download',
    ctaAll: 'All platforms',
    ctaSource: 'Source',
    stats: [
      { n: '59', k: 'tools & providers' },
      { n: '52', k: 'report token usage' },
      { n: '26', k: 'expose plan quotas' },
      { n: '0', k: 'telemetry & analytics' },
    ],
    counterLabel: 'Counted in this view',
    counterUnit: 'tokens',
    counterNote: 'demo figure',
    focusLabel: 'source',
    creditsLabel: 'credits · kept apart from tokens',
    scroll: 'Scroll',
    posterAlt: 'The Jiran clepsydra: drops from fifty-nine sources fall into a celadon basin, are evened out by a regulating vessel and drip into the receiving vessel, where a graduated float rod rises past a cinnabar pointer as tokens are counted',
  },
  name: {
    kicker: 'Name',
    title: 'Count it, and it comes clear',
    body: [
      '计然 (Jīrán) is the strategist in the Records of the Grand Historian remembered for keeping count. The two characters also read as a sentence — count it, and it comes clear: the tokens your AI tools spent and what those plans actually cost you, tallied drop by drop until you know.',
      'It shipped as Token Monitor up to v0.47.0-rev.36. The rename is not a reset: the old user-data folder is copied over on first launch, and the old environment variables and headers keep working.',
    ],
    quote: 'Weigh what is in surplus and what falls short, and you will know what is dear and what is cheap.',
    quoteSource: 'Jiran, as quoted in Shiji · Biographies of the Money-makers',
    imageAlt: 'Close-up of the float rod: a bamboo slip marked with Chinese numerals rises from the water past a cinnabar pointer',
  },
  questions: {
    kicker: 'Ask',
    title: 'Three numbers, read from your own disk',
    intro:
      'Every tracked tool already keeps transcripts, session databases or caches on your machine. Jiran reads those — the data already lives on your disk, so that is where the counting happens.',
    sample: 'sample data',
    items: [
      {
        q: 'How much have I used?',
        a: 'Tokens and cost, broken down by tool, model, device, project and individual session, with a durable daily history.',
        tag: 'Usage',
      },
      {
        q: 'How much of my plan is left?',
        a: 'Per-provider quota windows — session, weekly, billing, credits. The Hub probes them and publishes one sanitized snapshot to every device; in local-only mode the Limits page is empty by design.',
        tag: 'Limits',
      },
      {
        q: 'What am I paying for it?',
        a: 'A hand-kept subscription ledger sits beside the model price list: what a plan costs, when it renews, and what this month would have cost at API prices.',
        tag: 'Cost',
      },
    ],
    usageLegend: ['Claude Code', 'Codex', 'OpenCode', 'Other'],
    usageAxis: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    quotaWindows: ['Session', 'Week', 'Billing'],
    quotaLeft: 'left',
    quotaReset: 'to reset',
    ledger: {
      plan: 'Plan',
      planValue: '$20.00 / mo',
      renew: 'Renews',
      renewValue: 'Nov 3',
      equiv: 'This month · at API prices',
    },
  },
  rules: {
    kicker: 'Rules',
    title: 'Honest about what is measured',
    intro: 'A usage dashboard that quietly mixes measurements with guesses is worse than no dashboard. These rules hold on every surface.',
    items: [
      {
        glyph: 'src',
        title: 'Provenance, not a glyph',
        body: 'Where a tool never stored real token counts, the total is reconstructed from the text it did store and the wire record marks it estimated; the tool detail panel explains the source. No number carries a marker prefix.',
        demoMeasured: 'measured',
        demoEstimated: 'reconstructed',
      },
      {
        glyph: 'cr',
        title: 'Credits are their own unit',
        body: 'A provider that bills in credits (Qoder is the case in point) reports exact credits beside its reconstructed token total; credits are never folded into a token total.',
      },
      {
        glyph: '‖',
        title: 'A refresh never interrupts you',
        body: 'Frames arrive every few seconds. While a dropdown or a half-typed value is open the rebuild is deferred, expanded rows and scroll positions are kept, and nothing is written when nothing changed.',
        demoHint: 'Hover the number: new frames wait',
        demoHeld: 'deferred',
        demoLive: 'live',
      },
      {
        glyph: 'ISO',
        title: 'A number belongs to the tab that measured it',
        body: 'Day, Month and Total come from the collector’s fixed windows; Yesterday and Week are calendar ranges resolved on request. Everywhere a total is reported, the week starts on ISO Monday.',
        tabs: ['Day', 'Yesterday', 'Week', 'Month', 'Total'],
        tabNotes: ['collector window', 'calendar range, on request', 'on request · ISO Monday', 'collector window', 'collector window'],
      },
      {
        glyph: '10′',
        title: 'A greyed device is a silent device',
        body: 'A device whose last report is older than 10 minutes is marked stale on purpose, rather than being shown as if it were live.',
        demoClock: 'demo clock ×60',
        devices: ['Workstation', 'MacBook', 'WSL · Ubuntu'],
        lastSeen: 'last report',
      },
    ],
  },
  flow: {
    kicker: 'Flow',
    title: 'Four surfaces, one product',
    intro:
      'Local mode is the default: launch the desktop app and it starts tracking this device — no Hub, no agent, no .env. To gather several machines, run a Hub with Docker Compose on a machine you control.',
    surfaces: [
      { name: 'Desktop app', tech: 'Electron · Windows / macOS / Linux', role: 'Collects this machine and shows the full UI', hub: 'no' },
      { name: 'Hub', tech: 'Docker Compose + MySQL', role: 'Ingest, aggregation, SSE, and the same dashboard as a web app / installable PWA', hub: '—' },
      { name: 'Headless agent', tech: 'Node.js', role: 'The collector with no GUI, for servers and WSL distros', hub: 'yes' },
      { name: 'Android', tech: 'Kotlin / Compose', role: 'Reads the fleet and the quotas on a phone; collects and posts nothing', hub: 'yes' },
    ],
    th: ['Surface', 'Role', 'Needs a Hub'],
    diagram: {
      sources: 'local transcripts / session DBs / caches',
      collector: 'tokscale collector',
      collectorNote: '1.5 s debounce on change · full scan every 5 min',
      ingest: 'POST /api/ingest',
      hub: 'Hub · MySQL',
      hubNote: 'normalize + aggregate',
      stream: 'SSE /api/stats/stream',
      readers: ['Desktop', 'Browser', 'Android'],
      device: 'one device',
      quota: 'quota probing lives on the Hub',
    },
    destinations: {
      title: 'Six destinations inside the app',
      items: ['Overview', 'Usage', 'Devices', 'Limits', 'Trends', 'Management'],
      note: 'The desktop app and the Hub dashboard render the same interface — a screen arranged once behaves the same in both.',
    },
  },
  privacy: {
    kicker: 'Edge',
    title: 'Local-first is the architecture, not a slogan',
    intro:
      'No telemetry, no analytics, no hosted backend, nothing sent to the maintainer. Network access happens only for features you use: the update check, the exchange-rate lookup, the Hub you deploy, and the providers behind quota accounts you configured there.',
    staysTitle: 'Never leaves this machine',
    stays: ['Prompts and replies', 'Source code and file contents', 'Absolute workspace paths', 'OAuth credentials, access / refresh tokens', 'Provider cookies and API keys', 'Raw provider responses'],
    crossesTitle: 'With sync on, goes to your own Hub',
    crosses: ['Device identifiers and metadata', 'Aggregate token and cost totals', 'Tool, model, session and project attribution', 'An optional workspace folder label (never a path)', 'Subscription details you typed in'],
    boundary: 'device boundary',
    site: 'This website follows suit: no analytics scripts, no cookies. Its only outside request asks GitHub for the latest version number.',
    more: 'Full privacy policy',
  },
  sources: {
    kicker: 'Sources',
    title: 'Fifty-nine sources, wired in one place',
    intro:
      'The client list is defined once and every runtime always collects all of it — there is no per-tool opt-in that could silently under-count. A tool with no entry here is not tracked.',
    filters: { all: 'All', u: 'Token usage', l: 'Plan quotas', s: 'Session details' },
    legend: 'Dots, in order: token usage · plan quotas · session details',
    more: 'Full matrix with data paths',
  },
  install: {
    kicker: 'Get',
    title: 'Download it, open it, it starts counting',
    intro: 'First run needs no setup. Packaged builds check GitHub Releases and surface an update indicator.',
    latest: 'Latest stable',
    published: 'published',
    fallback: 'Browse every file on GitHub Releases',
    detected: 'Suggested for your system',
    platforms: [
      { id: 'mac', name: 'macOS', req: 'macOS 12+ · signed and notarized', assets: [['macArm', 'Apple Silicon (.dmg)'], ['macIntel', 'Intel (.dmg)']] },
      { id: 'win', name: 'Windows', req: 'Windows 10 / 11 · code-signed', assets: [['winSetup', 'Installer (.exe)'], ['winPortable', 'Portable (.exe)']] },
      { id: 'linux', name: 'Linux', req: 'x64', assets: [['appImage', 'AppImage'], ['deb', 'Debian package (.deb)']] },
      { id: 'android', name: 'Android', req: 'A Hub read client — needs a Hub', assets: [['android', 'APK']] },
      { id: 'server', name: 'Server', req: 'Headless agent needs Node.js 22.13+; the Hub runs on Docker Compose', assets: [['headless', 'Headless agent (.tar.gz)'], ['hubCompose', 'Hub Compose bundle (.zip)']] },
    ],
    hubTitle: 'Several machines: run a Hub',
    hubBody: 'The root docker-compose.yml is the only supported deployment. The Hub serves the dashboard on the same port (17321), installable as a PWA; the image is ghcr.io/igngserver/jiran-hub.',
    hubGuide: 'Hub deployment guide',
    copy: 'Copy',
    copied: 'Copied',
    tested: 'Development and verification concentrate on Windows 11, a Docker Compose Hub, and Ubuntu running the headless agent. Anything outside that has not been fully verified and may misbehave.',
  },
  footer: {
    line: 'Jiran · 计然',
    tagline: 'Count it on your own machine first.',
    product: 'Product',
    docs: 'Docs',
    links: {
      repo: 'Source code',
      releases: 'Releases',
      tools: 'Supported tools',
      privacy: 'Privacy',
      hub: 'Run a Hub',
      agent: 'Headless agent',
      config: 'Configuration',
      api: 'API',
    },
    credits: 'Token accounting runs on {tokscale}. The product is open source under {MIT}.',
    site: 'This site sets no cookies and runs no analytics.',
  },
  notFound: { title: 'This page was never counted', body: 'The link may be out of date.', back: 'Back to the start' },
};

export const CONTENT: Record<Lang, Content> = { zh, en };
export type { Content };
