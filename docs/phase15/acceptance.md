# Phase 15 · 功能扩展验收报告（2026-10-25）

分支：`feat/phase14-reading-experience` 延续施工（Phase14 收尾后同一分支追加）。
范围：头脑风暴清单逐项核实后的 9 项实现 + 4 项"已存在"核实 + 4 项明确延后。
计划与处置：`docs/phase15/plan.md`。

## 1. 提交清单

| 功能                       | SHA       | 内容                                                                                                                                                     |
| -------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F3 疑问解决态              | `346c9c5` | schema v6→v7（resolvedAt 可选字段）、全部笔记页解决徽标/筛选/计数、阅读器目录面板快捷解决；+11 测试                                                      |
| F5b BibTeX 导入            | `16b0cd8` | 容错解析器（嵌套/引号/拼接/反转义/标识符归一化）、导入对话框（库内已有识别禁选）、整库导出 .bib；+11 测试                                                |
| F8 阅读报告导出            | `9fd1a55` | paperReport 域（元信息/按页批注/概念与证据引用/关系）、库行入口下载 .md；+6 测试                                                                         |
| F4 间隔重复复习            | `633b114` | SM-2 域、独立键 rw.review 存储（版本容忍+未来版本拒写）、ReviewView 学习界面、侧栏入口+到期徽标；+15 测试                                                |
| F7 证据按论文分组          | `7d66d4e` | ConceptDetail 证据排序改论文分组→页码，跨论文表述差异可扫读；零 schema                                                                                   |
| F6 论文术语表（追加轮）    | `1d89bfe` | schema v7→v8（glossary 数组，备份合并/导出/恢复链路同步）、批注工具栏「术语」、目录面板术语区、阅读 hover 卡（只监听已渲染 span，零 DOM 改动）；+13 测试 |
| F11 按标识符补全（追加轮） | `55e35b8` | Crossref/arXiv 按钮触发查找（应用首个网络读，仅手动、无后台）、只填空白字段、CSP 放行两域名；+8 测试                                                     |
| F9 AI 摘要卡（追加轮二）   | `4ac9e77` | schema v8→v9（Paper.summary + 溯源）、目录面板两击确认生成（document 范围披露）；服务端 summarize 模式                                                   |
| F10 笔记成稿（追加轮二）   | `4ac9e77` | 全部笔记页「AI 整理成稿」：笔记引用作为 passage（引用契约一致）、两击确认、结果审阅+下载不写回；服务端 draft 模式                                        |

## 7. PR #2 审查修复轮（v0.13.1，`21da681`）

P0/P1/P2 九项全修复（draftNotes 协议与 64 段独立边界、复习会话队列、摘要卡溯源
schema v10、元数据竞态双保险、hover 字符级命中、BibTeX 文件内重复与失败原因、报告
纳入摘要/术语表、草稿 Markdown 渲染与原生 Dialog）。+23 测试；全门禁在重建 dist 上
复跑全绿（check 1722 / reader 29 / annotations 31 / immersive 33 / backup 39 /
graph 17 / ui-phase12 64）。

**门禁事故与守卫（如实）**：ui-phase12 两次历史 64/64 实为旧 dist 误过（断言旧
蓝色设计），Phase14 截图视觉确认有误读；断言已改近黑设计并加 dist 新鲜度守卫，
旧批次截图已从证据移除。建议其余 preview 型门禁后续同接入守卫。

## 8. PR #2 审查修复轮二（2026-10-25）

第一轮修复后按同一清单再逐条核对，补的是漏项与"只改了一半"的地方：

**协议与服务端**

- `<reader_notes>` 此前只加了区块、没做分隔符中和：笔记正文里写 `</reader_notes>`
  可提前闭合数据区。现在四个分隔符一并中和，系统提示明确"引用与笔记都是数据"。
- draft 边界补齐：draftNotes 计入 200k 上下文总量；笔记条数不得多于 passages；
  同一 passageId 只能被一条笔记引用（否则"读者说"指代不清）。
- 新增 3 例边界测试（合计上限、超量、重复引用、注入中和）。

**客户端**

- 成稿的默认 AI 客户端缺失：`App` 不传 `ai` 时 NotesView 永不显示「AI 整理成稿」。
  改为 `ai ?? { ask: askAi }`，同时保留测试注入。
- 64 段裁剪改为"写过正文优先、再按页序回填"，披露文案、门控与实际携带共用
  `carryNotes` 一个函数；66 条笔记场景验证裁剪与回排。
- 元数据补全：请求飞行中改写 DOI/arXiv 后，应答按标识符快照丢弃并说明，不再
  只靠点击序号判过期。
- 术语 hover：同一 span 内从普通句子漂到术语时 `mouseover` 不重发，补 `pointermove`
  复用同一求值器（防抖与离开清理不变）。
- 草稿审阅框宽度改为 `min(560px, calc(100vw - 96px))`，窄窗口不再挤压页面。

**门禁**

- 新鲜度守卫抽成 `preview-gate.mjs`，接入全部 17 个 preview 型门禁与 phase15
  证据脚本；ui-phase12 只保留调用。
- 重建 dist 后串行复跑：check 99 文件 / **1729 测试**、reader 29/29、
  annotations 31/31、immersive 33/33、backup 39/39、graph 17/17、ui-phase12 64/64。
- 证据：`docs/screenshots-phase15/`（复习卡、BibTeX 预览、术语 hover、草稿对话框）、
  `docs/screenshots-reader/` 本轮重出、`docs/screenshots-phase3/2026-10-25T10-22-55-annotations/`。

## 9. 0.13.2 发布与桌面真机验收（2026-10-25）

- PR #2 已合并进 `main`（合并提交 `1c8384e`），两轮审查修复进入主线。
- 版本号 `0.13.1 → 0.13.2`（package.json / Cargo.toml / tauri.conf.json，Cargo.lock
  同步），NSIS 安装包构建并归档为
  `docs/installers/Research Workspace_0.13.2_x64-setup.exe`。
- 静默安装到 `D:\Research Workspace`；注册表 DisplayVersion 与可执行文件 FileVersion
  均为 0.13.2。
- 桌面门禁（desktop.mjs）随当前界面修正三处陈旧假设：侧栏主题开关已迁入设置（改查
  底部控件完整可见）、AI 状态角标已移除（改为 sidecar 健康轮询）、AI 回答改为流式
  渲染（断言前点「跳过」取全文）。修复后 **43/43** 通过：真实 WebView2、sidecar
  凭据与端口、PDF 渲染、AI/KaTeX、笔记与知识持久化、备份导出与恢复、强杀后无孤儿
  进程、无控制台错误。
- 证据：`docs/screenshots-phase10/2026-10-25T10-47-27-desktop/`。
