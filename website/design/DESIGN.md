# 设计说明 · 计算遥测美学（Computational Telemetry）

> 本文记录计然官网的视觉体系、交互工作台设计原则与三维静帧母版的再生成流程。

## 核心理念：让产品本身成为主角

计然（Jiran）取意于「在行动之前先把资源底数算清」。作为现代 AI 编程工具的本地 Token、模型成本与订阅额度遥测平台，官网摒弃脱离产品的抽象古器物隐喻，直接围绕**产品真实界面、Fluent 2 信息层级与高精度遥测信号**展开：

1. **交互式实机工作台（`src/components/Workbench.astro` + `src/scripts/workbench.ts`）**：
   - 紧接首屏置于舞台中央，1:1 对齐桌面端与 Hub Web 共享的 `src/shared-ui/` 双栏布局（左侧分组导航轨、顶部设备与时间范围命令栏、四格核心读数带、14 日柱状走势、工具/模型构成、额度健康卡片、WSL2 设备检视与热力图）；
   - 内置四大一键导览场景（跨设备车队总览、2–4 款模型横向对比与 CSV 导出、26 家订阅与 API 额度预警、Windows + WSL 自动扫描与 10 分钟离线置灰）；
   - 支持实时切换 `USD / CNY` 币种、Fluent 2 `深色 / 浅色` 主题，并真实演示计然标志性的 **`render({ quiet: true })` 交互保护机制**——指针或焦点停留在工作台内时，模拟 SSE 推送自动挂起为「已暂缓刷新」，绝不打断当前交互。

2. **空间三维计算遥测核心（`src/scripts/hero/scene.ts` + `shaders.ts`）**：
   - 几何与计然真实应用图标（`assets/icon.png`）同构：双段开口计量圆弧 + 左下发光信号原点 + 中央 Fresnel 光学计量核 + 外圈 59 枚径向来源刻度针；
   - 59 条三维样条流道将脉冲包汇聚入采集门（实心脉冲代表精确上游日志，半透明脉冲代表按内容推算的本地适配数据）；
   - 右下独立琥珀色卫星环专收原生 `Credits` 脉冲，绝不并入主计量核（对应产品准则：积分与 Token 严格分账）；
   - 底部铺设自定义 GLSL 抗锯齿坐标网格与 14 日量化柱阵。

## 色彩系统

定义在 `design/palette.json` 与 `src/styles/global.css`：

| 令牌 | 色值 | 用途 |
| --- | --- | --- |
| `--bg` | `#060a14` | 站点主画布（深邃黑曜深空色，与 WebGL 清屏色及指数雾同源） |
| `--surface` | `#0d1527` | 玻璃遥测卡片底色 |
| `--fg` / `--fg-dim` | `#f1f5f9` / `#94a3b8` | 高对比主标题正文（>15:1）与次级说明文字 |
| `--cyan` / `--cobalt` | `#38bdf8` / `#0a84ff` | 主遥测信号、核心按钮渐变、Token 用量指示 |
| `--violet` / `--teal` | `#a78bfa` / `#2dd4bf` | 模型输出与订阅配额、缓存命中效率 |
| `--amber` | `#fbbf24` | 原生 Credits 独立通道与成本热力阶梯 |
| `--emerald` / `--rose` | `#34d399` / `#fb7185` | SSE 在线脉冲 / 健康配额、`<20%` 告急预警 |

## 字体系统

全部通过 `@fontsource-variable` 自托管并随构建产物设置一年 `immutable` 缓存，零外部字体请求：

- **标题与界面正文**：`Instrument Sans Variable` + 系统现代中文黑体（`PingFang SC`、`Noto Sans CJK SC`、`Microsoft YaHei UI`）
- **遥测数字、代码与坐标铭牌**：`JetBrains Mono Variable`（强制开启 `tabular-nums` 与斜杠零 `zero`）
- 首屏拉丁可变字体通过 `<link rel="preload">` 与 `src/integrations/early-hints.mjs` 自动写入 `dist/_headers` 的 `103 Early Hints`。

## 动效与性能守卫

- 首屏三维场景所有粒子位置均为 `f(seed, time)` 纯函数，无状态漂移；
- `scene.<hash>.js` 仅在浏览器支持 WebGL2 且未开启 `prefers-reduced-motion: reduce` 时，于页面 `load` 后空闲时间动态加载，绝不阻塞首屏 HTML/CSS；
- 自动检测软件光栅（如 CI 中的 SwiftShader）并平滑降级帧率与流道数；页面滚出首屏或标签页隐藏时立即暂停渲染循环。

## 重新生成三维静帧母版与社交卡片

静帧海报（`src/assets/renders/hero-*.webp`）、OpenGraph 社交卡片（`public/og/og-{zh,en}.jpg`）与 `public/apple-touch-icon.png` 均由实时场景同源生成：

```bash
# 在本地构建区（$BUILD_SCRATCH_ROOT）内执行：
pnpm build
env -u ANTIGRAVITY_AGENT -u AI_AGENT -u CLAUDECODE pnpm exec astro preview --port 4323 --host 127.0.0.1 &
PREVIEW_PID=$!
PLAYWRIGHT_BROWSERS_PATH="$HOME/.build/ms-playwright" node design/tools/stills.mjs http://127.0.0.1:4323/ ./masters
kill $PREVIEW_PID
node design/tools/media.mjs ./masters .
```

生成后将 `src/assets/renders/hero-*.webp`、`public/og/og-{zh,en}.jpg` 与 `public/apple-touch-icon.png` 同步回 worktree 即可。
