# Phase 6 验收报告：科研知识依赖与跨论文概念关联

日期：2026-10-17。工作目录：`D:\论文阅读解构项目`。分支：`phase6-knowledge-graph`（从 Phase 5 已验收提交 `5ce4c15` 建）。

---

## 一、结论

1. **知识属于项目，不是另一套工作区。** 项目页多了一个「知识」区，与「文献」并列；概念列表、关系图、概念详情都在这一页里。
2. **概念与它在论文中的一次出现是两条记录。** 概念有稳定的 ID、可跨论文；每一条 `ConceptEvidence` 带着文件哈希、页码、引文与上下文——这就是「FFT 是全局概念，而它在某篇论文里的用途是一条带出处的证据」在数据层的落地。
3. **同名不合并。** 从阅读记录整理出的候选，与已有概念同名时只提示「已有同名概念，不会自动合并」；合并是一个需要读者点击的独立动作。
4. **AI 建议与读者确认分开。** 建议进来时被 reducer 强制标成 `suggested` + `origin: 'ai'`，无论调用方写了什么；`prerequisitesOf` 这类读图函数只看确认过的关系。
5. **Gate 0 已通过。** 离线验收现在验证的是**页面真正会走的路径**：经过预览代理读到 `provider: mock` **且** `instanceId` 等于本次启动的那个进程；一个模拟付费服务在三条路径上都被证明「即使存在也收不到任何业务请求」。
6. 回归：`check` 1128 项、`build`、`verify:guard` 10 项、`verify:graph` 17 项（新）、`verify:ai` 54、`verify:immersive` 33、`verify:real` 28、`verify:annotations` 26、`verify:reader` 27，全绿。

---

## 二、Gate 0：把「离线」变成一条可验证的链路

Phase 5 的事故是：验收脚本启动预览服务器时漏传 `AI_PORT`，代理回退到默认端口，那里正好有一个付费服务在跑，两次提问被它回答并计费。当时的护栏只问了「我启动的服务是不是 mock」，从没问过「页面到底在和谁说话」。

### 2.1 本轮补上的四件事

| 要求                    | 落实                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 离线端口必须显式指定    | 三个离线套件都显式设置 `AI_PORT`；`startPreview` 把 `AI_PORT` 传进预览进程的 env                                                 |
| 离线服务锁定 Mock       | `--offline` 覆盖 `AI_PROVIDER` 与密钥（Phase 4.2 已有，本轮沿用并复核）                                                          |
| **经过代理**验证身份    | 新增 `scripts/verify/offline.mjs`：`probeProxy(origin)` 读 `origin + /api/ai/health`，必须 `provider==='mock' && online===false` |
| 验证是同一次运行的实例  | health 新增 `instanceId`（每个进程一个 UUID）；`requireOfflineProxy(origin, { expectedInstance })` 不匹配即 `exit 4`             |
| 端口占用/身份不符即中止 | `refuseIfPortTaken` + 上述检查，全部在浏览器打开之前                                                                             |
| 自动化验收无隐式重试    | 服务本身不重试；`guard-probe` 从 mock 自己的访问日志里数调用次数，断言一次请求恰好一次调用                                       |
| 在线/离线入口完全分开   | `ai:serve:offline` / `ai:serve:online` / `verify:live`（真实）与离线套件互不相干                                                 |

### 2.2 反例测试：`npm run verify:guard`（10 项）

脚本自己起一个**模拟付费服务**（health 报 `deepseek`/`online: true`，并记录每一条请求），然后：

| 场景                                         | 断言                                                                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 预览被指到付费服务（复现 Phase 5 的形状） | `probeProxy` 返回 `online-provider`；子进程 `exit 4`；付费服务**收到 0 条业务请求**                                                           |
| B. 预览完全不带 `AI_PORT`（真正的默认回退）  | 在浏览器打开之前就被拒绝                                                                                                                      |
| C. 正确接线                                  | 经过代理读到本次 mock 的 `instanceId`；一次 `/api/ai/ask` 得到 200 + `provider: mock`；付费服务**没有新增请求**；mock 侧恰好 **1 次**上游调用 |
| D. 端口上是另一个 mock（不同 `instanceId`）  | 仍然 `exit 4` —— 「是 mock」不等于「是这次的 mock」                                                                                           |

另外 `scripts/verify/offline.test.mjs` 用真实 socket 单测 `probeProxy` 的六种回答（mock / deepseek / 无实例号 / 5xx / 非 JSON / 连不上）。

> 说明：场景 B 在没有 `AI_PORT` 时确实会访问默认端口 8787 一次 `GET /health`。这台机器上 8787 仍是 Phase 4.1 留下的付费服务，所以这一步本身是一次真实探测——但只是 health，不是业务请求，也不产生费用。**建议停掉那个进程。**

---

## 三、Task A：概念与证据的数据模型

`src/domain/knowledge.ts`：

```ts
Concept        { id, name, aliases[], summary, origin: 'user'|'ai', status: 'confirmed'|'suggested',
                 projectIds[], createdAt, updatedAt }
ConceptEvidence{ id, conceptId, paperId, pdfSha256, page, quote, prefix, suffix, rects[],
                 source: 'annotation'|'difficulty'|'selection'|'manual'|'ai',
                 annotationId?, suggestionId?, note, createdAt }
ConceptRelation{ id, from, to, kind: 'prerequisite'|'related'|'extends',
                 status, origin, note, createdAt, updatedAt }
```

**方向是写死在一处的**，不在使用点各自解释：

- `prerequisite`：要理解 `from`，需要先理解 `to`（KZG —prerequisite→ 双线性配对）；
- `extends`：`from` 建立在 `to` 之上；
- `related`：无方向。

**证据的身份**：`pdfSha256` 与页面矩形一起保存。它不是装饰——`isStaleEvidence(evidence, paper.pdf.sha256)` 决定这条出处还能不能跳回原文。论文换了文件，旧证据保留、标注「来自另一个文件版本」、按钮禁用，而不是把人带到一个错误的位置。

**不自动合并**：`mergeConcepts` 只由读者触发；`createConcept` 从不按名字去重。UI 里同名时提示「已有同名概念，不会自动合并」。

**确认过的关系不会被覆盖**：`withPageRecord` 式的批量写入在这个域里不存在；`suggestions/add` 只**追加** `suggested` 记录，且强制把 `status`/`origin` 改写为建议值；已确认的行不会被同 id 之外的东西碰到。

---

## 四、Task B：从阅读记录生成概念候选

`candidatesFromDifficulties(pdfSha256s)`（`useKnowledgeApi`）：

- 读 **Phase 5 已经缓存的难点分析**（`rw.difficulties`），**不重新解析 PDF，也不调用模型**；
- 按概念名归并建议，每个候选带上它的原文出处（页码、引文、矩形、来源 id）；
- 与已有概念同名时标出 `possibleDuplicates`，UI 只提示、不合并；
- **读者点「添加为待确认概念」才会写入**：`status: 'suggested'`、`origin: 'ai'`，出处一并写入。

这一步把 Phase 5 的产物接进了知识层，成本为零，也符合「先复用现有数据」。

---

## 五、Task C / D：知识视图与依赖导航

### 5.1 两个呈现，一份数据

- **列表**：名称、简短概述、`前置 N · 出处 M`、状态徽章；搜索按名称/概述/别名过滤。
- **关系图**：分层布局——一个概念放在它在本项目内最深的前置知识的右一列，**左到右就是依赖顺序**。只有确认过的 `prerequisite` 参与分层；建议的关系画成虚线、半透明，不改变布局。

两者都读同一个 `conceptsInProject(state, projectId)`，浏览器验收断言「2 个节点、1 条边」与列表一致。

### 5.2 概念详情

顺序按读者需要排：它是什么 → 前置知识 → 被谁依赖 → 相关与扩展 → 论文与出处。

- 前置/相关都是可点的概念链接，能一路走下去（`KZG → 配对 → …`）；
- 每条出处显示论文、页码、引文、来源（你的笔记 / 难点标注 / 手动）；「打开原文」调用阅读器的 `focus`，跳到该页并用 Phase 3 的保守匹配把这句话标出来——**找不到就说找不到，不猜位置**；
- 「从笔记里添加出处」把本项目的批注挂到概念上（这就是「将新的论文原文关联至已有概念」）；
- 关系可以手动加、删；删除一条关系只删那条关系（有测试）。

### 5.3 从原文进入概念

难点卡片新增「存为概念」：把这条建议的名称、通俗解释、原文锚点一次写成 `suggested` 概念 + 证据，项目页的「知识」里立刻可见。浏览器验收走的就是这条路：读一页 → 点标记 → 存为概念 → 项目页看到它 → 打开出处回到原文。

---

## 六、Task E：数据与交互安全

- **独立数据层**：`rw.knowledge`（版本 1）+ `rw.knowledge.corrupt` 备份槽；`rw.projects`、批注、难点缓存一律不碰。
- **稳定 ID**：概念/证据/关系各用 `makeId()`；关系与证据由动作携带 id，reducer 是纯函数。
- **存储失败有提示**：`persisted === false` 时界面顶部写明「这次改动没有保存到本地存储」。
- **不自动丢弃确认过的内容**：读取时只丢「这一版读不懂的条目」，并在丢弃前把原文复制到备份槽；备份槽已有一份不同的内容时**不覆盖**，此时整轮禁止写入（`writesBlocked`），界面照实说明。有测试。
- **删除项目不删知识**：`project/detach` 只把 projectId 从概念上摘掉，概念、出处、关系全部保留（浏览器验收：删项目后 3 个概念仍在，且都不再指向任何项目）。
- **PDF 替换**：证据带 `pdfSha256`，不匹配即标 stale 并禁用跳转。
- **删除关系不连带**：`deleteRelation` 只过滤关系数组，有测试。

---

## 七、Mock 建议的安全边界

- 本轮的「建议」**全部来自本地规则**（缺点缓存的整理），没有新增模型调用；服务端新增的任何 route 都没有（知识层完全在浏览器侧）。
- 唯一的模型交互仍是 Phase 5 的难点分析，走原有离线/在线边界。
- 浏览器验收全程跑在 `--offline` 服务上，并在打开浏览器前校验了**经过代理**的 provider 与实例 id；报告里带 `instanceId`。

---

## 八、浏览器验收与截图

`npm run verify:graph`（新，17 项），截图在 `docs/screenshots-phase6/<时间戳>-graph/`：

| 检查                                      | 结果                                  |
| ----------------------------------------- | ------------------------------------- |
| 读一页后，难点建议成为概念候选的源头      | 3 个标记                              |
| 难点 → 概念（名称、待确认、AI 提出）      | 通过                                  |
| 出处 → 打开原文并标出被引用的那句话       | 通过（`01-evidence-jump.png`）        |
| 确认概念                                  | 徽章消失                              |
| 概念 A 的前置 = 概念 B；B 的「被依赖」= A | 双向                                  |
| 关系图的节点/边数与列表一致               | 2 节点 / 1 边（`02-graph.png`）       |
| 同名不合并                                | 3 个概念                              |
| 删除关系后两个概念都还在                  | 通过                                  |
| 深色主题下不溢出                          | 宽度 640px（`03-knowledge-dark.png`） |
| 900px 窗口下重排、横向溢出 0              | 通过（`04-knowledge-narrow.png`）     |
| 删除项目后知识仍在、且不再指向该项目      | 3 个概念，全部 unlinked               |
| 本次服务是离线 mock；难点分析只打到它     | 通过                                  |
| 控制台无非预期错误                        | 0                                     |

---

## 九、测试

| 范围                     | 数量                                                      |
| ------------------------ | --------------------------------------------------------- |
| `npm run check`          | **48 文件 / 1128 项**（Phase 5 为 1080，+48）             |
| `knowledge.test.ts`      | 16 项（同名不合并、方向、环、建议、项目摘除）             |
| `knowledgeStore.test.ts` | 9 项（往返、损坏、部分可读、备份不覆盖、写失败）          |
| `KnowledgeView.test.tsx` | 17 项（列表/图一致、关系增删、建议、出处、stale、持久化） |
| `offline.test.mjs`       | 6 项（`probeProxy` 的六种回答）                           |
| `verify:guard`           | 10 项（反例测试）                                         |

浏览器：`verify:graph` 17、`verify:ai` 54、`verify:immersive` 33、`verify:real` 28、`verify:annotations` 26、`verify:reader` 27。

---

## 十、本轮发现并修复的缺陷

1. **预览代理的终点从没被核对过**（Gate 0 的由来）。修复：`instanceId` + 经过代理的身份校验 + 反例测试。
2. **`fetch` 拒绝 4190 端口**：它在 Fetch 规范的 blocked-port 列表里，`curl` 能通、`fetch` 一律 `bad port`。表现为「预览服务器没启动」。换成 4175 并写明原因。
3. **验收脚本把「清空成白底」当成「渲染完成」**：`verify:immersive` 的原始模式检查偶发失败——画布刚清成白、墨还没画上去时也满足「纸是白的」。修复：所有纸张等待都同时要求红色块已经画出来。修完连跑两次全绿。
4. **测试套件在满载下超时**：新增 4 个文件后，5 秒的默认超时在 48 个 jsdom 环境并发时不够，出现了与本轮改动无关的随机失败。改为 15 秒并注明原因。
5. **Playwright 的 `name` 默认是子串匹配**（第二次踩）：概念链接「Bilinear pairing」同时匹配到「删除指向 Bilinear pairing 的前置关系」。链接用 `exact`，卡片用子串——两者都在注释里写清了为什么。
6. **`useSyncExternalStore` 的 `getSnapshot` 必须返回同一个对象**：测试里的假 store 每次返回新对象导致无限渲染。已在测试的假 store 里缓存快照。

---

## 十一、未完成与限制

1. **没有 AI 提出的概念关系。** 关系目前只能由读者创建；`suggestions/add` 与「AI 建议的关系」区块都已就位并有测试，但本轮没有接一个会产出关系的分析器——基于共现的规则会制造没有依据的边，而基于模型的关系需要真实模型才有意义（本轮禁止）。
2. **候选只来自难点缓存。** 没有从批注正文里抽概念（那需要模型或词表），也没有重新解析 PDF。
3. **跨项目关联只有数据层**：概念可以带多个 `projectId`，但界面上没有「把这个概念加入另一个项目」的入口（接口已有 `concept/linkProject`）。
4. **图谱是静态分层布局**，没有拖拽、缩放、折叠；概念多时靠滚动。当前规模的科研项目够用。
5. **概念删除是永久的**（有确认框），没有回收站。
6. **真实模型未验证**：知识层不依赖模型；难点分析仍是 Mock 验证过的链路。
7. 搜索是子串匹配，不做同义词/别名外的模糊匹配。

---

## 十二、Git 提交

分支 `phase6-knowledge-graph`，**无远程、未推送**。

新增：`src/domain/knowledge.ts`、`knowledgeState.ts`、`src/services/knowledgeStore.ts`、`src/features/knowledge/{useKnowledgeApi,KnowledgeView,ConceptDetail,ConceptGraph}.tsx`、`src/styles/knowledge.css`、`scripts/verify/{offline.mjs,guard-probe.mjs,graph.mjs}`、本报告与 `docs/phase6-gate0-report.json`。

修改：`App.tsx`（知识 store、阅读器 focus、删除项目时摘除知识）、`ProjectView.tsx`（文献/知识两个区）、`ReaderView.tsx`（focus 落点）、`SuggestionCard.tsx`（存为概念）、`server/index.mjs`（health 加 `instanceId`）、`vite.config.ts`（测试超时）、三个验收脚本。

---

## 十三、验收标准逐条对照

| #   | 标准                           | 结论 | 依据                                                        |
| --- | ------------------------------ | ---- | ----------------------------------------------------------- |
| 1   | 同一概念能关联多篇论文         | 达成 | `papersOf` 测试：两篇论文各一条出处                         |
| 2   | 同名不同义不会被自动合并       | 达成 | 领域测试 + 浏览器「3 个概念」；合并需显式动作               |
| 3   | 关系方向和类型正确             | 达成 | `prerequisite` 从依赖方指向被依赖方；`related` 无向；有测试 |
| 4   | 用户能手动增删改概念与依赖     | 达成 | 新建/编辑/确认/删除、加关系/删关系，浏览器验收覆盖          |
| 5   | 来源能跳回实际 PDF 原文        | 达成 | 打开原文 → 阅读器落点并标出引文                             |
| 6   | PDF 替换后旧证据不会错误定位   | 达成 | `isStaleEvidence` + 禁用按钮 + 文案；单测与组件测试         |
| 7   | 共享概念不因删除某项目而丢失   | 达成 | `project/detach` 只摘链接；浏览器：删项目后 3 个概念仍在    |
| 8   | 未确认建议不能污染正式知识关系 | 达成 | reducer 强制建议状态；读图只看 confirmed；有测试            |
| 9   | 图谱与列表数据一致             | 达成 | 同一数据源；浏览器断言节点/边数                             |
| 10  | 深浅色与窄窗口可正常操作       | 达成 | 深色截图；900px 下重排、横向溢出 0                          |
| 11  | 原有阅读/批注/AI/难点无回归    | 达成 | 五套浏览器验收 + 1128 单测                                  |
| 12  | 离线验收零真实调用             | 达成 | Gate 0 反例测试；三个套件均在浏览器打开前校验代理身份与实例 |
