# 布局与个性化重构实施计划（下一轮施工基准 · 2026-10-24）

任务书：工作区布局与个性化体验重构（布局系统 / 个性化配置 / 设置窗口 / 统一视觉系统）。
本文把任务书落成可执行、可验收的阶段；视觉基准见 [DESIGN_SPEC.md](./DESIGN_SPEC.md)，
验收基准见 [ACCEPTANCE.md](./ACCEPTANCE.md)。

## 0. 施工前结论（已核实，施工时直接引用）

- **版本无分歧**：本地 = origin/main = 0.12.6（`main@964f865`），无"远程 0.12.0"问题；无 tags。
- **右面板导航已符合高频入口要求**：顶层已是 目录/AI/知识 三 chip；书签、笔记在目录面板内，
  难点在知识面板内。重构重点是**面板 chrome 统一（标题行/关闭/滚动区/底部操作）、AI 输入固定底部、
  压缩双层容器与重复文案**，不是重建导航。
- **已有能力直接复用**：侧栏拖拽+键盘+折叠（useSidebar）、面板拖拽（--panel-w）、主题深度
  （darkPalette 0–100）、纸张模式（4 种）、无闪烁主题初始化（theme-init.js）。
- **已知技术债顺手清理**：reader.css 过期注释（"Six tabs…"）、`.settings*`/`.segmented` 在
  components.css 与 apple.css 双份定义（本轮触及处只改 apple.css 生效层，并在原地注明）、
  `.ai-panel` 等独立宽度与 `.reader-side > *` 覆盖规则并存（统一由 `--panel-w` 主持）。

## 1. 新增存储键提案（全部遵循：默认值 + clamp + 旧版本容忍）

| 键                       | 类型/默认                                                        | 边界             | 迁移与兼容                                                                     |
| ------------------------ | ---------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------ |
| `rw.layoutPreset`        | `'balanced' \| 'focus' \| 'research'`，默认 `balanced`           | 白名单外回落默认 | 键缺失=首次使用，落默认                                                        |
| `rw.density`             | `'standard' \| 'compact' \| 'comfortable'`，默认 `standard`      | 同上             | 写 `<html data-density>`；theme-init.js 无需涉及（不防闪烁）                   |
| `rw.uiFont`              | `'default' \| 'large' \| 'larger'`，默认 `default`               | 同上             | 写 `<html data-ui-font>`；仅命中 UI 表面，禁止波及 `.reader-scroll/.textLayer` |
| `rw.zoomDefault`         | `'fit-width' \| '100' \| 'last'`，默认 `fit-width`（沿用现行为） | 同上             | 只决定打开时的初始缩放策略，不改缩放数学（readerMath 不动）                    |
| `rw.sidebarWidth` 默认值 | 248 → **224**                                                    | 200–420 不变     | 已存储值一律尊重；仅影响新用户与"恢复默认布局"                                 |

实现位置：键常量进 `src/app/config.ts`；clamp 在消费端（useSidebar / ReaderView / 新 hook）；
预设/密度/字号经 `App.tsx` 写 `data-*` 属性，CSS 侧只加 Token 覆盖块（DESIGN_SPEC §2）。

## 2. 阶段划分

### P0 分支与基线 ✅（本轮已完成）

分支策略、基线记录（ACCEPTANCE §1）、设计与验收基准文档、项目 skill。施工在新分支
`feat/layout-personalization`（或当轮命名）上进行。

### P1 Token 与密度地基

- 改：`tokens.css`（间距/控件高度/密度/UI 字号 Token 块）、触及区域的消费替换（渐进，不全量改写）。
- `App.tsx` 挂 `data-density`/`data-ui-font`；设置中心先留接口（P4 出 UI）。
- 验收门：`npm run check` 全绿；三密度 × 三主题截图无裁切；PDF 视觉零变化（画布与文本层对比截图）。
- 风险：字号档选择器误伤 PDF 文本层 → 用 `:root[data-ui-font]` + 明确作用域，跑选段锚点脚本。

### P2 布局预设

- 改：`config.ts`（新键 + 默认宽度 224）、新 `useLayoutPreset`（或并入 useSidebar）、
  `App.tsx` / `ReaderView.tsx` 接线、"恢复默认布局"动作。
- 行为：预设只设初始开合；窄窗口抽屉/浮层规则优先于预设；手动拖拽后预设不回写覆盖。
- 验收门：三预设冷启动恢复正确；759/1100 ±1px 断点一致；恢复默认不触碰数据键（单测断言 localStorage）。
- 新增测试：布局偏好持久化、宽度边界 clamp、旧配置（键缺失/非法值）回落。

### P3 阅读器工具栏与右面板

- 改：`ReaderView.tsx` 工具栏分组与"更多"收纳（长标题截断验证）、三面板统一 chrome、
  AI 输入固定底部、空状态瘦身、清理过期注释与重复宽度规则。
- 不做：三 chip 结构重建、面板功能增删。
- 验收门：`verify:reader`、`verify:immersive`、`verify:annotations` 全过；左右栏同开、长标题、
  窄窗口、AI 输入、选段、书签跳转场景走查；`verify:ui-phase12` 回归。
- 风险：apple.css 覆盖层导致改动不生效 → 每处样式先 grep 两文件；工具栏折叠在 800×600 出现溢出
  → 收纳进"更多"，不允许换行错位。

### P4 设置中心重组

- 改：`SettingsView.tsx` 页面为 个人/外观/阅读偏好/工作区布局/AI 服务；头像从外观移入个人；
  Dialog 自适应高度（`max-height` + 内部滚动）；AI 面板只挪位置，供应商/密钥/预算逻辑零改动；
  文案压缩（保留隐私与本地数据处理说明）。
- 验收门：`AiSettingsPanel.test.tsx`、`ProfilePanel.test.tsx` 全过；短页无大片留白、长页内部滚动；
  主题/密度/字号/缩放默认值/布局预设五处设置与工具栏快捷入口状态同步。
- 新增测试：设置恢复默认（含确认逻辑）、各偏好键持久化、AI 面板迁移后快照/交互不回归。

### P5 验收与交付

- 跑 ACCEPTANCE 三层全量；四档尺寸 × 主题矩阵；改造前后截图对照（ACCEPTANCE §5 清单）；
  输出 `docs/` 验收报告（模板见 ACCEPTANCE §6），注明未完成项与回归风险。

## 3. 明确不做（任务书约束的落地）

不动 AI 请求协议/供应商逻辑/密钥存储；不重写 PDF.js 核心、知识图谱、引用校验；不删功能、
不迁移不清空用户数据；不引入 UI 框架/新依赖（react-resizable-panels 评估后明确不引入）；
未经授权不 push、不改远程。

## 4. 风险登记

| 风险                                        | 缓解                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1100px JS/CSS 双源漂移                      | P2/P3 每次改后 grep 双处；理想态迁移为属性选择器（需实测无回归，见 DESIGN_SPEC §3.4） |
| apple.css 双份定义静默失效                  | 触及 `.settings*`/`.segmented` 时双文件 grep；原地注释生效层                          |
| theme-init.js 与 theme.ts 失同步 → 首帧闪白 | 调色改动必须同步两处；L3 冷启动截图比对首帧                                           |
| UI 字号波及 PDF 文本层                      | Token 作用域限定 + verify:annotations 回归                                            |
| 密度/字号在 800×600 溢出                    | 矩阵必测 800×600；溢出进"更多"而非裁切                                                |
| 设置窗口改版挤压 AI 长表单                  | AI 面板内部结构不动，仅外层容器与页签迁移                                             |
