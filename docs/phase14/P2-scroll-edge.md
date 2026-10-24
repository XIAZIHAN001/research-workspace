# Phase 14 · P2 Scroll Edge 视觉系统（2026-10-24）

## 1. 方案对比与选型（含证据样张，`docs/phase14/scroll-edge/`）

| 方案 | 样张 | 结论 |
|---|---|---|
| `mask-image` 上下渐隐 | `mask-variant-middle-800x600.png` | 视觉最"真"（内容实际透明消隐），但**状态盲**：无法感知滚动位置——即使滚到顶部仍切掉首行 24px；sticky 子元素与到达边缘的焦点环一并被裁。样张中可见顶部主按钮被硬切一半。 |
| 固定栏 `backdrop-filter` 磨砂 | —（无样张） | 本应用现有布局中**不存在内容真正从栏下穿过的叠加栏**：AI 面板头/输入区是滚动区的 flex 兄弟，设置导航 sticky 在自己的网格列里，下方无内容穿过。无真实叠加就没有可磨砂的对象，强行改造布局去制造叠加违背"最小可维护"。 |
| **sticky 渐隐条（采纳）** | `soft-top/middle/bottom`、`standard-top`、`soft-middle-dark100`、`off-top` | 每个滚动容器的 `::before/::after` 是 `position: sticky` 的渐隐条（高度 = `--scroll-edge-h`）。条只在内容"有处可滚、且尚未到边"时被钉在视口边缘盖住内容；**四态由浏览器原生推导，零 JS、零监听、零 React 重渲染**：无溢出=两条各占 h px 背景色（不可见）；顶部=上条自然滚出被裁（首行完整可读）；中间=双条钉边；底部=镜像。渐变色取自各表面的背景变量（`--scroll-edge-from`），深色动态调色板自动跟随（见纯黑样张）。 |

## 2. 实现

- `src/styles/scroll-edges.css`（新，main.tsx 在 apple.css 之前导入）：容器清单 + 表面色 + 双条样式。
  应用对象：`.ai-scroll`、`.sidebar-scroll`、`.outline-scroll`、`.knowledge-panel-scroll`、
  `.knowledge-list`、`.concept-graph-scroll`、`.main`、`.global-search-results`、设置页滚动区。
  **明确不含 `.reader-scroll`（PDF 列）**——Canvas/text layer/标注层零触碰。
- `tokens.css`：`--scroll-edge-h` 由 `<html data-scroll-edge>` 驱动：柔和 20px（默认）、标准 36px、关闭 0px。
- 偏好层：`rw.scrollEdge`（off/soft/standard，默认 soft，白名单解析回落）；`useAppearancePrefs`
  写 `data-scroll-edge` 并跟随恢复默认事件；`resetLayoutDefaults` 写回 `soft`；设置›外观新增
  「滚动边缘」行（复用 TextSegments）。
- 兼容性：sticky/linear-gradient 均为基线能力，无 `@supports` 分支需要；`pointer-events: none`
  保证条不挡点击；条随容器 padding 保持在 scrollport 内，不遮任何栏外控件。

## 3. 验证（browser-use，dev 1440）

- 顶部/中间/底部三态（柔和，800×600，`.main` 真实内容）：`soft-top/middle/bottom-800x600.png`
  ——顶部首行完整、底部尾行渐隐、中间双端柔和 ✓
- 三档偏好即时生效并持久化：standard 36px / off 0px / 恢复柔和（`rw.scrollEdge` 存储断言）✓
- 纯黑深色下渐变跟随动态调色板：`soft-middle-dark100-800x600.png` ✓
- 侧栏滚动区尾部渐隐且滚动区外的 footer 簇不受影响 ✓（`soft-top` 样张左栏）
- 组件测试：偏好解析/回落/应用/恢复默认（appearancePrefs.test.ts + layoutPrefs.test.ts，+4 断言）
- 回归：`npm run check` 90 文件 / 1644 测试全绿；reader/immersive/ui-phase12 在 P8 总验收复跑
  （immersive 覆盖 AI 面板滚动区不回归）。

## 4. 已知边界

- 渐隐条占用上下各 h px 的滚动空间（视觉上成为内容首尾的柔和留白）——柔和档 20px，可接受。
- 空/短列表天然不可见（条即背景色），无需 JS 判断溢出。
- AI 对话区的实际滚动效果依赖 verify:immersive 的离线会话流程回归；浏览器手动走查需本地 AI 服务，
  归入 P8 复核项。
