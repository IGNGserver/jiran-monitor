# Android 端 Fluent 2 迁移审计（2026-09-26）

> 本文件先是**审计**，随后记录了**修复结果**。§2–§5 的问题按原样保留（其中若干条已修，
> 结论见 §8）；组件与令牌的现行契约在 [android-fluent2-contract.md](android-fluent2-contract.md)，
> 那份是长期文档，这份是历史 + 决策依据。

审计对象：工作区**未提交**的 Android UI 改动 —— 19 个已修改 Kotlin 文件 + 5 个新增未跟踪文件
（`FluentNav.kt` / `FluentScaffold.kt` / `theme/{Adaptation,Elevation,Motion}.kt`），
`git diff --stat` 为 +3664 / −2993，另有未跟踪的 `scripts/verify-android-fluent-contrast.js`、
`docs/design/fluent2-*` 与 `package.json` 里的 guard 接线。分支 `main`，基线 `7f27762`（v0.47.0-rev.11）。

## 0. 基线事实（本次实测，非推断）

| 检查 | 结果 |
| --- | --- |
| `./gradlew --offline :app:compileDebugKotlin` | BUILD SUCCESSFUL，产物时间晚于全部源文件 → 当前工作树**能编译** |
| `npm run verify:android-fluent-contrast` | 通过（42+42 别名、25 个引用官方 token、38 文本对 + 6 非文本对） |
| `npm run verify:product-scope` / `npm test` | 通过，2221 passed / 0 failed |
| Android 测试 | 仅 3 个文件 / 25 个 JUnit4 用例，全在 data + formatters，**UI 零测试** |
| CI | `.github/workflows/ci.yml` **不跑 Android**；Android 只在 `release.yml` 打 tag 时构建 |

也就是说：这 6600 行改动没有打破任何**现有**契约，但现有契约里**没有一条**覆盖 Android 的组件层、
布局层和功能对齐。下面所有问题的共同成因就是这个观测面缺口。

## 1. 结论摘要

迁移分三层，完成度差异极大：

| 层 | 完成度 | 判断依据 |
| --- | --- | --- |
| Token 层（色 / 形 / 距 / 字 / 动效 / 高度） | **基本完成** | `Color.kt` 有官方 token 守卫；`Type.kt` 是 1:1 的 Fluent type ramp 且页面直用 `FluentTypeRamp`（全站只有 1 处仍读 `MaterialTheme.typography`）；硬编码 dp 只在 `MoreScreens.kt` 一个文件里集中 |
| 外壳组件层 | **做了一半** | `AppCard`/`FluentNavBar`/`FluentListRow`/`FluentTabStrip`/`DateTimeRangePicker` 是真 Fluent 实现（无 ripple、tint state layer、4/8/12dp 圆角、发丝描边 + 阴影）；但同一屏内并存 M3 `Switch`/`Button`/`AlertDialog`/`OutlinedTextField`，`FluentSection` 全仓仅 1 处调用、`FluentCardList` 仅 3 处 |
| 设计逻辑 / 功能面 | **基本没动** | 信息架构、作用域模型、i18n、账号管理、状态语义仍停留在迁移前；且 `res/`、平台主题、edge-to-edge、焦点语义这些"底层设计决定"完全没被触碰 |

最尖锐的一条：**没有任何一处业务代码读 `MaterialTheme.colorScheme`**（实测：全站唯一命中是 `Theme.kt:28` 的注释）。
那座 M3↔Fluent 桥（`Theme.kt:37-109`）的**唯一存在理由就是给残留的 M3 控件供电**。
所以"组件没改全"不只是观感不统一 —— 每留一个 M3 控件，就继续供养一层本该被淘汰的桥接复杂度。

## 2. A 类：组件没改全（M3 / M2 残留）

### A1 已确认的可见缺陷（P0）

| # | 位置 | 问题 | 证据链 |
| --- | --- | --- | --- |
| A1-1 | `OverviewScreen.kt:19-21,129,341` | 下拉刷新用的是 **Material 2** 的 `pullRefresh`；`PullRefreshIndicator` 未传 `backgroundColor/contentColor/elevation`，而 `TokenMonitorTheme`（`Theme.kt:212`）只提供 M3 与 Fluent 两套 CompositionLocal，M2 的 `LocalColors` 无人覆盖 → 刷新指示器落在 **M2 基线调色板**：明暗两套都是白底盘 + 紫色（#6200EE）箭头。这是全站最强的一处"根本没换" | `MainActivity.kt:24` 只有 `TokenMonitorTheme`；`build.gradle.kts:89` 仍依赖 `libs.compose.material` |
| A1-2 | `TokenMonitorApp.kt:142` + `FluentScaffold.kt:85-127` | `Scaffold(contentWindowInsets = WindowInsets(0,0,0,0))` 把四边 inset 全部归零，而全仓 `statusBarsPadding()` **只出现 1 次**（`FluentScaffold.kt:150`，在 `FluentTopBar` 内）。四个根 tab 页用的是 `FluentPageHeader`（`Overview:149`/`Analytics:99`/`Devices:91`/`More:130`），无任何顶部 inset 补偿；`MainActivity` 也没有 `enableEdgeToEdge()`。targetSdk 36 → Android 15+ 强制边到边，**标题会被状态栏压住** | 实测 grep：`statusBarsPadding` 1 处、`enableEdgeToEdge` 0 处 |
| A1-3 | `res/values/themes.xml:2` | 平台主题 parent 是 `android:style/Theme.Material.Light.NoActionBar`（M2 平台主题），且 `res/` 里**没有 `values-night`**：深色模式下窗口背景/状态栏/导航栏仍按浅色 Material 基线走，冷启动与 Compose 首帧之间会闪白 | `find res` 实测只有 3 个文件 |
| A1-4 | `MoreScreens.kt:637-654` | `FloatingActionButton` + `shape = CircleShape`：Fluent 体系**没有 FAB 这个组件**；且 `elevation` 走 `FloatingActionButtonDefaults`（M3 tonal elevation 语义），只把 Dp 换成了 Fluent 值。`pressedElevation(level4) < defaultElevation(level8)` 还按反了 | 同文件 `:704` 已有 `FluentFilledButton` 却没用 |
| A1-5 | `Theme.kt:136-142` | M3 1.3 的按钮圆角走 `FilledButtonTokens.ContainerShape` → `ShapesKt.fromToken()` 这条 token 通道（已反编译 `material3-android:1.3.1` 确认调用链），`toMaterialShapes()` 只能覆盖 5 个 shape 槽位，**约束不到它**。因此 `MoreScreens.kt:945,957,992-994,1051,1058` 的 `Button`/`OutlinedButton` 圆角脱离 Fluent `controlCorner=4dp` 契约（实际渲染半径待目视确认，见 §7） | `FluentShapes.toMaterialShapes` 无 `full` 槽位 |

### A2 残留 M3 控件清单（P0/P1，全部是"同屏双系统"）

| 控件 | 位置 | Fluent 对应物 |
| --- | --- | --- |
| `Switch` | `MoreScreens.kt:1041` | Fluent ToggleSwitch（40×20、拇指无 ✓、关闭态需可见描边）；M3 是 52×32 + 圆形 ripple |
| `AlertDialog` ×2 | `MoreScreens.kt:760,812` | 容器用 M3 tonal 色阶表达高度（`surfaceContainerHigh` ← `neutralBackground3`）；Fluent 应为「平表面 + shadow(level16) + 0.5dp 描边 + largeCorner」—— `DateTimeRangePicker.kt:141-157` 已经把正确做法写出来了，这里没复用 |
| `OutlinedTextField` ×4 | `MoreScreens.kt:765,806,1001,1010` | Fluent Field：label 恒置顶、边框恒 `neutralStroke1` 1px、焦点只加**外部**焦点环；M3 是浮动 label + 聚焦时边框加粗到 2dp |
| `Button`/`OutlinedButton`/`TextButton` | `MoreScreens.kt:945,957,992-994,1051,1058,1064,1094`、`UiCards.kt:164,361`、`DateTimeRangePicker.kt:291,314` | `FluentFilledButton`（同文件 `:704`）已存在；`SectionHeader`/`EmptyState` 就在它旁边却没换 |
| `IconButton` | `FluentScaffold.kt:164,200`、`MoreScreens.kt:571,689`、`DateTimeRangePicker.kt:388,400` | Fluent quiet icon button：4dp 方角 + hover/press 底色，非圆形 ripple |
| `CircularProgressIndicator` | `AnalyticsScreen.kt:251` | Fluent ProgressRing（更细笔触、非材料端点） |
| `Scaffold`/`SnackbarHost` | `TokenMonitorApp.kt:140,200` | 已把 insets 归零并覆 `containerColor`，`FluentSnackbar` 自绘 —— 可接受，但见 A1-2 的 inset 副作用 |
| `FilterChip` | `MoreScreens.kt:39` | **死 import**，全站零调用（`FluentTabStrip` 已取代）→ 直接删，是"只做一半"最省事的证据 |
| vico `m3ChartStyle` | `TrendCharts.kt:36,110,288` | 图表样式来自 M3 样式包；`Color.kt:351` 的 `FluentChartPalette` 才是项目自己的契约，却没接进 Vico |
| Material Icons | 全站 47 处 import，含 `FluentNav.kt:59-62` 的导航图标 | Fluent System Icons。且 filled/outlined 混用（导航与空态用 Outlined，`Add`/`Refresh`/`Check`/chevron 用 Filled），与 `FluentNav.kt` 注释自述的"Fluent 以 outlined 为常态"矛盾；尺寸 18/20/22dp 无统一格。`scripts/update-fluent-assets.js` 只同步 web 的 `src/shared-ui/vendor`，**Android 端零 Fluent 图标资产** |
| **客户端品牌图标整体缺席** | `ClientBranding.kt:159-183` | 实测 Android `res/` 有 **0 个 drawable**、全仓 **0 处 `painterResource`/SVG 加载**，而 `src/shared-ui/icons/clients/` 有 **64 个官方 SVG**（web 与桌面都在用）。所以 43 个被跟踪客户端在 Android 上一律降级成字母 monogram（`monogram()` 取首字母），品牌识别度与两端不一致。这是资产管线没接到 Android 的直接后果，和上一条同源 |

### A3 桥接层自身的缺陷（P1，会咬人但目前无读者）

- `Theme.kt:43-45,78-80`：`secondary = neutralForeground2` 配 `onSecondary = foregroundOnAccent`，`tertiary = brandForeground1` 配 `onTertiary = foregroundOnAccent` —— **把前景色当容器色、再叠白字**。今天无人读 `colorScheme.secondary`，但任何新引入的 M3 组件（或残留的 `AlertDialog` 内部配色）一读就错。
- `Theme.kt:41,49,70,76,77,84,85,105`：`primaryContainer`/`tertiaryContainer`/`inversePrimary` 用 `Color(0xFF…)` 硬编码 MS Blue 常量。守卫的解析器只认 `FluentColorTokens` 实例内的 `alias = argb("HEX")` 行（`verify-android-fluent-contrast.js:98`），**这些值完全在守卫之外** → 选 Green/Purple/Rose 种子时它们仍然漏蓝。
- `Theme.kt:162,168`：主题选择器的 `System`/`Rose` 色板直接用了 Material 调色板的 `#607D8B`（Blue Grey 500）与 `#C2185B`（Pink 700）—— 一个 Fluent 应用的主题挑选器上挂着两颗 Material 品牌色。
- `Theme.kt:197-201` 动态取色双轨：`ThemeSeedId.System` 是**默认值**（`UserPreferencesStore.kt` 的 `theme_seed` 默认 `system`），Android 12+ 上 `MaterialTheme.colorScheme` 走 Material You 壁纸色，而所有自绘组件读 `LocalFluentColors`（固定蓝）。结果默认路径就两套强调色同屏：`MoreScreens.kt:1041` 的 Switch 轨道是壁纸色，`:1037,1071` 的文字是 Fluent 蓝。注释（`Theme.kt:187-191`）自己承认了这点。`docs/design/fluent-2.md:22` 认可壁纸取色，但没处理这个组件层后果。

## 3. B 类：只换了组件，布局与设计逻辑没按 Fluent 重做

### B1 焦点与选中语义整体缺失（P0，最严重）

实测全仓 `focusable` / `focusIndicator` / `State.Selected` / `selectable(` / `toggleable` **命中 0 次**。
所有可点击的自绘 Fluent 组件一律传 `indication = null`（`UiCards:121`、`FluentNav:139,195`、`FluentScaffold:356,455`、`Charts:306`、`AnalyticsScreen:349`、`MoreScreens:730`），于是：

- 键盘 / 遥控器 / 外接指针下**焦点完全不可见**；
- 导航项声明了 `Role.Tab`（`FluentNav.kt:140,195`）却没有 `State.Selected`，选中只对 TalkBack 靠 `contentDescription="已选择"` 兜底（仅主题色板 `MoreScreens.kt:888` 这么做），其余靠颜色 + 字重 —— 色觉障碍与高对比模式下失去信息；
- 全仓 `contentDescription` 仅 25 处，导航图标为 `null`。

这直接推翻了 `docs/design/fluent-2.md:18` 承诺的 "keyboard and screen reader support"，而且 Fluent 的状态规范里 focus 是一等状态。

另外两处是**双层 state layer 叠加**（手写 tint + M3 ripple 同时在跑）：`DateTimeRangePicker.kt:433`（日历格：ripple 叠 `:437-450` 的 Fluent 选中填充）、`MoreScreens.kt:1026`（整行 clickable 默认 ripple 叠 Switch 自身 ripple）。同屏混用：定价屏 `:603`（FluentFilledButton）vs `:571,637`（M3）。

### B2 自适应体系是死变量（P0）

`Adaptation.kt:22-48` 定义了 `isCompact/isMedium/isLarge/isLargeFont/fontScale`，`Theme.kt:207,210` 提供，
但实测**除 `motionEnabled` 外全站零消费者**。后果：

- `isLargeFont` 注释自称"1.3x 是固定高度撑破的分界"，却没人读 → nav 56dp、TopBar 48dp、行 min 52dp、色板 40dp 在超大字下必然裁切；
- 大屏策略绕过该层：`TokenMonitorApp.kt:82,221` 直接 `LocalConfiguration.current.screenWidthDp` 判 rail 与 720dp 封顶，`LocalConfiguration` 在分屏/多窗口下不可靠，而且和 `Adaptation` 是两套真相；
- `Adaptation.kt:65-66` 的 600/840 断点注释写"per Fluent's breakpoint ladder"，实际是 Material 的 `WindowSizeClass` 数值 —— Fluent web 的阶梯不是这一套；
- 无 forced-colors / 高对比处理（web 有 `@media (forced-colors: active)`）。

`docs/design/fluent2-screenshot-redesign-brief.md` 全文 **0 次提到 Android**，所以 Android 侧从来没有写成文字的规格 —— 这解释了为什么壳层与逻辑层会分叉。

### B3 动效规则没落实到底（P1）

`Motion.kt` 本身是合格的 Fluent 实现（官方 `duration*`/`curve*`、tab 横向 / push-pop 纵向、enter 比 exit 慢）。缺口在执行面：

- `fluentMotionEnabled()` 只接到 NavHost 四套转场与 `FluentStaggeredIn`。**骨架 shimmer（`Skeleton.kt`）、`animateGrowFraction/Progress`（`ChartAnimation.kt`）、颜色 tween、日历 `animateFloatAsState` 全部不看这个开关** → 动画缩放为 0 的设备上它们照跑；
- 只读 `ANIMATOR_DURATION_SCALE`，未读 Android 13+ 无障碍 reduce-motion；
- `FluentStaggeredIn` 用无 key 的 `remember` + `LaunchedEffect(Unit)`，SSE 帧不重播（对），但 LazyColumn 回收滚回会重播。

### B4 间距与页面骨架不统一（P1）

- `MoreScreens.kt` 一个文件 **62 处字面 `.dp`**，其中 13×`10.dp`、4×`6.dp`、2×`14.dp`、1×`2.5.dp` 不在 `Spacing.kt` 自称的 strict 4dp 网格上；Overview/Analytics/Devices 已经全量 token 化 —— 同一次改动里明显是两个时代的代码。
- `FluentTabStrip` 自带 `padding(horizontal = l)`（`FluentScaffold.kt:421`），嵌进默认 `contentPadding = l` 的 `AppCard` 后卡内 tab 比卡内标题多缩 16dp（`AnalyticsScreen.kt:662,731,736,769`、`OverviewScreen.kt:212,240`）。控件契约没考虑"卡内复用"。
- 命名债：`AppCard`/`SectionHeader`/`MetricHeroCard` 读起来是 M3 时代的名字，实现其实已是 Fluent 表面（`UiCards.kt:66-127`：无 ripple、tint state layer、发丝描边 + Fluent elevation）。真正的问题是**同一职责两套原语并存**且新那套没人用：`FluentSection` 1 处、`FluentCardList` 3 处、`FluentListRow` 6 处，而 `AppCard` 11 处、`SectionHeader` 18 处。设置屏（`MoreScreens.kt:1020-1064`）甚至手搓 `Row + clickable + 尾随 Switch` 当偏好行，而 `FluentListRow` 就在同一文件的 `:674` 被用着。
- 高度近似而非实现：`Elevation.kt:37-45` 把 Fluent 的 key+ambient 双层阴影压成单个 `Dp`（文件 `:19-24` 自认"honest approximation"），Compose 单光源渲染出的仍是 M3 阴影；且同族表面不统一 —— `AppCard` 有阴影、`CompactMetricCard`/`FluentCardList` 没有。
- `UiCards.kt:118` 的 `Modifier.then(if (onClick != null) Modifier else Modifier)` 是空操作死代码。
- 自定最小触控 48dp（`FluentScaffold.kt:80` `FluentTouchMin`）被自己打破：色板 40dp（`MoreScreens.kt:887`）、按钮高 32dp（`:726`）。

### B5 信息架构仍是旧模型（P1）

`docs/design/fluent-2.md:14` 的决议是"页面标题 → 共享作用域命令栏"。web 落地成了**一个全局 `prefs.period`**，`PERIOD_TABS = today/yesterday/week/month/allTime` 跨视图共享（`app.js:133`、`state.prefs.period`）。
Android 是另一套：`HubViewModel.kt:28` 的 `AnalyticsPeriodKind` 只属于分析屏，总览屏根本没有作用域条 —— 它把 `今日/本月/全部` 三张卡同时铺开（`OverviewScreen.kt:158,189,194`），设备详情页与项目页又各自独立选周期（`DevicesScreen.kt:71,194`、`MoreScreens.kt:469`）。
作用域选一次不跨页跟随，这是 web 上已经被废弃的旧模型，属于设计逻辑未重做的核心实例。

## 4. C 类：功能未与网页端对齐

web 侧 8 个视图（`app.js:103-112`：overview/usage/devices/limits/trends/accounts/management/settings）、
5 套 locale（en/zh-CN/zh-TW/ja/ko，每套 548 key）、约 20 个端点。
Android 侧 4 个一级 + 9 个子路由、10 个 REST 端点、0 套 locale。

### C1 数据正确性（P0 —— 不是"少功能"，是"显示错")

| 问题 | 证据 |
| --- | --- |
| **Qoder 在 Android 上恒显示 0 token / 0 成本**。Qoder 以 credits 计量、token 字段全为 0，`clientCredits` 是唯一精确值；web 有独立 credits 格式化（`core/format.js:66-85`），Android `HubDtos.kt` 里**没有 `clientCredits`/`clientModelCredits`/`sessions.*.credits` 任何字段**，份额图直读 `clients` map | `docs/API.md:268`（"this is the one Qoder figure that is exact"）、`grep clientCredits android/` = 0 |
| **估算值与精确值不可区分**。web 用 `estimatedValue()` 打 `~` 前缀（`core/format.js:83-85`、`core/data.js:527`），Android `Formatters.kt` 无对应函数、DTO 无 `clientEstimated` | Qoder/Claude Desktop 等来源本身就是 `estimated: true`。后续版本已移除 `~` 前缀，只保留 `estimated` 数据与详情说明 |
| 设备数据源**同屏两轨**：总览与设备页读 `state.devices`（来自 `/api/devices`，SSE 帧不刷新，`HubViewModel.kt:348` 只换 `stats`），服务状态页读 `stats.devices`（实时）。两份同名列表可以互相矛盾 | `OverviewScreen.kt:98`、`DevicesScreen.kt:76`、`MoreScreens.kt:1116,1121` |
| "在线"两套定义：总览用 `!it.stale`（`OverviewScreen.kt:328`），设备页用 `deviceCountsAsOnline(stale, clientStatus)`（`DevicesScreen.kt:88`）→ 同一次改动内两屏统计口径不同 | `Formatters.kt:249-263` |
| 死 UI：`DevicesScreen.kt:363` 渲染 `LimitsSection(device.limits, "本设备限额")`，但 Hub 明确 `delete device.limits`（`src/hub/server.js:507`），`LimitsSection` providers 空即 `return`（`LimitsUi.kt:123`）→ **该区块永不出现** | 实测两端代码 |
| `FluentPageHeader` 与 `HubApiFactory` 的中文异常文案、`Locale.CHINA`（`DateTimeRangePicker.kt:343`）等把语言写死进代码 | 见 C2 |

### C2 i18n = 0（P0）

`res/` 下**没有 `strings.xml`，没有任何 `values-<lang>` 目录**；UI 文案硬编码中文（`MoreScreens.kt` 92 行含 CJK、`AnalyticsScreen.kt` 53 行、`OverviewScreen.kt` 28 行…），连导航标签也是 `FluentNav.kt:59-62` 的中文字面量。
web 是 5 locale × 548 key，README 有 5 种语言。Android 无法给出任何非中文界面 —— 而 Android 不在 `ci.yml` 里，所以这个问题不可能被自动发现。

### C3 整块功能缺失（P1，按端点算）

Android 未接入的 Hub 能力（`HubApi.kt` 实测只有 10 个 GET/PUT/POST）：

- **配额账号管理整套**：`GET/POST /api/accounts`、`PATCH/DELETE /api/accounts/:id`、`POST /api/accounts/:id/refresh`、`POST /api/accounts/oauth/{start,exchange}` —— web 的 `accounts.js` 是 26 个 provider、三种凭据录入模式（oauth/simple/json）+ 免责声明 + OAuth 两步向导；Android 只有只读影子（`LimitsUi.kt` 无编辑入口、无单账号刷新、无筛选，`includeAllProviders` 是唯一开关）。
- **订阅账本**：`GET/PUT /api/subscriptions`（含 `baseUpdatedAt` 乐观并发、续费推算、充值明细台账）Android **零实现，DTO 里都没有**。
- **汇率 / 多币种**：`GET /api/rates` 未接，`Formatters.kt:40-50` 把 `US$` 写死；web 有 `settings.currency` 4 种。
- **设备管理**：`DELETE /api/devices/:id`、`POST /api/devices/:id/rename` 未接，而 `HubDtos.kt` 已解析 `deviceDelete`/`deviceRename` capability 却零判断。
- **逐设备作用域**：`GET /api/history?deviceId=` 未接（`HubApi.history()` 无参数）→ 趋势永远是 Hub 全网聚合，无法按设备看。
- **Yesterday / Week 预设**：web 最近两次提交才加的 `PRESET_RANGE_PERIODS`（`dateRanges.js:14`，走 `/api/usage/range`），Android `AnalyticsPeriodKind` 只有 Today/Month/AllTime/Custom。基础设施已经在（`HubApi.kt:26` 有 `usageRange`、`capabilities.usageRange` 有门控），缺的是日历窗口计算层 + tab。

### C4 "接口通了但功能没做"（P2，低成本可清）

DTO 解析了但全站零判断/零展示：`HubCapabilitiesDto` 的 `stats/history/statsStream/subscriptions/publicStats`、
`HealthDto.secretRequired/deviceCount/now`、`StatsDto.staleAfterMs`（因此本地不会随时间自化 stale）、
`LimitsDto.refreshMs`（没有按周期主动刷配额的逻辑）、`LimitWindowDto.windowMinutes/resetDescription`、
`SseStatsDto.type/reason/at`（无法区分 snapshot 与各类 reason）、`UsageRangeDto.from/to/*`、
`SessionDto.projectId`、`PricingResponseDto` 整体返回值。
另：`HubViewModel` 的 `currentSharePeriod()`/`clientModelsFor()`/`clientModelCostsFor()`/`clientsForModel()` 四个 helper 无调用点，其中 `clientsForModel()` 与 `ModelDetailScreen` 的会话反推路径并存 → 模型→客户端与客户端→模型两条拆分**口径不一致**。

### C5 其它状态语义落差（P2）

无本地缓存（重启即空）、无"这是 X 前的数据"陈旧提示、SSE 死后不降级轮询、`503 too_many_streams` 的 `Retry-After` 未遵守、
无通知（配额将尽/设备过期都不会响）、无小组件、无手动深浅色开关（只有 `isSystemInDarkTheme()`）、
趋势 tab 每次进都无条件 `refreshHistory()`（缺 `historyRevision` 变化判断）、
`FormattersHelpersTest` 测的是 `Formatters.heatmapValue` 而 UI 用 `ContributionHeatmap.kt:40` 的重载 —— 测了一份死代码。

## 5. D 类：治理与可验证性

1. **设计与代码互相矛盾，且文档更陈旧**：`docs/design/fluent-2.md:22` 写的是"Android **保留** Compose Material 3 控件，只让颜色/表面/形状/字阶跟随 Fluent token"。
   未提交的代码已经**替掉了**卡片、导航栏、tab 条、列表行、浮层。现在有两种"合法"实现同时存在，
   这正是 A2 那张表的成因 —— 一半人照文档保留 M3 控件，另一半照直觉自绘 Fluent 控件。
   AGENTS.md 的"Keep this file lean and current / 过期注释比没有更糟"要求这里必须收敛成一份决议。
2. **守卫覆盖面与风险面严重错配**：`verify-android-fluent-contrast.js` 只 `readFileSync(Color.kt)` 的
   `alias = argb("HEX")` 行 —— 保证了色值，管不到用法（无 focus、无焦点环、`Color(0x…)` 绕过、图标体系、间距 token、控件选型）。
   而 `verify-shared-ui-boundary.js` 给 web 侧立了"禁止视图直接 fetch/storage/history"这类**结构**约束，Android 侧没有对等物。
3. **CI 无 Android 门禁**：`ci.yml` 不跑 gradle；Android 单测只在 release 时跑一次；且
   `build.gradle.kts:183` 关掉了 Gradle 原生 `Test` 任务、改用 4 个依赖硬编码中间产物路径的 `Exec` JUnitCore 任务 —— AGP 一升级就碎。
4. **这 6600 行没有提交、没有分支、没有 issue 关联**，直接在 `main` 工作区。

## 6. 修复计划

前置决策 **D1（必须先定，阻塞 A2/B1/B4 的收口方向）**：Android 到底按哪条契约走？

- 推荐：**自绘 Fluent 控件为唯一合法路径**（承认既成事实），把 `docs/design/fluent-2.md:22` 改写为新契约，
  并把"M3 桥接只服务尚未迁移的残留"写成显式技术债清单，逐条清零后删掉 `Theme.kt:37-109` 的 `toMaterialScheme()`。
- 反向选项（按现文档保留 M3 控件）意味着要**回退** `AppCard`/`FluentNavBar`/`FluentTabStrip`，代价更大且与 web 观感割裂，不建议。

下面阶段按"先止血 → 再补齐 → 再优化"排，每阶段末尾都能独立提交、独立验证。

### 阶段 0：把观测面先建起来（0.5 天，零风险，最高杠杆）

1. `ci.yml` 增加 Android job：`./gradlew :app:compileDebugKotlin :app:runUnitTests`（Node job 不动）。
2. 扩展 Android 守卫为 `verify:android-fluent`，除现有对比度外再加 4 条**可机检**的结构性断言，直接对齐本次发现：
   - 禁用符号白名单：`androidx.compose.material.*`（M2）、`material3.{Switch,AlertDialog,OutlinedTextField,Button,OutlinedButton,TextButton,FloatingActionButton,Chip,FilterChip,CircularProgressIndicator,IconButton}`、`vico.compose.m3`、`material.icons` —— 允许清单外一律 fail（先以"只准减不准增"棘轮模式接入，避免一次卡死）；
   - `MaterialTheme.colorScheme|shapes|typography` 读取点必须为 0（保留 `typography` 的 1 处例外，修完清零）；
   - 字面 `.dp` 的 `Spacer/padding` 必须落在 `FluentSpacing` 集合内；
   - 可点击组件必须同时具备 `focusable`/`selectable` 语义（对 `indication = null` 的自绘组件强制要求 state description）。
3. 把 `Theme.kt` 里 8 处 `Color(0x…)` 硬编码迁进 `FluentColorTokens`（走 `argb`），让它们进入现有对比度 + 规格漂移守卫；顺手修 A3 的 `secondary/tertiary` 反配。

**验证**：新守卫必须在当前代码上**跑出红灯**（列出已知残留），这同时就是它的自检。

### 阶段 1：止血 —— 用户一定会看到的缺陷（1.5 天，纯 UI 层，不碰 wire）

| 项 | 动作 |
| --- | --- |
| A1-2 边到边 | `MainActivity` 调 `enableEdgeToEdge()`；`FluentPageHeader` 加 `statusBarsPadding()`；`Scaffold.contentWindowInsets` 恢复为 `ScaffoldDefaults.contentWindowInsets` 并把 TopBar/Nav 的 inset 交给它，删掉手工归零 |
| A1-3 平台主题 | `themes.xml` 改 `Theme.Material3.DayNight.NoActionBar` + 新增 `values/`+`values-night/` 的 `windowBackground`/`statusBarColor`/`navigationBarColor`（取 Fluent 中性面），消除冷启动闪白 |
| A1-1 下拉刷新 | 自绘 Fluent 刷新指示（ProgressRing + `surfaceFlyout` + level16 + 描边），去掉 `pullRefresh` 与 `libs.compose.material` 依赖 |
| A1-4 FAB | 去掉 FAB，改用卡内 `FluentFilledButton("新增")` 或 TopBar 动作位 |
| A1-5 + A2 按钮族 | 全量替换成 `FluentFilledButton` / 新增 `FluentSubtleButton` / `FluentQuietIconButton`；ripple 双层（`DateTimeRangePicker:433`、`MoreScreens:1026`）一并消除 |
| A2 表单族 | 新增 `fluentTextField`（label 置顶 + 1px `neutralStroke1` + 外部焦点环）与 `FluentDialog`（复用 `DateTimeRangePicker.kt:141-157` 的浮层配方）、`FluentToggle`（40×20 轨道 + 关闭态描边）；`SettingsScreen` 的 `MoreScreens.kt:830-1112` 整屏按此重写，并把手搓偏好行换成 `FluentListRow` |
| A2 进度 | `CircularProgressIndicator` → `FluentProgressRing` |
| B1 焦点/选中 | 一次性补齐：`selectable()`/`toggleable()` + `State.Selected`、统一 `FluentFocusRing`（`neutralStroke1` 2px 外环，满足 1.4.11 的 3:1）、给导航与图标按钮补 `contentDescription` |

**验证**：新增 Compose UI 测试（`androidTest` 源集 + `compose-ui-test-junit4`，属测试依赖）覆盖"焦点环可见 + 选中态有 state description + 刷新指示器在深色下不是白盘紫箭头"三条；真机/模拟器在 Android 15（强制边到边）截图核对四个根页 + 设置屏 + 定价对话框。

### 阶段 2：图标与设计语言收口（1.5 天，含 1 个新增资产流程）

1. 引入 Fluent System Icons 到 Android：扩展 `scripts/update-fluent-assets.js`，把选中子集导出为 `android/.../res/drawable/fluent_<name>.xml`（矢量、离线、与 web 同源、保留 MIT license 文件）。这是**新增资产同步**，不新增 npm 依赖。
2. 全站 47 个 `material.icons` 引用换成 `FluentIcons` 常量表，统一 `Regular` 字重 + 20/24dp 两档（导航 24、行内 20）。
3. `TrendCharts.kt` 弃用 `vico.compose.m3`：自建 `FluentChartStyle`（`Color.kt:351` 已有 `FluentChartPalette`），移除 `vico-compose-m3` 依赖。
4. B4 间距：`MoreScreens.kt` 62 处字面 dp 全量替换；`10/6/14/2.5.dp` 归到最近 token；`FluentTabStrip` 去掉自带横向 padding，改由外层 `AppCard.contentPadding` 管；统一同族 elevation；`ThemeSeedId` 色板/按钮高回到 ≥48dp 触控契约；删 `UiCards.kt:118` 死代码。
5. B3 动效：把 `fluentMotionEnabled()` 接到 shimmer、图表生长、日历转场；补 Android 13+ reduce-motion 读取。
6. B2 自适应：`TokenMonitorApp.kt:82,221` 改读 `LocalFluentAdaptation`；`isLargeFont` 驱动 nav/row/swatch 的最小高与文本截断策略；加 forced-colors（`AccessibilityManager` 高对比）分支；断点注释按 Fluent 阶梯或按 Material 阶梯改口径（别两套混说）。

**验证**：图标/依赖清零由阶段 0 的棘轮守卫把关；Vico 换样式后与 web 截图对色；`fontScale=1.3` 与 `1.5` 跑四个根页 + 设置屏截图。

### 阶段 3：功能对齐（3–5 天，**这部分会碰 wire/兼容面，需要单独 PR**）

顺序按"修错误 > 补预设 > 补管理面"：

1. **数据正确性（C1，最先）**：`HubDtos.kt` 补 `clientCredits`/`clientModelCredits`/`session.credits`/`clientEstimated`/`periodWindows`；`Formatters.kt` 补 `estimatedValue()`（`~` 前缀，后续版本已移除）与 credits 格式化；把 `!stale` 与 `deviceCountsAsOnline` 统一成一个函数；设备列表单一数据源（统一用 `stats.devices`，SSE 帧即刷新，`/api/devices` 退化为兜底）；删掉 `DevicesScreen.kt:363` 的死区块。
   → 这一步只增字段不改语义，按 AGENTS.md 属兼容面**新增**，需同步 `docs/API.md` 与 `tests/shared/clientTracking.test.js` 类的期望清单。
2. **作用域模型（C3 的 Yesterday/Week + B5）**：把 web 的 `dateRanges.js` 语义移植成 `ui/core/DateRanges.kt`（含 `firstDayOfWeekIndex(locale)`，别再用 `Locale.CHINA`），总览/分析/设备共用一个 `state.period`；`usageRange` 能力位缺失时按 web 一样隐藏预设并归一回 `today`。同时把 `FluentTabStrip` 的 `options: List<String>` + `selectedIndex: Int`（标签当身份、无左右方向键）改成 id/label 分离 + tablist 键盘漫游，与 web 的 `tm-tablist` 对齐。
3. **账号管理（C3）**：接 `/api/accounts` 全套 + OAuth 两步向导 + 免责声明；这是 Android 最大的一块缺失，也是唯一需要新数据流的部分（可复用 `DateTimeRangePicker` 的浮层配方做抽屉表单）。**后续进展**：已接入，且 codex/antigravity 统一为浏览器登录向导（编辑页可查看凭据状态、清除凭据、原地重授权；不再有会建重复账号的 exchange）。
4. **次级补齐**：`/api/rates` + `settings.currency`、`/api/subscriptions`（含 `baseUpdatedAt` CAS）、`/api/history?deviceId=` + `historyRevision` 变化才重取、设备 rename/delete。
5. **i18n（C2）**：建 `res/values/strings.xml` + `zh-CN/zh-TW/en/ja/ko`，把 Kotlin 里的中文字面量抽成 `R.string`（这是一次纯机械但面积很大的改动，建议独立提交并配合 lint 规则禁止 `Text("字面量")`）。**若不做**，则必须在 `docs/` 与 README 显式声明"Android 当前仅中文"，别让人以为两端同覆盖。
6. **本地缓存与陈旧提示（C5）**：进程重启可读上次快照 + 标注"数据截至 X"，SSE 失效降级轮询，遵守 `Retry-After`。

**验证**：每项在 `HubRepositoryTest` 加端点/错误映射用例；ViewModel 补 `connectionGeneration` 隔离与 `loadCustomRange` 取消单飞测试（目前 0 覆盖）；credits/estimated 渲染加 Node 侧守卫不可行（Android 无），改由 Compose UI 测试断言文案含 `~` 与 credits 单位。

### 阶段 4：治理收尾（0.5 天）

1. 改写 `docs/design/fluent-2.md` 的 Platform mapping（按 D1 决议），并在 `docs/design/` 补一份 Android Fluent 契约（组件清单 + 状态要求 + 图标来源 + 自适应断点口径），填补 brief 0 次提及 Android 的空洞。
2. `AGENTS.md` 增补一节"Android 加控件/图标的触点表"（现在只有客户端新增的表）。
3. 把 `build.gradle.kts:183` 的 `Test { enabled = false }` + 4 个硬编码路径 `Exec` 任务恢复为标准 `testOptions.unitTests`，让 `./gradlew test` 能用。
4. 当前工作树先落成提交：阶段 0 的守卫 + CI 先单独成一个 PR（这样后面每个 PR 都有红灯可跑），再按阶段拆 PR。

### 工作量与排序

| 阶段 | 估时 | 为什么在这个位置 |
| --- | --- | --- |
| 0 观测面 | 0.5d | 不做这条，后面每一阶段都会重新漏 |
| 1 止血 | 1.5d | 边到边压标题、白盘紫箭头、pills、无双系统焦点 —— 用户必见 |
| 2 语言收口 | 1.5d | 图标/图表/间距是"像不像 Fluent"的主体 |
| 3 功能对齐 | 3–5d | Qoder 显示 0 与估算不可辨是**错误**，优先；账号管理是最大缺失，可拆到后续 |
| 4 治理 | 0.5d | 防止下一次再漂 |

合计 7–9 人日，可分 4 次可独立回滚的交付。

## 7. 未验证 / 需要你确认的（不编造）

1. **A1-5 的实际渲染半径**：机制已反编译确认（`ButtonDefaults.shape` 走 `FilledButtonTokens.ContainerShape`，`toMaterialShapes()` 覆盖不到），但"到底是 pill 还是别的"我没有目视确认 —— 需要一张 Android 12+ 上设置屏的截图。
2. **A1-2 的可见程度**：targetSdk 36 + 无 `enableEdgeToEdge()` 在 Android 15+ 上的具体行为（是否真压标题、是否有系统兜底）来自版本规则推断，未在 Android 15 实机验证。
3. **阶段 3-2 的方向**：Android 是否要引入"全局作用域"模型（跨页跟随 period）？这会改变四个屏幕的信息架构，属产品决策，不只是 UI。
4. **阶段 3-5 的 i18n**：Android 是否真的需要 5 locale（若目标用户就是中文，"显式声明仅中文"比补 5 套翻译更诚实）。
5. `npm run verify` 整体我**没有**跑通（记忆里这个 checkout 的 eslint bin shim 会中断它）；本次是分别跑 `verify:android-fluent-contrast` / `verify:product-scope` / `npm test` 全绿，外加 `:app:compileDebugKotlin` 成功。

---

## 8. 修复结果（同日）

### 已做并验证

| 项 | 结果 | 验证方式 |
| --- | --- | --- |
| CI 无 Android 门禁 | `ci.yml` 新增 `android` job：编译 + `:app:testDebugUnitTest` + `verify:android` | 任务图 `--dry-run` 通过；本地两条 gradle 任务实跑通过 |
| 观测面只有色值 | 新增 `scripts/verify-android-fluent-boundary.js`，10 项 cap/floor 棘轮 | 当前全部 at limit；曾以 cap=33 抓到回归方向正确 |
| Theme.kt 8 处绕过守卫的硬编码色 | 收进 `FluentColorTokens` 新别名，并由种子派生；选绿/紫/玫红不再漏蓝 | 守卫 `hexInTheme` cap 0；新增 2 组文本对 |
| 动态取色双轨（默认路径即两套强调色） | 壁纸只提供色相/饱和，各角色按固定亮度重建；MaterialTheme 由同一份别名派生 | 守卫新增 8 组**与色相无关**的亮度推导断言（Node 侧可证） |
| 边到边 + 四个根页无顶部 inset | `enableEdgeToEdge()` + 按模式重设 SystemBarStyle + `FluentPageHeader` 顶部 inset | 编译 + `assembleDebug`；**未做 Android 15 实机目视** |
| 平台主题为 M2 且无夜间 | `Theme.DeviceDefault`(+Night)、`values`/`values-night` 窗口背景 | 资源编译通过 |
| Material 2 下拉刷新（暗色白盘紫箭头） | 手势保留、指示器换成 `surfaceFlyout` + `level8` + Fluent 进度环 | 编译；`androidx.compose.material` 依赖已删 |
| 残留 M3 控件 | 新增 `FluentControls.kt`（按钮 4 变体 / 图标按钮 / 开关 / 输入 / 对话框 / 进度 / 选项行）并全量替换 | `forbiddenWidgetCalls` 33 → 2（仅剩 `Scaffold` + `SnackbarHost`，均带理由） |
| 焦点与选中语义缺失 | `fluentFocusRing` / `fluentClickable` / `selectable` / `toggleable` + `Role`；日历格与小时轮补 contentDescription | `selectionSemantics` 4 → 15、`focusSemantics` 0 → 16 |
| Material Symbols | 扩展 `update-fluent-assets.js`：28 个 Fluent 系统图标 + 61 个客户端品牌标 → VectorDrawable；`material.icons` 依赖删除 | 47 → 0；`assembleDebug` 通过（AAPT 实际编译了 89 个矢量）；3 个含滤镜/渐变的 SVG 明确跳过并回落 monogram |
| vico M3 图表样式 | `ChartStyle.fromColors` 由 Fluent 别名直给；`vico-compose-m3` 依赖删除 | 编译 |
| 硬编码间距 / 卡内双重缩进 / 触控自相矛盾 | `offGridSpacing` 12 → 0；`FluentTabStrip` 改由外层决定内缩；按钮最小高回到 48dp | 守卫 |
| 自适应是死变量 | 宽度类改由根节点 `BoxWithConstraints` 实测，rail 与阅读宽度共用；`isLargeFont` 驱动行高/导航高/媒体缩放 | 编译（视觉未核） |
| 动效开关漏项 | shimmer、图表生长、数值过渡全部接 `fluentMotionEnabled()`；`animate*AsState` 处标注为何无需手动 gate | 编译 |
| Qoder 显示 0 用量 / 估算不可辨 | DTO 补 `clientCredits`/`clientEstimated`/`clientModelCredits`/session credits；份额行改由 key 并集排序并渲染积分与 `~` | 新增 2 个 JVM 用例锁住该行为 |
| 设备双数据源 / 两套“在线”定义 / 死限额块 | SSE 帧同步刷新设备表；`fleetOnlineCount`/`fleetSorted` 统一；删死块并注明 Hub 语义 | 编译 |
| 模型↔客户端拆分口径不一致 | 两个方向统一走 `clientModels`，会话摊分只在无归属数据时兜底；删除只覆盖一种情形的死 helper | 编译 |
| 作用域缺 昨日/本周 + 两处重复周期解析 | 新增 `ui/core/DateRanges.kt`（与 `dateRanges.js` 同语义）、标签按 locale 周起始；tab 顺序对齐 web `PERIOD_TABS`；`resolvePeriod` 单一来源 | 3 个 JVM 用例（闭区间、周起始随 locale、跨零点失效） |
| 账号只读、无订阅、无币种、无逐设备作用域、无设备改名/删除 | 接 `/api/accounts*`（含 OAuth start/exchange、启停、单账号刷新）、`/api/subscriptions`（CAS）、`/api/rates`、`/api/history?deviceId=`、`rename`/`delete`；新增配额账号屏与订阅屏、币种设置 | 编译 + `assembleDebug`；月度折算 2 个 JVM 用例 |
| 账号编辑走错了凭据形态（codex/agy 编辑退回手动粘贴；exchange 不带 accountId 会建重复账号） | codex/antigravity 只保留浏览器登录向导（web 与 Android 同步）；编辑页显示 `credentialConfigured` 与安全元数据、可清除凭据；exchange 带 `accountId` 原地重授权 | web 守卫 3 条 + Hub 2 个测试文件；Android 4 个 JVM 用例 |
| 日历/热力图周起始三处不一致 | 三者统一取 `DateRanges.firstDayOfWeek` | 1 个 JVM 用例行标映射 |
| Gradle 原生 `test` 被禁用 | 恢复启用，保留 Windows JUnitCore 通道，CI 用 `testDebugUnitTest` | `:app:testDebugUnitTest` 34 通过 |
| 文档与代码互相矛盾（D1） | 按“自绘 Fluent 控件为唯一路径”改写 Platform mapping，并新增 `android-fluent2-contract.md` | — |

### 明确未做

- **全量 i18n**：约 406 条（352 条纯文本 + 54 条插值）× 5 语言需要人工审校，且只抽一部分会造成同屏混语言，比整套中文更糟。改为在 `docs/design/fluent-2.md` 显式声明“客户端 UI 目前仅简体中文、不跟随语言设置”，并把与区域设置真正相关的缺陷（周起始、写死 `Locale.CHINA`）单独修掉。
- **总览页改成全局作用域驱动**：这会把四个屏幕的信息架构整体改掉，属产品决策，不是缺陷修复。作用域预设本身已按 web 补齐，未改总览的三周期卡片式布局。
- **通知 / 桌面小组件 / 离线缓存 / 陈旧提示**：审计里列为 P2，本次未动。
- **Android 15 边到边、大字裁切、双栏大屏的实机目视**：本机无相应设备/模拟器会话，只做到编译与资源打包通过。

### 验证边界（重要）

`npm test` 与 `npm run lint` 目前有失败，全部集中在桌面设置这一处：
`tests/electron/settingsDesktopView.test.js`（13 项）与 `src/shared-ui/views/settingsDesktop.js`
的一个 `no-unused-vars`。起因是工作区里另一份**并发的、未提交的** `src/shared-ui` 重构
（把桌面设置收成三组、移除采集/导出的 GUI），与 Android 无关，未予改动；写这段时该文件仍在被改。

本仓库自身范围内实测通过的是：`:app:compileDebugKotlin`、`:app:assembleDebug`、
`:app:testDebugUnitTest`（34 项）、`npm run verify:android`、`npm run lint`。
