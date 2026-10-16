# Phase 0 开发概述

记录时间：2026-10-16 凌晨（最近一次系统时间读数 00:14）。工作目录：`D:\论文阅读解构项目`。

这份文档把当前会话里已确认的事实存档，供下次接手时直接读取。每条信息按来源标注：

- 已核实：本次会话中亲自执行命令或读取文件得到的结果。
- 取自日志：来自 `.cache/phase-log.txt`，本次未复核。
- 判断：基于已核实事实的推断或建议，未在本工程中验证。

## 一、结论

Phase 0 尚未完成。目前只有环境审查、数据层和一个占位页。

- Phase 0A 环境审查：已完成，结论见第二节。
- Phase 0B 工程初始化：大部分完成，但 `npm run build` 目前失败，原因见第四节。
- Phase 0C 首页 UI 原型：未完成。侧边栏、形象区、欢迎词、主题切换、玻璃效果都不存在，页面只是占位文字。
- Phase 0D 测试与验收：未执行。没有截图、缩放检查和无障碍检查，不能标记为通过。
- Token 与费用：不可获取，见第六节，没有做任何估算。

下一步最先要做的是让构建恢复通过，然后再做 UI。

## 二、环境与架构审查（Phase 0A）

### 环境事实（已核实）

- 系统：Windows 11（10.0.26100），Intel Core Ultra 9 275HX，内存 31.4 GB，D 盘共 552 GB、剩余 279 GB。
- 运行环境：Node 24.14.1，npm 11.11.0；另装有 pnpm 10.33.0、yarn 1.22.22，没有 bun；git 2.52.0；Python 3.13.5。
- WebView2 运行时 155.0.4283.45，Edge 155.0.4283.45，Chrome 155.0.8059.79。
- Rust：`~/.rustup/toolchains` 下有 `stable-x86_64-pc-windows-msvc`，用绝对路径能运行 rustc 1.94.0 和 cargo 1.94.0。但 `rustc`、`cargo` 不在 PATH 上，`~/.cargo/bin` 不存在，`tauri info` 报告 Rust 未安装。
- MSVC：`tauri info` 检测不到任何 Visual Studio 或 Build Tools 实例，默认路径下也没有 `vswhere.exe`。`D:\VS CODE` 下有一份 MSVC 14.44.35207（含 `cl.exe`、`link.exe`、`vcvars64.bat`、`VsDevCmd.bat`、`libcmt.lib`、`msvcrt.lib`），Windows SDK 10.0.26100.0 在 `C:\Program Files (x86)\Windows Kits\10`（Lib 下有 `ucrt`、`um`）。
- 链接器冲突：PATH 上的 `link` 指向 `D:\VS CODE\Git\usr\bin\link.exe`（GNU 版）。在没有加载 `vcvars64.bat` 的 shell 里，它可能遮住 MSVC 的 `link.exe`（判断，本次没有重新复现）。
- Tauri：`@tauri-apps/cli` 2.12.3 已装并能运行，`@tauri-apps/api` 未装；工程里还没有 `src-tauri/`，没有做过任何 Rust 编译。
- 目录不是 git 仓库（没有 `.git`）。本阶段没有提交，也没有推送。
- 取自日志：20:37 记录 MSVC 子进程环境验证通过，本次未复核。

### 技术选型评估（判断，未在本工程内验证）

20:37 完成的 0A 报告原文不在本次上下文里。下面是按已核实的环境事实和一般经验重新整理的，不是原文。

- Tauri 2 + React + TypeScript 适合本项目：本地优先、安装包小，WebView2 已就绪。主要风险不在框架，而在本机 Rust 与 MSVC 没有接入标准路径。
- 首页 UI 原型不依赖 Tauri。前端先用 Vite 直接跑，`src-tauri/` 等到需要文件系统、SQLite、密钥保管时再加。
- 存储：Phase 0 用 localStorage，经 `KeyValueStore` 与 `ProjectsStore` 两层隔离，换成 SQLite 时只需改动 `services/`。长期方案是元数据与笔记进 SQLite（用 FTS5 做全文检索，图谱先用节点表和边表），PDF 等大文件放应用数据目录，按内容哈希命名。
- PDF 阅读器：pdf.js 在 WebView2 中应可行，未试。要提前预留段落级锚点，因为译文、批注、概念跳转都要回指原文位置；扫描版 PDF 需要 OCR，单独算风险。
- 知识图谱：先用 SQLite 加前端渲染，不引入图数据库。
- 模型 API：密钥与请求放在 Rust 侧或本地小服务里，不进 WebView。任何付费调用、上传论文内容都要用户明确同意。
- AI 欢迎词：本阶段用模拟数据。建议定义一个返回欢迎词字符串的 provider 接口，后续再替换成真实模型。

### 主要风险与备选

| 风险                        | 说明                                                                                                  | 备选                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Rust/MSVC 未接入            | `tauri info` 检测失败；PATH 上的 GNU `link.exe` 可能遮住 MSVC 的                                      | 每次在 `vcvars64.bat` 环境里启动，不改系统；或经用户同意安装官方 Build Tools；再不行改用 Electron，或暂时只做 Web 版 |
| 依赖大版本较新              | TypeScript 6、Vite 8、ESLint 10、Vitest 5。tsc、eslint、vitest 已实测可运行，但生态插件可能跟进不及时 | 出现不兼容时回退一个大版本并锁定                                                                                     |
| 跳过安装脚本                | 依赖是用 `npm install --ignore-scripts` 装的（用户已批准），之后若有依赖需要 postinstall 会出问题     | 遇到时单独对该包执行脚本，先征求同意                                                                                 |
| 玻璃效果表现                | `backdrop-filter` 与边缘光在 WebView2 上的实际效果和性能还没看过                                      | 材质分层降级：关闭模糊，只保留半透明与描边                                                                           |
| localStorage 不适合长期存储 | 清理缓存可能丢数据                                                                                    | 尽早迁到 SQLite 文件                                                                                                 |

## 三、工程现状（Phase 0B）

### 目录结构（已核实：逐个读取过文件）

```text
D:\论文阅读解构项目
├─ index.html            入口；<html> 带 data-theme / data-theme-pref 默认值，加载 /theme-init.js
├─ package.json          脚本与依赖，版本全部固定
├─ vite.config.ts        端口 1420 且 strictPort；vitest 用 jsdom，setup 在 src/test/setup.ts
├─ tsconfig*.json        app / node 两个项目引用；strict 加 noUncheckedIndexedAccess 等
├─ eslint.config.js      typescript-eslint 加 react-hooks，强制 consistent-type-imports
├─ .prettierrc.json      单引号、分号、尾逗号 all、行宽 100、LF
├─ .npmrc                save-exact=true、fund=false、audit=false
├─ .claude/launch.json   预览服务器配置，端口 1420
├─ public/
│  ├─ theme-init.js      首帧前同步解析主题，避免闪烁
│  └─ avatar/            空目录，默认形象 /avatar/default.svg 尚不存在
├─ docs/screenshots/     空目录
├─ scripts/              空目录
└─ src/
   ├─ main.tsx           占位入口（本次收尾新增，只证明 Vite + React + TS 链路能启动）
   ├─ app/config.ts      存储键、媒体查询、头像限制
   ├─ domain/            project.ts、projectsState.ts、parse.ts 及测试
   ├─ services/          ids.ts、storage.ts、projectsStore.ts、avatar.ts 及测试
   ├─ features/theme/    theme.ts 及测试
   ├─ styles/spring.css  弹簧缓动曲线（linear()）
   ├─ test/setup.ts      jest-dom、自动卸载、每个用例后清空 localStorage
   └─ ui/、features/home/、features/projects/   空目录，预留给 UI
```

### 常用命令（来自 `package.json`）

| 命令                   | 作用                                       | 当前状态                              |
| ---------------------- | ------------------------------------------ | ------------------------------------- |
| `npm run dev`          | 启动 Vite，端口固定 1420，被占用时直接报错 | 实测可启动，占位页能渲染              |
| `npm run typecheck`    | `tsc -b`                                   | 审计时通过，之后未重跑                |
| `npm run lint`         | ESLint                                     | 审计时通过，之后未重跑                |
| `npm run format:check` | Prettier 检查                              | 审计时有 2 个文件不合规，已修，未复查 |
| `npm run test`         | Vitest 单次运行                            | 审计时 24 个用例通过，之后未重跑      |
| `npm run build`        | `tsc -b && vite build`                     | 当前失败，见第四节                    |
| `npm run check`        | 依次跑 typecheck、lint、format:check、test | 未跑                                  |

### 数据层要点（已核实：读过源码）

- 项目以 `id` 为身份，名称可改。`Project` 含 `corePaper`、`relatedPapers`、`createdAt`、`updatedAt`（毫秒时间戳），后续笔记、批注、概念图谱都挂在项目下。
- 名称规整：合并空白、按码点截断到 80、空白返回 `null`。
- `projectsReducer` 的动作：`hydrate`、`add`、`rename`、`remove`、`select`。列表新建在前，选择不改顺序；删除选中项时先选顶上来的那一项，其次是上一项，最后是 `null`。
- `parseProjectsState` 对存储里的 JSON 做严格校验，形状不对返回 `null`；`selectedId` 无效时退回第一个项目。
- `storage.ts` 的读写都可注入 `KeyValueStore`，写失败返回 `false`。无法解析的数据先备份到 `rw.projects.corrupt`，再从空状态开始。
- `projectsStore.ts` 给 `useSyncExternalStore` 用，持久化发生在 `dispatch` 里；快照带 `persisted` 标志，写入失败时界面可以提示。
- 头像以 data URL 存在 `rw.avatar`，只接受 png / jpeg / webp / svg，上限 1 MB。默认路径 `/avatar/default.svg`，这个文件目前不存在。
- 主题分 `system | light | dark`。`public/theme-init.js` 在首帧前写入 `data-theme`，它和 `app/config.ts` 共用存储键 `rw.theme`，改动时两处要同步。
- `styles/spring.css` 只定义了 `--ease-spring`（`linear()` 阻尼曲线，约 5.4% 过冲）。注释说回退值在 `tokens.css`，该文件还没建。
- 配置里已预留：宽度小于 760px 时侧栏改为浮层，另有深色和减少动效的媒体查询。

### 本次收尾对工程的改动（已核实）

- `src/domain/projectsState.ts`：`select` 选中当前项、`rename` 名称不变或 id 不存在时，改为返回原状态对象。原先这些空操作会返回新对象，`projectsStore.dispatch` 因此多写一次 localStorage、多通知一次订阅者。这个问题是后台测试代理发现的。
- `src/main.tsx`：新增占位入口，只渲染一行标题和说明文字。
- `package.json`：删除 `verify:ui`、`usage`、`desktop` 三个脚本，它们指向的 `scripts/` 文件不存在。
- `index.html`：删除指向不存在的 `/favicon.svg` 的 `<link>`。
- `src/services/projectsStore.ts`、`src/styles/spring.css`：执行过 `prettier --write`，只有格式变化。
- `.cache/phase-log.txt`：追加了一条审计记录。
- 后台测试代理在写测试途中被我停止，它已写的文件原样保留，见第四节。

## 四、测试与验收状态（Phase 0D）

结论：Phase 0D 没有执行。下面只列实际跑过的检查和时间点，没跑过的不写通过。

### 实际执行过的检查（已核实）

| 时间           | 命令                                 | 结果                                                                                                   |
| -------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 23:42 前后     | `tsc -b`                             | 通过                                                                                                   |
| 23:42 前后     | `eslint .`                           | 通过                                                                                                   |
| 23:42 前后     | `prettier --check .`                 | 2 个文件不合规（`projectsStore.ts`、`spring.css`），随后已 `--write` 修复，未复查                      |
| 23:42          | `vitest run`                         | 2 个文件、24 个用例通过                                                                                |
| 00:14 之前不久 | `npm run build`                      | 失败（退出码 2），卡在 `tsc -b`，`vite build` 没有执行                                                 |
| 收尾阶段       | 预览服务器（`npm run dev` 同一配置） | 占位页渲染成功，控制台只有 Vite 调试信息和 React DevTools 提示，没有错误或警告；没有截图；服务器已停止 |

注意：23:42 那一轮之后，后台代理又改过测试文件，我也改了 `projectsState.ts`、`main.tsx`、`package.json`、`index.html`。这些改动之后没有重跑 `eslint`、`prettier`、`vitest`，`tsc` 只在构建里跑了一次且失败。所以“通过”只适用于 23:42 那一刻的文件。

### 构建失败的原因

`tsc -b` 报 `TS6133` / `TS6192`（声明了但没用的变量和导入），出在三个后台代理留下的脚手架测试文件：`src/services/avatar.test.ts`、`src/services/projectsStore.test.ts`、`src/services/storage.test.ts`。它们只有辅助函数和导入，没有任何用例。我只看到输出的最后 20 行，上面可能还有别的报错，完整清单没有确认。

处理办法二选一：删除这三个文件，或补完用例。我没有擅自删除，因为这是代理的未完成成果，由你决定。

### 测试文件清单

| 文件                                                   | 用例数（按源码行估计）                          | 状态                                                          |
| ------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------- |
| `src/services/ids.test.ts`                             | 2                                               | 23:42 通过                                                    |
| `src/domain/project.test.ts`                           | 22（20 行 `it`，其中 1 个 `it.each` 展开 3 项） | 23:42 通过；文件 23:48 又被改过（4510→5000 字节），改动未复核 |
| `src/domain/projectsState.test.ts`                     | 24 行                                           | 未验证；它写成期间我改了 reducer，两者是否一致不确定          |
| `src/domain/parse.test.ts`                             | 2                                               | 未验证                                                        |
| `src/features/theme/theme.test.ts`                     | 2                                               | 未验证                                                        |
| `avatar` / `projectsStore` / `storage` 三个 `.test.ts` | 0                                               | 空脚手架，导致构建失败                                        |

代理被我停止时正准备跑检查，所以它自己的通过/失败数没有拿到。

## 五、首页 UI 原型状态（Phase 0C）

未完成。磁盘上没有任何 UI 组件、样式表或形象资源，页面只有 `src/main.tsx` 里的占位文字。

`.cache/phase-log.txt` 22:49 的一条记录写着“UI shell（tokens、玻璃 CSS、hooks、侧栏、对话框、头部）已写好”，但这些文件现在都不存在，原因不明（我没有去查会话记录）。我按“从零开始”处理，记作一次返工。

- 已具备的底座：项目状态与持久化、主题解析与首帧脚本、头像读写校验、弹簧缓动曲线。
- 尚缺：`tokens.css`、玻璃材质样式、`App` 外壳、侧栏与项目对话框、首页形象区与欢迎词区、`/avatar/default.svg`、favicon。
- 计划用的 `lucide-react` 图标（PanelLeft、Plus、Sun、Moon、Monitor、Pencil、Trash2、Sparkles 等）我核对过都存在。

任务书里的设计要求，提炼如下，供实现时对照：

- 布局：左侧紧凑项目导航，主区多留白，不用大方形项目卡片，中央放形象和欢迎词。
- 视觉：参考 ColorOS 17 凝光玻璃，半透明材质、边缘光与高光，动效克制连续，支持浅色和深色，不堆模糊与阴影。
- 架构：以论文理解为中心，双语阅读、笔记、图谱、推荐、复现都作为辅助能力挂在项目下，不做成孤立的一级工作区。

## 六、开发成本与用量记录

下面写“不可获取”的项目，就是真的拿不到，没有估算。

| 项目                      | 记录                                                                            |
| ------------------------- | ------------------------------------------------------------------------------- |
| 模型标识                  | `claude-sonnet-5-5[1m]`（会话元数据，已核实）；推理强度 high；权限模式 auto     |
| 总输入 / 输出 Token       | 不可获取                                                                        |
| 缓存读取 / 创建 Token     | 不可获取                                                                        |
| 实际 API 费用或中转站账单 | 不可获取。用量接口只说明推理经组织自有的提供方调用，没有给出账单数据            |
| 后台测试代理的用量        | 不可获取                                                                        |
| 上下文占用快照            | 收尾阶段读到约 215k / 786k（27%）。这是窗口当前大小，不是累计消耗，不能当用量用 |

我曾尝试列出会话日志目录来找用量，被权限拦截，没有绕过。要精确数字，请到中转站或提供方后台查账单，再对照下面的时间线。

### 时间线（UTC+8，2026-10-15 至 16）

| 时间          | 事件                                                                           | 来源             |
| ------------- | ------------------------------------------------------------------------------ | ---------------- |
| 19:58         | 会话创建，Phase 0A 开始                                                        | 会话元数据、日志 |
| 20:26         | MSVC / rustc 链接探测第 1 次失败（cmd 引号问题）                               | 日志             |
| 20:37         | 0A 完成，0B 开始                                                               | 日志             |
| 20:57         | `npm install` 被自动模式分类器拒绝，需用户批准                                 | 日志             |
| 21:42         | 用户批准 `npm install --ignore-scripts`；21:47 装完（239 个包，约 2 分 37 秒） | 日志             |
| 22:27         | 数据层写完，tsc 与 eslint 通过                                                 | 日志             |
| 22:37 / 22:49 | UI 层开始；单测委派给后台代理                                                  | 日志             |
| 23:37         | 本次上下文接手，开始审计                                                       | 已核实           |
| 00:14         | 构建失败已确认；随后停止预览服务器和后台代理，写本文档                         | 已核实           |

各阶段耗时没有精确数字：0A 约 39 分钟（19:58 到 20:37，含一次失败探测）；0B 中 20:57 到 21:42 在等批准，日志里已把这段排除在开发时间之外；0C 未完成；0D 未执行。

### 返工与阻塞

- R1：MSVC 链接探测因 cmd 引号失败，重做一次（日志）。
- B1：`npm install` 被分类器拦下，等待约 45 分钟，另有 2 次短暂拦截（日志）。这是阻塞，不算返工。
- R2：日志声称已写好的 UI 外壳在磁盘上不存在，按未开始处理，原因不明（已核实磁盘状态，原因未查）。
- R3：后台代理留下 3 个空测试脚手架，使构建失败，待清理（已核实）。
- R4：reducer 空操作返回新对象导致多余写入，已修一处（已核实改动，修复后未跑测试）。
- 另：接手时我一度误判任务书被截断，随即更正，对工程无影响。

按以上，明确记录的返工至少 2 次（R1、R2），另有 2 项缺陷（R3、R4）。

## 七、任务书交付物对照

| 交付项                    | 状态                                                         |
| ------------------------- | ------------------------------------------------------------ |
| 1. 可运行的本地工程       | 部分：`npm run dev` 能启动占位页；`npm run build` 失败       |
| 2. 首页 UI 截图与设计说明 | 未交付：没有 UI，没有截图                                    |
| 3. 架构与技术选型文档     | 本文第二节是按现有事实重整的版本，20:37 的 0A 报告原文不在手 |
| 4. 测试与验收报告         | 未交付，见第四节                                             |
| 5. Token 与成本记录       | 不可获取，见第六节                                           |
| 6. 下一阶段建议           | 见下一节                                                     |

任务书的安全约束仍然有效：只在本目录内开发，不提交也不推送 Git，不用付费 API，不改系统环境，需要额外权限时先问。

## 八、下一步建议

按顺序做：

1. 恢复构建。删除或补完 `avatar.test.ts`、`projectsStore.test.ts`、`storage.test.ts` 三个空脚手架，再跑 `npm run check` 和 `npm run build`，把结果如实记进第四节。
2. 做 Phase 0C。先写 `tokens.css`（浅色和深色变量、玻璃材质分层，以及 `spring.css` 提到的缓动回退值），再做 App 外壳和侧栏，然后是首页形象区与欢迎词（用 mock provider），最后是项目的新建和重命名对话框。
3. 补 `public/avatar/default.svg`，需要时再补 favicon。
4. 验收时用预览工具截浅色和深色各一张，检查 760px 以下的侧栏浮层，并跑 axe-core（已在依赖里）。截图放进 `docs/screenshots/`。
5. Tauri 放在 UI 通过之后。先在 `vcvars64.bat` 环境里确认 Rust 与 MSVC 能编译，如果要安装 Build Tools 或改系统环境，先问用户。
6. 需要精确用量时，到提供方或中转站后台查账单。

接手提示：先读本文，再读 `.cache/phase-log.txt`。注意日志 22:49 那条与磁盘现状不符，以本文和磁盘为准。

Phase 0 完成之前，不进入 PDF 阅读器、知识图谱或实验复现的开发。
