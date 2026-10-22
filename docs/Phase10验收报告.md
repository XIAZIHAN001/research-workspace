# Phase 10 验收报告：Tauri v2 桌面化与 Windows 可安装版本

生成日期：2026-10-18
分支：`phase10-tauri-desktop`
基线：`8d8f6fa`（Phase 9 报告提交）
实现提交：`0c01826`（桌面壳与 sidecar）+ `f6c7923`（路径、开发隔离与布局修复）

## 一、结论

Phase 10 的主要目标已经达成：

- 已产出可安装的 Windows x64 桌面构建：`Research Workspace_0.10.0_x64-setup.exe`（27.54 MiB）；
- 安装后的应用不依赖 Vite 开发服务器、外部 npm 服务、项目源代码目录或全局 Node.js；
- 应用自带的 Node sidecar 在临时回环端口启动，使用每次启动生成的 Bearer 凭据，强制离线 Mock；
- PDF 阅读、翻页、文字选择、高亮、笔记、知识概念、旧 `.rwbackup` 导入、备份导出、重启持久化、同版本重装持久化均已在实际安装包上验证；
- 正常关闭与强制结束应用后，自带的 sidecar 都会退出，不遗留孤儿进程；
- 开发模式（Tauri dev + Vite）已在本机真实启动并完成 17/17 项验收；
- Linux 只完成了静态代码审查与构建说明，**没有**在 Linux 上编译或图形运行，报告中明确标注为未验证。

本轮没有真实 DeepSeek 调用，没有新增模型或 Agent，没有远程 Git 写入，没有覆盖 Phase 0–9 的历史验收报告与截图。

## 二、基线、环境与工具链

### 2.1 Windows 主机

| 项目 | 值 |
| --- | --- |
| 系统 | Windows 11 Home China 10.0.26100（x64） |
| Node / npm | v24.14.1 / 11.11.0 |
| WebView2 Runtime | 155.0.4283.60 |
| Visual Studio | Visual Studio 2022 17.14.36429.23，路径 `D:\VS CODE` |
| MSVC | 14.44.35207（`cl.exe` / `link.exe`） |
| Windows SDK | 10.0.26100 |
| Rust / Cargo | 1.99.1（rustup，`RUSTUP_HOME=D:\Rust\rustup`，`CARGO_HOME=D:\Rust\cargo`） |
| Tauri CLI | `@tauri-apps/cli` 2.12.3 |
| Tauri JS API | `@tauri-apps/api` 2.12.4 |
| 安装包工具 | Tauri bundler 下载的 NSIS 3.13 |

工具链都在 D 盘；Windows 系统目录没有安装新的 Rust/MSVC。最初尝试的 WSL + cargo-xwin 构建环境已按用户要求删除，保留了 WSL 原有的 `/opt/icicle`、`/opt/src`、`/opt/node24`、`/root/.cargo-cached`、`.docker` 等零知识证明相关工作内容。下载的 `vs_BuildTools.exe` 已删除，未执行安装。

用户级 `.wslconfig` 中仍保留 `networkingMode=mirrored`（两行，之前为让 WSL 使用 Windows 本地代理而开启）；它不影响桌面应用，如不再需要可由用户删除。

### 2.2 本轮实际使用的构建方式

本机已有完整的 Visual Studio 2022 C++ 工具链，只是安装在非默认目录 `D:\VS CODE`。Phase 10 最终使用：

```bat
call "D:\VS CODE\VC\Auxiliary\Build\vcvars64.bat"
set "PATH=D:\Rust\cargo\bin;%PATH%"
set "RUSTUP_HOME=D:\Rust\rustup"
set "CARGO_HOME=D:\Rust\cargo"
npm run desktop:build
```

即原生 Windows MSVC 构建，不再使用 WSL 交叉编译。`scripts/desktop/msvc-env.cmd` 固化了这套环境（路径可通过 `RW_VS_PATH` 覆盖）。

## 三、最终桌面架构

### 3.1 组件

```text
┌──────────────────────────── Tauri 应用进程 ────────────────────────────┐
│  WebView2                                                              │
│  React 19 + Vite 8 生产构建（嵌入 exe，tauri://localhost / http://…)   │
│      │ Tauri IPC: ai_service_info / restart_ai_service                 │
│      │            事件: ai-service-status                              │
│      ▼                                                                 │
│  Rust 壳（src-tauri/src/main.rs）                                      │
│      │ std::process::Command（不使用 shell 插件）                      │
│      ▼                                                                 │
│  rw-node.exe（打包的 Node 24.14.1）+ sidecar/server/                   │
│  127.0.0.1:临时端口 + 每次启动的 Bearer 令牌 + 强制离线 Mock           │
└────────────────────────────────────────────────────────────────────────┘
```

- 窗口：`main`，标题 `Research Workspace`，1280×860，最小 960×640，创建时固定 WebView2 数据目录。
- 应用标识符：生产 `com.researchworkspace.desktop`；开发 `com.researchworkspace.desktop.dev`。
- 应用版本：`0.10.0`。
- 前端与 PDF.js、KaTeX 全部来自本地构建，没有远程 CDN。

### 3.2 为什么选择 Node sidecar，而不是重写 Rust 后端

采用 **方案 A：打包现有 Node 服务为 sidecar**。

理由：

1. 现有服务已经覆盖提示词构造、引用校验、难点分析、知识关系校验、限流、并发、超时、Mock/真实 Provider 等约两千行经过 Phase 4–9 验证的逻辑；
2. 用 Rust 重写会同时改变业务逻辑与安全边界，回归风险远大于收益；
3. sidecar 把“持有密钥/发起模型调用”的边界保持在独立进程内，Tauri 壳只负责生命周期与凭据传递；
4. 目标机器不需要安装 Node：`scripts/desktop/prepare-sidecar.mjs` 把当前 Node 运行时（Windows 上为 `node.exe`，87.2 MB）复制进 `src-tauri/sidecar/rw-node.exe`，作为 Tauri 资源随安装包分发。

安全边界：

- sidecar 只绑定 `127.0.0.1`，端口由操作系统分配（`AI_PORT=0`），不使用 8787；
- 每次启动生成 64 字符随机令牌，通过 Tauri IPC 交给本应用的 WebView，页面请求必须带 `Authorization: Bearer`；
- 服务端校验 `Host`、`Origin`、令牌、实例标识；允许来源包括 `http://tauri.localhost`、`https://tauri.localhost`、`tauri://localhost`；
- Rust 启动子进程时 `env_clear()`，只恢复 Windows/Linux 必需的环境变量，父进程的 `AI_PROVIDER`、`DEEPSEEK_API_KEY`、代理变量不会进入 sidecar；
- 子进程始终按 `--offline` 语义运行，`config.mjs` 强制 mock provider，`online=false`。

### 3.3 本地 AI 服务的生命周期

启动：

1. 应用窗口创建后，Rust 生成随机令牌与实例 id；
2. 从 `resource_dir()/sidecar`（开发模式为 `src-tauri/sidecar`）启动 `rw-node.exe server/desktop.mjs`；
3. sidecar 绑定临时回环端口，向 stdout 输出一行 `RW_AI_READY {json}`；
4. Rust 校验端口、实例 id 与 `online=false`，通过 `ai-service-status` 事件告诉前端；
5. 前端向 Rust 请求 `ai_service_info`，取得 base URL 与令牌，再直接请求 sidecar。

失败与重启：

- 启动失败、超时、身份不匹配、进程异常退出都会变成界面上的“AI 服务不可用”状态，并显示错误摘要；
- 状态角标提供“重启服务”，Rust 会先停止旧子进程，再生成新令牌、新端口、新实例。

关闭：

- 应用正常退出时，`RunEvent::Exit` 停止子进程；
- 子进程同时监听 stdin EOF 与父进程 PID（4 秒轮询），即使应用崩溃或强杀也会在数秒内退出；
- 验收中正常关闭与 `Stop-Process -Force` 强杀两种方式都确认 sidecar 消失，没有孤儿。

## 四、版本与构建结果

### 4.1 版本

| 组件 | 版本 |
| --- | --- |
| tauri | 2.12.4 |
| tauri-build | 2.7.3 |
| tauri-runtime | 2.12.2 |
| wry | 0.57.0 |
| webview2-com | 0.39.1 |
| @tauri-apps/cli | 2.12.3 |
| @tauri-apps/api | 2.12.4 |
| Rust | 1.99.1 |
| Node sidecar | v24.14.1 |
| NSIS | 3.13（Tauri bundler） |

没有使用任何 Tauri 插件（无 shell、fs、http、updater、telemetry）。

### 4.2 正式构建

命令：

```bash
npm run desktop:build
# = npm run desktop:prepare && tauri build
# beforeBuildCommand = npm run build
```

结果：

- 可执行文件：`src-tauri/target/release/research-workspace.exe`（6,183,936 字节）；
- 安装包：`src-tauri/target/release/bundle/nsis/Research Workspace_0.10.0_x64-setup.exe`（27.54 MiB）；
- SHA-256：`6ed2d083c2f09349589f3a4dd77ab97eb4eda2fff73566149227b0f807439ba8`；
- 安装方式：当前用户（`installMode: currentUser`），无 UAC；
- 实际安装路径：`D:\Research Workspace`（注册表 `HKCU\...\Uninstall` 中 `DisplayName=Research Workspace`、`DisplayVersion=0.10.0`、`InstallLocation="D:\Research Workspace"`）；
- 安装内容：`research-workspace.exe`、`sidecar/rw-node.exe`、`sidecar/server/`、`uninstall.exe`，安装后约 94 MB；
- 架构：Windows x64；本轮未构建 ARM64。

说明：第一次运行安装器时 `/S` 仍显示了 “Installation Complete” 完成页；同版本重装时 `/S` 正常静默退出。安装本身成功，未影响功能或数据。该行为不影响“可安装版本”的交付，但记录在此。

## 五、Task A：Tauri v2 桌面壳

| 要求 | 验证 |
| --- | --- |
| 桌面窗口正常创建 | 实际安装版启动，CDP 看到 `http://tauri.localhost/` 页面 |
| 图标、标题、标识符稳定 | `tauri.conf.json` + `src-tauri/icons/`；标识符 `com.researchworkspace.desktop` |
| 正确加载生产前端 | 生产 URL 是 `http://tauri.localhost/`，不是 1440/1420 开发地址；安装版无 Vite |
| 浅色/深色主题 | 桌面验收点击深色/浅色，`data-theme` 分别为 `dark` / `light`，截图 `01b-dark.png` |
| PDF.js Worker | 开发模式资源记录中出现 `pdf.worker.min.mjs`；发布版 PDF 正常渲染文字层与画布 |
| KaTeX 字体与公式 | 公式模式 Mock 回答渲染出 3 个 `.katex`，字体为 `KaTeX_Main, math, "Times New Roman", serif` |
| Blob / File API / 本地 PDF | 通过文件输入导入 PDF，写入 IndexedDB；重启后仍可打开 |
| 不依赖远程 CDN | 开发页面资源全部来自 `127.0.0.1:1440`、`ipc.localhost`、`data:`/`blob:`；生产 CSP 只允许本地 |
| 不重构阅读/知识视图 | 现有 React 视图未改结构，仅增加桌面状态角标与传输层 |

开发模式与生产模式分离：

- 开发：`npm run desktop:dev` → Vite `127.0.0.1:1440` + `tauri dev --config src-tauri/tauri.dev.conf.json`；
- 生产：`npm run desktop:build` → 嵌入 `dist`，不读取 `devUrl`；
- 开发标识符 `com.researchworkspace.desktop.dev`，数据目录与安装版分离；
- 开发端口从 1420 改为 1440：本机 Windows 的 Hyper-V/WSL 保留了 TCP 1334–1433，1420 绑定会报 `EACCES`。

## 六、Task B：本地 AI 服务的桌面生命周期

验收证据（发布版）：

- 应用启动后子进程为 `D:\Research Workspace\sidecar\rw-node.exe`，父进程是 `research-workspace.exe`；
- sidecar 只监听 `127.0.0.1`，观测端口如 7715、11435、12267，均不是 8787；
- 在 8787 上启动陷阱 HTTP 服务，整个桌面验收期间收到 0 个请求；
- 通过 IPC 取得 `baseUrl` 与令牌；带令牌健康检查返回 200，`instanceId` 与 IPC 一致，`provider=mock`、`online=false`；
- 不带令牌的同一健康检查返回 401；
- 正常关闭应用后对应 sidecar PID 消失；
- 强制结束应用后 sidecar 在 10 秒内消失（实测很快）；
- 状态角标在失败时显示具体错误，并提供“重启服务”；
- 安装后的应用使用自带 `rw-node.exe`；系统 Node 虽仍安装，但进程路径证明应用没有使用它。

## 七、Task C：桌面数据持久化与迁移

### 7.1 实际存储位置

- 生产：`C:\Users\user\AppData\Local\com.researchworkspace.desktop\webview`（WebView2 的 `EBWebView`）；
- 开发：`C:\Users\user\AppData\Local\com.researchworkspace.desktop.dev\webview`；
- `rw.projects`：项目、论文元数据、批注（LocalStorage）；
- `rw.knowledge`：知识 schema v2，概念、证据、关系、拒绝记录（LocalStorage）；
- PDF 内容：IndexedDB，内容寻址（SHA-256）；
- 备份：`.rwbackup` 文件，由用户显式导出/导入。

桌面 WebView 与 Edge/Chrome 的存储是隔离的。应用没有读取、复制或修改 Edge/Chrome 的用户配置目录；迁移路径是 **用户在浏览器导出 `.rwbackup` → 在桌面应用导入**。

### 7.2 迁移与持久化验收

| 检查 | 结果 |
| --- | --- |
| 关闭并重新打开，数据仍在 | 通过（项目、笔记、概念、PDF） |
| 同版本重装后数据仍在 | 通过：重装后读取到 8 个项目、15 篇论文、9 条笔记、9 个概念、3 条已确认关系、1 条拒绝记录，schema v2 |
| 普通界面更新不更换存储 origin | 标识符固定；开发与生产用不同标识符，避免互相污染 |
| schema v2 正常 | `rw.knowledge.version === 2` |
| PDF 内容寻址去重 | 重复导入同一文件会提示“仍然新建 / 加入已有论文”；同文件只存一份 |
| 拒绝记录保留 | 导入 Phase 9 旧备份后 `rejections=1`，知识视图显示“已拒绝的关系建议” |
| 备份与恢复 | 桌面导出 `.rwbackup` 成功；在桌面应用中重新导入并通过回读校验 |
| 旧 `.rwbackup` | 导入 `.cache/verify/phase9-research-workflow.rwbackup` 成功，项目、5 条笔记、3 条已确认关系、1 条拒绝记录恢复 |

风险与限制：

- WebView2 数据与**应用标识符/数据目录**绑定；未来若更换标识符或 `data_directory`，旧数据不会自动出现。必须保持稳定，迁移通过 `.rwbackup`。
- 本轮没有改为原生应用数据目录；继续使用 WebView2 的 LocalStorage/IndexedDB，已明确记录该依赖。
- 应用数据默认在 `%LOCALAPPDATA%`（C 盘）；这是 Windows 桌面应用的标准位置，不影响本轮“工具链尽量不装 C 盘”的约束。如需要可后续通过 `appDirectoriesOverride` 迁到 D 盘，但会改变数据路径，必须配套备份迁移。
- 验收过程中在应用数据中创建了多个 `桌面验收 ...` 测试项目和 `Phase 9 真实精读` 恢复项目；它们都是本轮测试数据，可在界面“管理项目”中删除，未删除真实用户数据。

## 八、Task D：桌面 API Key 管理

本轮未实现在线模型配置：

- 桌面 sidecar 强制离线 Mock，启动不会发起任何真实付费请求；
- 不读取 `.env.live`；安装包与前端构建中没有 API Key；
- `dist/` 中未发现 `DEEPSEEK_API_KEY` 或 `sk-…` 形式的密钥；
- sidecar 的 Provider 代码只在服务端读取环境变量，且桌面启动时环境被清空；
- 安全的系统凭据存储（Windows Credential Manager / keyring）尚未接入，在线 Provider 配置明确标记为待完成。

这是按本轮授权范围做的取舍：先交付安全、可离线运行的桌面版，不以明文存储换取功能完整。

## 九、Task E：Windows 独立运行验收

### E1 开发环境：17/17

- Tauri dev 成功启动，页面地址 `http://127.0.0.1:1440/`；
- React 界面、PDF 导入/渲染、翻页、文字选择、高亮、笔记、AI Mock 均通过；
- 中文/希腊字母/特殊字符的 PDF 页面在桌面 WebView 中正确提取与渲染（截图 `02-dev-cjk-pdf.png`）；
- 开发数据目录与安装版分离；
- 自带 sidecar 启动，AI 状态“离线 Mock”；
- 无控制台错误；无远程第三方脚本；
- 8787 旧端口未被连接（发布版专项陷阱测试）。

证据：`docs/screenshots-phase10/2026-10-18T12-12-57-dev/`（17/17，`verify.log`、`report.json`）。

### E2 正式构建

见第四节。安装包与可执行文件均已生成，资源包含 sidecar 运行时与 server 源码。

### E3 独立运行：44/44

在 `D:\Research Workspace` 的安装版上执行 `npm run verify:desktop`，全部通过：

1. 不运行 Vite 开发服务器；
2. 不运行外部 npm 服务；
3. 不依赖项目源代码目录（应用从 `D:\Research Workspace` 启动）；
4. 不要求全局 Node.js（进程路径为自带 `sidecar/rw-node.exe`）；
5. 应用启动；
6. PDF 阅读、翻页、文字层、画布；
7. AI Mock 回答与离线来源标识；
8. 高亮、笔记、知识概念创建/保存；
9. 关闭重启后数据仍在；
10. 导入 Phase 9 旧 `.rwbackup` 成功；
11. 桌面导出新的 `.rwbackup` 成功；
12. 退出后自有服务进程关闭（正常退出 + 强杀）。

补充：同版本重装后数据仍在（8 个项目、15 篇论文、9 条笔记、9 个概念、3 条关系、1 条拒绝）。

证据：`docs/screenshots-phase10/2026-10-18T12-25-45-desktop/`（44/44，`verify.log`、`report.json`、`build.log`、`reinstall.log`、12 张截图）。

未执行：

- 在隔离的 Windows 虚拟机中做“安装 → 卸载 → 重装”的完整流程；本机不是隔离环境，卸载会删除当前应用，未执行。数据保留策略已由同版本重装验证；卸载前应先导出 `.rwbackup`。

## 十、Task F：Linux 兼容准备

本轮只做静态审查，**没有在 Linux 上编译或运行**。

已完成：

- 检查 Rust 平台分支：Windows 专属只有 `data_directory` 与 verbatim 路径去前缀；没有硬编码 Windows 业务路径；
- sidecar 资源名统一 `sidecar/rw-node.exe`；`prepare-sidecar.mjs` 在非 Windows 上 `chmod 755`；
- `AI_ALLOWED_ORIGINS` 加入 `tauri://localhost`，服务端来源校验接受任意合法 scheme；
- 环境变量补充 `HOME`、`TMPDIR`；
- 数据目录使用 Tauri 应用数据目录；Linux 不设置 `data_directory`；
- 生命周期与平台无关；
- 编写 `docs/Phase10-Linux构建说明.md`，包含 Ubuntu 24.04 依赖、构建命令、验证清单与风险。

未验证：

- Linux `cargo build` / `tauri build`；
- WebKitGTK 下的 PDF.js module worker、CMap/字体、KaTeX；
- AppImage/deb 实际安装与图形运行；
- Linux 下的 WebView 数据目录与重装持久化。

三者严格区分：静态审查完成 ≠ Linux 编译成功 ≠ Linux GUI 实际运行成功。

## 十一、Task G：安全与回归

| 检查 | 结果 |
| --- | --- |
| Tauri capabilities 最小化 | `capabilities/default.json` 仅 `core:default`，窗口 `main` |
| 无 shell / fs / http 插件 | `Cargo.toml` 无 `tauri-plugin-*`；进程由 Rust `std::process::Command` 启动 |
| 生产 CSP | `default-src 'self'`；`script-src 'self'`；`connect-src 'self' http://127.0.0.1:* ipc: http://ipc.localhost`；`object-src 'none'` 等 |
| 不加载远程脚本 | 开发页面资源检查全部本地；生产 CSP 不允许远程脚本 |
| 不接受未知 HTTP 服务 | 随机端口 + 每次启动令牌 + 实例 id + `online=false` 校验 |
| PDF 不作为代码执行 | pdf.js 渲染到 canvas/文字层；CSP 禁止远程脚本；PDF 内容不进入 `innerHTML` |
| 密钥未进入构建 | `dist/` 与安装包扫描无 `sk-…`；无 `.env*`；sidecar 资源不含测试/env |
| `.rwbackup` 恢复 | 桌面 44/44 + 浏览器 backup 39/39 |
| 版本不兼容停止写入 | Phase 9 既有测试与 `verify:backup` 的“新版本备份拒绝”用例仍通过 |
| 旧网页应用仍可运行 | `verify:reader` 27/27、`verify:backup` 39/39 |

回归汇总：

- `npm run check`：63 个测试文件，**1316 项通过**；
- `npm run verify:reader`：27/27；
- `npm run verify:backup`：39/39；
- `npm run verify:desktop`：44/44；
- `npm run verify:desktop-dev`：17/17；
- Tauri 原生 `cargo check` / release 构建通过。

## 十二、修改文件与本地 Git 提交

### 提交 1：`0c01826`

`Phase 10: add the Tauri desktop shell and an authenticated AI sidecar`

- `src-tauri/`（Cargo.toml、build.rs、main.rs、tauri.conf.json、capabilities、icons）
- `server/desktop.mjs`、`server/desktop.test.mjs`
- `server/config.mjs`、`server/guards.mjs`、`server/index.mjs` 及测试
- `src/services/desktop/aiService.ts`、`src/features/desktop/AiServiceBadge.tsx`、`src/styles/desktop.css`
- `src/services/ai/client.ts` 的桌面传输
- `scripts/desktop/` 的 sidecar 准备与构建脚本
- `package.json` / `package-lock.json`（`@tauri-apps/api`）

### 提交 2：`f6c7923`

`Phase 10: fix desktop paths, dev isolation and UI overlap`

- Windows verbatim 路径去前缀（`src-tauri/src/main.rs`）
- 开发标识符 `src-tauri/tauri.dev.conf.json`，开发端口 1440（`vite.config.ts`、`.claude/launch.json`、`package.json`）
- sidecar 来源校验接受 `tauri://localhost`，401 响应带 CORS（`server/config.mjs`、`server/index.mjs`）
- 侧栏主题切换换行（`src/styles/components.css`）
- AI 状态角标移位并只让重启按钮接收点击（`src/styles/desktop.css`）
- 桌面发布/开发验收脚本（`scripts/verify/desktop.mjs`、`desktop-dev.mjs`）
- `src-tauri/Cargo.lock`
- Linux 构建说明（`docs/Phase10-Linux构建说明.md`）
- 删除已废弃的 WSL 交叉编译脚本

本报告文件随后单独提交。

## 十三、尚未解决的兼容性问题

1. **Linux 未验证**：没有 Linux 编译、打包或 GUI 实跑证据；只能作为静态审查结果。
2. **在线模型/密钥管理未完成**：桌面固定离线 Mock；系统凭据存储（Windows Credential Manager / keyring）待接入。
3. **单实例**：未实现 single-instance；同时启动两个应用实例可能争用同一个 WebView2 数据目录。日常使用应只开一个。
4. **卸载流程**：未在隔离环境执行“卸载”；当前数据默认保留在 `%LOCALAPPDATA%`，卸载前建议先导出 `.rwbackup`。
5. **Windows ARM64**：未构建；本轮只有 x64 安装包。
6. **安装器 `/S`**：首次安装仍显示完成页，重装静默退出；功能正常，但静默安装行为不完全一致。
7. **应用数据在 C 盘**：`%LOCALAPPDATA%` 是 WebView2 的标准位置；若必须迁到 D 盘，需要改变应用数据目录并做迁移验证。
8. **测试数据**：应用数据中包含本轮创建的测试项目与 Phase 9 恢复项目，尚未自动清理。
9. **Linux WebKitGTK 风险**：PDF.js module worker、CMap、KaTeX 字体与 AppImage 资源路径需要在真实 Linux 桌面逐项验证。

## 十四、Agent 执行效率复盘

本轮主要时间花在“正确的构建路径”而不是代码量上：

- 初始环境没有 Rust/MSVC，先尝试 WSL + cargo-xwin；用户指出本机已有 Visual Studio 后，定位到非默认路径 `D:\VS CODE`（注册表 `devenv.exe` 指向 `D:\vscode2` 是过期残留，最终通过搜索 `devenv.exe` 找到真实安装）；
- 第一个真实阻塞是 Tauri 的 `resource_dir()` 返回 `\\?\D:\...` verbatim 路径，Node 收到后报 `EISDIR lstat D:`；通过临时诊断日志定位并修复；
- 第二个环境问题是 Windows 保留 TCP 1334–1433，Vite 默认 1420 无法绑定；改用 1440；
- 布局问题由真实截图/自动化暴露：主题切换被侧栏裁切、AI 状态角标遮挡“提问”按钮；均用可回归的边界检查修复；
- 服务端在加入 Linux 来源后，原有“只接受 http(s)”校验导致 sidecar 拒绝启动；补测试并放宽为任意合法 scheme；
- 验收脚本复用了 Phase 3/7 的 PDF、文本选择与备份流程，避免重新发明测试夹具；
- 最终以 44 项发布版检查 + 17 项开发版检查 + 浏览器 27/27 + 39/39 + 1316 项单测收尾。

用户反馈的“左下角主题切换显示不完全”已修复并由 `侧栏主题切换在非全屏窗口中完整可见` 检查覆盖；“文字编码”方面，桌面 WebView 的中文、希腊字母、特殊字符与 CJK 文字层均已验证正常，若用户看到的是其他具体位置，需要再按该位置排查。

## 十五、验收证据索引

- 发布版最终证据：`docs/screenshots-phase10/2026-10-18T12-25-45-desktop/`
  - `verify.log`（44/44）、`report.json`、`build.log`、`reinstall.log`
  - `00-sidebar-footer.png`、`01-home.png`、`01b-dark.png`、`02-reader.png`、`03-ai.png`、`03b-formula.png`、`04-note.png`、`05-knowledge.png`、`06-backup.png`、`07-restart.png`、`09-rejection.png`、`10-reinstall.png`
- 开发模式最终证据：`docs/screenshots-phase10/2026-10-18T12-12-57-dev/`
  - `verify.log`（17/17）、`report.json`、`01-dev-home.png`、`02-dev-cjk-pdf.png`、`03-dev-ai.png`、`04-dev-note.png`
- 安装包：`src-tauri/target/release/bundle/nsis/Research Workspace_0.10.0_x64-setup.exe`
- 桌面导出的备份：`src-tauri/target/phase10-artifacts/desktop-export-*.rwbackup`
- 旧备份夹具：`.cache/verify/phase9-research-workflow.rwbackup`
- Linux 构建说明：`docs/Phase10-Linux构建说明.md`

截图与运行日志目录不纳入 Git（与 Phase 0–9 的截图目录做法一致），但保留在磁盘上，路径如上。
