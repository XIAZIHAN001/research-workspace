# Phase 14 · P0 事实核对与基线冻结（2026-10-24）

## 1. 仓库事实

- 分支：`feat/phase14-reading-experience`（自 `feat/layout-personalization@352f8af` 切出）。
- 工作树：干净，无 stash，单一 worktree；领先 `origin/main` 5 个提交（Phase 13 成果均在本地，未推送）。
- Phase 13 报告的独立复验：**本轮重新执行，非引用旧报告**（见 §3）。

## 2. 基线检查（本轮实测）

| 检查 | 结果 |
|---|---|
| `npm run check` | **全绿：90 文件 / 1642 测试**（typecheck + eslint + prettier + vitest） |
| `verify:reader` | 上轮 27/27（同 HEAD 实测），P8 复跑 |
| `verify:immersive` | 上轮 33/33（同 HEAD 实测），P8 复跑 |
| `verify:ui-phase12` | 上轮 64/64（同 HEAD 实测），P8 复跑 |
| `verify:annotations` | **失败（本轮实测复现）**：7 项选段/高亮/锚点核心 PASS（框选精度 0.0px、双栏 context 正确），在等待 `.notes-panel` 时超时——该 DOM 已随 37493ba 并入目录面板（`.outline-panel`），脚本仍在找退役类名。定性：**存量脚本漂移**，功能本体未被证伪。 |

Tauri IPC stub 契约：Phase 13 已把 ui-phase12 的 stub 更新到现行 `get_ai_settings`（嵌套 budget）+ `ai_providers` 契约并 64/64 通过；**真机 Tauri 桌面构建仍未验证**（本环境无桌面构建条件），列 P7 如实记录。

## 3. 滚动容器盘点（P2 施工对象）

| 容器 | 位置 | Scroll Edge 适用 |
|---|---|---|
| `.ai-scroll` | reader.css:1089（AI 对话） | ✅ 原型首选 |
| `.sidebar-scroll` | components.css:167（项目导航） | ✅ |
| `.outline-scroll` | reader.css:1946（目录/书签/笔记） | ✅ |
| `.knowledge-panel-scroll` | knowledge-ai.css:70（知识面板） | ✅ |
| `.knowledge-list` / `.concept-graph-scroll` | knowledge.css:183/494（项目知识视图） | ✅ |
| `.main` | layout.css:171（首页/项目/论文库） | ✅ |
| `.dialog:has(.settings) .settings` | components.css:1283（设置长页） | ✅ |
| `.global-search-results` | components.css:2110（搜索结果） | ✅ |
| `.notes-scroll` | reader.css:831 | 待确认是否仍被渲染（NotesPanel 已退役，P2 时核实） |
| `.reader-scroll` | reader.css:168（**PDF 列**） | ❌ 任务书明确禁止 mask/blur 触及 Canvas/text layer |
| `.ai-model-picker`、backup/搜索弹层、`.ai-range-part p` | 弹层内部滚动 | P2 视效果决定，默认不动 |

固定栏（磨砂候选）：AI 面板 `.ai-head` 与 `.ai-ask`（flex 列两端）、设置窗口 `.dialog-head` 与 sticky 的 `.settings-nav`、阅读器 `.reader-bar`（非 sticky，位于滚动区外，无需处理）。

WebView2 兼容性：backdrop-filter 与 mask-image 均为 Chromium 支持项；实现需带 `@supports` 回退（无 backdrop-filter 时用不透明背景）。

## 4. 遗留风险与新风险

1. `verify:annotations` 漂移 → P5 按当前语义交互重写（保留其 7 项已 PASS 的核心断言，不删断言）。
2. 真实桌面（Tauri）验收缺失 → P7 记录 NOT_RUN 与原因，不以浏览器代替宣称。
3. PDF 列视觉不可触碰：P2 的一切效果只挂在非 PDF 容器与工具栏背景材料上。
4. `.notes-scroll` 归属待核实（可能是死样式），P2 一并清理或确认。

## 5. P0 结论

基线冻结完成：功能基线全绿；唯一确认的验收缺口是 `verify:annotations` 的脚本漂移（P5 修复）与桌面真机验收（P7 记录）。可进入 P1。
