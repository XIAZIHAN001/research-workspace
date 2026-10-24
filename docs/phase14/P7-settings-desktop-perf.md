# Phase 14 · P7 设置持久化、桌面兼容与性能（2026-10-24）

## 1. 设置持久化与迁移（单测 + 走查双覆盖）

| 键                                             | 默认                      | 边界/解析         | 迁移                                                                | 测试                        |
| ---------------------------------------------- | ------------------------- | ----------------- | ------------------------------------------------------------------- | --------------------------- |
| `rw.theme` / `rw.themeLevel` / `rw.themeStyle` | system / 100 / 派生       | clamp 0–100       | `rw.themeLevel` 缺失回落 `rw.themeStyle`（obsidian/graphite）并回写 | theme.test                  |
| `rw.layoutPreset`                              | balanced                  | 白名单            | 旧 `rw.sidebar==='closed'` 一次性推导 focus，否则 balanced          | layoutPrefs.test            |
| `rw.sidebarWidth` / `rw.panelWidth`            | 224 / 360                 | 200–420 / 260–560 | 非法/缺失回落默认                                                   | layoutPrefs.test + App.test |
| `rw.density` / `rw.uiFont` / `rw.scrollEdge`   | standard / default / soft | 白名单            | 非法回落                                                            | appearancePrefs.test        |
| `rw.zoomDefault` / `rw.zoomLast`               | fit-width / {fit,scale}   | scale clamp 0.5–3 | JSON 失败回落                                                       | layoutPrefs.test            |
| `rw.paper`                                     | auto                      | 四值              | 原样                                                                | paperTheme.test             |

- 恢复默认布局（`resetLayoutDefaults`）覆盖全部偏好键并广播事件；单测断言数据键零触碰。
- 跨重启恢复：`verify:annotations` 的 knowledge 段含真实 reload 后概念/证据/跳转存续；
  `verify:reader` 含阅读位置跨 reload；浏览器走查核过 density/scrollEdge/preset 即时生效与
  `localStorage` 写入（Phase 14 P2 截图与状态断言）。

## 2. 桌面（Tauri）兼容 —— 部分执行，其余如实 NOT_RUN

- `npm run desktop:prepare`：✓ sidecar 运行时准备成功（rw-node.exe 87.2 MB，win32/x64）。
- `cargo check`（src-tauri）：**NOT_RUN** — 本机 MSVC 链接环境故障（`multiversion_no_op`/
  `rustversion` 构建脚本在 link 阶段失败，Git Bash 与 cmd 两种环境同样失败）。该问题先于本轮
  存在（src-tauri 本轮零改动），属本机工具链配置，需人工修复 PATH/组件后重验。
- 桌面 GUI 人工走查（开关窗、AI 服务页 provider IPC、密钥状态、sidecar 生命周期）：**NOT_RUN**
  （无 GUI 自动化通道）。缓解：桌面分支 UI（WindowBar、AI 服务页桌面分区、provider IPC 契约）
  已由 `verify:ui-phase12` 的 tauri stub 以现行契约覆盖（64/64，含 AI 服务页三主题审计）。

## 3. 性能（Scroll Edge 专项）

- 实现为零 JS：sticky 渐隐条由浏览器合成，无 scroll 监听、无 rAF 循环、无 React 状态更新；
  未引入 backdrop-filter（无真实叠加层，见 P2 §1），长列表滚动无额外合成层成本。
- 主观流畅度：`.main`（内容高 983px @768 视口）与设置页快速滚动走查无卡顿、无渐隐闪烁；
  主题切换时渐变条随 Token 即时更新，无残留。
- 未做 60fps 仪器化测量（无可靠桌面 GPU 采样环境），不做无证据宣称。

## 4. 无障碍 / 平台差异

- 焦点环、reduced-motion（过渡塌缩到终态、环境层去模糊）、axe 审计、console 干净：
  `verify:ui-phase12` 64/64（本轮实测）。
- 浏览器/桌面差异点已在代码中守卫（`isDesktopApp()` 分支：WindowBar、AI 服务页），浏览器降级
  提示文案保留。
