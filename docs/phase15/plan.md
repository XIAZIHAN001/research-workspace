# Phase 15 · 功能扩展计划（2026-10-25）

依据用户头脑风暴清单逐项核实后的实施计划。先核实、后动手：两项"建议"其实已经存在，
如实记录并从本轮范围剔除。

## 0. 核实为已存在（不重复实现）

| 建议           | 核实结论                                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 阅读进度显性化 | 已存在：`readingProgress()` + PaperRow 进度条与百分比（libraryFilters.ts:116、PaperRow.tsx:53）；首页"继续阅读"按最近位置排序 + 未读队列 + 状态统计（HomeView）。 |
| 自动主题切换   | 已存在：`ThemePref = 'system'` 为默认值，实时跟随 `prefers-color-scheme`（theme.ts:67、useTheme.ts:29）。                                                         |
| BibTeX 导出    | 已存在：单条复制（citation.ts `toBibtex` + 库行菜单）。本轮只补"导入"与"整库导出"。                                                                               |
| 按论文导出笔记 | 已存在：目录面板"导出笔记"（OutlinePanel）。本轮补"整篇阅读报告"（批注+概念+证据聚合）。                                                                          |

## 1. 本轮实现（按风险从低到高串行，每项独立提交）

### F3 疑问解决态（annotation schema v7）

- `Annotation.resolvedAt?: number`（epoch ms，存在即已解决）；`AnnotationEdit` 支持置/清。
- 迁移 v6→v7：纯可选字段，不重写数据，仅升版本号（模式同 v5→v6 的可选字段先例）。
- UI：全部笔记页疑问卡片显示解决态徽标 + 标记已解决/重新打开；疑问状态筛选 chip；
  阅读器目录面板笔记行同步徽标与快捷操作（走既有 `onEditAnnotation` 通道）。
- 价值：疑问从"散落的笔记"变成可追踪、可闭环的问题清单。

### F5b BibTeX 导入 + 整库导出

- `domain/bibtexImport.ts`：容错解析器（@article/@inproceedings/@misc 等；title/author/
  year/doi/eprint→arxivId；LaTeX 反转义；坏条目跳过并说明原因）。
- 导入对话框：文件选择 → 预览列表（按 DOI/arXiv 匹配库内已有 → 默认跳过）→ 勾选导入
  （`actions.addPaper`，identifier 冲突走既有 conflict 逻辑）。
- 整库导出：下载 .bib（复用 `toBibtex` + taken 去重键）。

### F8 阅读报告导出

- `domain/paperReport.ts`：单篇论文的 Markdown 报告——元信息、按页批注（含解决态与
  AI 来源标注）、涉及概念及其证据引用（页码）、所属项目。
- 入口：论文库行"更多操作"菜单，下载 .md。

### F4 间隔重复复习（闪卡）

- `domain/review.ts`：SM-2（4 档评分：忘了/困难/良好/轻松）。
- `services/reviewStore.ts`：独立键 `rw.review`，自有版本与旧版容忍（模式照
  knowledgeStore——独立键独立版本，不碰 rw.projects/rw.knowledge）。
- 复习视图：到期概念卡（正面概念名，背面摘要+证据引用）；侧栏入口 + 到期计数。
  卡片按 confirmed 概念派生：调度状态只存已复习过的概念，概念删除后卡自然作废。

### F7 概念跨论文证据分组（最小增量）

- ConceptDetail 的证据列表按论文分组并标注论文标题，突出"同一概念在不同论文中的
  表述差异"；纯只读增强，不动 schema。

## 2. 本轮明确延后（记入 backlog，不承诺下轮）

| 项                                      | 延后原因                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------- |
| F6 术语表（hover 卡）                   | 需动 rw.projects schema + 阅读器文本层 hover 联动，改动面大，独立成轮。   |
| F9 导入时 AI 摘要卡                     | 需扩展 AI 请求面（新 prompt 类型+范围披露文案），涉及成本承诺，独立设计。 |
| F10 笔记整理成稿                        | 同上，且输出结构需与证据锚点校验链路打通。                                |
| F11 元数据抓取（arXiv/DOI）             | 需网络层与 CSP/Tauri http 权限评估，违反"零网络"现状前必须单独验收。      |
| 双论文并排 / 离线 RAG / Zotero / WebDAV | brainstorm 时的"谨慎评估"档，本轮不做。                                   |

## 3. 约束（沿用项目铁律）

不动 PDF 渲染链路与 reader 测量；不引入依赖；新键默认值+clamp+旧版容忍；三种主题态过
检查；每项完成后 `npm run check` + 相关 verify 脚本；数据安全（不改写既有用户数据语义，
v7 迁移幂等）。
