---
name: research-workspace-ui
description: Research Workspace（本地优先论文精读工作台，React 19 + 原生 CSS + Tauri）的前端设计与验收工作流，本项目专属。凡在本仓库做任何 UI 工作——布局/侧栏/面板调整、阅读器界面、设置窗口、主题/密度/字号、src/styles 样式、界面验收或截图对比——都应使用本技能，即使用户只说"调一下布局""改个样式""看看这个界面对不对"。
---

# Research Workspace UI 设计与验收

本地优先、以 PDF 精读为中心的桌面研究工作台。技术栈：React 19 + TypeScript + Vite + Tauri 2；
**无 Tailwind、无状态管理库、无 CSS 框架**——纯全局 CSS + 自定义属性 Token + React hooks。
详尽规范在 `docs/design/`（DESIGN_SPEC / ACCEPTANCE / IMPLEMENTATION_PLAN / SKILLS_AND_TOOLS），
本文件只保留日常改动必须知道的部分。

## 铁律（改任何 UI 前先读）

1. **PDF 阅读体验优先**。UI 让空间、让注意力给 PDF。不要动 ReaderView 的测量链路
   （ResizeObserver → fitWidthScale → `.reader-slot` 绝对定位），否则选段定位、引用高亮、
   虚拟滚动的坐标一致性全部失效。
2. **中性单色，黑白反转**。主按钮沿用 `--color-primary-bg/-fg` 的黑白反转方案；蓝色只是辅助
   强调（`--color-accent`），禁止大面积蓝按钮、蓝背景。深色模式保持纯黑到中性灰，禁止蓝灰底。
3. **复用优先**。先找现有组件 / Token / hook（见下方代码地图）；禁止引入 UI 框架或新 npm 依赖；
   禁止重写 PDF.js 核心、知识图谱、原文引用校验。
4. **三种主题态都要过**。每个视觉改动在 浅色 / 纯黑（level 100）/ 中间深色（level ≈36）下检查，
   并确认键盘焦点可见、`prefers-reduced-motion` 行为正常。
5. **不加装饰**。不新增卡片、阴影、渐变、玻璃效果；间距只用间距刻度（DESIGN_SPEC §2），不随手写 px。
6. **数据安全**。不迁移、不清空论文/笔记/标注/知识数据；新存储键遵循下方持久化约定。

## 代码地图（省一次探索）

| 区域       | 位置                                            | 关键事实                                                                                                               |
| ---------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 设计 Token | `src/styles/tokens.css`                         | `:root` + `[data-theme='light']` + `[data-theme='dark']`；深色程度靠 JS 写入 7 个 `--dark-*` 变量                      |
| 布局外壳   | `src/app/App.tsx`, `useSidebar.ts`, `config.ts` | 侧栏宽 248（200–420），拖拽 + 键盘（±16、Home/End）；`data-narrow` 属性驱动 CSS                                        |
| 阅读器     | `src/features/reader/ReaderView.tsx`            | 右侧三态：折叠 rail / 侧栏列（`--panel-w` 360，260–560）/ ≤1100px 浮层；工具栏：返回·标题·历史·查找·页码·缩放·纸张模式 |
| 右侧面板   | `OutlinePanel` / `AiPanel` / `KnowledgePanel`   | 顶层只有 3 个 chip（目录/AI/知识）；书签、笔记在目录面板内，难点在知识面板内                                           |
| 主题       | `src/features/theme/` + `public/theme-init.js`  | 深色程度 0–100 连续值 → `darkPalette(level)`；**改调色必须同步 theme-init.js，否则首帧闪白**                           |
| 设置       | `src/features/settings/`                        | 模态 Dialog；页：个人/外观/AI 服务；头像目前在外观页                                                                   |
| 存储       | `src/app/config.ts`                             | 全部 `rw.*` localStorage 键常量在此；759/1100 断点常量在此                                                             |

## CSS 层级陷阱

- `src/main.tsx` 按固定顺序导入全局 CSS；**`apple.css` 最后导入，是 presentation-only 覆盖层**——
  同名选择器（`.settings*`、`.segmented` 等）在 `components.css` 与 `apple.css` 各有一份，
  改错文件会静默无效。改样式前先 grep 两个文件。
- 断点：**759px 只存在于 JS**（`config.ts` → `data-narrow` 属性，CSS 据属性布局）；
  **1100px 是 JS + `reader.css` 双份**，注释已声明必须同步改，改时两处一起动。
- 旧注释可能过期（如 reader.css 的 "Six tabs…"），以组件 JSX 实际结构为准。
- flex 子元素加 `min-width: 0`；`transition` 禁止 `all`，只动画 `transform/opacity`；
  长文本容器必须有截断/换行策略；页码等数字列用 `tabular-nums`。

## 持久化约定（rw.* localStorage 键）

- 键名常量集中在 `src/app/config.ts`，命名 `rw.<feature>`。新键三件套：**默认值 + 消费端 clamp
  - 旧版本容忍**（键缺失/非法值回落默认，参照 `parseThemeLevel` 的迁移先例）。
- 配置键只存 UI 偏好。永远不要写入或改写 `rw.projects`、`rw.projects.corrupt/backup` 及任何
  论文、标注、知识数据；工作区数据有自己的版本迁移（`src/domain/migrate.ts`），别碰。
- 需要预渲染读取的偏好（如主题）必须同步 `public/theme-init.js`。

## 验收流程（每次 UI 改动都要走）

分层流程与基线记录见 `docs/design/ACCEPTANCE.md`，逐项清单见
`references/acceptance-checklist.md`。概要：

1. **静态层**：`npm run check`（typecheck + eslint + prettier + vitest，基线 1628 测试全绿）。
2. **脚本浏览器层**：按改动区域跑 `scripts/verify/*.mjs`（playwright-core + 本机 Edge/Chrome，
   无需下载浏览器）：reader / immersive / appearance·contrast / page-checks(axe+console) / desktop 系列。
3. **交互层**：`npm run dev` → `http://127.0.0.1:1440`，用 browser-use 插件（control-browser skill）
   走查关键场景；窗口尺寸矩阵 1600×900 / 1366×768 / 1024×768 / 800×600。
4. **断点一致性**：759 与 1100 边界 ±1px 各测一次，JS 行为与 CSS 表现必须一致。
5. **产出**：`file:line` 格式问题清单 + 分主题截图（浅色 / 纯黑 / 中间深色）。

## Git 协议

- 在独立分支工作（`feat/...`）；未经用户明确授权不得 push、force、改写远程或历史。
- 提交信息沿用仓库惯例：`type(scope): 中文描述`（如 `feat(reader,ai): ...`）。
- 每阶段保持可回滚提交；验收报告放 `docs/`，沿用既有 Phase 验收报告惯例。

## 深入阅读

- `docs/design/DESIGN_SPEC.md` —— 设计规范：Token 盘点与新增提案、布局预设、组件规范
- `docs/design/IMPLEMENTATION_PLAN.md` —— 布局与个性化重构的分阶段实施计划
- `docs/design/ACCEPTANCE.md` —— 验收基线、脚本目录、矩阵与报告模板
- `docs/design/SKILLS_AND_TOOLS.md` —— ZCode 环境清单与外部资源评估结论
