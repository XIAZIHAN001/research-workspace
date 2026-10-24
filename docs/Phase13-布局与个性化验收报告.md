# Phase 13（布局与个性化）验收报告

日期：2026-10-24 · 分支：`feat/layout-personalization`（基于 `feat/ui-design-workflow`）· 未推送远程

## 1. 范围

按 `docs/design/IMPLEMENTATION_PLAN.md` 完成工作区布局与个性化体验重构：

- **P1+P2（6ce9f3e）**：间距/控件高度/密度/UI 字号 Token；`rw.density`、`rw.uiFont`、`rw.layoutPreset`、`rw.zoomDefault`、`rw.zoomLast` 偏好层；侧栏默认 248→224；恢复默认布局；ReaderView 预设接线与缩放策略。
- **P3（ef165c1）**：阅读器工具栏语义分组 + ≤1100px「更多」菜单（ReaderMoreMenu）；面板样式收敛；清理过期注释与重复宽度规则。
- **P4（d51bed0）**：设置中心五页（个人/外观/阅读偏好/工作区布局/AI 服务）；头像移入个人；纸张模式经 App 提升与工具栏同源；设置窗口自适应高度。
- **P5（本提交）**：三层验收、截图、验收报告、验收脚本存量漂移修复。

## 2. 基线对比

| 项 | 基线（2026-10-24 上午） | 本轮完成后 |
|---|---|---|
| `npm run check` | 88 文件 / 1628 测试全绿 | **90 文件 / 1642 测试全绿**（+14 偏好层测试） |
| `verify:reader` | 未运行（基线未含） | **27/27** |
| `verify:immersive` | 未运行 | **33/33** |
| `verify:ui-phase12` | 未运行（此前不可达） | **64/64** |
| `verify:annotations` | 未运行 | **未通过**（存量漂移，见 §6） |

## 3. 修改模块（要点）

- `src/app/config.ts`：新键常量；`SIDEBAR_DEFAULT_WIDTH = 224`；`rw.sidebar` 注释为遗留迁移键。
- `src/app/layoutPrefs.ts`（新）：预设/缩放解析、迁移（旧 `rw.sidebar` 一次性推导预设）、`resetLayoutDefaults`、`rw:layout-change` 事件。
- `src/app/useSidebar.ts`：启动开合由预设决定（专注收起）；新增 `setWidth`；监听恢复默认；**不再写 `rw.sidebar`**。
- `src/app/useLayoutPreset.ts`（新）、`src/features/theme/appearancePrefs.ts` + `useAppearancePrefs.ts`（新）：偏好状态 + `<html data-*>` 应用 + 恢复默认跟随。
- `src/features/reader/ReaderView.tsx`：`layoutPreset`/`paperMode` props；面板初始态与预设联动（研究模式开面板，回到上次面板）；默认缩放三策略；布局事件监听。
- `src/features/reader/ReaderMoreMenu.tsx`（新）+ `reader.css`：工具栏分组、窄窗收纳菜单。
- `src/features/settings/`：`SettingsView` 五页；`ReadingPrefsPanel`、`LayoutPanel`、`PrefSegments`（新）；`AppearancePanel` 增密度/字号、移除头像；`ProfilePanel` 增头像；`components.css` 设置窗口自适应高度。
- `src/styles/tokens.css`：间距刻度、控件高度、密度与字号覆盖块；`--sidebar-w` 默认 224px。
- **验收脚本修复（存量漂移）**：`verify/reader.mjs`（纸张菜单 `role=option` 选择、pdf.js 样张告警白名单）、`verify/immersive.mjs`（纸张菜单助手 `choosePaperMode`、难点并入知识面板后的入口/文案/类名、AI scope 新契约三处断言）、`verify/ui-phase12.mjs`（rail 按钮名、**tauri stub 契约更新**、外观页新分段三处选择器、侧栏 224 断言）。

## 4. 自定义功能的状态存储

| 键 | 默认 | 边界/解析 | 迁移 |
|---|---|---|---|
| `rw.layoutPreset` | `balanced` | 白名单外回落 | 缺键时由旧 `rw.sidebar==='closed'` 推导 `focus`，否则 `balanced`，并写回 |
| `rw.density` | `standard` | 三值白名单 | 缺失/非法回落 |
| `rw.uiFont` | `default` | 三值白名单 | 同上 |
| `rw.zoomDefault` | `fit-width` | 三值白名单 | 同上 |
| `rw.zoomLast` | `{fit:true,scale:1}` | scale clamp 0.5–3 | JSON 解析失败回落 |
| `rw.sidebarWidth` / `rw.panelWidth` | 224 / 360 | 200–420 / 260–560 clamp | 已存储值一律尊重 |
| `rw.sidebar` | — | **不再写入**，仅迁移读取一次 | — |

恢复默认（`resetLayoutDefaults`）只写偏好键并广播 `rw:layout-change{reset}`，测试断言 `rw.projects` 等数据键零触碰。数据迁移体系（`domain/migrate.ts` SCHEMA_VERSION=6）未改动。

## 5. 验收执行

- **L1**：`npm run check` 全绿（见 §2）。
- **L2**：reader/immersive/ui-phase12 全过；对比度审计内嵌于 ui-phase12 的多主题 audit（浅色/深色 100/深色 0 全过）。
- **L3 浏览器走查**（browser-use，dev 1440）：设置五页渲染与自适应高度、预设切换即时生效（`data-sidebar` open↔closed、持久化正确）、密度/字号即时生效、恢复默认确认流（全部键回归默认 + 侧栏实时重开）、纯黑/浅色一致性、1024×768 与 800×600/758×600 抽屉断点。
- 截图：`docs/screenshots-layout-personalization/`（8 张，改造后）；改造前基线在 `docs/design/baseline/`（7 张）；`docs/screenshots-reader/` 由 verify:reader 重新生成（7 张）。

## 6. 未完成项、已知限制与回归风险

1. **`verify:annotations` 未通过（存量，非本轮引入）**：其笔记流建立在 37493ba 已退役的独立 `.notes-panel` DOM（`.note-item/.note-quote` 等）上，需按「笔记并入目录面板」重写脚本，属独立任务。
2. **存量发现——AI 服务页在「stub 桌面契约」下崩溃**：ui-phase12 的 tauri stub 契约过时（旧扁平 `get_ai_settings`、缺 `ai_providers`），桌面分支渲染即整树卸载。已将 stub 更新至现行 IPC 契约后 64/64 通过；已用 worktree 构建验证 **main 同样存在**（因选择器漂移此前不可达）。真机 Tauri 返回现行契约，理论不受影响，**建议在桌面壳里人工复核一次 AI 服务页**。
3. 均衡布局下面板默认收起（旧版每次打开论文自动展开目录）——任务书 3.2 的明确要求，属有意行为变更；rail 保留一键直达。
4. `rw.sidebar` 不再持久化手动开合：启动布局由预设决定，会话内切换仍完全可用。
5. 布局预设文字分段控件在极窄设置栏可能换行（已加 `segmented--text` 76px 轨道，1366 下单行）；未逐档验证 800×600 下的设置窗口。
6. 键盘焦点环、`prefers-reduced-motion`、axe 审计由 ui-phase12 覆盖通过；未新增 ReaderView 级 jsdom 测试（面板联动由浏览器验证覆盖）。
7. 远程未推送；合并前建议在 Tauri 桌面壳跑一轮 `npm run desktop:dev` 人工走查（本环境未构建桌面端）。
