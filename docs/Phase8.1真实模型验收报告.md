# Phase 8.1 真实模型验收报告：DeepSeek Flash 知识分析质量

日期：2026-10-18。工作目录：`D:\论文阅读解构项目`。分支：`phase8-evidence-knowledge`。本轮未做远程 Git 写入，未修改应用源码，未写入任何正式知识库。

---

## 一、结论

1. **12 次真实业务请求全部完成，全部 HTTP 200 / `valid`。** 0 次 `recovered`、`malformed`、`incomplete`；12 次 `finish_reason=stop`，无截断，无协议结构污染。
2. **官方成本约 ¥0.0899（空闲时段）到 ¥0.1799（峰值时段）**，保守 ledger 估算 ¥0.1934；预留 ¥1.44。未超过 12 次或 ¥2 的硬上限，未触发任何停止条件。
3. **协议层表现优秀。** 12/12 返回了约定的 JSON 结构；0 次忽略身份字段，0 次忽略状态字段，0 次页码冲突，0 次方向字段与类型矛盾。
4. **概念识别总体良好，但存在过度生成。** 71 个概念集中在 DLM/TSLM 的核心机制、表示、公式与方法组件；没有作者姓名或随机英文词。短上下文（31 字选区、531 字单段）仍产生 5–6 个概念，包含 `demonstrations`、`Next-token prediction` 这类通用/对照概念，说明“宁少勿多”和“上下文不足时收缩”没有完全做到。
5. **关系方向没有发现完全颠倒的严重错误，但分类有偏差。** 78 条关系中 51 条 prerequisite、23 条 related、4 条 extends；12 条 `inferred`，0 条 `external`。逐条抽样的 17 条中，9 条正确、7 条部分正确、1 条关系类型错误（把“替代”写成 `extends`）。主要问题是把定义/对比关系写成前置学习关系，以及把替代/近似写成 `extends`。
6. **证据约束有效。** 193 条通过逐字校验的引文；4 条被服务端过滤（1 条引文不在段落，3 条引文为空/过短）。其中一条失败引文使 `dual-tower architecture → complementary representations` 被自动降级为 `inferred` 并显示警告——这正是设计想要的行为。
7. **不确定性处理部分达成。** 模型会在部分关系上标 `inferred`（12 条），但在极少上下文下仍返回 `groundedInText: true` 并给出多个概念，没有主动拒绝或显著收缩。
8. **稳定性有改进空间。** 同一请求（冒烟 vs 重复）得到相同的 6 个核心概念，但 6 条共同关系中：1 条 `prerequisite` 变成 `related`，1 条 `direct` 变成 `inferred`，重复运行还多出 1 条关系。服务端 `temperature=0.3` 下这属于可预期的不稳定。
9. **结论：DeepSeek Flash 适合作为“带证据的候选建议生成器”，不适合作为自动确认的知识图谱构建器。** 保留现有“读者逐条采纳”机制即可使用；不需要立刻升级到更强模型。优先做 temperature 0 与提示词/校验层面的修正。
10. 本报告的逐条判断是 **Agent 依据论文原文的核对**，不是独立领域专家验收；标“待复核”的关系需要人类专家确认。

---

## 二、基线与安全边界

| 项目 | 实际结果 |
| --- | --- |
| Phase 8 最终记录 | `docs/screenshots-phase8/2026-10-17T16-09-27-knowledge-ai/report.json`：48 passed / 0 failed |
| `npm run check`（本轮前后） | 59 文件 / 1254 项通过 |
| 分支 / HEAD | `phase8-evidence-knowledge` / `8589368`（8.1 开始前） |
| 跟踪文件工作区 | clean；只有 Phase 8 回归产生的未跟踪时间戳目录 |
| 端口 | 8787、8792、8793、8794、4180、4181 预检时均无服务应答 |
| 使用端口 | 8794（本地 AI 服务）、4181（preview）；启动前检查，实例 ID 直连/代理/页面三处一致 |
| 代理终点 | `provider=deepseek`、`online=true`、`model=deepseek-flash`、`reasoning=思考模式关闭` |
| 密钥 | 只从本地 `.env.live` 读取并传入服务子进程；未写入请求体、日志、报告、Git；运行后已清除 |
| 正式知识库 | 未读取、未写入；12 次调用只走服务端点，不调用应用 store/backup API |
| 论文 | 仅 `.cache/papers/2610.22294.pdf` 与 `2610.22327.pdf`（CC BY） |
| 重试 | 无。服务端 provider 不重试；运行器不重试；每次 POST 发送前计数 |
| Mock 预检 | 3 次离线 mock 全链路通过；不计入真实业务请求 |

运行器：`scripts/verify/live-knowledge-8.1.mjs`。它强制要求 `--stage=boundary --quality-ok` 才能进入最后一组，并要求 smoke/main 的 ledger 记录通过协议检查。

---

## 三、官方定价、调用与成本

### 3.1 官方价格（2026-10-18 实际抓取 `api-docs.deepseek.com/quick_start/pricing`）

| deepseek-flash（DeepSeek-V4.1-Flash-1017） | 空闲时段 | 峰值时段 |
| --- | --- | --- |
| 1M 输入 tokens（缓存命中） | $0.003 | $0.006 |
| 1M 输入 tokens（缓存未命中） | $0.15 | $0.30 |
| 1M 输出 tokens | $0.60 | $1.20 |

峰值时段为 UTC 01:00–04:00 与 06:00–10:00（周一至周五，排除中国法定节假日）；其余时间（含周末）为空闲时段。本报告按 **1 USD = 8 CNY** 保守折算。

参数：`deepseek-flash`、`DEEPSEEK_THINKING=disabled`、`reasoning_effort=none`、输出上限 4096 tokens、超时 120 秒、temperature 0.3（服务默认，未改）。三次运行的服务实例分别为 `b970e552…`、`3e827ec6…`、`61892cb9…`，均通过代理实例校验。

### 3.2 逐次调用

| # | 场景 | 页 | 字符 | 输入/输出/缓存 tokens | 延迟 | 状态 | 官方空闲 ¥ | 官方峰值 ¥ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | smoke-dlm-definition | 2/1/3 | 2602 | 1376/1242/0 | 5784 ms | valid | 0.0076 | 0.0152 |
| 2 | main-dlm-definition | 1/2 | 1838 | 1115/1259/384 | 5028 ms | valid | 0.0069 | 0.0139 |
| 3 | main-dlm-method | 3/2/4 | 2822 | 1425/1320/384 | 5556 ms | valid | 0.0076 | 0.0152 |
| 4 | main-ts-definition | 1/2/3 | 2434 | 1261/1262/384 | 5141 ms | valid | 0.0071 | 0.0142 |
| 5 | main-ts-method | 3/2/4 | 2811 | 1391/1780/384 | 6791 ms | valid | 0.0098 | 0.0195 |
| 6 | boundary-adjacent | 4/3/5 | 2776 | 1413/1518/384 | 6410 ms | valid | 0.0085 | 0.0171 |
| 7 | boundary-short | 1/3 | 1186 | 971/1154/384 | 4738 ms | valid | 0.0063 | 0.0125 |
| 8 | boundary-formula | 6/5/7 | 1869 | 1231/1458/384 | 6129 ms | valid | 0.0080 | 0.0160 |
| 9 | boundary-multicolumn | 4/3/5 | 2176 | 1368/1369/384 | 6855 ms | valid | 0.0078 | 0.0155 |
| 10 | boundary-minimal | 2 | 531 | 870/912/384 | 3663 ms | valid | 0.0050 | 0.0099 |
| 11 | boundary-existing | 1/2/3 | 2434 | 1308/1747/1152 | 6288 ms | valid | 0.0086 | 0.0172 |
| 12 | boundary-repeat | 2/1/3 | 2602 | 1376/1352/1152 | 5419 ms | valid | 0.0068 | 0.0136 |
| **合计** | 12 次 | — | — | **15105/16373/5760** | 平均 5650 ms | **12/12 valid** | **0.0899** | **0.1799** |

Ledger 的保守估算（输入按峰值缓存未命中、输出按峰值，忽略缓存折扣）为 **¥0.1934**；预留 **¥1.44**。实际账单应以官方结算为准，但无论按空闲还是峰值，均远低于 ¥2/¥3 上限。

---

## 四、协议遵守率

| 指标 | 结果 |
| --- | --- |
| `valid` | **12 / 12（100%）** |
| `recovered` | 0 |
| `malformed` | 0 |
| `incomplete` | 0 |
| `finish_reason=stop` | 12 / 12 |
| 截断 | 0 |
| `rawChars` 范围 | 3,292–6,940 |
| 输出 tokens 范围 | 912–1,780 |
| 服务端忽略的身份字段 | 0 |
| 服务端忽略的状态/id 字段 | 0 |
| 页码与段落冲突 | 0 |
| 方向字段缺失/默认 | 0 |
| support 字段缺失/默认 | 0 |
| 结构污染 | 未观察到 |

真实模型完整遵守了知识分析的 JSON 协议；没有出现把协议字段写进正文、转义信封、截断 JSON 或空回答的情况。

---

## 五、概念识别质量

### 5.1 总量与分布

- 概念 **71** 个：`direct 71`、`inferred 0`、`external 0`。
- 关系 **78** 条：`direct 66`、`inferred 12`、`external 0`；类型 `prerequisite 51`、`related 23`、`extends 4`。
- 通过逐字校验的证据 **193** 条；被过滤 **4** 条。

### 5.2 好的部分

真实模型找到的核心概念与论文主线高度一致，例如：

- DLM 论文：`Diffusion language models (DLMs)`、`Shared canvas`、`Masked diffusion language models`、`Masked infilling`、`Bidirectional context conditioning`、`Multi-target few-shot prompting`、`Joint multi-site infilling consistency`、`Selective masking likelihood-ratio reward`、`Masked position allocation`。
- TS 论文：`Time Series Language Models (TSLMs)`、`Complementary Representations`、`Inductive Bias`、`Original Measurement Frame`、`Normalized Delay Embeddings`、`Dual-Tower Architecture`、`Line Plot`、`视觉 token 压缩与多级特征融合`、`Single Primary Representation`。
- 公式页：`奖励引导分布 Q_β`、`对数似然比奖励 R(u)`、`示例可见/掩蔽条件分布 P1 与 P0`、`奖励引导重采样`——即使在文字层碎片化的情况下，模型仍能识别公式结构并用逐字碎片作证据。

没有出现作者姓名、期刊名、普通英文单词被当作核心技术概念的情况。

### 5.3 不足

1. **全量概念都标为 `direct`。** 其中一些是模型自己的聚合命名（如 `Autoregressive models and their prompting guidance`、`视觉 token 压缩与多级特征融合`），并非原文中的逐字术语；标 `inferred` 会更准确。
2. **短/极少上下文过度生成。** 31 字选区（配 1 页上下文）返回 6 个概念；531 字单段返回 6 个概念、5 条关系，包含 `demonstrations`、`Next-token prediction` 这类通用/对照概念。模型没有因为上下文不足而收缩，也没有把 `groundedInText` 设为 false。
3. **通用/对照概念与核心概念并列。** `Autoregressive models`、`Next-token prediction`、`demonstrations` 对理解论文有辅助作用，但不应当与 DLM、shared canvas 等核心概念同级。

---

## 六、前置关系方向与学术合理性

### 6.1 结构方向

- 12 次调用中 0 次 `relation-direction` 拒绝，0 次方向字段缺失；模型输出的 `direction` 与 `kind` 在结构上 100% 一致。
- 没有发现“原文说 A 依赖 B、模型写成 B 依赖 A”这种完全颠倒的严重错误。

### 6.2 学术方向的主要问题

1. **定义/属性关系被写成前置学习关系。** 例如 `DLM → Shared canvas / prerequisite`：论文用 shared canvas 定义 DLM 的生成方式；把它写成“先学画布再学 DLM”是教学顺序推断，不是原文陈述。用 `related` 或更明确的 `definitional` 更合适。
2. **替代关系被写成 `extends`。** 例如 `Complementary Representations → Single Primary Representation / extends`：论文用 “Our work instead treats representation…” 表示替代/转向，不是“扩展”。这是本轮唯一一条明确的关系类型错误。
3. **近似/实现关系被写成 `extends`。** 例如 `奖励引导重采样 → Q_β / extends`：论文说直接从 Qβ 采样不可行，改用 importance resampling 近似；这是近似实现，不是扩展。
4. **`prerequisite` 过密。** 78 条关系中 51 条是 prerequisite；部分关系更适合 `related`（对比、实现、同一框架的两部分）。这会让学习路径比论文实际的知识结构更强、更线性。

### 6.3 好的部分

- `Autoregressive models → In-place editing / related` 正确使用了无方向的对比关系。
- `Multi-target few-shot prompting → Joint multi-site infilling consistency / related / inferred` 明确说明“原文未明说”，support 分类诚实。
- `Selective masking likelihood-ratio reward → Multi-target few-shot prompting / extends` 与原文 “we further leverage…” 相符。
- `Dual-Tower Architecture → Line Plot / Normalized Delay Embedding / prerequisite` 与论文“architecture combines two views”一致。
- 在已有概念/关系场景中，模型没有提出反向的 `Language Model → TSLM` 依赖；不过它也没有复用提供的两个已有概念，见限制。

---

## 七、引用与证据质量

| 指标 | 结果 |
| --- | --- |
| 通过逐字校验的引文 | **193** |
| 被过滤的引文 | **4** |
| 引文不存在于所给段落 | 1 |
| 引文为空/过短/过长 | 3 |
| 页码与段落不一致 | 0 |
| 引文位置可靠性 | 服务端逐字校验通过；当前页由浏览器在采纳时可再测框，其他页标 `verbatim` |
| 引文是否支持结论 | 抽样 17 条中 9 条充分、7 条部分充分、1 条关系类型错误；见第九节 |

关键行为：

- `main-ts-definition` 中模型为 `dual-tower architecture → complementary representations` 给出的引文 `We instantiate this principle with two v` 不在所给段落里；服务端拒绝该引文，把关系从 `direct` 降级为 `inferred`，并在 warnings 中说明。**模型没有用假引文蒙混过关。**
- `main-ts-method` 和 `boundary-multicolumn` 各有空/过短引文被过滤；关系/概念保留，但对应证据被丢弃。
- 逐字引文合法不等于结论正确；界面现有的 caveat 仍然必要。

---

## 八、不确定性处理

- 12 条关系标为 `inferred`，说明模型会在部分场景使用推断标签（例如 `Multi-target few-shot prompting → Joint multi-site infilling consistency`、`奖励引导重采样 → Q_β`、`Masked progressive filling → DLM`）。
- 0 条 `external`：模型没有引入明显的论文外知识；这对减少幻觉是好事，但本轮没有验证 `external` 路径的真实模型行为。
- **未达成：** 在 531 字单段、31 字选区这类上下文不足的场景中，模型仍返回 `groundedInText: true` 和多个概念，没有主动拒绝或显著减少建议。它把部分关系标为 `inferred`，但没有在整体层面承认证据不足。
- 现有服务的“direct 无有效引文 → 降级 inferred”规则工作正常；这是比模型自述更可靠的一道防线。

---

## 九、逐条人工评估（17 条代表性建议）

> 以下为 Agent 依据论文原文的逐条核对，不是独立领域专家验收。标“待复核”的条目需要人类专家确认；不宣称已完成专家验收。

| # | 场景 | 建议 | 结论 | 依据与理由 |
| --- | --- | --- | --- | --- |
| 1 | smoke | 概念 `Diffusion language models (DLMs)` | **正确** | 原文直接定义 DLM 不受 next-token prediction 限制、可在 shared canvas 任意位置生成；是论文核心对象。 |
| 2 | smoke | 概念 `Shared canvas` | **正确** | 原文反复用 shared canvas 描述演示、上下文与待填充区域共处的位置；是 DLM 机制的核心结构。 |
| 3 | smoke | 概念 `Autoregressive models and their prompting guidance` | **部分正确** | 原文把自回归模型及其 guidance 作为对照（“primarily designed for autoregressive models and do not directly apply…”），不是论文发展的核心技术概念；作为对比有帮助，但不该与 DLM 并列。 |
| 4 | main-ts-method | 概念 `视觉 token 压缩与多级特征融合` | **正确** | 原文说明视觉特征压缩为 230/64 个 token 并做多级融合；属于方法组件。 |
| 5 | boundary-formula | 概念 `奖励引导分布 Q_β` | **正确** | 原文定义 `Qβ(u) := P1(u) exp(βR(u)) / Zβ`；公式碎片被逐字引用，概念准确。 |
| 6 | boundary-short | 概念 `demonstrations` | **部分正确** | 原文用 demonstrations 定义 few-shot prompting；概念本身正确，但过于通用，不是本文特有技术概念；短上下文下仍被列为核心概念，显示过度生成。 |
| 7 | boundary-minimal | 概念 `Next-token prediction` | **部分正确** | 原文以“不受 next-token prediction 限制”界定 DLM；作为对照有帮助，但在 531 字上下文中被列为核心概念，说明未因上下文不足而收敛。 |
| 8 | main-ts-method | 概念 `Dual-Tower Architecture` | **正确** | 原文提出 dual-tower architecture 并结合 line plots 与 normalized delay embeddings；是核心方法。 |
| 9 | smoke | 关系 `DLM → Shared canvas / prerequisite / direct` | **部分正确；方向待复核** | 引文支持“DLM 可在共享画布任意位置生成”，但“先理解画布才能理解 DLM”是教学顺序推断；`direct` 把“引文支持关联”误当成“引文支持前置方向”。 |
| 10 | smoke | 关系 `Autoregressive models → In-place editing / related / direct` | **正确** | 原文明确对比：面向自回归模型的引导方法不直接适用于 in-place editing；用 `related` 而非 prerequisite 恰当。 |
| 11 | main-dlm-method | 关系 `Multi-target few-shot prompting → Joint multi-site infilling consistency / related / inferred` | **正确** | 原文讨论联合填充多站点带来一致性收益；模型明确说明这是推断、不是原文直述，`inferred` 恰当。 |
| 12 | main-dlm-definition | 关系 `Selective masking likelihood-ratio reward → Multi-target few-shot prompting / extends / direct` | **正确** | 原文 “To address … we further leverage selective masking … to derive a likelihood-ratio reward”；`extends` 与 “further” 相符。 |
| 13 | main-ts-definition | 关系 `Dual-tower architecture → Complementary representations / prerequisite / inferred` | **部分正确；证据待复核** | 论文确实说 “Building on this representational principle, we design a dual-tower TSLM”；关系合理，但模型给出的引文未通过校验，服务端已降级为 `inferred` 并警告；本条证据不足。 |
| 14 | main-ts-method | 关系 `Complementary representations → Single primary representation / extends / direct` | **错误（关系类型）** | 论文用 “Our work instead treats representation…” 表示替代/转向，不是“扩展”；方向/关联存在，但 `extends` 断言了错误的学术关系。 |
| 15 | boundary-formula | 关系 `奖励引导重采样 → Q_β / extends / inferred` | **部分正确；类型待复核** | 原文说直接从 Qβ 采样不可行，改用 importance resampling 近似；这是近似/实现，不是扩展；模型标 `inferred` 是诚实的。 |
| 16 | boundary-existing | 关系 `Dual-Tower Architecture → Complementary Representations / prerequisite / direct` | **正确** | 原文 “Building on this representational principle, we design a dual-tower TSLM” 支持该前置；同场景未复用已有 TSLM/Language Model 概念，见限制。 |
| 17 | boundary-repeat | 关系 `Multi-target few-shot prompting → DLM / related / direct` | **部分正确（稳定性）** | 与冒烟同一请求时该边为 `prerequisite/direct`；重复运行变成 `related/direct`，且 `Shared canvas → Bidirectional` 的 support 从 direct 变 inferred；`related` 本身不算错，但一致性不足。 |

**统计：17 条中 9 条正确、7 条部分正确、1 条错误（关系类型）。** 0 条完全凭空捏造的概念或引文；主要问题是关系类型、support 分类和教学方向推断，而不是事实幻觉。

---

## 十、被服务端过滤的无效内容

| 请求 | 代码 | 位置 | 结果 |
| --- | --- | --- | --- |
| 04 main-ts-definition | `quote-not-in-passage` | `We instantiate this principle with two v` | 引文被丢弃；关联关系降级为 `inferred` 并显示警告 |
| 05 main-ts-method | `quote-shape` | selection | 空/过短/过长引文被丢弃 |
| 09 boundary-multicolumn | `quote-shape` ×2 | ctx-1 | 两条空/过短引文被丢弃 |

没有无效内容进入知识图谱；服务的“逐字校验 + 页码归属 + 降级警告”在真实模型上有效。

---

## 十一、新发现与工程缺陷

### 11.1 预检中发现并修复的工具缺陷

1. **PDF 哈希在 pdf.js 转移 buffer 之后计算，得到空 SHA-256。** 预检中两篇论文的哈希都变成 `e3b0c442…`；这会让证据的文件身份失效。修复：在把 bytes 交给 pdf.js 之前计算哈希。两篇论文现在分别得到正确的 `8b9ccec0…` 与 `2cdef165…`。这是验收工具缺陷，不是应用缺陷；在第一次真实调用之前已修复。
2. **Mock 与真实响应混在同一 `responses/` 目录。** 预检文件和真实文件编号交叉，容易误引。修复：按 `mock/` / `live/` 分目录；真实 12 份证据在 `.cache/verify/phase8.1-live/live/responses/`。

### 11.2 应用/服务端

本轮没有发现新的应用或服务端缺陷。真实模型触发的 4 条无效引文全部被服务端正确过滤；一条关系被正确降级；0 次身份/状态字段绕过；0 次页码冲突。

### 11.3 模型行为问题（不是工程缺陷）

- 同一请求在 temperature 0.3 下关系类型/support 不完全稳定；
- 全量概念标 `direct`，聚合/对照概念也标 direct；
- 极小上下文仍过度生成；
- `extends` 被用于替代/近似关系；
- 已有概念列表没有被模型主动复用（`matchedExisting=0`），因此真实模型下的复用路径未被触发。

---

## 十二、与离线 Mock 的差异

| 维度 | Mock | 真实 DeepSeek Flash |
| --- | --- | --- |
| 概念数量 | 固定 2 个（模拟概念 A/B） | 5–6 个/次，共 71 个 |
| 关系数量 | 固定 2 条 | 5–10 条/次，共 78 条 |
| 语义质量 | 不具学术含义，只验证数据流 | 概念多为中心技术概念；有少量通用/对照概念 |
| 协议 | 固定 JSON，测试边界触发 | 12/12 valid，0 recovered/malformed/incomplete |
| 证据 | 复制段落首句 | 193 条逐字引文；4 条被过滤 |
| 不确定性 | 固定 inferred/external 示例 | 12 条 inferred；0 条 external；极小上下文未拒绝 |
| 延迟 | ~5 ms | 平均 5.65 s，最大 6.86 s |
| 成本 | ¥0 | 官方空闲约 ¥0.0899，峰值约 ¥0.1799 |
| 禁止字段 | 触发「模型写入 status/id」的 mock 场景，被服务端忽略 | 模型未尝试写入，ignored 计数 0 |
| 复用已有概念 | 离线测试覆盖 | 本轮未触发（matchedExisting=0） |

真实模型的输出远多于 Mock，协议与证据边界仍然成立；Mock 仍然是可重复、零成本的回归工具，但不能替代真实质量结论。

---

## 十三、是否适合正式使用，是否需要更强模型

### 13.1 适合度

**适合作为候选知识建议生成器，前提是保留强制人工确认。** 理由：

- 协议遵守 12/12，证据链完整（193 条逐字引文，4 条无效被过滤）；
- 概念集中在论文主线，没有作者姓名或随机词；
- 方向没有严重颠倒；不确定时会标 `inferred`；
- 延迟 3.7–6.9 秒，成本约 ¥0.01/次（空闲），对个人阅读场景可接受；
- 现有“建议 → 读者逐条采纳 → 才进入依赖图”的流程正好覆盖它的主要弱点。

**不适合作为自动确认的知识图谱构建器。** 原因：

- 关系类型/ support 有偏差（替代写成 extends，定义/对比写成 prerequisite）；
- 极小上下文会过度生成，`groundedInText` 未反映不足；
- 同一请求结果不完全稳定；
- 已有概念复用未被触发，不能假定它会自动复用读者的知识结构。

### 13.2 是否需要更高推理强度或更强模型

**当前不需要。** `thinking=disabled` 已经能 100% 遵守协议，概念质量足以支撑“建议 + 人工确认”。优先尝试：

1. `temperature: 0`（稳定关系类型/support）；
2. 提示词明确区分“定义/属性/对比”与“学习前置”，限制 `extends`；
3. 对聚合概念要求 `inferred`；
4. 极小上下文时限制建议数量或要求 `groundedInText:false`。

如果这些修正后仍需要更高精度，再考虑 `DEEPSEEK_THINKING=low` 或 `deepseek-v4-pro` 的小规模对照；那需要新的预算授权，本轮不执行。更强模型不会自动修复“关系类型定义”问题，提示词/校验仍是第一优先级。

---

## 十四、后续修复建议与仍待人工复核

### 14.1 建议的离线修正（不涉及新的付费调用）

1. **知识分析 temperature 设为 0**（或至少低于 0.3），提高重复请求的一致性；在服务端 `/api/ai/knowledge` 路径单独设置，不影响问答。
2. **提示词增加关系类型判据：**
   - `prerequisite` 必须能回答“为什么理解 A 通常需要先理解 B”，不能只因为同段出现或定义相关；
   - `extends` 只用于 A 在 B 之上增加能力；替代/对照用 `related`；
   - 对定义关系，建议用 `related`，避免制造线性学习路径。
3. **概念 support 校准：** 若概念名不是任一段落中的逐字短语，服务端可将 `direct` 降级为 `inferred` 或给出警告（类似现有引文降级）。这能修正“71 个概念全 direct”的偏斜。
4. **极小上下文保护：** 当总上下文低于阈值（如 800–1000 字）时，提示词要求最多 2–3 个概念、少给前置关系，或允许 `groundedInText:false`；服务端也可给界面一个“上下文偏少”的提示。
5. **已有概念复用验证：** 重新设计一个选区直接包含已有概念名称的场景（例如选区就是 TSLM 定义句，已有概念名与原文完全一致），确认 `matchedExisting>0`；本轮真实模型没有触发该路径。
6. **UI 真实输出回放：** 把一份真实响应用作离线 fixture，渲染知识面板/概念详情，验证更大的列表、长中文名称和多条证据的布局；本轮未在 UI 中回放真实输出。
7. **可选：low thinking 对照。** 仅在完成 1–4 后仍不满足精度时，另行申请小规模对照；不得自动扩大预算。

### 14.2 待人工复核

以下条目建议由人类领域专家确认，本报告仅给出 Agent 判断：

- 第 9 条：`DLM → Shared canvas` 是否应作为学习前置，还是仅作定义/相关；
- 第 13 条：`Dual-tower architecture → Complementary representations` 的前置方向与缺失证据；
- 第 14 条：`Complementary representations → Single primary representation` 应使用何种关系类型；
- 第 15 条：`奖励引导重采样 → Q_β` 是扩展、近似还是实现关系；
- 以及 71 个概念/78 条关系中未抽样部分的学术正确性。

---

## 十五、Git、证据与可复现性

- 分支：`phase8-evidence-knowledge`；Phase 8 提交 `2697994` / `8589368`。Phase 8.1 的 `scripts/verify/live-knowledge-8.1.mjs` 与本报告在完成后本地提交；未推送远程。
- 未修改应用源码、Phase 8 报告、知识库或备份。
- 运行器与原始证据在 `.cache/verify/phase8.1-live/`（Git 忽略）：
  - `live-ledger.json`：12 次请求的计数、token、延迟、预留/估算费用、实例 ID；
  - `live/requests/01…12-*.json`：实际发送的段落、页码、字符；
  - `live/responses/01…12-*.json`：完整响应与 usage；
  - `scenarios.json`：场景与论文哈希；
  - `deepseek-pricing.html`：官方价格页快照。
- 密钥只存在于运行时的 `.env.live`，未进入上述文件；运行后已清除。
- 未自动重试；12 次业务请求全部计数；没有超时/失败请求。

---

## 十六、验收标准逐条对照

| # | 标准 | 结论 | 依据 |
| --- | --- | --- | --- |
| 1 | 最多 12 次真实业务请求 | 达成 | ledger count = 12 |
| 2 | 费用硬上限 ¥2 | 达成 | 预留 ¥1.44；官方峰值约 ¥0.1799；未触发预算停止 |
| 3 | 仅 DeepSeek 官方 API | 达成 | provider=deepseek，base URL 官方，服务实例校验 |
| 4 | 只用两篇 CC BY 论文 | 达成 | 12 个场景全部来自 2610.22294 / 2610.22327 |
| 5 | 禁止其他 AI 服务/子 Agent | 达成 | 未调用其他模型，未创建子 Agent |
| 6 | 不自动写入正式知识库 | 达成 | 只调用服务端点，未调用 store/backup；`.env.live` 清除 |
| 7 | 协议遵守率 | 达成 | 12/12 valid，0 recovered/malformed/incomplete |
| 8 | 概念识别质量 | 部分达成 | 71 个概念多为中心概念；短/极少上下文过度生成 |
| 9 | 前置方向准确性 | 部分达成 | 0 结构方向错误；1 条类型错误、若干教学方向推断 |
| 10 | 引用合法性 | 达成 | 193 条逐字通过；4 条被过滤；0 页码冲突 |
| 11 | 证据支持 | 部分达成 | 17 条抽样：9 正确、7 部分正确、1 类型错误 |
| 12 | 不确定性处理 | 部分达成 | 12 inferred；极小上下文未拒绝/未收缩 |
| 13 | 延迟/成本记录 | 达成 | 逐次 token/延迟/官方价格计算 |
| 14 | 至少 12 条人工评估 | 达成 | 17 条；Agent 核对，非专家验收 |
| 15 | 被过滤内容记录 | 达成 | 4 条，代码/位置/处理 |
| 16 | Mock 与真实差异 | 达成 | 第十二节 |
| 17 | 新工程缺陷 | 达成 | 2 个工具缺陷，已在付费调用前修复 |
| 18 | 是否适合正式使用/更强模型 | 达成 | 第十三节 |
| 19 | 不覆盖 Phase 8 报告 | 达成 | 未修改 |
| 20 | 完成后停止，不进入 Phase 9 | 达成 | 本轮结束 |

---

## 十七、停止声明

本轮真实调用已完成 12 次并停止；没有自动重试，没有超出授权范围，没有进入 Phase 9。若需要实施第十四节的离线修正或进行 low thinking/更强模型对照，需另行授权；本轮不再发起任何真实 API 请求。
