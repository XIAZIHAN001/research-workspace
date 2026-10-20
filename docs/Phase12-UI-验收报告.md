# Phase 12 验收报告：深色视觉系统、液态玻璃交互与物理动效

生成日期：2026-10-19
分支：`phase12-ui-motion`（从 `phase11-desktop-ai` / `d01d180` 新建）
提交状态：本轮变更**未提交**；工作区包含实现、两套 Phase 12 验收脚本、报告与截图证据。

## 一、摘要

Phase 12 的视觉目标已完成，并在**真实 Tauri / WebView2 开发窗口**与隔离浏览器中分别验证：

- 深色外观改为中性的 **Graphite**（默认深色），并提供可选的 **Obsidian 纯黑**；浅色与跟随系统保留，旧的 `rw.theme=dark` 在升级后仍解析为 Graphite，不会失效。
- 按钮、分段选项、主题选择器、Mock/DeepSeek 模式卡片、阅读器工具条与选区工具条采用克制的液态玻璃材质；PDF 页面、AI 回答正文、笔记/知识主体和表单主输入区保持实体底色。
- 首页从大头像 + 超大字问候的“欢迎页”改为紧凑工作台：小头像、真实问候、真实入口、继续阅读（有阅读位置的真实论文）与最近项目；没有伪造任何论文或项目。
- 动画统一为 tokens；按压缩放约 `0.975`、分段指示胶囊滑动、弹窗 `0.98→1` 入场、侧栏 260ms 收放；完整支持 `prefers-reduced-motion`、键盘焦点与快速连续操作。
- 移除了原本主导界面的青绿色渐变，氛围层改为低饱和灰蓝，仅作用于应用外壳的装饰伪元素，不对 PDF 或正文施加任何 blur/mask。

未完成 / 未验证的内容集中在第 9 节：Linux、安装版重新打包、真实 Windows 缩放的逐档切换、可靠 FPS 采样。

## 二、基线与执行环境

### 2.1 Git 与基线

| 项目 | 值 |
| --- | --- |
| 起始分支 | `phase11-desktop-ai` |
| 起始 HEAD | `d01d180`（Phase 11 报告提交） |
| 工作树 | 无已跟踪文件的修改；仅有未跟踪的 Phase 12 提示词与历史截图目录 |
| 本轮分支 | `phase12-ui-motion` |
| 版本 | 0.11.0（未改版本号，未重新打包安装器） |
| 桌面运行时 | Tauri 2.12.4，WebView2 `Edg/155.0.4283.62` |

### 2.2 改造前基线

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过 |
| `npm run format:check` | **失败**，仅因未跟踪的用户文件 `Research_Workspace_Phase12_Codex_*.md` 未按项目 Prettier 规则排版 |
| `npm run test` | 66 个测试文件 / 1341 项通过 |

处理方式：将该提示词文件加入 `.prettierignore`（只影响格式检查，不修改文档内容）。此后 `npm run check` 全绿。没有把这次基线失败算作本轮引入。

### 2.3 与 Phase 11 报告的差异

核对了 `docs/Phase11验收报告.md` 与实际仓库：分支、提交、版本、依赖版本、测试脚本名称与基线数量一致，未发现需要改写的基线差异。Phase 11 明确注明其 `verify:desktop` 44/44 早于最后一次 AI 设置 CSS 修补；本轮所有相关回归均以本轮源码与构建产物重新运行，没有复用旧通过数量。

## 三、设计系统

### 3.1 语义 tokens

`src/styles/tokens.css` 以 `--color-*` 为唯一真源，旧的短名（`--bg-base`、`--text`、`--text-2`、`--accent` 等）全部改为别名，因此阅读器、知识、备份等既有样式无需重写即可跟随主题。

| 语义 token | Graphite | Obsidian |
| --- | --- | --- |
| `--color-bg-app` | `#15171b` | `#000000` |
| `--color-bg-sidebar` | `#1c1f24` | `#080808` |
| `--color-bg-panel` | `#202329` | `#0d0d0f` |
| `--color-bg-elevated` | `#292d34` | `#18191b` |
| `--color-border-subtle` | `#343a43` | `#28292d` |
| `--color-text-primary` | `#e8eaee` | `#f2f2f3` |
| `--color-text-secondary` | `#9ca4af` | `#9b9da3` |
| `--color-text-tertiary` | `#8f97a2` | `#87898f` |
| `--color-accent` | `#9ab9ec` | `#a8bff0` |

浅色主题同步降低了青蓝饱和：背景改为中性灰 `#eceef2`，面板 `#fbfbfc`，强调色 `#335f8f`，不再使用原先大面积青绿渐变。

### 3.2 Graphite / Obsidian / 浅色 / 跟随系统

- `data-theme` 仍为 `light | dark`，供阅读器与 `color-scheme` 使用；新增 `data-theme-style="graphite|obsidian"` 只控制深色表面。
- 存储上 `rw.theme` 的取值与语义未变；新增 `rw.themeStyle`（默认 `graphite`）。旧的 `rw.theme=dark` 没有样式记录时自动得到 Graphite；旧的 `system` / `light` 完全不受影响。
- `public/theme-init.js` 在首帧前同时读取两个键并设置两个属性，避免升级后先闪一帧错误配色。
- 主题控件从三选一扩展为四选一：跟随系统 / 浅色 / 石墨深色 / OLED 纯黑，均有 `aria-label`、`title` 与 `aria-pressed`。

### 3.3 对比度

使用现有像素级 `auditContrast`（文字透明化后采样真实背景的最坏极值）测量：

| 场景 | 检查文本 run 数 | 最低比值 |
| --- | --- | --- |
| 首页 / Graphite | 33 | 5.00 |
| 首页 / Obsidian | 33 | 5.48 |
| 首页 / 浅色 | 33 | 5.17 |
| 论文库 / Graphite | 39 | 4.93 |
| 阅读器 / Graphite | 30 | 4.93 |
| AI 设置 / Graphite | 35 | 5.27 |
| 真实 WebView2 首页 / Graphite | 32 | 5.12 |
| 真实 WebView2 AI 设置 / Graphite | 30 | 5.26 |
| 真实 WebView2 阅读器 / Graphite | 23 | 4.82 |

所有文本满足 WCAG AA（普通文本 4.5:1）。状态从不只靠颜色：Mock/在线有文字与图标，选中项有指示条/对勾/字重，危险操作有文字标签。

## 四、Liquid Glass 实现

### 4.1 材质

`src/styles/glass.css` 保留原有的“边缘反光 + 顶部 sheen + 指针光斑”光模型，并新增：

- `.glass`：用于侧栏与真正悬浮的元素，使用 `backdrop-filter: blur(20px) saturate(1.15)`；不支持时回退到更不透明的填充。
- 控件材质：按钮、chip、分段指示胶囊与模式卡片共用同一配方——`--control-fill` 半透明填充、顶部 `--control-sheen`、0.5px `--control-edge` 与极短的 `--control-lift`；**默认不做 backdrop blur**，避免长列表里每个按钮都成为合成层。只有侧栏、浮层与对话框外壳使用 `.glass` 的模糊。

### 4.2 应用范围

| 使用玻璃/轻材质 | 保持实体底色 |
| --- | --- |
| 侧栏、侧栏选中项、底部工具区按钮 | PDF 阅读页与滚动容器 |
| `.btn`、`.btn-primary`、`.icon-btn`、`.chip`、分段控件指示胶囊 | AI 回答正文、笔记/难点/知识面板主体 |
| 主题选择器、Mock/DeepSeek 模式卡片 | 通用对话框与 AI 设置对话框主体 |
| 阅读器工具条、右侧 Tab、折叠 rail、选区工具条 | 表单主输入区、备份/知识记录主体 |

AI 设置对话框：`min(780px, 100vw - 32px)`、`max-height: min(88vh, 900px)`、自身滚动、主体不透明（实测 `rgb(32,35,41)`），窄屏（≤900px）模式卡、统计和预算全部单列。Phase 11 修复的“底层文字透出”没有重现。

## 五、动效实现

| 场景 | 参数 |
| --- | --- |
| 悬停提亮 | 150ms `--ease-out` |
| 按压/松开 | scale `0.975`，120ms；松开由 spring easing 回弹 |
| Tab/分段选项 | 210ms，单个指示胶囊通过 `translateX` 滑动 |
| 侧栏收放 | 260ms；窄屏为叠层滑入 |
| 弹窗入场 | 220ms，`opacity 0→1` + `scale .98→1` |
| 卡片/列表箭头 | 150ms，最多 1–2px 位移 |
| AI 请求状态 | 保留既有非侵入式状态文本与旋转图标，不伪造联网或费用 |

- 未引入 `motion/react` 或任何新依赖；全部使用 CSS transition/transform 与既有 `--ease-spring`。
- `prefers-reduced-motion: reduce` 下：过渡坍缩到 0.01ms、按压 transform 移除、弹窗/欢迎/头像动画关闭、氛围层 `filter: none`。
- 分段控件的滑动指示在 `:has()` 不可用时回退为选中项自绘底板；状态仍由 `aria-pressed` 表达。
- 真实 WebView2 的 DPR 为 1.875，Chromium 会把 2 CSS px 焦点描边取整为 3 设备像素（计算值 1.6 CSS px），截图可见；报告中按设备像素解释，不把该取整当作缺陷。

## 六、布局与 PDF 安全性

- 侧栏宽度 248px（目标 240–260）；底部工具区两列排布，所有按钮和四段主题控件均在侧栏边界内。
- 侧栏关闭时主面板预留 44px 顶部条，展开按钮不再覆盖首页头像/标题或阅读器返回按钮。
- 首页在 ≥901px 为双栏工作台，≤900px 自动单列；1024×689、960×600（150% 缩放等效）与 720×820 窄窗均无水平滚动或内容裁切。
- 窄窗侧栏为叠层；AI 状态胶囊在叠层打开时移到侧栏右侧，不再遮挡主题开关。
- **没有在 PDF 坐标祖先上新增 transform / filter / mask**。阅读器只改了工具条、Tab、rail 与面板底色。
- 真实 WebView2 中 `.pdf-page` 与 `.reader-scroll` 的 `filter`、`backdrop-filter` 均为 `none`；文本层、页码、缩放、双语/纸张模式与批注回归由 `verify:reader`、`verify:annotations`、`verify:compat`、`verify:research-workflow` 覆盖并通过。
- 拖拽面板边界未改动；没有新的每帧 JS 动画。

## 七、测试矩阵

### 7.1 本轮执行结果

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `npm run check` | **PASS** | 67 个测试文件 / 1361 项；typecheck、eslint、prettier 全绿 |
| `npm run build` | **PASS** | 生产构建通过（仅保留既有 chunk 体积提示） |
| `npm run verify` | **PASS** 61/61 | 首页空/有数据、新建、项目、管理、删除确认、主题、窄窗、reduced-motion、焦点、对比度 |
| `npm run verify:reader` | **PASS** 27/27 | 真实 PDF 导入、渲染、文本选择、缩放、页码、持久化 |
| `npm run verify:ai` | **PASS** 54/54 | 选区提问、引用校验、Mock 标识、主题对比度 |
| `npm run verify:annotations` | **PASS** 26/26 | 高亮/笔记创建、重开、跳转、删除 |
| `npm run verify:backup` | **PASS** 39/39 | 导出、恢复、冲突、单文件备份 |
| `npm run verify:compat` | **PASS** 13/13 | 双栏、富文本、扫描件、无文字层、24 页 |
| `npm run verify:immersive` | **PASS** 33/33 | 沉浸阅读、纸张模式、AI 问答 |
| `npm run verify:guard` | **PASS** 10/10 | 离线代理守卫与“零付费”证据 |
| `npm run verify:graph` | **PASS** 17/17 | 知识关系、难点、证据 |
| `npm run verify:research-workflow` | **PASS** 30/30 | 两篇真实论文的完整研究工作流 |
| `npm run verify:knowledge-ai` | **PASS** 48/48 | 证据约束型知识建议 |
| `npm run verify:knowledge-replay` | **PASS** 29/29 | 真实响应零费用回放 |
| `npm run verify:knowledge-replay-all` | **PASS** | 12 条响应，0 个不变量问题 |
| `npm run verify:knowledge-real` | **PASS** 16/16 | 两篇真实论文的知识网络，0 次助手请求 |
| `npm run verify:ui-phase12` | **PASS** 44/44 | 本轮新增：主题/兼容、对比度、布局、阅读器、AI 设置、焦点、reduced-motion、快速输入、控制台 |
| `npm run verify:ui-phase12-desktop` | **PASS** 28/28 | 本轮新增：真实 Tauri/WebView2 开发窗口（CDP） |

`verify:ui-phase12` 的证据：`docs/phase12-ui-verification-report.json`；真实窗口证据：`docs/phase12-desktop-verification-report.json`。

### 7.2 一次瞬时失败（已复验）

其中一次 `npm run check` 出现 5 个服务端/离线守卫单测失败，表现为 `fetch failed / bad port` 与本地测试服务 `unreachable`；同一环境下立即重跑 `npm run test` 与随后完整 `npm run check` 均为 1361/1361 全绿。失败集中在测试自行绑定的临时端口与 Node `fetch` 受限端口冲突，属于既有测试基础设施的偶发问题，不涉及本轮 UI 改动；未通过跳过或放松断言掩盖。

### 7.3 明确未运行

| 项目 | 原因 |
| --- | --- |
| `verify:desktop` / `verify:desktop-phase11` / `verify:desktop-isolated` / `verify:desktop-online-sim` | 这些脚本面向**已安装的 0.11.0 安装版**。该安装包仍是 Phase 11 的旧前端；为了验证本轮 UI 需要重新打包，而重新打包会覆盖 Phase 11 的安装产物。真实 WebView2 的等价验证改由开发版窗口完成。 |
| `verify:export-backup` / `verify:cleanup-list` | 会打开正式安装版并读写其正式数据目录，与本阶段无关。 |
| `verify:live` / `verify:real` | 可能触发真实付费模型请求；本阶段禁止。 |
| Linux 编译与 GUI | 当前环境只有 Windows；未验证。 |
| 可靠 FPS / 帧耗时采样 | 桌面窗口在验证时可能被最小化，无法获得可信的绘制时序；没有编造 FPS 数字。 |
| Windows 100% / 125% / 150% 逐档系统缩放 | 没有修改系统显示设置。以 CSS 视口 1440×900、1024×689、960×600（150% 等效）、800×800、720×820 覆盖布局，并记录真实窗口 DPR 1.875。 |

## 八、截图索引

### 8.1 浏览器（隔离 Playwright 配置，生产构建）

目录：`docs/screenshots-phase12/2026-10-19T09-16-54-ui/`

| 文件 | 主题 | 视口 | 场景 |
| --- | --- | --- | --- |
| `00-home-light-empty-1440x900.png` | 浅色 | 1440×900 | 首次启动、空工作区 |
| `01-home-graphite-1440x900.png` | Graphite | 1440×900 | 已有真实数据的首页 |
| `02-home-obsidian-1440x900.png` | Obsidian | 1440×900 | 同上 |
| `03-home-light-1440x900.png` | 浅色 | 1440×900 | 同上 |
| `04-home-graphite-1024x689.png` | Graphite | 1024×689 | 桌面窗口常用尺寸 |
| `04b-home-graphite-960x600-scaled.png` | Graphite | 960×600 | 1440×900 @150% 等效 |
| `05-home-narrow-720x820.png` | Graphite | 720×820 | 窄窗、侧栏关闭 |
| `06-sidebar-overlay-720x820.png` | Graphite | 720×820 | 窄窗叠层侧栏与 AI 状态胶囊 |
| `07-library-graphite-1440x900.png` | Graphite | 1440×900 | 论文库 |
| `08-reader-graphite-1440x900.png` | Graphite | 1440×900 | 阅读器（侧栏折叠为 rail） |
| `09-reader-notes-graphite-1440x900.png` | Graphite | 1440×900 | 阅读器 + 笔记面板 |
| `10-ai-settings-graphite-1024x689.png` | Graphite | 1024×689 | AI 设置、两张模式卡 |
| `11-ai-settings-obsidian-1024x689.png` | Obsidian | 1024×689 | 同上 |
| `12-ai-settings-narrow-800x800.png` | Graphite | 800×800 | AI 设置单列 |
| `13-focus-ring-1440x900.png` | Graphite | 1440×900 | 键盘焦点环 |
| `14-reduced-motion-1440x900.png` | Graphite | 1440×900 | reduced-motion |

### 8.2 真实 Tauri / WebView2 开发窗口

目录：`docs/screenshots-phase12/2026-10-19T09-10-37-desktop/`
窗口：1024×689 CSS px，DPR 1.875，`com.researchworkspace.desktop.dev` 隔离数据目录。

| 文件 | 主题 | 场景 |
| --- | --- | --- |
| `01-desktop-home-graphite-1024x689.png` | Graphite | 首页（开发验收数据） |
| `02-desktop-home-obsidian-1024x689.png` | Obsidian | 首页 |
| `03-desktop-home-light-1024x689.png` | 浅色 | 首页 |
| `04-desktop-ai-settings-graphite-1024x689.png` | Graphite | AI 设置，真实 IPC，离线 Mock |
| `05-desktop-ai-settings-obsidian-1024x689.png` | Obsidian | AI 设置 |
| `06-desktop-reader-graphite-1024x689.png` | Graphite | 真实 PDF 阅读器 |
| `07-desktop-reduced-motion-1024x689.png` | Graphite | reduced-motion |

截图目录未纳入提交；`.gitignore` 未覆盖 `docs/screenshots-*` 的约定与 Phase 10/11 保持一致（历史上也未提交）。

### 8.3 改造前后对照

“改造前”使用仓库中已跟踪、未覆盖的历史证据；“改造后”使用本轮截图。没有对历史截图做任何重拍或覆盖。

| 区域 | 改造前 | 改造后 |
| --- | --- | --- |
| 首页 | `docs/screenshots-phase11/2026-10-19T05-25-00-desktop-ai/01-home.png`（大头像居中欢迎页） | `01-desktop-home-graphite-1024x689.png`（紧凑工作台） |
| 侧栏 | 同上图左侧（三段主题、浅色玻璃） | `01-desktop-home-graphite-1024x689.png` / `02-desktop-home-obsidian-1024x689.png` |
| AI 设置 | `docs/screenshots-phase11/2026-10-19T05-25-00-desktop-ai/02-ai-settings-offline.png` | `04-desktop-ai-settings-graphite-1024x689.png` |
| 阅读器工具条/辅助面板 | `docs/screenshots-reader/02-reader-light.png`（Phase 2） | `06-desktop-reader-graphite-1024x689.png` / `09-reader-notes-graphite-1440x900.png` |

## 九、已知问题与未验证项

1. **安装版未重新打包。** `Research Workspace_0.11.0_x64-setup.exe` 仍是 Phase 11 的旧界面；Phase 12 只改前端，正式发布需在下一构建中重新打包并重新跑安装/升级验收。
2. **Windows 缩放的逐档实测缺失。** 真实窗口 DPR 1.875（约 187.5% 有效渲染比例），未手动切换到 100%/125%/150% 再逐档观察；已用等效 CSS 视口覆盖布局。
3. **FPS 未测量。** 没有可信的帧率数据；未用主观“顺滑”代替证据。
4. **Linux 未验证。** 与 Phase 10/11 相同。
5. **PDF 深色纸张来自既有纸张模式。** 深色下默认“跟随外观”会使用深灰纸张（Phase 5 的显式功能），不是本轮新增的滤镜；`原始/暖纸/深灰` 仍可切换。
6. **测试基础设施偶发端口冲突。** 见 7.2；重跑通过，未修改断言。
7. **`verify:ui-phase12` 的 AI 状态使用浏览器内 IPC stub**，仅用于布局与对比度；真实 IPC 的行为由 `verify:ui-phase12-desktop` 在开发版窗口覆盖，且全程离线 Mock。

## 十、安全与数据边界

- **0 次真实 DeepSeek 付费请求。** 浏览器验收使用离线 mock 或页面内 Tauri stub；桌面验收连接的是开发版自带的离线 Mock，未切换模式、未输入/删除 Key、未发起模型请求。
- **0 项正式用户数据被访问、写入、删除或迁移。** 桌面验收使用 `com.researchworkspace.desktop.dev` 隔离目录，并在结束时把主题偏好恢复为初始值；未打开正式 `com.researchworkspace.desktop` 的 WebView 目录。
- 未执行安装、卸载、重置凭据、删除数据或远程 push/发布。
- 数据 schema、PDF.js 坐标映射、批注锚点、Rust sidecar、IPC、CSP、网络端点、Mock/在线逻辑均未修改。
- 新增持久化只有 `rw.themeStyle`（UI 偏好），不含敏感信息；不影响备份格式。
- 验收脚本会覆盖 `docs/screenshots/`、`docs/screenshots-phase3/`、`docs/screenshots-reader/` 等既有证据目录；本轮运行后已用 `git checkout --` 恢复这些已跟踪历史证据，只有本轮新增的 Phase 12 截图与报告保留。

## 十一、文件变更清单与回滚

### 11.1 修改

- 主题/状态：`src/features/theme/{theme.ts,useTheme.ts,ThemeSwitch.tsx,theme.test.ts}`、`src/app/config.ts`、`src/app/App.test.tsx`
- 应用与导航：`src/app/App.tsx`、`src/features/projects/Sidebar.tsx`
- 首页：`src/features/home/{HomeView.tsx,AvatarPicker.tsx}` + 新增 `HomeView.test.tsx`
- 样式：`src/styles/{tokens.css,base.css,glass.css,layout.css,components.css,reader.css,desktop.css}`
- 首帧与资源：`index.html`、`public/theme-init.js`、`public/avatar/default.svg`（默认头像改为中性石板色，去除青绿）
- 验收工具：`scripts/verify/contrast.mjs`（跳过 disabled 控件，符合 WCAG 对非活动组件的要求）
- 配置：`.prettierignore`（排除用户提示词）、`package.json`（新增两个验收脚本）

### 11.2 新增

- `scripts/verify/ui-phase12.mjs`（44 项浏览器验收）
- `scripts/verify/ui-phase12-desktop.mjs`（28 项真实 WebView2 验收）
- `docs/phase12-ui-verification-report.json`
- `docs/phase12-desktop-verification-report.json`
- `docs/screenshots-phase12/`（未提交）
- 本报告

### 11.3 依赖

**无新增或升级依赖。** 构建产物中没有新的第三方库。

### 11.4 提交状态与回滚

- 本轮在 `phase12-ui-motion` 分支上完成，**未提交、未 push**。所有实现改动仍在工作区，可直接审阅。
- 回滚：若只需回到 Phase 11 基线，可 `git checkout phase11-desktop-ai`（未提交改动会随之保留在工作区）；若要丢弃本轮全部改动，使用 `git restore` 恢复已跟踪文件并删除新增的验收脚本/报告/截图目录。未使用 `git reset --hard`、`git clean -fd` 或强制操作。
