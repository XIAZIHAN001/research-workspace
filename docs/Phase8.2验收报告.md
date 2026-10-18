# Phase 8.2 验收报告：关系语义校准、模型输出约束与真实响应回放

生成日期：2026-10-18
分支：`phase8.2-relation-semantics`
基线：`018c936`（Phase 8.1 完成提交）

## 一、结论

本轮完成了 Phase 8.1 报告列出的四项工程修正，并保持 Phase 8 的全部安全边界：

1. **关系语义被拆开。** `prerequisite` 现在只表示学习前置；新增 `definition`（定义依赖）、`approximates`（近似实现）、`replaces`（替代/对照）。定义、近似、替代不再被塞进前置或扩展，也不进入学习路径。
2. **模型输出被保守校准。** 知识分析路径显式使用 `temperature: 0`；提示词写清了六种关系的判据；概念名不是原文逐字术语时，`direct` 会被降为 `inferred` 并给出提示；上下文不足 1000 字时最多保留 3 个新概念和 3 条新关系，并明确允许模型不生成建议。
3. **同名不再等于同一概念。** 服务端、领域合并与批处理映射三层都改成“必须唯一匹配才复用”，同名多义时跳过并说明原因，不自动合并。Phase 8.1 的真实输出在回放中通过别名正确复用了 3 个已有英文概念，只新增 3 个节点。
4. **真实输出可以零费用回放。** 12 次 Phase 8.1 真实响应全部通过当前校验器回放（0 次网络调用）；其中 3 份脱敏夹具驱动浏览器端完整 UI 验收，29/29 通过，覆盖 6 概念/10 关系、长英文名、长中文名、双引文关系、无效引文丢弃、采纳/忽略、连续两次分析不产生重复节点、深色与窄窗口、跳回原文再返回。

全量校验：`npm run check` 通过，61 个测试文件、1291 个测试；构建通过。相关浏览器回归全部通过：`verify:knowledge-ai` 48/48、`verify:knowledge-real` 16/16、`verify:graph` 17/17、`verify:backup` 39/39。

**本轮没有调用任何真实 AI API，没有远程 Git 写入，没有进入 Phase 9。**

## 二、本轮边界与禁止项

| 约束 | 执行情况 |
| --- | --- |
| 只做离线工程修正，不调用真实 AI API | 达成。所有 AI 调用都指向进程内 mock 或回放提供方；浏览器验收在打开页面前校验 `online: false` 与本进程实例 id。 |
| 不覆盖 Phase 8 / 8.1 历史证据 | 达成。新截图写入 `docs/screenshots-phase8.2/`；未修改 `docs/screenshots-phase8/`、`docs/screenshots-phase7/` 中已提交的运行目录。 |
| 不自动重新分类用户已确认的关系 | 达成。语义提示只读；必须由读者点击“改为「…」”才调用 `updateRelationKind`。 |
| 不得仅凭同名自动合并全局概念 | 达成。同名/同别名对应多个概念时，服务端、`mergeSuggestions`、`buildSuggestionBatch` 都跳过并说明原因。 |
| 只保存必要、脱敏的夹具，保留 CC BY 署名 | 达成。3 份夹具只保留复现所需段落与模型输出字段；附论文标题、作者、arXiv 号、CC BY 4.0 链接。 |
| 不远程写 Git，不自动进入 Phase 9 | 达成。本轮只做本地提交，报告到本节为止。 |

## 三、基线与变更范围

Phase 8.2 开始前的基线：

- `npm run check`：59 个测试文件、1254 个测试通过；
- Phase 8 / 8.1 的协议、备份与浏览器验收均已有记录；
- 关系中只有 `prerequisite` / `extends` / `related` 三种类型。

本轮新增/修改的核心文件：

| 文件 | 作用 |
| --- | --- |
| `src/domain/knowledge.ts` | 六种关系类型、方向说明、语义提示、唯一匹配 helper、歧义安全合并 |
| `src/features/knowledge/RelationHint.tsx` | 只读语义提示与一次显式改类型按钮 |
| `src/features/knowledge/ConceptDetail.tsx` | “定义、近似与替代”分区；前置语义说明；提示接入 |
| `src/features/knowledge/ConceptGraph.tsx` | 全类型图例、箭头规则、边标题 |
| `src/features/reader/KnowledgePanel.tsx` | 真实输出中的提示、复用关系的稳定显示 |
| `src/features/reader/useKnowledgeAnalysis.ts` | 歧义名称跳过、别名不遮蔽已有概念 |
| `server/knowledge.mjs` | k2 规则、六类提示词、名称校准、短上下文上限、歧义诊断 |
| `server/providers/deepseek.mjs` | 每调用 temperature，知识路径显式 0 |
| `server/providers/mock.mjs` | 新类型、权威名称、短上下文、复用、歧义场景 |
| `server/replay.test.mjs` | 真实响应离线回放测试 |
| `scripts/verify/knowledge-replay.mjs` | 真实输出浏览器回放验收 |
| `scripts/verify/replay-all.mjs` | 12 次真实响应零费用回放 |
| `server/providers/fixtures/phase8.1/` | 3 份脱敏夹具 |

数据 schema 没有升级：知识仍是 `version: 1`，新增的是关系 `kind` 的取值与可选诊断字段；旧记录、旧备份不需要迁移。

## 四、Task A：关系语义修正

### 4.1 六种关系及判据

| kind | 含义 | 方向 | 进入学习路径 |
| --- | --- | --- | --- |
| `prerequisite` | 读者理解 A 之前必须先理解 B，仅表示学习顺序 | A → B | 是（仅已确认） |
| `definition` | A 的定义或核心刻画依赖 B | A → B | 否 |
| `approximates` | A 是 B 的近似实现、近似计算或重采样 | A → B | 否 |
| `replaces` | A 替代、取代或作为 B 的对照方案 | A → B | 否 |
| `extends` | A 在 B 之上增加能力（真正的扩展） | A → B | 否 |
| `related` | 无方向的一般关联或对比 | 无方向 | 否 |

提示词明确要求：同段出现、定义包含、互为对照都不构成前置；近似/实现不能写成扩展；替代/对照不能写成扩展。

### 4.2 用户已确认的关系不会被自动改类

- `relationSemanticHint()` 只读取 `rationale` / `note`，返回建议，不修改记录；
- `RelationHint` 仅在读者点击按钮后调用 `updateRelationKind`；
- `updateRelationKind` 仍执行重复关系与前置环检查；
- 新增测试验证：计算提示后 `kind` 仍为 `prerequisite`；只有显式调用后才变为 `definition`，且 `status` 保持 `confirmed`。

### 4.3 三个指定反例均已进入测试

| 反例 | 实际 kind | 提示 | 测试 |
| --- | --- | --- | --- |
| DLM → Shared canvas（定义写成前置） | `prerequisite` | 建议 `definition` | `knowledgePhase8.test.ts` |
| Complementary representations → Single primary representation（替代写成扩展） | `extends` | 建议 `replaces` | 同上；回放 05 的真实输出也触发了该提示 |
| Importance resampling → Q_β（近似写成扩展） | `extends` | 建议 `approximates` | 同上 |
| 仅同段出现 | `prerequisite` | 建议 `related`，提示“同一段出现不足以构成前置” | 同上 |

反例测试断言的是规则和不变式（学习路径只含 `prerequisite`、学术关系不形成前置环、提示不改数据），不是某个模型在某一轮的固定答案。

### 4.4 界面

- 关系详情新增“定义、近似与替代”分区，显示类型、方向、依据强度、解释、出处、改类型与删除；
- 前置知识区注明“只表示学习顺序；定义、近似、替代关系不是前置”；
- 图谱图例按实际出现的类型生成；`related` 无箭头，其余有箭头；每条边有 `from → to · 类型 · 状态` 的标题；
- 深色/浅色下六种边型均有独立样式（实线、虚线、点线、点划线等）。

## 五、Task B：模型输出校准

### 5.1 只对知识分析使用 temperature 0

DeepSeek 适配器改为接受每次调用的 `temperature`；默认仍是 0.3，问答与难点分析不变；`/api/ai/knowledge` 显式传 `0`。

这里不宣称“完全确定性”：温度 0 只去掉主动采样噪声，批量调度与硬件仍可能带来差异。验收断言的是参数被正确发送，以及同一夹具的离线回放可重复。

### 5.2 提示词

`KNOWLEDGE_SYSTEM` 现在包含：

- 六种关系的严格判据与反例；
- 方向映射（五种 `from-first`，`related` 为 `undirected`）；
- 同一段出现、定义包含、对照关系都不构成前置；
- 已有概念必须复用列表中的名字；
- 模型自己归纳的名称可以被接受，但会被保守标为推断；
- 上下文少于 1000 字时最多 3 个概念/3 条关系，可以少给或不给；
- 逐字引文只证明文字存在，不证明学术判断成立。

### 5.3 概念名逐字校准

- 服务端检查概念名或任分别名是否出现在**本次发送的段落**中；
- 不在原文中且声称 `direct` 的概念，降为 `inferred` 并给出警告；
- 非 `direct` 的非逐字名称保留原依据类型，但提示“是模型归纳的名称”；
- 已有概念不受此规则影响（名称来自读者，不来自本次模型）；
- 诊断字段 `nameNotVerbatim` 记录数量。

真实回放中，05 的 6 个中文名有 2 个被标记为非逐字术语，依据按规则降级；这比 Phase 8.1 一律显示 `direct` 更保守。

### 5.4 短上下文上限与允许拒绝

- 上下文合计 `< 1000` 字时：最多保留 3 个新概念、3 条新关系；
- 超出的条目以 `concept-limit` / `relation-limit` 拒绝，原因写明“上下文较少时”；
- `diagnostics.smallContext`、`smallContextLimited` 记录状态；
- 提示词明确允许返回空建议并设置 `groundedInText: false`，界面已有对应提示。

用 Phase 8.1 的 `10-boundary-minimal` 真实响应（531 字上下文）回放：6 个概念降为 3 个，5 条关系降为 2 条（部分关系因端点被裁掉而无法成立）。这是本轮的预期行为。

### 5.5 `groundedInText` 不是事实证明

- 提示词说明引文只证明文字存在；
- 界面继续显示“模型自己认为提供的原文不足以支撑完整分析；这是它的自述，不是被核对过的事实”；
- 结果区固定说明“逐字引文只证明这些文字确实来自本次发送的原文，不证明关系在学术上成立；是否采纳由你决定”。

## 六、Task C：已有概念身份与复用

### 6.1 匹配规则

名称归一化沿用领域函数：折叠空白、大小写不敏感；名称与别名都参与匹配。只有**恰好一个**已有概念匹配时才自动复用；零个则新建，多个则跳过。

三层都执行这一规则：

1. **服务端**：`existingByKey` 从“键 → 第一个名称”改为“键 → 名称集合”；歧义键被记录，相关概念与关系拒绝，诊断 `ambiguousExistingNames` / `ambiguousConceptsSkipped` / `ambiguousRelationsSkipped`；
2. **领域合并** `mergeSuggestions`：同一批建议内也维护名称集合；歧义概念不选择、不新增，关系与出处一并跳过并写入 `report.skipped`；
3. **批处理** `buildSuggestionBatch`：歧义名称不创建新节点；新概念的别名不会遮蔽读者已有的不同概念。

### 6.2 真实输出中的复用证据

回放 05（`05-main-ts-method`）时，模型给出 6 个中文/中英混合概念；其中 3 个通过别名匹配到 Phase 8.1 回放 11 已建立的英文概念：

- `互补表示（complementary representations）` → `Complementary Representations`
- `双塔架构（dual-tower architecture）` → `Dual-Tower Architecture`
- `归一化延迟嵌入（normalized delay embeddings）` → `Normalized Delay Embedding`

结果：知识库从 8 个概念变为 11 个，而不是 14 个；没有出现中文重复节点，已有英文名称保持不变。浏览器回放明确断言了这一点。

### 6.3 重复运行

对 05 连续执行两次同一分析：

- 概念节点 11 → 11，没有重复；
- 关系 16 → 17：唯一增加的是读者上一轮明确“忽略”的那一条（忽略会删除建议记录，重新分析可以再次提出）；其余已存在关系均被跳过；
- 界面显示“有 N 条内容没有加入知识库（重复、循环或引用不成立）”。

### 6.4 其他身份/来源边界

- 模型返回的 `id` / `status` / `confirmed` / `doi` / `arXiv` / `paperId` 继续被计数并忽略；
- 引文页码必须与段落记录一致，否则拒绝；
- 出处绑定 `paperId + pdfSha256`；PDF 被替换后旧出处保留但不能跳转（既有测试与浏览器回归均通过）；
- 同名不同义不会自动合并（新增服务端、领域与 HTTP 端到端用例）。

## 七、Task D：Phase 8.1 真实响应回放

### 7.1 夹具

提交了 3 份夹具，均位于 `server/providers/fixtures/phase8.1/`：

| 文件 | 场景 | 内容 | 用途 |
| --- | --- | --- | --- |
| `11-boundary-existing.json` | 已有概念/关系 | 6 概念、10 关系、25 条证据；英文长名；3 条关系有双引文 | 多关系、长英文名、已有概念端点 |
| `05-main-ts-method.json` | TSLM 方法段 | 6 概念、8 关系；长中文名；1 条 `quote-shape` 拒绝 | 长中文名、无效引文丢弃、别名复用 |
| `12-boundary-repeat.json` | DLM 重复分析 | 6 概念、7 关系；1 条关系有两个同段引文 | 双引文关系 UI |

夹具不是原始 HTTP 报文：Phase 8.1 保存的是**服务端已校验的响应**，没有保存模型原始文本。夹具中的概念、关系、解释与引文均逐字复制自该响应；证据只保留 `passageId` 与 `quote`（页码由服务端按段落填入）。05 的已保存拒绝码用一条空引文复现，使“丢弃无效引文”的界面路径仍被覆盖。每份夹具都注明这一推导关系。

署名信息：论文标题、作者、arXiv 号、CC BY 4.0 与许可链接。没有 API Key、代理、实例 id 或请求日志。

### 7.2 12 次真实响应全部零费用回放

`npm run verify:knowledge-replay-all` 读取 `.cache/verify/phase8.1-live/live/responses/` 的全部 12 份响应，按原始请求重新执行当前 k2 校验：

| 响应 | 上下文 | 概念 | 关系 | 证据 | 备注 |
| --- | ---: | ---: | ---: | ---: | --- |
| 01-smoke-dlm-definition | 2602 | 6→6 | 6→6 | 17 | |
| 02-main-dlm-definition | 1838 | 6→6 | 6→6 | 13 | |
| 03-main-dlm-method | 2822 | 6→6 | 6→6 | 17 | |
| 04-main-ts-definition | 2434 | 6→6 | 6→6 | 14 | |
| 05-main-ts-method | 2811 | 6→6 | 8→8 | 18 | |
| 06-boundary-adjacent | 2776 | 6→6 | 6→6 | 16 | |
| 07-boundary-short | 1186 | 6→6 | 6→6 | 15 | |
| 08-boundary-formula | 1869 | 6→6 | 6→6 | 13 | |
| 09-boundary-multicolumn | 2176 | 5→5 | 6→6 | 14 | |
| 10-boundary-minimal | 531 | 6→3 | 5→2 | 9 | 触发短上下文上限 |
| 11-boundary-existing | 2434 | 6→6 | 10→10 | 25 | |
| 12-boundary-repeat | 2602 | 6→6 | 7→7 | 19 | |

不变式检查：0 个问题。包括证据必须指向本次发送的段落、页码与段落记录一致、小上下文不得超过 3/3、同一回复内不得有重复关系。

### 7.3 浏览器回放 `verify:knowledge-replay`：29/29

回放服务由真实 `createAiServer` + 真实校验器 + 进程内 replay provider 组成，`online: false`；浏览器经由 Vite 代理访问，未发出任何外部请求。

覆盖与结果：

- 11：6 概念/10 关系；英文长名（`Normalized Delay Embedding`、`Dual-Tower Architecture`）；已有 TSLM/LM 端点复用；采纳概念与关系；跳回原文再返回保持选中；深色与 900px 窄窗口无横向溢出；
- 05：6 概念/8 关系；长中文名；通过别名复用 3 个英文概念（8→11 个节点）；`quote-shape` 无效引文被丢弃且不进入证据；忽略一条关系后仅该行消失；
- 重复分析：概念 11→11，无重复节点；界面列出被跳过的重复内容；
- 12：6 概念/7 关系；一条关系显示两条已验证引文；来源、支持标签与模型解释同时存在；
- 离线：所有浏览器请求只到预览源或本地回放服务；控制台无错误/警告。

截图与报告：`docs/screenshots-phase8.2/2026-10-18T06-03-16-replay/`（7 张 PNG + `report.json`）。

## 八、Task E：测试、构建与回归

### 8.1 全量

```bash
npm run check
```

结果：类型检查、ESLint、Prettier 全部通过；**61 个测试文件、1291 个测试通过**（基线 59 文件/1254 测试）。新增 37 个测试，集中在：

- 六种关系类型、方向、学习路径排除；
- 三个指定语义反例与同段出现反例；
- 提示不改数据、显式改类型才生效；
- 名称逐字校准与别名命中；
- 短上下文上限；
- 同名/同别名歧义（服务端、领域、批处理）；
- 回放夹具的计数、双引文、拒绝路径与脱敏检查；
- 新关系类型在备份中的读写；
- DeepSeek 每次调用 temperature 与越界回退。

### 8.2 构建

```bash
npm run build
```

通过。构建产物仅用于本地预览验收。

### 8.3 浏览器回归

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `npm run verify:knowledge-replay` | 29/29 | 本轮回放验收 |
| `npm run verify:knowledge-ai` | 48/48 | Phase 8 完整链路（旧备份 → 恢复 → 分析 → 采纳 → 导出 → 再恢复） |
| `npm run verify:knowledge-real` | 16/16 | 真实论文、跨论文、跨项目、替换文件 |
| `npm run verify:graph` | 17/17 | 图谱、同名建新概念、删除项目保留知识、深色/窄窗 |
| `npm run verify:backup` | 39/39 | Phase 7 备份往返、冲突、缺失文件、写入失败回滚 |

所有回归均在离线 mock/回放服务上运行，并在打开浏览器前校验实例 id 与 `online: false`。

### 8.4 兼容性

- 知识 schema 仍为 `version: 1`；三种旧关系类型与旧记录无需迁移；
- 新增 `definition` / `approximates` / `replaces` 可被 `parseKnowledgeState` 读取并写入备份；
- Phase 7 形状的备份（无 Phase 8 字段）继续可恢复；`verify:knowledge-ai` 的旧备份场景通过；
- 已确认关系的类型、方向、出处与学习路径在恢复后保持不变；
- 新类型不会使旧客户端“猜测”：旧版本会把未知 kind 视为无效并拒绝该条，而不是改动为 `prerequisite`。

## 九、本轮发现并修复的缺陷

1. **空 summary 阻止已有概念复用。** 服务端在校验 summary 之后才判断“是否已有概念”，模型给已有概念返回空 summary 时整条被拒绝，无法复用。现在已有概念的 summary 不参与校验、不覆盖读者内容。
2. **跨语言复用后关系行消失。** 模型用中文名引用已有英文概念，合并时正确复用了概念，但界面按模型名称反查 id 失败，关系建议行不可见。现在先按解释指纹匹配已存关系，再用存储的一端名称显示。
3. **歧义名称曾被静默归到第一个概念。** 旧 `existingByKey` 与 `mergeSuggestions.byName` 都是 first-wins；现在改为集合，多个匹配即跳过。
4. **短上下文没有硬上限。** 旧提示词只说“宁少勿多”，531 字上下文仍生成 6 概念/5 关系；现在服务端强制 3/3。
5. **非逐字概念名仍可声称 direct。** 现在降为 inferred 并提示。

## 十、已知限制

1. **回放不是原始字节。** 夹具由已校验响应重建，缺少模型原始 prose envelope 与被丢弃条目的完整原文；05 的拒绝条目按拒绝码复现。报告与夹具均标明。
2. **浏览器回放的上下文由应用自己的检索计划决定。** 11 的多页引文有一部分不在本次发送的段落里，回放会丢弃这些引文（不伪造 passage id），因此部分关系的依据被降级。这是应用本地检索与 Phase 8.1 手工请求之间的真实差异，不是回放失败。
3. **温度 0 不等于确定性。** 同一真实模型在服务端批量调度下仍可能有差异；本轮只保证参数与离线回放可重复。
4. **语义提示是短语规则。** 它只对解释文本中的明确线索给建议，可能漏掉改写过的表述；提示永远不自动改类。
5. **短上下文上限按新概念计数。** 已有概念的新出处不受 3 条上限影响；这是有意的，因为复用不增加节点。
6. **未验证更复杂的关系组合。** 例如同一对概念同时存在定义、近似、替代三类关系时，图例会画出多条边；本轮有渲染与重复键测试，但没有大规模视觉评估。

## 十一、验收标准逐条对照

| 要求 | 结果 | 证据 |
| --- | --- | --- |
| 修正定义关系误判为前置 | 达成 | `definition` 类型、提示词、反例测试、回放 05 提示 |
| 修正实现/近似误判为扩展 | 达成 | `approximates`、反例测试 |
| 修正替代/对照误判为扩展 | 达成 | `replaces`、反例测试、回放 05 真实提示 |
| 同段出现不得成为前置 | 达成 | `CO_OCCURRENCE_CUES`、提示与测试 |
| 已确认关系不被自动改类 | 达成 | `RelationHint` 只读 + 显式按钮 + 领域测试 |
| 知识路径 temperature 0 | 达成 | `server/index.mjs`、DeepSeek 参数测试 |
| 提示词改进 | 达成 | `KNOWLEDGE_SYSTEM` 六类判据、方向、短上下文 |
| 概念名非逐字 → 保守标记/提示 | 达成 | 名称校准、`nameNotVerbatim`、真实回放 |
| 极少上下文限制数量并允许拒绝 | 达成 | 3/3 上限、空建议测试、531 字回放 |
| 保留逐字引文校验与人工确认 | 达成 | 既有测试与浏览器回归全部通过 |
| `groundedInText` 不作为事实证明 | 达成 | 提示词与界面固定说明 |
| matchedExisting 精确名/别名/大小写 | 达成 | 服务端/领域/HTTP 用例 |
| 同名不同义不自动合并 | 达成 | 集合匹配、歧义诊断、合并跳过测试 |
| DOI/论文来源/证据冲突 | 达成 | 标识字段忽略、页码与段落校验、替换 PDF 不能跳转 |
| 重复运行不产生无意义重复节点 | 达成 | 回放重复分析 11→11 |
| 12 次真实请求/响应零费用回放 | 达成 | `verify:knowledge-replay-all` 12/12，0 问题 |
| 真实输出 UI 覆盖 5–6 概念、5–10 关系 | 达成 | 11: 6/10，05: 6/8，12: 6/7 |
| 长技术名、双引文关系 | 达成 | 11 英文长名；12 双引文 |
| 无效引文丢弃 UI | 达成 | 05 `quote-shape` |
| 采纳/拒绝 | 达成 | 11 采纳概念与关系；05 忽略关系 |
| 深色、窄窗口 | 达成 | 回放 11 深色 + 900px |
| 跳回原文并返回 | 达成 | 回放 11 证据跳转与返回 |
| 不覆盖 Phase 8/8.1 证据 | 达成 | 新目录 `docs/screenshots-phase8.2/` |
| 旧 schema、已确认关系、Phase 7 备份兼容 | 达成 | 全量测试 + `verify:knowledge-ai` / `verify:backup` |
| 无真实 API、无远程 Git、无 Phase 9 | 达成 | 见第二节与停止声明 |

## 十二、Git 状态与复现

本轮提交在本地分支 `phase8.2-relation-semantics`，不推送远程。提交前工作区包含：

- 领域/服务/界面与测试修改（见第三节）；
- 3 份脱敏夹具；
- 回放脚本与 npm 命令；
- `docs/screenshots-phase8.2/2026-10-18T06-03-16-replay/`。

复现命令（全部离线）：

```bash
npm run check
npm run verify:knowledge-replay-all
npm run verify:knowledge-replay
npm run verify:knowledge-ai
npm run verify:knowledge-real
npm run verify:graph
npm run verify:backup
```

回放脚本会在 `.cache/` 下写入回放报告；浏览器截图与 `report.json` 写入 `docs/screenshots-phase8.2/`。运行前若环境里导出了 `AI_PROVIDER=deepseek` 或 `DEEPSEEK_API_KEY`，验收脚本会拒绝启动。

## 十三、停止声明

本轮只完成 Phase 8.2 的离线工程修正、真实响应回放与验收报告：

- 未调用任何真实 AI API；
- 未进行远程 Git 写入；
- 未自动进入 Phase 9；
- 未覆盖 Phase 8 / Phase 8.1 的历史证据。

Phase 8.2 到此结束。
