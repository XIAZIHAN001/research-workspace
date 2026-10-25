# Phase 14 · 综合体验优化验收报告（2026-10-24）

分支：`feat/phase14-reading-experience`（自 Phase 13 `feat/layout-personalization@352f8af` 切出）
方式：无人值守连续施工，P0–P8 阶段化提交，全部在本地，**未 Push/Merge**。

## 1. 阶段提交清单

| 阶段 | SHA | 范围 |
|---|---|---|
| P0 基线冻结 | `8a56214` | docs/phase14/P0-baseline.md（事实核对、滚动容器盘点、遗留验收定性） |
| P1 诊断 backlog | `223d3ce` | P1-design-review.md + 库/笔记空状态基线截图 |
| P2 Scroll Edge | `8f310ee` | scroll-edges.css（9 个滚动表面）、`rw.scrollEdge` 偏好（关闭/柔和/标准）、设置行、+4 测试 |
| P3+P4 记录 | `2f6fc23` | 阅读主工作流回归（reader 27/27、immersive 33/33）+ AI/引用核查（均零改动） |
| P5 笔记/知识闭环 | `b5ba824` | OutlinePanel 恢复旧文件笔记可发现性；annotations.mjs 语义化重写 31/31 + 知识闭环段；OutlinePanel +1 单测 |
| P6 库/检索/空状态 | `ebc7b17` | 检索三态截图与核查；空状态居中项评估后不改 |
| P7 持久化/桌面/性能 | `a4585c8` | 持久化矩阵、桌面部分执行记录、性能结论 |
| P8 总验收 | 本提交 | 五门禁复跑、视口矩阵补拍、总报告；桌面真机 4/4（P7 更正与补验见本提交） |

## 2. 门禁（P8 全部重新串行复跑，非引用旧报告）

| 门禁 | 结果 |
|---|---|
| `npm run check` | **90 文件 / 1645 测试全绿**（typecheck + eslint + prettier + vitest） |
| `npm run verify:reader` | **27/27**（选段精度 0.0px、位置跨 reload、纸张模式、重复导入） |
| `npm run verify:immersive` | **33/33**（纸张取色、AI 范围披露与载荷一致、难点闭环、无未预期 console） |
| `npm run verify:annotations` | **31/31**（重写后；含导出、知识闭环端到端、重启恢复） |
| `npm run verify:ui-phase12` | **64/64**（含 axe/焦点环/reduced-motion/三档深色审计） |

一次全量 vitest 中 `server/service.test.mjs` 出现过 1 例 provider 失败映射的超时失败，隔离复跑
两次均通过、全量复跑亦通过——判定为并发负载下的时序偶发，未做任何白名单放宽。

## 3. 主线交付：Scroll Edge 视觉系统（P2，本轮主视觉任务）

- 方案选型有对比样张：`mask-image`（状态盲，顶部仍切首行、裁 sticky 子元素与焦点环）与
  `backdrop-filter`（本布局无真实叠加栏）均被否决；采纳 **sticky 渐隐条**：`::before/::after`
  钉在各滚动容器上下边缘，四态（无溢出/顶部/中间/底部）由浏览器原生推导，**零 JS、零监听、
  零 React 重渲染**；渐变色取各表面背景变量，纯黑与可调灰阶自动跟随。
- 应用面：AI 对话、项目导航、目录/书签/笔记、知识面板、项目知识列表/图谱、主内容区、
  检索结果、设置长页。**PDF 列（`.reader-scroll`）零触碰**——Canvas/text layer/标注层无任何
  mask/blur/filter。
- 偏好「滚动边缘：关闭/柔和（默认）/标准」独立持久化（`rw.scrollEdge`），设置›外观可调，
  随「恢复默认布局」回到柔和；`pointer-events: none` 保证不挡点击。
- 截图：`docs/phase14/scroll-edge/`（三态 + 标准档 + 关闭档 + 纯黑 + mask 对比样张）。

## 4. 其他完成项

- **旧文件笔记可发现性恢复**（合并时丢失）：OutlinePanel 新增「另一份 PDF 上的笔记（N）」
  区块——可见、可删、不可跳（锚点失效诚实提示），+1 单测。
- **`verify:annotations` 语义化重写**：31/31，保留原 7 项核心断言（框选精度 0.0px）；新增
  导出与知识闭环；修复 appearance.mjs/ui-phase12.mjs 的关闭按钮 strict violation。
- **知识闭环端到端**：选段 → 笔记 → 新建概念 → 笔记挂为证据 → `打开原文` 回跳原文（spotlight）
  → 重启后全部存续——不依赖 AI 服务、零付费调用（annotations.mjs knowledge 段）。
- P1–P7 阶段记录与全部证据截图在 `docs/phase14/`。

## 5. 未解决项与 NOT_RUN（如实）

1. **桌面真机验证：已完成 ✓（用户授权后执行）**。经项目自带 `msvc-env.cmd` 启动 debug 壳，
   WebView2 CDP + playwright 驱动：桌面壳/窗口控制、**AI 服务页真实 Rust IPC**（provider 列表、
   凭据行、无降级提示）、外观偏好在桌面 webview 生效、Scroll Edge 正常——4/4 通过，证据在
   `docs/phase14/desktop/`。更正：此前记为"本机 MSVC 链接环境故障"有误，真实原因是 cargo 必须
   经 `scripts/desktop/msvc-env.cmd` 调用（VS 在非标准路径 `D:\VS CODE`）。
2. 未覆盖的桌面边界：在线模式付费调用、密钥真实写入 OS 凭据库、安装包安装流程。
3. **Ctrl+K 键盘路径**：本 IAB 自动化后端未送达组合键（自动化限制）；RTL 单测覆盖该快捷键。
4. 空状态垂直居中项：评估后不改（与论文库共用样式，顶部对齐为一致模式）。
5. `server/service.test.mjs` 一例并发时序偶发（复跑即过），未放宽断言，如再现需专项排查。

## 6. 数据与安全核查

- 未删改任何真实论文/笔记/标注/知识数据；全部测试使用生成夹具与隔离 localStorage。
- 未调用在线/付费模型（AI 全程离线 mock 与本地受控脚本）；未读取/回显密钥。
- 无新增 npm 依赖；无未授权远程操作；无临时探针入库（诊断代码均已移除）。

## 7. 截图索引

- Scroll Edge：`docs/phase14/scroll-edge/`（8 张，含方案对比）
- 基线（改造前）：`docs/phase14/baseline/` + `docs/design/baseline/`
- 矩阵：`docs/phase14/matrix/`（1600×900 / 1024×768 浅色+纯黑）+ `docs/phase14/p6/`（检索）
- 阅读器实景：`docs/screenshots-reader/`（本轮门禁重新生成）
- 验收 JSON：`docs/reader-verification-report.json`、`docs/phase12.1-ui-verification-report.json`

## 8. 合并建议

**建议合并**（本地分支，待用户审阅后自行推送）：核心闭环回归全绿、滚动主视觉以零 JS 成本落地、
验收自动化恢复完整（annotations 复活并加强）、桌面真机 4/4 通过、无已知功能回归。

## 9. P8 之后的追加修复（2026-10-24 深夜，`5f387ad` + `af20c14`）

总验收后继续压验收套件本身，发现并修复两类问题（均为脚本问题，应用零改动）：

1. **reader 新增长标题截断检查**（29/29）：标题填满 200 字符上限后，论文库行换行不溢出、
   阅读器工具栏截断且页码/缩放可达；另加固选段检查——适应宽度后 PDF.js 异步重建文本层，
   原断言可能落在重建中途拿到空选区（实测复现一次），改为轮询重选。
2. **Phase 13 面板合并遗留的陈旧选择器**：笔记折叠进目录面板、难点折叠进知识面板、纸张模式
   收进下拉菜单后，7 个验证脚本仍引用旧控件名——`verify:backup` 因此在恢复流程硬超时
   （总验收时未复跑 backup，故 P8 未暴露）。批量修复后串行复跑全绿：reader 29/29、
   backup 39/39、ui-phase12 64/64、immersive 33/33、graph 17/17、research-workflow 30/30、
   knowledge-real 16/16；`npm run check` 90 文件/1645 测试全绿。
   desktop/desktop-dev 仅做选择器对齐，桌面门禁未复跑（需 cargo 构建）。

## 10. P1 backlog 收尾（2026-10-25，主按钮近黑 + 死代码清理）

P1 诊断 backlog 中标注"本轮实现"但 P2–P8 期间漏掉的两项，补做完成：

1. **浅色主按钮改近黑**（P2 backlog #1）：`--color-primary-bg` #0066cc→#1d1d1f、
   hover→#000，白字不变；伴生投影 `--primary-shadow/--primary-glow` 同步去蓝，蓝色只保留
   给链接与强调（`--color-accent`/`--link`/`--focus` 未动）。深色主题本就是白底黑字的
   反转方案，零改动。证据：`docs/screenshots-phase12/2026-10-25T00-09-00-ui/`
   （浅色首页「新建项目」近黑胶囊；对比度审计 home/light 最低 4.66 仍达 WCAG AA）。
2. **NotesPanel/DifficultyPanel 死代码清理**（P2 backlog #5，范围比挂账略大）：两个组件
   均为 Phase 13 面板合并后的死代码（笔记→目录面板、难点→知识面板），删除组件与测试
   （-23 测试），清理 reader.css 41 个死选择器及 apple.css/layout.css 的 7 处死引用；
   `note-kind/note-origin/note-page` 为 NotesView（全部笔记）共用，经核实其样式在
   components.css `.note-card` 作用域自足，未受影响。

门禁：`npm run check` 1622 测试全绿（90 文件）；verify:ui-phase12 64/64（含四档主题
对比度与矩阵截图）；verify:annotations 31/31；verify:reader 29/29。至此 P1 backlog
全部闭环，处置明细见 `docs/phase14/P1-design-review.md` 处置记录表。
