# 设计说明 · 光学计量暗室与 JR-01 机芯（Precision Optical Metrology）

> 本文记录计然官网的视觉设计纪律、JR-01 参数化三维机芯结构、六幕空间连续叙事与资产重生成流程。

## 核心理念：钟表级光学计量（Horological AI Metrology）

计然（Jiran）取意于「在行动之前先把资源底数算清」。官网摒弃传统 SaaS 模板的蓝紫底色、霓虹药丸与重复圆角玻璃卡片，采用**无彩色黑曜石暗室底板 + 1px 建筑游丝分割 + 双信号光学色彩纪律**，并围绕参数化建模的五层机械光学机芯 **`JR-01 Chrono-Ledger Core`** 与 1:1 真实产品工作台展开：

1. **参数化五层计量机芯（`design/meter.json` + `design/blender/build_meter.py` + `src/scripts/meter/`）**：
   - **`L_quota`（顶层 · 蓝宝石双弧表冠）**：折射曲面蓝宝石穹顶内悬浮计然标志性的开放双圆弧与 T 字擒纵桥（与产品图标同构），168 刻暗钛表圈锚定全球统一的 ISO 周一零点窗口；
   - **`L_credits`（二层 · 悬臂式偏心黄铜副盘）**：香槟黄铜副盘物理悬挑于主轴之外，象征原生 `Credits`（如 Qoder）绝不掺入总 Token 或美元成本；对侧三枚锁芯对应 Hub 的 `AES-256-GCM` 凭据密钥环；
   - **`L_drum`（三层 · 反向啮合里程鼓轮与行星汇率环）**：外圈精钢里程鼓累加实时 Token，内圈 48 齿黄铜行星环咬合 `models.dev` 单价与多币种汇率；
   - **`L_prism`（四层 · 五棱石英分光镜与游标出处环）**：中央五棱石英将调用拆入五条径向波导轨（输入 / 输出 / 缓存读 / 缓存写 / 未缓存输入），外周游标区分上游精确日志与字符推算出处（拒写伪精确 `~`）；
   - **`L_ingest`（底层 · 59 槽光纤底座与 12 叶零外泄光阑）**：52 道冰青光纤与 7 道黄铜配额槽经 4 座跨主机 / `\\wsl$` 桥接入账，中央 12 叶机械光阑在落盘处当场剥离提示词正文与代码路径。

2. **六幕空间连续叙事（全局固定 `<Stage />` + `director.ts`）**：
   - **`#top`（首屏组装态）**：`JR-01` 悬浮于 84 日双信号量化波面与 4 设备车队信标之上，左侧配超细字重建筑排版与实时双轨读数仪；
   - **`#anatomy`（粘性五层爆炸剖面）**：随滚动将五层总成纵向拉开，SVG 虚线引线与三维投影标签像素级锚定各层，将核心能力与五条自动化测试计量铁律合一；
   - **`#workbench`（1:1 实机 Fluent 2 交互工作台）**：在 CNC 暗钛金属边框内完整复刻 `src/shared-ui/`，真实演示 ISO 周一窗口、多模型并排对比、独立 Credits 与 `render({ quiet: true })` 暂缓刷新；
   - **`#architecture`（零外泄光学门拓扑沙盒）**：Canvas 实时演示灰红色提示词碎片在本机光阑处汽化拦截、冰青 Token 与黄铜成本汇入自建 Hub `:17321`，支持亲手切换「仅本机离线模式」与模拟「>10 分钟休眠置灰及 baseline 无损续接」；
   - **`#sources`（59 款工具无缝游丝台账）**：1px 游丝网格，按能力筛选与即时搜索；
   - **`#install`（54° 冠冕回归与等距容器栈）**：三维舞台以高俯角回归蓝宝石双弧表冠，配合五端无障碍下载面板与 CSS 3D 等距分层 Docker Hub 堆栈。

## 色彩系统（严格双信号纪律）

定义在 `design/palette.json` 与 `src/styles/global.css`：

| 令牌 | 色值 | 用途 |
| --- | --- | --- |
| `--void` / `--ink-1..3` | `#050608` / `#090b0f` / `#0e1117` / `#151922` | 无彩色黑曜石暗室底板与阶梯表面（零海军蓝偏色） |
| `--fg` / `--fg-dim` / `--fg-faint` | `#edf0f5` / `#9aa1ae` / `#5e6572` | 铂银主油墨（对比度 >16:1）、次级说明与坐标刻度 |
| `--line` / `--line-2` | `rgb(255 255 255 / 0.08)` / `0.16` | 1px 建筑游丝分割线与十字对位准星（`.reg`） |
| `--cyan` | `#56ccf2` | **唯一信号色 A**：仅用于 Token 计量脉冲、5 维分光与时间配额余量 |
| `--brass` | `#e5a94c` | **唯一信号色 B**：仅用于真实货币成本（USD/CNY）与独立原生 `Credits` |
| `--danger` | `#ef5a52` | 仅用于 `<20%` 临界配额告警与光阑拦截火花 |

## 字体系统

全部通过 `@fontsource-variable` 自托管并设置一年 `immutable` 缓存，零第三方字体 CDN：

- **陈列标题与界面正文**：`Instrument Sans Variable` + 系统现代中文黑体（`PingFang SC`、`Noto Sans CJK SC`、`Microsoft YaHei UI`，超细陈列字重 `250–320`）
- **遥测读数、不变量代码与坐标铭牌**：`JetBrains Mono Variable`（开启 `tabular-nums` 与斜杠零 `zero`）
- 首屏拉丁可变字体通过 `<link rel="preload">` 与 `src/integrations/early-hints.mjs` 自动写入 `dist/_headers` 的 `103 Early Hints`。

## 重新生成 Blender Cycles 母版、压缩 GLB 与社交卡片

几何单一事实来源为 `design/meter.json`（与 `src/scripts/meter/spec.ts` 严格对齐）：

```bash
# 1. 使用 Blender 5.2 LTS 无头执行参数化建模、Cycles AgX 16-bit 静帧渲染与原始 GLB 导出：
blender --background --python design/blender/build_meter.py -- ./masters

# 2. 在本地构建区（$BUILD_SCRATCH_ROOT）内执行 meshopt 量化压缩与 WebP / OG 卡片合成：
node design/tools/model.mjs ./masters/meter_raw.glb
node design/tools/media.mjs ./masters .
```

生成后将 `design/blender/jiran_meter.blend`、`public/models/meter.glb`、`src/assets/renders/{hero,hero-portrait,exploded}.webp`、`public/og/og-{zh,en}.jpg` 与 `public/apple-touch-icon.png` 同步回 worktree。
