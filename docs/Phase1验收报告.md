# Phase 1 验收报告：数据模型与持久化基础建设

日期：2026-10-16。工作目录：`D:\论文阅读解构项目`。执行者：本会话（DeepSeek 模型路由，见第九节）。

证据标注沿用 Phase 0 报告的约定：

- **实测**：本次亲自运行命令或在真实浏览器里观察到的结果。
- **代码/单测**：只通过读代码和 jsdom 单元测试确认，未在真实窗口里观察。
- **未验证**：没有证据，不标为通过。

## 一、结论

Phase 1 的四项任务（Schema 版本化与迁移、全局论文身份、存储与状态适配、针对性测试）**全部完成**，第七节列出的验收标准 1–7 条均满足。没有已知回归：`npm run check`、`npm run build` 通过，`npm run verify` 的 61 项浏览器检查全部通过，12 张截图与 Phase 0 **逐字节相同**。

本轮没有做任何界面改动：可视结果与 Phase 0 完全一致，因此 12 张 Phase 0 截图仍是当前界面的真实渲染。原截图与 `docs/verification-report.json` 未被覆盖（见第五节）。

## 二、本轮完成的功能

| #   | 功能                 | 说明                                                                                               | 证据                        |
| --- | -------------------- | -------------------------------------------------------------------------------------------------- | --------------------------- |
| A1  | Schema 版本机制      | 持久化信封写入 `version: 2`；`migrateStoredPayload()` 是唯一的读取入口，迁移链按版本号注册         | 实测（浏览器 localStorage） |
| A2  | Phase 0 数据迁移     | 无版本号载荷被识别为 v1 并迁移；项目、论文、稳定 ID、选中状态、时间戳全部保留                      | 实测 + 单测                 |
| A3  | 迁移确定性与幂等性   | 论文 id 直接沿用旧 `PaperRef.id`，不生成新随机 id；重复加载不产生新 id，第二次加载不再写盘         | 实测 + 单测                 |
| A4  | 失败分级保护         | `unreadable` / `invalid` / `unsupported-version` / `migration-failed` 四类原因可区分，原文永不丢失 | 实测 + 单测                 |
| B1  | 全局论文身份         | 新增知识库级 `Paper` 实体，`id` 与标题、DOI 解耦                                                   | 单测 + 实测                 |
| B2  | 跨项目引用           | `Project.corePaperId` + `relatedPaperIds`；同一篇论文被多个项目引用只登记一份                      | 实测（浏览器载荷）+ 单测    |
| B3  | 外部标识规范化       | `normalizeDoi()` / `normalizeArxivId()`，含 URL、`doi:`、`arXiv:` 前缀与版本号处理                 | 单测                        |
| B4  | 身份匹配             | `findPaperByExternalId()`：仅凭 DOI/arXiv id 匹配，DOI 优先；无可靠标识时绝不按标题合并            | 单测                        |
| B5  | 可调用的关联接口     | `referencePaper(projectId, input)` / `unlinkPaper(projectId, paperId)`                             | 单测                        |
| C1  | 状态管理适配         | `useProjects()` 暴露 `papers` 注册表；项目页从注册表解析核心论文                                   | 实测（浏览器渲染）          |
| C2  | 删除项目的引用完整性 | 删除项目只删项目，注册表不动；被其他项目引用的论文不受影响                                         | 单测                        |
| D1  | 自动化测试           | 新增 3 个测试文件，净增 176 项；原有 318 项一条未删、未降低强度                                    | 实测（`npm run check`）     |

## 三、新旧数据结构对照

### 3.1 持久化信封（`rw.projects`）

|            | Phase 0（v1）                        | Phase 1（v2）                                                   |
| ---------- | ------------------------------------ | --------------------------------------------------------------- |
| 版本标识   | 无                                   | `version: 2`                                                    |
| 顶层字段   | `projects`, `selectedId`             | `version`, `projects`, `papers`, `selectedId`                   |
| 论文元数据 | 内嵌在每个项目里（同一篇论文存多份） | 只存一份，放在知识库级 `papers` 注册表，项目存 id               |
| 读取方式   | `parseProjectsState()` 直接校验      | `migrateStoredPayload()` → 版本检测 → 迁移链 → 校验（唯一入口） |
| 写入方式   | `JSON.stringify(state)`              | `serializeProjects(state)`（唯一写入点，固定写当前版本号）      |

### 3.2 领域对象

| 对象            | Phase 0                                                                              | Phase 1                                                                                            |
| --------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `PaperRef`      | `{ id, title, authors, year? }`，`id` 是**项目内**标识                               | 被 `Paper` 取代                                                                                    |
| `Paper`（新）   | —                                                                                    | `{ id, title, authors, year?, doi?, arxivId?, createdAt, updatedAt }`，`id` 是**知识库级**稳定标识 |
| `Project`       | `{ id, name, corePaper: PaperRef, relatedPapers: PaperRef[], createdAt, updatedAt }` | `{ id, name, corePaperId: string, relatedPaperIds: string[], createdAt, updatedAt }`               |
| `ProjectsState` | `{ projects, selectedId }`                                                           | `{ projects, papers: Record<string, Paper>, selectedId }`                                          |

`Project.id` 的语义没有变化：仍是唯一身份锚点，重命名不变，笔记/批注/图谱节点将挂在它上面。论文侧新增了同等强度的 `Paper.id`，两者一起构成"项目引用 → 论文身份"的单向关系。

### 3.3 存储键

| 键                    | 用途                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `rw.projects`         | 当前载荷（v2）                                                                                                   |
| `rw.projects.corrupt` | Phase 0 既有约定，保留原用途：读不懂（JSON 坏 / 形状不符）的载荷原文，供人工恢复                                 |
| `rw.projects.backup`  | **新增**：本版本拒绝解释的载荷原文（更新版本、迁移失败），以及迁移前的 v1 原文。写入它之前绝不改写 `rw.projects` |

## 四、迁移与身份机制的设计说明

### 4.1 迁移路径

```
raw string
  └─ JSON.parse 失败 ─────────────────────────► unreadable（隔离到 .corrupt，起空状态）
  └─ 非对象 / version 非法 ───────────────────► invalid（隔离到 .corrupt）
  └─ version > 2 ─────────────────────────────► unsupported-version（原文进 .backup，rw.projects 不动）
  └─ version 缺失 → 视为 1
       └─ 迁移链 while (version < 2)
            ├─ 无对应步骤 / 步骤抛错 / 版本未推进 / 越级 ─► migration-failed（原文进 .backup）
            ├─ 步骤返回 null（不是该版本形状）───────────► invalid（隔离到 .corrupt）
            └─ 1 → 2 迁移
       └─ parseProjectsState() 校验迁移结果
            ├─ 失败且未迁移 ─► invalid
            └─ 失败且已迁移 ─► migration-failed（视为迁移代码缺陷，不是数据问题）
       └─ 成功 ─► 原文进 .backup ─► 写回 v2 载荷 ─► 返回 state
```

要点：

1. **唯一的读取入口**。`loadProjects()` 只是 `loadProjectsWithReport().state` 的薄封装，任何路径都走迁移链，不存在"绕过迁移直接解析"的分支。
2. **确定性来自"不生成新 id"**。v1 的论文 id 原样升级为全局 `Paper.id`；迁移里没有任何 `makeId()` 调用，因此同一份载荷无论执行多少次，输出逐字节相同（实测：两个独立 store 各自迁移后 `rw.projects` 完全一致）。
3. **幂等性来自版本号**。v2 载荷不再进入迁移链（`from === SCHEMA_VERSION` 时直接返回，不写盘）；写回成功后 `version` 已是 2，所以第二次加载零写入（单测对 `setItem` 打桩断言未被调用）。
4. **写回前先备份**。v1 → v2 写回前，原文进 `rw.projects.backup`；即使此后迁移结果被证明有误，也能人工恢复。
5. **两类保护分开**。数据本身有问题（`unreadable` / `invalid`）走 Phase 0 既有的 `.corrupt` 隔离；可能是好数据但我们读不了（`unsupported-version` / `migration-failed`）走 `.backup`，并且**完全不碰** `rw.projects`，同时保证在应用后续写入覆盖 live 键之后原件仍可恢复（单测覆盖）。
6. **迁移里做的两处收敛**（都有注释与单测）：v1 允许关联论文重复或与核心论文同 id，v2 不允许，迁移时去重（信息不丢，论文仍通过核心/首次出现被引用）；v1 允许两个项目同 id，v2 的项目 id 是唯一锚点，无法表示，整份载荷判为 `invalid` 隔离，不做合并。

### 4.2 论文身份

- **稳定全局 id**：`Paper.id` 由 `crypto.randomUUID()` 生成一次，永不随标题、作者、DOI 变化。因此"重命名项目 / 修改论文标题 / 重新打开项目"都不改变身份（要求 7）。
- **匹配只依靠外部标识**：`findPaperByExternalId(papers, {doi, arxivId})`。两者都取不到可用值时返回 `null`，**没有**任何标题回退路径（要求 6）。DOI 规范化：去 `https://doi.org/`、`http://dx.doi.org/`、`doi:` 前缀，去空白，整体转小写。arXiv：去 `arXiv:` 前缀、`arxiv.org/abs|pdf` URL、`.pdf` 后缀、**版本号 vN**，转小写；同时支持 2007 年前的老式 id（`hep-th/9901001`）。无法规范化的标识**丢弃而不是原样保存**——保存一个永远匹配不上的 DOI 只会假装链接可用。
- **跨项目引用**：`useProjects().actions.referencePaper(projectId, input)` 先按外部标识查注册表，命中就复用那篇论文（连同它未来的笔记/批注），未命中才新建，然后一次 dispatch 同时登记论文和建立引用。这是"一篇论文属于多个项目"的唯一入口。
- **单一事实来源**：论文元数据只存在注册表一处，项目存 id。reducer 的 `withPaper()` 规定"已在注册表中的 id 不被覆盖"，所以调用方传入过期副本也不会污染数据。
- **删除项目不删论文**：registry 不做回收。共享论文当然要留；只被本项目引用的论文也留下（身份记录本身有价值，且回收是单向不可逆操作）。这是刻意的取舍，见第八节。

## 五、修改文件清单

新增（4 个源文件 + 3 个测试文件）：

| 文件                                   | 内容                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/domain/normalize.ts`              | `MAX_NAME_LENGTH`、`normalizeName`（从 `project.ts` 抽出，避免模块环）                          |
| `src/domain/papers.ts`                 | `Paper`、`PaperInput`、DOI/arXiv 规范化、`createPaper`、`findPaperByExternalId`、`authorCredit` |
| `src/domain/migrate.ts`                | `SCHEMA_VERSION`、`MigrationOutcome`、迁移链、`serializeProjects`、`migrateStoredPayload`       |
| `src/domain/normalize.test.ts`         | 12 项（从 `project.test.ts` 原样迁移，断言未改）                                                |
| `src/domain/papers.test.ts`            | 44 项（含从 `project.test.ts` 迁移的 8 项 authorCredit 断言）                                   |
| `src/domain/migrate.test.ts`           | 33 项                                                                                           |
| `docs/phase1-verification-report.json` | 本轮 `npm run verify` 的机器可读结果（Phase 0 的 `verification-report.json` 保持不变）          |

修改：

| 文件                                                                                                                          | 改动                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/domain/project.ts`                                                                                                       | `Project` 改为 id 引用；`createProject` 返回 `{ project, paper }`；移除 `PaperRef`/`authorCredit`                 |
| `src/domain/projectsState.ts`                                                                                                 | `papers` 注册表；动作 `add` 携带 paper，新增 `linkPaper`/`unlinkPaper`；`withPaper` 单源规则                      |
| `src/domain/parse.ts`                                                                                                         | v2 严格校验（含项目→论文引用完整性）；v1 校验改为 `parseLegacyState()`，只供迁移读取                              |
| `src/services/storage.ts`                                                                                                     | `loadProjectsWithReport()`、迁移写回、`.backup`/`.corrupt` 分流；`LoadIssue`/`LoadResult`                         |
| `src/services/projectsStore.ts`                                                                                               | 快照增加 `issue`；创建时走带报告的加载                                                                            |
| `src/features/projects/useProjects.ts`                                                                                        | 暴露 `papers`；新增 `referencePaper`/`unlinkPaper`                                                                |
| `src/features/projects/ProjectView.tsx`                                                                                       | 核心论文改为从注册表解析（新增 `corePaper` 属性），关联论文数量读 `relatedPaperIds`                               |
| `src/app/App.tsx`                                                                                                             | 传入解析后的核心论文；关联论文数量改字段名                                                                        |
| `src/app/config.ts`                                                                                                           | 新增 `PROJECTS_CORRUPT_KEY`、`PROJECTS_BACKUP_KEY` 常量                                                           |
| `src/ui/InlineRename.tsx`                                                                                                     | 只改导入路径（`normalizeName` 搬家）                                                                              |
| `src/features/projects/CreateProjectDialog.tsx`                                                                               | 只改导入路径（`MAX_NAME_LENGTH` 搬家）                                                                            |
| 测试：`parse.test.ts`、`projectsState.test.ts`、`storage.test.ts`、`projectsStore.test.ts`、`project.test.ts`、`App.test.tsx` | 夹具改为 v2 形状并新增本轮用例；无删除、无弱化既有断言                                                            |
| `.prettierignore`                                                                                                             | `docs/verification-report.json` 改为 `docs/*verification-report.json`，让本轮新增的机器生成结果同样不被格式化检查 |

未改动的文件：全部样式文件、`Sidebar.tsx`、`ProjectRow.tsx`、`HomeView.tsx`、主题/头像/欢迎词模块、`scripts/verify/*`。`docs/screenshots/` 12 张图与 `docs/verification-report.json` 内容未变（第五节）。

修改前的工作副本（只含将被修改的 14 个文件）在 `.cache/phase1-backup/`；Phase 0 截图与报告的原件在该目录的 `docs/` 下。目录不是 Git 仓库，因此没有 diff/回滚能力，未擅自初始化仓库。

## 六、实际执行的命令与结果

| #   | 命令                                       | 结果                                                                            |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| 1   | `npm run test`（基线）                     | 13 文件 / 318 项通过                                                            |
| 2   | `npx vitest run`（第 1 次）                | **失败**：3 文件 / 20 项失败，6 个未捕获异常，原因见下                          |
| 3   | 修复后 `npx vitest run`（第 2 次）         | **失败**：3 文件 / 17 项失败                                                    |
| 4   | 修复后 `npx vitest run`（第 3 次）         | 16 文件 / 494 项通过                                                            |
| 5   | `npx tsc -b`                               | 退出码 0                                                                        |
| 6   | `npx eslint .`                             | 退出码 0，0 error 0 warning                                                     |
| 7   | `npx prettier --check .`                   | 11 个新/改文件不符合格式 → `npx prettier --write` 后复查全部通过                |
| 8   | `npm run check`                            | 退出码 0（typecheck + lint + format + 16 文件 / 494 项测试）                    |
| 9   | `npm run build`                            | 退出码 0，1958 modules，CSS 16.46 kB / JS 252.98 kB（gzip 80.26 kB），478ms     |
| 10  | `npm run verify`                           | **61 项通过，0 失败**，12 张截图；报告存 `docs/phase1-verification-report.json` |
| 11  | 截图逐字节比对（Phase 0 vs 本轮）          | 12/12 **identical**                                                             |
| 12  | 浏览器手工验证（preview + 真实 Edge 内核） | 见 6.3                                                                          |

### 6.1 两次失败记录（如实列出）

第 1 次失败（20 项，跨 3 个文件）与第 2 次失败（17 项，跨 3 个文件）**是同一类原因**：我把 `normalizeName` / `MAX_NAME_LENGTH` / `authorCredit` 搬到了新模块，但只更新了我预期的调用点，漏了 `src/ui/InlineRename.tsx`、`src/features/projects/CreateProjectDialog.tsx`、`src/domain/projectsState.ts` 三处导入。症状是 `TypeError: normalizeName is not a function`。

第 2 次失败里还有 1 项是我自己写错的**测试夹具**（`linkPaper` 用例给不存在的项目 'b' 建引用，实际是 no-op），属于测试代码错误而非实现错误，已修正为使用两个真实项目。

两次修复都在同一轮内定位并改完，第三轮全绿；没有出现"两轮之后仍未解决"的情况。教训写在第九节。

### 6.2 测试分布（本轮实测，逐文件）

| 文件                             | 项数 | 文件                               | 项数               |
| -------------------------------- | ---- | ---------------------------------- | ------------------ |
| `app/App.test.tsx`               | 43   | `services/avatar.test.ts`          | 41                 |
| `domain/parse.test.ts`           | 103  | `services/welcome.test.ts`         | 28                 |
| `domain/projectsState.test.ts`   | 59   | `services/projectsStore.test.ts`   | 25                 |
| `domain/papers.test.ts`（新）    | 44   | `services/storage.test.ts`         | 38                 |
| `domain/migrate.test.ts`（新）   | 33   | `ui/format.test.ts`                | 17                 |
| `domain/normalize.test.ts`（新） | 12   | `features/home/useAvatar.test.tsx` | 7                  |
| `features/theme/theme.test.ts`   | 32   | `domain/project.test.ts`           | 5                  |
| `services/ids.test.ts`           | 2    | `domain/time.test.ts`              | 5                  |
|                                  |      | **合计**                           | **494（16 文件）** |

Phase 0 基线 318 项 → 本轮 494 项，净增 176 项。逐文件核对：`normalizeName` 的 12 项与 `authorCredit` 的 8 项是从 `project.test.ts` **原样搬走**（断言一字未改），因此 `project.test.ts` 从 24 项降到 5 项不是删除，而是拆分加 1 项新用例；其余文件项数只增不减。`theme`、`avatar`、`welcome`、`format`、`ids`、`time`、`useAvatar` 七个文件完全未改，项数与 Phase 0 一致。

本轮新增用例覆盖（对应任务书 Task D 的八条）：

- 无版本旧数据迁移：`migrate.test.ts`（项目/论文/选中/时间戳保留、显式 `version: 1`、选择修复）、`storage.test.ts`（写回 + 备份）、`App.test.tsx`（浏览器级：v1 载荷启动后仍能看到项目并打开）。
- 重复迁移与幂等：同载荷两次迁移 `toStrictEqual`；迁移后再次加载 `setItem` 未被调用；迁移输出的再迁移结果不变；两个独立 store 迁移后载荷逐字节相同。
- 损坏数据与不支持的版本：`{oops`、非对象、形状不符、`version: 99`、非法 version、重复项目 id、空论文 id；四种原因分别断言，并断言 live 键未被改写、备份位置正确。
- 多项目引用同一论文：reducer、store、迁移三层的共享用例，且注册表只增加一条。
- DOI / arXiv 规范化：前缀、URL、大小写、后缀、版本号、老式 id 的 20 余条用例。
- 无可靠标识时的独立身份：同标题不同 id 不合并；无标识时 `findPaperByExternalId` 恒为 `null`。
- 删除项目的引用完整性：删一个项目后共享论文仍在、另一个项目的引用仍可解析、注册表条目不丢。
- 持久化恢复与稳定 ID：跨两次加载的 id 与状态一致；store 重建后状态相同。
- 原有项目操作回归：创建、重命名、切换、删除、选中修复的既有断言全部保留（含 no-op 必须返回同一引用这一条弱约束）。

### 6.3 浏览器验证（实测）

我运行了**完整的** `npm run verify`（61 项），不是抽样：

- 结果：61 passed / 0 failed；报告写入 `docs/phase1-verification-report.json`。
- 与 Phase 0 的 `verification-report.json` 逐项比对：**61 项检查名称完全相同，detail 字段差异为 0**。
- 12 张截图与 Phase 0 逐字节相同（`cmp` 全部 identical），即本轮数据层改造在界面上零可见变化。
- 其中的 `reload keeps theme and projects (7 rows)` 是本轮最关键的浏览器证据：7 个项目由新代码路径创建、写入 v2 载荷、刷新后再读出来全部还在。

另外用 Browser 面板对 dev server（`127.0.0.1:1420`）做了一次针对性的迁移验证：

1. 把一份**手写的 Phase 0 载荷**（2 个项目，第二个把第一个的核心论文列为关联论文）写进 `rw.projects` 后刷新；
2. 读回 `rw.projects`：`version: 2`，`papers` 恰好 3 条（`paper-1` 被两个项目共享，只登记一次），项目 id / 名称 / 时间戳 / `selectedId` 全部保留，`rw.projects.backup` 存在且在，`rw.projects.corrupt` 不存在；
3. 打开项目页：核心论文标题、作者缩写、关联论文数量都从注册表正确解析（`Deep Residual Learning` / `He` / `1 篇`），控制台无 error / warning。

验证结束后已清空该 dev 源下的 LocalStorage 并停止 dev server，不残留测试数据。

### 6.4 未验证项

- **进程级重启后数据仍在**：仍无桌面壳，无法验证（同 Phase 0 限制 2）。
- `referencePaper` / `unlinkPaper` 只有单测覆盖，没有浏览器路径：它们目前没有 UI 入口（见第八节），这是设计取舍而非遗漏。

## 七、验收标准对照

| #   | 标准                                                            | 状态 | 依据                                                                                       |
| --- | --------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------ |
| 1   | Schema 版本机制真实接入持久化流程                               | 通过 | 六.3 浏览器实测载荷含 `version: 2`；`loadProjects` 唯一入口                                |
| 2   | 旧数据迁移与失败保护有测试覆盖                                  | 通过 | `migrate.test.ts` 33 项 + `storage.test.ts` 14 项新增                                      |
| 3   | 全局论文身份与跨项目关联具备实际可调用的数据接口                | 通过 | `referencePaper` / `unlinkPaper` / `findPaperByExternalId`；单测覆盖跨项目共享与删除完整性 |
| 4   | 相关单元测试通过，原有功能没有已知回归                          | 通过 | 494/494 通过；61 项浏览器检查与 12 张截图零差异                                            |
| 5   | `npm run check` 与 `npm run build` 通过                         | 通过 | 命令 8、9，退出码均为 0                                                                    |
| 6   | 对涉及 UI 或存储的变化执行浏览器回归，并说明是否跑了完整 verify | 通过 | **完整跑了** `npm run verify`：61/61，见 6.3                                               |
| 7   | 变更文件清单、数据结构决策与已知限制得到记录                    | 通过 | 第三、四、五、八节                                                                         |

## 八、遗留问题与下一阶段前置条件

1. **加载失败不告知用户**。`Store` 快照里有 `issue`（四类原因可区分），但界面不显示任何提示——读不懂的数据会被隔离、备份，然后应用以空状态启动。这是刻意为"不重新设计 Phase 0 界面"让步。风险：用户可能以为项目被删了。建议在 Phase 2 用现成 `.banner` 样式加一条只读提示（一句话即可，不需要新组件）。
2. **论文注册表不回收**。删除项目不会清理只被它引用的论文。数据量级无关紧要（几百篇论文几 KB），且回收不可逆，因此本轮选择保留。若将来要有"论文库"视图，这些条目正好是它的初始内容。
3. **关联论文没有关系元数据**。`relatedPaperIds` 是纯 id 数组，没有 Phase 0 报告建议的 `relation`（前作/baseline/后续）与 `addedAt`。理由：本轮没有任何 UI 会设置它们，加进来就是无消费者的抽象。迁移机制已经就位，加字段只需一条 2→3 迁移。
4. **本地 PDF 内容哈希未实现**。身份匹配目前只认 DOI / arXiv id。接入阅读器时只需在 `findPaperByExternalId` 增加一条哈希分支、`Paper` 增加一个字段，外加一次迁移。
5. **`updatedAt` 仍是一字段两用**（元数据修改 + 侧栏"最近更新"）。本轮给 `linkPaper`/`unlinkPaper` 也盖了这个时间戳，使真正的项目活动能反映在侧栏，但没有拆成 `updatedAt` / `lastReadAt`——那要等阅读会话出现。
6. **作者的稳定标识**仍未解决，`authors` 依旧是自由文本数组。
7. **`.backup` 写盘是尽力而为**：配额满时备份会静默失败（此时迁移写回同样失败，`persisted: false` 会驱动既有横幅提示）。极端情况下原件仍在 `rw.projects`，没有丢。
8. **无版本恢复机制**：目录不是 Git 仓库，本轮没有初始化它。改动前的副本在 `.cache/phase1-backup/`（已被 `.gitignore` 覆盖，将来初始化仓库时不会被提交）。Phase 2 开始前建议先建立版本控制。
9. **Tauri 壳仍未接入**（本轮禁止事项），因此 `src-tauri/` 仍不存在。

## 九、本轮执行效率复盘

先说明口径：我拿不到本会话的 token 用量或账单数据，所以下面**不含任何 token 或费用估算**，只描述可观察的工作构成。

**有效开发（占比最高）**：新写 3 个领域模块（`normalize.ts` 9 行、`papers.ts` 142 行、`migrate.ts` 227 行）与 3 个测试文件（共 587 行），改造 6 个既有源文件。设计上的关键取舍只有三处：论文 id 沿用旧 id（换来免费确定性）、注册表与项目分离（换来单源、无副本）、论文不回收（换来不可逆操作的安全）。

**测试**：3 次 `npx vitest run` 全量运行（约 12 秒/次），1 次 `npm run check`，1 次 `npm run build`，1 次 `npm run verify`。另外用 `--reporter=json` 跑了一次以取逐文件项数。

**修复**：两次测试失败（20 项 + 17 项），一次 prettier 格式修正（11 个文件），机械且集中。

**重复/低效操作（如实列出）**：

1. 我对"搬动导出符号"的影响面估计不足，只 grep 了数据字段名（`corePaper` 等）而没有同时 grep 符号名（`normalizeName` / `authorCredit` / `MAX_NAME_LENGTH`），导致漏掉 3 个导入点，白跑了 1 次全量测试（约 12 秒 + 一轮修复）。正确做法是搬家后先 `tsc -b`（几秒、能一次报出全部坏导入），而不是直接跑测试。
2. 截图比对第一次写错了路径拼接（`$f` 已含目录前缀），多花了一次命令往返。
3. 一次 Python 内联脚本因 Windows 反斜杠转义在 bash 里写坏，改用不含反斜杠字面量的写法重跑。
4. 一次基于旧报告的假设错误：我按 `npm run test` 的**文件名**推断会失败的文件，实际首次失败还包含 `projectsStore.test.ts`（因为它的 no-op 用例间接走了 rename）。

**可以省下但没省的部分**：我完整跑了 `npm run verify` 而不是只跑受影响场景。理由是：本轮动的是持久化，而 verify 里恰好有"刷新后 7 个项目还在"这一条端到端证据，且 12 张截图的逐字节比对能一次性给出"界面零回归"的结论——这两项加起来比任何抽样都便宜。

**没有做的事**（避免无谓消耗）：没有通读全工程目录、没有为凑数写重复断言、没有在通过后再发起额外的全面审计。
