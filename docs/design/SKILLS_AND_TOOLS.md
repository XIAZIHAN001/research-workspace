# ZCode 环境清单与外部资源评估（2026-10-24）

结论先行：**不新增任何外部安装**。本仓库已有的 playwright-core 验收脚本体系 + 已安装的
browser-use 插件覆盖了全部验收需求；外部设计技能的价值已蒸馏进本项目的
`.agents/skills/research-workspace-ui` 与 `DESIGN_SPEC.md`，无需安装原件。
任何未来的安装/脚本执行/权限变更，先列影响再向用户取得授权（见 §3 政策）。

## 1. 当前 ZCode 环境盘点

| 类别 | 已安装 | 与本项目的关系 |
|---|---|---|
| 官方插件（skills） | browser-use（control-browser、web-gui-tester）、documents、pdf、presentations、spreadsheets、visualize、github 套件、skill-creator、plugin-creator、zcode-guide、example-plugin | browser-use = 交互式 UI 走查/截图；skill-creator = 已用于生成本项目 skill；其余按需 |
| 内置 | dynamic-workflows | 多子代理编排，验收 fan-out 时可选 |
| 用户级 skills | `~/.agents/skills/`：context7-mcp、lark-* ×26 | 与本仓库无关 |
| MCP 服务器 | node_repl（浏览器/计算机使用后端）、web_reader、documents/pdf/presentations/spreadsheets 插件 MCP、example-plugin | web_reader 用于本轮回读外部资料；node_repl 供 browser-use 驱动浏览器 |
| **未安装** | playwright-mcp、anthropics frontend-design 插件、vercel-labs agent-skills、nextlevelbuilder ui-ux-pro-max | 见 §2 逐项结论 |

项目级 skill 发现路径：`<project>/.agents/skills/<name>/SKILL.md`（本次已创建
`research-workspace-ui`；`.gitignore` 不忽略 `.agents/`，随仓库分发）。

## 2. 外部资源逐项评估（已读实际内容，非 README 摘要）

| 资源 | 形式 | 结论 | 理由与去向 |
|---|---|---|---|
| anthropics/claude-code · frontend-design | 纯指导型 SKILL.md，无脚本 | **蒸馏，不安装** | 价值在方法论：立足题材、克制（一处大胆+安静陪衬）、反 AI 套路清单、design writing、quality floor（响应式/焦点/降动效）。已并入 DESIGN_SPEC §0/§4 与验收清单 §4 文案规则。安装原件对本项目无增量（其风格是"每客户独特识别"，与本仓库"既有中性体系"相反）。 |
| vercel-labs/agent-skills · web-design-guidelines | SKILL.md 运行时抓取远端规则清单 | **蒸馏，不安装** | 实际规则在 vercel-labs/web-interface-guidelines（command.md），已全文抓取并适配成本地静态清单（references/acceptance-checklist.md §4）。"每次评审先抓远端"不适合离线桌面项目；file:line 输出格式已采纳。 |
| vercel-labs/agent-skills · react-best-practices | SKILL.md | 按需人工参考，不安装 | 面向 React/Next 性能细节；本仓库改动以 CSS/布局为主，触及时再读。 |
| nextlevelbuilder/ui-ux-pro-max | 本地数据库 + **需执行 Python 脚本**（scripts/search.py） | **不安装** | ① 需执行外部脚本（政策 §3）；② 面向 greenfield 多栈选型（79 风格/192 配色），与本仓库"复用既有 Token、克制中性"冲突；③ 其优先级排序（无障碍 > 触达 44px > 性能 > …）已吸收进验收清单。 |
| microsoft/playwright-mcp | MCP 服务器（npx @playwright/mcp） | **暂不安装** | 仓库已有 `scripts/verify/*.mjs`（playwright-core + 本机 Edge/Chrome）承担脚本化回归；自由探索式走查由已安装的 browser-use 插件覆盖。若未来确需 MCP 协议（如接入其他客户端），配置为 `{"mcpServers":{"playwright":{"command":"npx","args":["@playwright/mcp@latest"]}}}`，安装前需用户授权。 |
| zotero/reader（源码研读） | 参考实现 | 结论已并入规范 | 关键可迁移点：headless 控制器 + 薄 React 外壳；**布局用 CSS 变量（--sidebar-width）推给 iframe/canvas 视图，不经 React 重渲染**（与我们 PDF 坐标稳定诉求同构）；视图状态（缩放/滚动）由宿主持久化并在构造时回灌；侧栏三态 open/width/view 与本项目 useSidebar 同构，验证了现有方向。 |
| microsoft/vscode layout.ts（源码研读） | 参考实现 | 结论已并入规范 | Parts 模型（部件声明 min/max + 可见性事件）、单一 grid 仲裁、类型化 LayoutStateKey 持久化、不变式集中管理、"最大化=保存先前状态"模式、根容器状态 class（nosidebar 等）。已并入 DESIGN_SPEC §3。 |
| bvaughn/react-resizable-panels（README 研读） | React 库 | **不引入依赖** | 新 API（Group/Panel/Separator/Grid）确实优雅，但项目已有指针事件拖拽 + clamp + localStorage + 键盘分隔条，覆盖相同能力；约束"尽量避免新增依赖"。可借鉴其语义：双击分隔条恢复默认尺寸（低成本高感知，可选做）。 |
| zai-org/zcode-plugins | 插件市场 | 不涉及 | 仅当要把项目 skill 打包成可分发插件时才相关；本项目 skill 走 `.agents/skills/` 项目级即可。 |

## 3. 安装与执行政策（对后续轮次生效）

1. 任何外部 skill / plugin / MCP 的安装，先说明：写入哪些路径、执行什么脚本、是否联网、回滚方式，
   并取得用户明确授权后再动。
2. 来源不明仓库的脚本一律不执行；官方插件缓存（`~/.zcode/cli/plugins/cache/`）内的脚本按 skill 文档使用。
3. 本项目 skill 的迭代在 `.agents/skills/research-workspace-ui/` 内完成（skill-creator 流程），
   不新增全局安装。
