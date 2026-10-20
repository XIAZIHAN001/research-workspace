# Phase 12.1 验收报告：Neutral Dark Theme & Monochrome Controls

生成日期：2026-10-19
分支：`phase12-ui-motion`（在 Phase 12 未提交成果上继续施工）
提交状态：Phase 12 与 12.1 的变更均**未提交、未 push**。

## 一、结论

Phase 12.1 已完成：

- 深色主题改为**连续中性灰阶**，由“设置 › 外观”里的“深色程度”滑块控制，0 = `#242424`，100 = 纯黑；默认 **100**。主题控件不再出现在一级页面。
- 所有深色表面（应用、侧栏、面板、浮层）由同一水平派生，RGB 三通道严格相等，不再有蓝/青倾向。
- Primary Action 改为黑白反转：深色近白底黑字，浅色近黑底白字；危险按钮保留红色语义。
- Liquid Glass 保留并中性化：无蓝色强调、无大面积持续模糊、无新增依赖。
- 旧 `rw.theme` / `rw.themeStyle` 配置兼容；新 `rw.themeLevel` 持久化；首帧由 `theme-init.js` 计算，无闪烁。
- 浏览器验收 **64/64**；真实 Tauri / WebView2 开发窗口验收 **33/33**；`npm run check` **67 文件 / 1395 项**通过。
- 头像移至侧栏左下角；AI 设置改为设置窗口内的紧凑页面，不再显示供应商名称或大卡片；全局“AI 就绪”浮动卡片已删除。

## 二、主题系统修改

### 2.1 文件与配置

| 文件 | 修改 |
| --- | --- |
| `src/app/config.ts` | 新增 `THEME_LEVEL_STORAGE_KEY = 'rw.themeLevel'`；保留 `rw.theme` / `rw.themeStyle` |
| `src/features/theme/theme.ts` | `DarkLevel`、`darkPalette()`、`parseThemeLevel()`、`levelPreset()`、新的 `applyTheme()` |
| `src/features/theme/useTheme.ts` | 管理 `pref + level`，实时应用与持久化；写入派生的 `rw.themeStyle` |
| `src/features/theme/ThemeSwitch.tsx` | 导出 `ThemeSegments` 与 `DarkLevelSlider`，供设置页使用 |
| `src/features/settings/SettingsDialog.tsx` | 大尺寸模态设置窗口，保留背后页面 |
| `src/features/settings/SettingsView.tsx` | 外观 / AI 服务分类导航 |
| `src/features/settings/AppearancePanel.tsx` | 主题、深色程度、头像 |
| `src/features/settings/AiSettingsPanel.tsx` | 紧凑 AI 模式、API Key、费用与预算；不显示供应商名称 |
| `src/features/ai/providerLabel.ts` | 把供应商标签映射为“在线模型 / 离线模拟” |
| `src/features/projects/Sidebar.tsx` | 设置入口与左下角头像；移除主题控件 |
| `src/app/App.tsx` | 设置窗口、左下角头像、删除全局 AI 状态卡片；成功通知改用中性 `banner-notice` |
| `public/theme-init.js` | 首帧前读取三个键并按同一公式写入 CSS 变量 |
| `index.html` | 增加 `data-dark-level="100"` 默认值 |
| `src/styles/tokens.css` | 中性浅/深色语义 tokens、Primary tokens、中性玻璃与氛围色 |
| `src/styles/components.css` | 黑白 Primary、滑块与主题区、去掉大块蓝绿选中态 |
| `src/styles/layout.css` | 中性氛围层、表面颜色过渡、通知语气修正 |
| `src/styles/glass.css` | 保留玻璃光模型，颜色改由中性 tokens 提供 |

### 2.2 颜色计算

```text
level ∈ [0, 100]（四舍五入并夹取）
base = round(36 × (1 - level / 100))

应用背景   = base
侧栏       = base + 8
普通面板   = base + 13
浮层/抬升  = base + 24
边框       = base + 38
细分隔线   = base + 26
```

每个值写成三通道相等的十六进制颜色（`#rrggbb` 且 r=g=b），由 `applyTheme()` 写入 `<html>` 的内联变量：

`--dark-level`、`--dark-app`、`--dark-sidebar`、`--dark-panel`、`--dark-elevated`、`--dark-border`、`--dark-hairline`。

深色 token 块只引用这些变量；浅色 token 块完全不受影响。滑块拖动时 React 更新 level，内联变量即时更新，`background-color` 以 150ms 过渡呈现平滑预览。

| level | 应用 | 侧栏 | 面板 | 浮层 | 边框 |
| --- | --- | --- | --- | --- | --- |
| 0 | `#242424` | `#2c2c2c` | `#313131` | `#3c3c3c` | `#4a4a4a` |
| 25 | `#1b1b1b` | `#232323` | `#282828` | `#333333` | `#414141` |
| 50 | `#121212` | `#1a1a1a` | `#1f1f1f` | `#2a2a2a` | `#383838` |
| 75 | `#090909` | `#111111` | `#161616` | `#212121` | `#2f2f2f` |
| 100 | `#000000` | `#080808` | `#0d0d0d` | `#181818` | `#262626` |

文字固定为 `#f2f2f2 / #bdbdbd / #a8a8a8`（主/次/三级），在 level 0 的最浅面板 `#3c3c3c` 上仍满足 AA（实测最低 5.39）。

### 2.3 持久化与兼容

- `rw.theme`：语义不变（`system | light | dark`）。
- `rw.themeLevel`：0–100，默认 100；存在时优先。
- `rw.themeStyle`：旧 Phase 12 键。
  - 无 `rw.themeLevel` 时迁移：`obsidian → 100`，`graphite → 36`（与旧 Graphite 亮度接近的中性灰）。
  - 新版本每次改主题/滑块都会写入派生值（100 → `obsidian`，其余 → `graphite`），旧客户端仍能读到合理预设。
- `data-theme` 仍为 `light/dark`；新增 `data-dark-level`；`data-theme-style` 保留为派生预设名，不再参与 CSS 颜色计算。
- 跟随系统：系统切换到深色时直接使用已保存的 level。
- 首帧：`public/theme-init.js` 在 React 挂载前完成 level 解析、夹取、颜色计算与属性写入；主题单元测试对比了脚本与 TypeScript 公式的逐档一致性。

### 2.4 控件位置

主题控件不再出现在一级页面，而是放在**设置窗口 › 外观**：

1. 三枚图标：跟随系统 / 浅色 / 深色（滑动指示胶囊，`aria-pressed`）。
2. 一行“深色程度”滑块 + 数值（0–100），`aria-valuetext` 在两端读作“深灰 / 纯黑”。

设置窗口是 1080px 上限的模态大窗（自身滚动、Esc/关闭按钮退出），背后的项目页或阅读器保持挂载。这样在阅读中切换深浅色不会退出阅读器，也不会丢失当前页。248px 侧栏、1024×689、800×800 与 720px 窄窗下均无溢出或裁切。

侧栏底部依次为“备份与恢复 / 管理项目 / 设置”，再往下是左下角头像与“本地工作区”标签。

### 2.5 设置窗口、头像与 AI 页面

- **头像左下角**：`AvatarPicker` 以 34px 紧凑尺寸放在侧栏最底部的 `.sidebar-user` 行，点击即可更换；完整的上传/恢复默认图控制仍在“设置 › 外观”中。
- **设置页面**：新增 `SettingsDialog` / `SettingsView`，左侧是“外观 / AI 服务”分类，右侧是紧凑表单；不再是覆盖全部内容的第一级页面，也不再是只服务 AI 的对话框。
- **AI 页面**：模式选择改为两条紧凑列表行（离线模拟 / 在线模型），不再使用大卡片；API Key、费用与用量、会话预算按普通设置分组排列。
- **不显示供应商名称**：可见文案只使用“在线模型 / 离线模拟 / API Key / 模型服务”等中性词。新增 `src/features/ai/providerLabel.ts`，把后端返回的供应商标签映射为中性名称；真实 provider/model 仍保留在数据与日志中。
- **删除全局 AI 状态卡片**：原先左下角浮动的“AI 就绪 · 离线模拟”胶囊会压在主面板边缘，已删除。当前模式仍可在“设置 › AI 服务”的状态行、阅读器 AI 面板的提示与回答出处中看到，Mock/在线仍明确区分。

## 三、Primary 按钮最终样式

| 主题 | 背景 | 前景 | Hover | 按压 |
| --- | --- | --- | --- | --- |
| 深色 | `#f5f5f5` | `#0a0a0a` | `#ffffff` + 柔和白色外发光 | `scale(0.975)`，松开弹簧回弹 |
| 浅色 | `#121212` | `#ffffff` | `#000000` + 中性阴影 | 同上 |

- 实测对比度：深色 18.16:1，浅色 18.73:1。
- 顶部 sheen、1 设备像素内高光、细边框与短 lift 保留液态玻璃质感。
- 次要按钮、图标按钮、导航项、分段控件继续使用低对比玻璃材质，不填大块实体色。
- `btn-danger` 保持红色语义；禁用按钮 `opacity: 0.55`，键盘焦点环保持 2px 中性描边。

## 四、Liquid Glass 与氛围层调整

- 深色玻璃使用白色半透明填充、白色边缘高光、黑色中性阴影；浅色使用黑色边缘、白色高光、轻量中性阴影。
- 强调色改为中性：深色 `#f2f2f2`，浅色 `#1a1a1a`；选中态依靠白色/黑色 tint、指示条与对勾，不再依赖蓝色。
- 顶部/底部氛围层改为中性白灰：深色 `rgba(255,255,255,0.04/0.025)`，浅色顶部白光、底部轻微中性暗角；纯黑下尤其克制。
- 氛围层仍只作用于 `.app` 的两个装饰伪元素，`pointer-events: none`，不参与滚动；不对 PDF、文字层、AI 回答或笔记正文施加任何 blur/mask。
- 深色滑块拖动时，应用/面板/对话表面以 150ms 颜色过渡更新；没有持续动画，没有新增 GPU 大面积合成。

## 五、测试与真实窗口验收

### 5.1 自动化

| 命令 | 结果 |
| --- | --- |
| `npm run check` | **PASS**：67 个测试文件 / **1395 项** |
| `npm run build` | **PASS** |
| `npm run verify:ui-phase12`（已扩展为 12.1） | **PASS 64/64** |
| `npm run verify:ui-phase12-desktop` | **PASS 33/33** |
| `npm run verify` | PASS 61/61 |
| `npm run verify:reader` | PASS 27/27 |
| `npm run verify:ai` | PASS 54/54 |
| `npm run verify:annotations` | PASS 26/26 |
| `npm run verify:backup` | PASS 39/39 |
| `npm run verify:compat` | PASS 13/13 |
| `npm run verify:immersive` | PASS 33/33 |
| `npm run verify:research-workflow` | PASS 30/30 |
| `npm run verify:graph` | PASS 17/17 |
| `npm run verify:knowledge-ai` | PASS 48/48 |
| `npm run verify:knowledge-real` | PASS 16/16 |
| `npm run verify:knowledge-replay` | PASS 29/29 |
| `npm run verify:knowledge-replay-all` | PASS：12 条回放，0 不变量问题 |
| `npm run verify:guard` | PASS 10/10 |

浏览器验收新增/覆盖：

- 0/25/50/75/100 五档应用、面板、侧栏、浮层颜色；
- 默认 100、实时更新、重载恢复、跟随系统、旧 `graphite/obsidian` 迁移；
- 深浅 Primary 颜色与 AA 对比度、hover、`0.975` 按压与回弹、禁用透明度；
- 键盘 Tab 到滑块、焦点环、reduced-motion、快速连续拖滑块/切主题；
- AI 设置在深色 100 与深色 0 下的文本对比度、侧栏无裁切、阅读器 PDF 无 filter/blur、无控制台异常。

证据：`docs/phase12.1-ui-verification-report.json`、`docs/phase12.1-desktop-verification-report.json`。

### 5.2 真实 Tauri / WebView2 窗口

- 开发版 `com.researchworkspace.desktop.dev`，CDP 连接，1024×689 CSS，DPR 1.875。
- 实际切换并截图 **level 0 / 50 / 100** 与浅色；验证设置窗口（外观 / AI 服务）、左下角头像、Primary 对比度、阅读器 PDF、焦点、reduced-motion、快速输入。
- 真实窗口最低文本对比度：dark 0 为 5.39，dark 100 为 8.00，浅色 6.35。
- 确认全局 AI 状态浮动卡片已移除，页面上没有遮挡；AI 状态在设置 › AI 服务与阅读器 AI 面板中仍可见。
- **没有**把浏览器模拟冒充安装版验收；安装版未重新打包（见第六节）。

## 六、截图索引

### 6.1 浏览器（隔离配置，生产构建）

目录：`docs/screenshots-phase12/2026-10-19T11-19-06-ui/`

| 文件 | 主题/程度 | 场景 |
| --- | --- | --- |
| `00-home-light-empty-1440x900.png` | 浅色 | 首次启动空工作区 |
| `00b-settings-appearance-1440x900.png` | 浅色 | 设置窗口 › 外观（主题、深色程度、头像） |
| `01-home-dark-100-1440x900.png` | 深色 100 | 首页 |
| `02-home-dark-0-1440x900.png` | 深色 0 | 首页 |
| `03-home-dark-50-1440x900.png` | 深色 50 | 首页 |
| `04-home-light-1440x900.png` | 浅色 | 首页 + 黑色 Primary |
| `04b-home-dark-100-960x600-scaled.png` | 深色 100 | 150% 缩放等效 |
| `05-home-narrow-720x820.png` | 深色 100 | 窄窗 |
| `06-sidebar-overlay-720x820.png` | 深色 100 | 窄窗侧栏叠层 |
| `07-library-dark-100-1440x900.png` | 深色 100 | 论文库 |
| `08-reader-dark-100-1440x900.png` | 深色 100 | 阅读器 |
| `09-reader-notes-dark-100-1440x900.png` | 深色 100 | 阅读器 + 笔记 |
| `10-ai-settings-dark-100-1024x689.png` | 深色 100 | 设置 › AI 服务（紧凑模式行、无供应商名） |
| `11-ai-settings-dark-0-1024x689.png` | 深色 0 | 设置 › AI 服务 |
| `12-ai-settings-narrow-800x800.png` | 深色 100 | 设置窗口窄屏单列 |
| `13-focus-ring-1440x900.png` | 深色 100 | 键盘焦点 |
| `14-reduced-motion-1440x900.png` | 深色 100 | reduced-motion |

### 6.2 真实 WebView2 开发窗口

目录：`docs/screenshots-phase12/2026-10-19T11-21-01-desktop/`

| 文件 | 场景 |
| --- | --- |
| `00-desktop-settings-appearance-1024x689.png` | 设置窗口 › 外观 |
| `01-desktop-home-dark-0-1024x689.png` | level 0 首页 |
| `02-desktop-home-dark-50-1024x689.png` | level 50 首页 |
| `03-desktop-home-dark-100-1024x689.png` | level 100 首页 |
| `04-desktop-home-light-1024x689.png` | 浅色首页 + 黑 Primary |
| `05-desktop-ai-settings-dark-100-1024x689.png` | 设置 › AI 服务 level 100 |
| `06-desktop-ai-settings-dark-0-1024x689.png` | 设置 › AI 服务 level 0 |
| `07-desktop-reader-dark-100-1024x689.png` | 真实 PDF 阅读器 |
| `08-desktop-reduced-motion-1024x689.png` | reduced-motion |

## 七、未验证项、Git 状态与发布条件

### 7.1 未验证 / 未运行

- **安装版未重新打包**：`Research Workspace_0.11.0_x64-setup.exe` 仍是 Phase 11 界面；本轮未覆盖正式安装包是工程约束。发布条件：完成 Phase 12/12.1 后重新打包安装器，并重跑安装、升级、单实例与桌面专项验收。
- **旧桌面验收脚本需要同步**：`verify:desktop*` 面向旧安装版 UI，仍引用已删除的 `.ai-service-badge`、侧栏主题控件与旧的 AI 大卡片。它们本轮未运行；下次重新打包前必须按新的设置窗口、头像位置和 AI 页面更新这些脚本。
- `verify:desktop` 等面向安装版的脚本未运行（同上）。
- Linux 未验证。
- 未逐档切换 Windows 100% / 125% / 150% 系统缩放；以 1440×900、1024×689、960×600、800×800、720×820 CSS 视口覆盖，并在真实窗口记录 DPR 1.875。
- 未做可靠 FPS 采样，不提供编造数字。
- 无真实 DeepSeek 请求。

### 7.2 Git 状态

- 分支：`phase12-ui-motion`。
- Phase 12 与 12.1 的代码、脚本、报告均为**工作区未提交变更**；未执行 reset/clean/强制操作，未 push。
- 运行既有验收套件会覆盖 `docs/screenshots/`、`docs/screenshots-phase3/`、`docs/screenshots-reader/` 等已跟踪历史证据；本轮运行后已用 `git checkout --` 恢复，Phase 12.1 证据保存在 `docs/screenshots-phase12/` 与两个 12.1 JSON 报告中。
- 回滚：未提交状态可直接丢弃；`git checkout phase11-desktop-ai` 可回到 Phase 11 分支（未提交改动会保留在工作区）。

### 7.3 新增/修改的验收资产

- 新增 `docs/Phase12.1-UI-验收报告.md`（本文件）。
- 扩展 `scripts/verify/ui-phase12.mjs`（64 项）与 `scripts/verify/ui-phase12-desktop.mjs`（33 项）。
- 新增 `scripts/verify/appearance.mjs`：供既有浏览器验收在“设置 › 外观”里切换主题，并保持阅读器/项目页不退出。
- 新增 `docs/phase12.1-ui-verification-report.json`、`docs/phase12.1-desktop-verification-report.json`。
- 无新增依赖。
