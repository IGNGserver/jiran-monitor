# 设计说明 · 刻漏

> 本文记录官网视觉的来源、规则与设计源资产的再生成方法。改视觉之前先读这一页。

## 概念

计然是《史记·货殖列传》里善于「计」的谋士；这两个字也可以读成一句话：**计之，然后了然**。
Token 是一滴一滴烧掉的，所以站点围绕一件真实存在、专门计量「流」的中国仪器展开——
**刻漏**（铜壶滴漏）。主标语「**点滴有数**」由「心中有数」化来。

首屏是一座三级刻漏，从左后上方一级级落到右前下方：

| 部件 | 对应的产品事实 |
| --- | --- |
| 五十九道从画面外落下的水滴 → **源壶** | 59 个工具与供应商（`src/data/product.ts` 的 `COUNTS.rows`）；越靠前的来源滴得越勤 |
| **平水壶**：一根出水管把源壶的水匀成稳定的一滴一滴 | tokscale 采集器：文件变化后 1.5 s 去抖、每 5 分钟完整扫描——不管上游多乱，下游是匀速的 |
| **受水壶** + 浮箭 + 朱砂指针 | 计入的总量。浮箭的刻度（汉字序数「一刻、二刻……」）随读数向上走过指针；读数在实时场景里贴在指针旁边 |
| 实心水滴 / **半透明水滴** | 「~」就是估算：实测与估算一眼可分（比例是演示值） |
| 旁边单独的小杯，落入铜色水滴 | credits 是独立单位，绝不倒进主壶（绝不折算进 Token） |
| 水面上的涟漪 | 「计入」的那一刻 |

刻意避开的东西（上一版「算仪」的教训）：画面中心不放任何圆形或发光核心（会读成瞳孔或黑洞）；
不用密集点云和光亮的红色小球（会触发密集恐惧）；不用纯黑底；不借用天文、星系的意象。

章节序号用账簿上的大写数字（壹贰叁肆伍陆柒），既是中文排版细节，也呼应「计」。

## 色彩

与 `design/kelou.json` 的 `palette` 同源，CSS 变量见 `src/styles/global.css`。

| 名 | 值 | 用途 |
| --- | --- | --- |
| 宣纸 paper `--bg` | `#f2ede3` | 底色；WebGL 场景的清屏色与雾色也是它，器物直接立在纸上 |
| 墨 ink `--fg` | `#1f1e1c` | 正文、标题、主按钮 |
| 青瓷 celadon | `#a9c1b5` / 文字用 `#4f7a6e` | 壶与水；页面里的「实时 / 健康」状态、能力圆点、数据流 |
| 黛 dai | `#3b4a55` | 规则章节的符号、图表次级序列 |
| 铜 brass `--rule` | `#a8834a` | credits、刻度细线 |
| 朱砂 cinnabar | `#c3402b` | **只**作「印」：品牌印章与标识里的一滴、章节序号、当前读数（指针与读数引线）、「0 遥测」 |

标识沿用产品图标的几何——开口刻度环加一根指针刻线，原来的朱砂算珠改成一滴朱砂
（`src/components/Mark.astro`、`public/favicon.svg`、`design/tools/media.mjs` 里的同一条路径）。

## 字体

| 角色 | 字体 | 说明 |
| --- | --- | --- |
| 展示（拉丁） | Instrument Serif | 窄而高的衬线，标题与工具名 |
| 展示（中文） | Noto Serif SC 400/600 | 只收站点用到的字（见下文「中文字体子集」）；首屏的竖排题跋「点滴有数」与印章、浮箭上的刻度数字也用它 |
| 正文 | Instrument Sans + 系统中文黑体 | |
| 数字与标签 | JetBrains Mono | 等宽数字、零带斜杠，像仪表读数 |

全部自托管（`@fontsource`），不请求第三方字体服务。中文标题使用 `word-break: keep-all`，只在标点处断行。

### 中文字体子集

`@fontsource/noto-serif-sc` 按 unicode-range 切成约 100 片，页面上几百个汉字会散落在 25～27 片里，
冷加载要拉近 1MB 字体。站点因此不直接引用这些分片，而是由 `design/tools/cjk-fonts.py` 从同一批分片里
抽出用到的字合并成子集（字形与 OpenType 特性原样保留，竖排用的 `vert` / `vrt2` 也在），产物提交进仓库：

| 文件 | 内容 |
| --- | --- |
| `src/assets/fonts/noto-serif-sc-a-{400,600}.woff2` | 英文页与所有脚本里出现的字（两种语言都会用到） |
| `src/assets/fonts/noto-serif-sc-b-{400,600}.woff2` | 其余只在中文页 / 404 出现的字 |
| `src/styles/fonts-cjk.css` | 对应的 `@font-face`，`unicode-range` 精确到字，所以英文页只下载 a 档 |
| `src/assets/fonts/noto-serif-sc.chars.json` | 每档收录的字；`tests/fonts.spec.ts` 用它检查构建产物里的字都被覆盖 |

改文案引入了新字时测试会失败并列出缺字。重新生成（Python 3 + `pip install -r design/tools/requirements.txt`）：

1. `pnpm build`；
2. `pnpm fonts`（读取 `dist/` 与 `node_modules` 里锁定版本的分片，改写上面四个文件）；
3. 再 `pnpm build`，`pnpm test` 通过后连同字体一起提交。升级 `@fontsource/noto-serif-sc` 后同样要重跑。

## 动效原则

- 场景是纯函数：每一滴水的位置 = f(种子, 时间)（`src/scripts/hero/scene.ts`）。第 n 滴的出水时刻是
  `(n + phase) × interval`；远处来的水滴按终端速度下落（先加速、再匀速，画面里停留得够久，能被看清和标注），
  出水口的短距离滴落是自由落体。涟漪由同一套时刻解析出来传给水面着色器（`shaders.ts`）。
  唯一逐帧积累的状态是演示计数器的缓动。
- 先上屏文字与静帧，页面 load 之后、空闲时再加载 three；任何失败都停在静帧上。需要 WebGL2（three r163 起不再支持 WebGL1）。
- `prefers-reduced-motion: reduce` 时不启动 WebGL，所有过渡缩为瞬时。
- 首屏滚出后停止渲染；标签页隐藏时停止渲染；前 90 帧过慢则像素比降为 1、阴影变硬。
- 标注：每隔一阵挑一滴正在空中的水，把它染成墨色并标上来源名与能力圆点；读数贴在朱砂指针旁，
  竖屏或空间不够时退回角落。
- 计数器是演示值，所以带「~」——与产品「`~` 就是估算」的规则一致。章节里的小仪表同样标注「示意数据」。

## 设计源资产

| 文件 | 作用 |
| --- | --- |
| `design/kelou.json` | 刻漏的几何、节奏与配色——站点场景与静帧共用的唯一定义 |
| `design/tools/stills.mjs` | 用站点自己的首屏场景（`?still=<机位>&t=<秒>&w=&h=`）渲染静帧母版 |
| `design/tools/media.mjs` | 由母版生成站点图片、社交卡片与 apple-touch-icon |
| `design/tools/cjk-fonts.py` | 按站点用字生成 Noto Serif SC 子集（见「中文字体子集」） |
| `src/assets/renders/kelou-*.webp` | 母版的高质量 WebP；构建时由 Astro 再生成多尺寸 |

静帧不再用 Blender 单独建模：它们就是实时场景在固定时刻的一帧，所以永远与页面上动起来的画面一致。

### 重新生成静帧

1. 起站点：`pnpm dev`（或 `pnpm build && pnpm preview`）。
2. `node design/tools/stills.mjs http://127.0.0.1:4321/ <母版目录>`——三张母版：

   | 母版 | 尺寸 | 机位 | 时刻 |
   | --- | --- | --- | --- |
   | `wide-base.png` | 2400×1260 | `wide`：刻漏在右侧，给文字留白 | 41.3 s |
   | `tall-base.png` | 1200×1800 | `tall`：刻漏在上半屏 | 41.3 s |
   | `macro-base.png` | 1600×1600 | `macro`：浮箭、刻度与朱砂指针特写（「名」一节） | 47.9 s |
3. `pnpm media <母版目录> .` 生成 `src/assets/renders/`、`public/og/`、`public/apple-touch-icon.png`。

改 `kelou.json` 或场景代码后重跑这三步，静帧与实时画面就一起更新。
