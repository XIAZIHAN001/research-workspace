# 验收流程与基线（v1 · 2026-10-24）

日常打勾清单在 `.agents/skills/research-workspace-ui/references/acceptance-checklist.md`；
本文件是基线记录、脚本目录与报告模板。逐条清单打勾后，把结果汇总进 `docs/` 下的验收报告
（沿用仓库 Phase 验收报告惯例）。

## 1. 基线记录（重构前状态）

| 项              | 值                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| 版本            | 0.12.6（package.json 与 src-tauri/tauri.conf.json 一致）                                                              |
| Git             | `main@964f865`，与 `origin/main` 完全同步（0 ahead / 0 behind），工作树干净，单一 worktree                            |
| `npm run check` | **全绿**：typecheck ✓ eslint ✓ prettier ✓ vitest **88 文件 / 1628 测试全过**（35.9s）                                 |
| 已知失败项      | 无                                                                                                                    |
| 测试栈          | Vitest 5 + jsdom + RTL 16；浏览器验收脚本为 playwright-core（devDep 已有 1.64.1，复用本机 Edge/Chrome，不下载浏览器） |

> 任务书中"远程 main 为 0.12.0、截图版本 0.12.6"的信息已过时：远程 main 现即 0.12.6，
> 本地即应修改的工作树，无版本分歧需要调和。

## 2. 三层验收

### L1 静态层（每次必跑）

```bash
npm run check        # typecheck + eslint + prettier + vitest
```

### L2 脚本浏览器层（按改动区域选择）

共享设施：`scripts/verify/browser.mjs launchBrowser()`（Edge→Chrome 通道，`BROWSER_PATH` 可覆盖）、
`scripts/verify/appearance.mjs setAppTheme(page,label)`（经设置窗口切主题，读器保持挂载）、
`scripts/verify/page-checks.mjs`（`watchPage` 收集 console error/warning + 请求失败；`runAxe` 跑 axe-core）。

| 命令                                                                        | 覆盖                                                    | 何时必跑                        |
| --------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------- |
| `npm run verify:reader`                                                     | 阅读器核心                                              | 触及 ReaderView/reader.css/断点 |
| `npm run verify:immersive`                                                  | 沉浸阅读：纸张模式画布取色、AI 面板、难点锚点、刷新存续 | 触及纸张模式/右面板/AI          |
| `npm run verify:annotations`                                                | 标注链路                                                | 触及选段/锚点                   |
| `node scripts/verify/contrast.mjs`                                          | 像素级对比度（文本中和后采样真实背景，跳过被遮罩内容）  | 触及任何颜色/主题               |
| `node scripts/verify/page-checks.mjs`                                       | axe + console/网络错误                                  | 触及任何组件结构                |
| `npm run verify:desktop` / `verify:desktop-dev` / `verify:desktop-isolated` | 桌面壳                                                  | 触及 WindowBar/Tauri 配置       |
| `npm run verify:ui-phase12`（及其 desktop 变体）                            | 既有 UI 验收回归                                        | 每轮收尾                        |

新增交互或设置项时，**优先扩展现有脚本**（复用 launchBrowser/setAppTheme/page-checks），
而不是新起一套自动化。

### L3 交互走查层（探索式，无法脚本化的部分）

```bash
npm run dev   # vite @ http://127.0.0.1:1440（非 Tauri 环境自动降级：AI 显示浏览器提示，导入/阅读全可用）
```

用 browser-use 插件（control-browser skill）或手动执行清单 §2–§4：
尺寸×主题矩阵、场景走查、静态界面规则、红线检查。导入一篇真实 PDF 后再测阅读器场景
（导入走 pdf.js + IndexedDB，纯浏览器可用）。改 Tauri 壳相关时补 `npm run desktop:dev`。

## 3. 矩阵与关键断点

- 尺寸：1600×900 / 1366×768 / 1024×768 / 800×600（1024 检查右面板 ≤1100 转浮层；800 检查主侧栏 ≤759 转抽屉）。
- 主题：浅色 / 纯黑（level 100）/ 中间深色（level ≈36）/ 跟随系统。
- 断点一致性：759 与 1100 各做 ±1px 步进，确认 JS 行为（useMediaQuery 分支）与 CSS 表现同帧一致；
  两处断点定义（config.ts 常量、reader.css @media）grep 复核仍是预期数值。

## 4. 红线（任一出现即打回）

见 acceptance-checklist.md §5：PDF 坐标系失效、主题首帧闪烁、文本裁切/滚动丢失/浮层遮挡/背景
滚动串扰、断点 JS-CSS 不一致、AI 协议与数据安全越界、未经授权的新依赖、对比度不达标。

## 5. 截图交付物（改造前 / 改造后各一套）

命名：`docs/design/baseline/<场景>-<尺寸>-<主题>.png`（改造后为 `docs/screenshots-<phase>/`，沿惯例）。

| 场景                   | 最低要求                                    |
| ---------------------- | ------------------------------------------- |
| 普通阅读（均衡布局）   | 1366×768，浅色 + 纯黑                       |
| 专注阅读               | 1366×768，浅色                              |
| 研究模式（右面板打开） | 1600×900，浅色 + 纯黑                       |
| 设置窗口               | 1366×768，浅色（每页一张）                  |
| 窄窗口                 | 1024×768（右面板浮层）、800×600（侧栏抽屉） |

## 6. 验收报告模板

```markdown
# <Phase> 验收报告（<日期>）

## 范围与分支

## 基线对比（check 结果、新增/受影响测试）

## 修改模块（按 文件:行 列要点）

## 验收执行（L1/L2/L3 各项结果，矩阵覆盖表）

## 自定义功能的状态存储（键/默认值/边界/迁移）

## 截图（改造前后对照）

## 未完成项 / 已知限制 / 潜在回归风险
```
