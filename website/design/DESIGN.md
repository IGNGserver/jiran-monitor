# 设计说明 · 产品优先与四组「Token 词元」主题模型

> 本文记录计然官网的视觉设计原则、四组「Token 词元」主题三维模型规范、章节结构与静态资产重生成流程。

## 核心理念：讲清楚产品能力，三维模型服务于词元语义

计然（Jiran）的官网围绕开发者真实关心的问题展开：**用了多少 Token、订阅配额还剩多少、多台电脑怎么在保护隐私的前提下同步查看**。

1. **拒绝「展示模型而喧宾夺主」**：
   - 不使用全局贯通固定画布或粘性五屏爆炸拆解，不编造硬件机芯编号，不使用光学/钟表隐喻词或内部源码变量横幅。
   - 采用清晰、克制、诚实的产品语言（与仓库 `README.zh-CN.md` / `README.md` 口径一致）。

2. **四组按章节依次呈现的「Token 词元」主题三维模型（`design/tokens.json` + `design/tools/build-models.mjs` + `src/scripts/models/`）**：
   - **`hero.glb`（首屏 `#top` · 词元流归集）**：左侧四条本地会话滑轨上的原始词元块穿过本地解析门框，在右侧归集为缓存读取、输入、输出与成本/Credits 四组立体词元叠柱；
   - **`mix.glb`（核心功能一 `#features` · 五维词元构成与模型单价对比）**：前排展示输入、输出、5 层半透明缓存读取晶片、缓存写入与未缓存输入五维词元积木，后排展示三款主力模型的词元量叠块与百万单价金柱对照；
   - **`quota.glb`（核心功能二 `#features` · 双窗口配额环与独立 Credits）**：左侧底座带周一至周日 7 格刻度与「周限额 + 5 小时滚动窗口」双环，右侧独立分离的底座承载原生 Credits 金色词元叠牌与月费/API 对照柱，直观体现原生积分独立分账；
   - **`hub.glb`（多端与隐私 `#architecture` · 本地留盘与自建 Hub 同步）**：左侧开发机将深色原始对话记录留在本地底座，仅让青色/金色词元增量沿导轨汇入中央三层 Docker Compose Hub 立方体，并分发至右侧 Android 手机与 5 款桌面微件。

3. **单引擎按需懒加载架构**：
   - 首屏先直接呈现响应式 AVIF / WebP 高清静帧（零 CLS、零首屏阻塞）；
   - 页面 `load` 空闲后按需动态加载 `src/scripts/models/runtime.ts`，全场共享单一离屏 `WebGLRenderer` 与摄影棚 PMREM 反射贴图，仅对进入视口的 `[data-model-stage]` 懒加载对应 `.glb` 并驱动渲染；开启系统「减少动态（`prefers-reduced-motion: reduce`）」时完全不初始化 WebGL。

## 色彩与排版系统

定义在 `design/palette.json` 与 `src/styles/global.css`：

| 令牌 | 色值 | 用途 |
| --- | --- | --- |
| `--void` / `--ink-1..3` | `#090b10` / `#0e1118` / `#141923` / `#1b2230` | 沉稳石墨深色底板与卡片表面层级 |
| `--fg` / `--fg-dim` / `--fg-faint` | `#eef1f6` / `#9ba3b2` / `#636c7d` | 铂白正文标题、次级说明与辅助标注 |
| `--cyan` | `#4fc3f7` | **语义信号 A**：Token 词元数量、五维构成比例与配额窗口余量 |
| `--brass` | `#e5a94c` | **语义信号 B**：真实货币成本（USD/CNY/TWD/HKD）与独立原生 `Credits` |
| `--danger` | `#ef5a52` | `<20%` 紧迫配额提醒与本地边界提示词过滤标识 |

字体全部通过 `@fontsource-variable` 自托管并开启一年 `immutable` 缓存（`Instrument Sans Variable` + 系统现代中文无衬线体用于标题与正文，字重 `520–640` 清晰易读；`JetBrains Mono Variable` 用于等宽数字与配置命令）。

## 重新生成压缩 GLB、高清静帧与社交卡片

在本地构建区（`$BUILD_SCRATCH_ROOT/token记录系统/<slug>`）内执行：

```bash
# 1. 由 design/tokens.json 参数化生成并经 gltfpack (meshopt) 压缩输出四组 GLB：
pnpm run models

# 2. 构建站点后通过无头 Chromium WebGL2 采集确定性高清静帧母版，并合成 WebP 与 OG 分享卡：
pnpm build
PLAYWRIGHT_BROWSERS_PATH="$HOME/.build/ms-playwright" pnpm run stills .tmp-masters
pnpm run media .tmp-masters .
rm -rf .tmp-masters
```

生成后将 `public/models/{hero,mix,quota,hub}.glb`、`src/assets/renders/{hero,hero-portrait,mix,quota,hub}.webp`、`public/og/og-{zh,en}.jpg` 与 `public/apple-touch-icon.png` 同步回 worktree。
