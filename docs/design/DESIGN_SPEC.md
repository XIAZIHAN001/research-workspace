# Research Workspace 设计规范（v1 · 2026-10-24）

配套文档：[ACCEPTANCE.md](./ACCEPTANCE.md) · [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) · [SKILLS_AND_TOOLS.md](./SKILLS_AND_TOOLS.md)
本规范是下一轮「工作区布局与个性化体验重构」的视觉与结构依据；日常规则速查见
`.agents/skills/research-workspace-ui/SKILL.md`。

## 0. 设计原则

1. PDF 阅读空间第一优先：所有 UI 是阅读的脚手架，可折叠、可收纳、不与正文争夺注意力。
2. 极简、中性、原生桌面感：浅色用中性灰与黑字；深色支持纯黑到中性灰的连续调节；不引入蓝灰底。
3. 主操作黑白反转；蓝色（`--color-accent`）只做辅助强调，不做大面积按钮或背景。
4. 不增加无意义卡片、阴影、渐变、玻璃特效；结构感来自对齐、间距节奏与层级，不来自装饰。
5. 复用现有 Token、主题系统、状态管理与组件；不为套用外部 UI 库破坏现有架构。
6. 每个视觉决策在浅色 / 纯黑（level 100）/ 中间深色（level ≈36）三态下同时成立。

## 1. 现有 Token 盘点（src/styles/tokens.css，实测）

新代码一律使用语义 Token；旧式短别名仍在大量使用，**不批量重命名**，触及处渐进替换。

| 类别 | Token（现值） |
|---|---|
| 颜色语义（新式） | `--color-bg-app/-sidebar/-panel/-elevated`、`--color-border-subtle`、`--color-text-primary/secondary/tertiary`、`--color-accent`（浅 #0066CC / 深 #2997FF）、`--color-danger/ok/warn`、`--color-primary-bg/-fg` |
| 颜色别名（旧式，仍广泛使用） | `--bg-base`、`--sheet`、`--card`、`--well`、`--text/-2/-3`、`--accent(-soft)`、`--hairline`、`--control-fill(-hover)`、`--input-fill`、`--focus`、`--row-hover/-active`、`--scrim` 等 |
| 字号 | `--fs-hero` clamp(32,3.4vw,44) · `--fs-title` clamp(26,2.6vw,34) · `--fs-h2` 20 · `--fs-h3` 17 · `--fs-body` 15 · `--fs-row` 15 · `--fs-small` 13 · `--fs-caption` 12 · `--fs-micro` 11 |
| 圆角 | `--r-sm` 8 · `--r-md` 12 · `--r-lg` 18 · `--r-xl` 22 · `--r-pill` 980 |
| 动效 | `--dur-fast` 120ms · `--dur` 200ms · `--dur-slow` 320ms · `--ease-out`、`--ease-spring`、`--press-scale` 0.975 |
| 字体 | `--font-ui`、`--font-display`（系统栈，无 webfont） |
| 布局 | `--sidebar-w`（JS 内联写入） |

**主题机制**：`<html data-theme>` + JS 写入的 7 个 `--dark-*` 变量；深色程度是 0–100 连续值，
`theme.ts darkPalette(level)` 推导中性灰阶梯（app/sidebar/panel/elevated/border/hairline）。
**任何调色改动必须同步 `public/theme-init.js`**（预渲染防闪烁），否则首帧闪白。

**已知缺口**：没有间距刻度、控件高度、密度变量——这就是 §2 要补的地基。

## 2. 新增 Token 提案（重构实施时的基准值）

加入 `tokens.css` 的 `:root`，三档密度用 `[data-density='…']` 覆盖（与主题同机制，消费端不改）：

```css
:root {
  /* 间距刻度：4 的倍数，替换随手写的 px 间距（渐进替换，触及即改） */
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
  --space-5: 20px; --space-6: 24px; --space-8: 32px;
  /* 控件高度层级：按钮/输入/chip 统一取值 */
  --control-h-sm: 24px; --control-h-md: 28px; --control-h-lg: 32px;
  --control-h: var(--control-h-md);
}
/* 界面密度：只影响 UI 行高、间距与控件高度，永远不进 .reader-scroll 内部 */
:root[data-density='compact']    { --space-3: 8px;  --space-4: 12px; --space-6: 20px;
                                   --control-h-md: 24px; --fs-body: 14px; --fs-row: 14px; --fs-small: 12px; }
:root[data-density='comfortable']{ --space-3: 14px; --space-4: 20px; --space-6: 28px;
                                   --control-h-md: 32px; --fs-body: 16px; --fs-row: 16px; --fs-small: 14px; }
/* UI 字号档：独立于密度；选择器必须限定在 UI 表面，禁止波及 PDF 文本层（.textLayer 的字号跟随画布缩放） */
:root[data-ui-font='large'] { --fs-body: 16.5px; --fs-row: 16.5px; --fs-small: 14px; --fs-caption: 13px; }
:root[data-ui-font='larger']{ --fs-body: 18px;   --fs-row: 18px;   --fs-small: 15px; --fs-caption: 14px; }
```

约束：
- 密度与字号档**只改 UI 文本**。PDF 画布是 canvas 渲染天然不受影响；PDF 文本层（透明选字层）
  字号由缩放驱动，任何 UI 缩放选择器不得命中 `.reader-scroll`、`.reader-slot`、`.textLayer`。
- 三档密度下逐一复测工具栏、面板、设置页不出现裁切与换行错乱。

## 3. 布局系统

### 3.1 Parts 模型（借鉴 VS Code workbench 的可迁移结论）

- 每个区域（主侧栏 / PDF 列 / 右侧面板）是自治部件：声明 min/max 尺寸与可见性，布局层只通过这个
  接口协调。现状已基本如此（`useSidebar`、`--panel-w`），重构**保持该边界，不引入布局库**。
- 布局不变式集中在一处（config.ts / ReaderView 接线处），不散落在组件里：
  - 759px 以下主侧栏只能是抽屉（`data-narrow`）；
  - 1100px 以下右侧面板只能是浮层；
  - 预设改变的是**初始状态**，永不禁止用户手动拖拽/开合后的结果。
- 布局状态用类型化键集中持久化（见 §3.3 与 IMPLEMENTATION_PLAN §1），恢复时逐键 clamp。

### 3.2 三种布局预设

| 预设 | 主侧栏 | 右侧面板 | 语义 |
|---|---|---|---|
| 专注阅读 focus | 收起（保留"展开侧栏"入口） | 收起（rail 常驻） | 最大化 PDF |
| 均衡布局 balanced（默认） | 展开 | 收起，按需从 rail 打开 | 日常默认 |
| 研究模式 research | 展开 | 展开并定位到上次使用的面板 | 边读边查/问 AI |

- 切换预设只设置各部件的初始开合；已存储的手动宽度（`rw.sidebarWidth`、`rw.panelWidth`）保持不动。
- 预设选择持久化；重新打开应用恢复所选预设，窄窗口下抽屉/浮层规则仍优先于预设。

### 3.3 宽度与默认值

- 主侧栏：默认 **224**（任务书要求 ~224；现值 248），min 200 / max 420 不变。
  默认值变更只影响新用户与"恢复默认布局"；已存储的用户宽度一律尊重。
- 右侧面板：默认 360，min 260 / max 560 不变。
- 恢复默认布局：设置中心提供显式操作，写入全部布局默认值（开合 + 宽度 + 预设 + 密度 + 字号档），
  带确认；**不触碰任何论文/标注数据键**。

### 3.4 断点纪律

- 759px：JS 单源（`NARROW_VIEWPORT_QUERY`），CSS 只认 `data-narrow` 属性——保持单源。
- 1100px：JS `READER_OVERLAY_QUERY` 与 `reader.css @media` 双源，注释已声明必须同步；重构时
  保持该纪律，或借此机会把 CSS 侧迁移为属性选择器消除断点（需实测无回归才做）。

## 4. 组件规范

- **工具栏语义分组**（顺序固定，组间用分隔）：
  `[返回 · 标题（截断）] [阅读位置 ←→] [查找] [页码 ·/·总页] [缩放 − % + 适应宽度] [纸张模式] [更多 ⋯]`
  高频项直出；查找/阅读历史/纸张模式在窄窗口收进"更多"。同语义按钮不得重复出现。
- **右侧面板 chrome 统一**：每个子面板 = 标题行（标题 + 关闭 ✕）+ 独立滚动内容区 + 底部操作区。
  AI 输入框固定面板底部，答案区独立滚动；消灭双层容器与重复说明文字。
- **按钮层级**：同一视图内只有一个主按钮（黑白反转），其余为次级/ghost；侧面板内禁止多个等突出主操作。
- **空状态**：一句话说明 + 一个明确的下一步动作入口，不占大版面、不放插画。
- **文案**：主动语态、具体动词（"保存更改"非"提交"）、操作命名全流程一致、错误说清怎么修、
  隐私与本地数据处理说明保留但压缩篇幅。

## 5. 明确禁止清单

- 大面积蓝色按钮/背景；蓝灰深色底；新增阴影/渐变/玻璃卡。
- 未经授权的新 npm 依赖、UI 框架、CSS 框架。
- 影响坐标正确性的"增强"：对 `.reader-slot`/`.textLayer` 的任何定位、字号、变换改动。
- 把设置窗口改成需要滚动才能找到主题切换的超长单页（保持分区导航 + 自适应高度）。
- 在浅色主题下使用纯白大字灰底以外的"创意"配色。
