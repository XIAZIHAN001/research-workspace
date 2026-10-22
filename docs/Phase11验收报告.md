# Phase 11 验收报告：桌面版真实 AI 接入与生产使用安全加固

生成日期：2026-10-19
分支：`phase11-desktop-ai`
基线：`0181f6c`（Phase 10 报告提交）
实现提交：`b249e22`（桌面 AI 凭据、模式切换、费用控制与单实例；本报告随后单独提交）

## 一、结论

Phase 11 的目标已完成，并且**没有发出任何真实付费 DeepSeek 请求**：

- 桌面版现在可以在 Windows Credential Manager 中保存 DeepSeek API Key，前端只能看到“已配置/未配置”，不能读回明文；
- 离线 Mock 与 DeepSeek 官方 API 两种模式可显式切换；应用每次启动都从离线 Mock 开始；
- 在线模式通过真实桌面链路工作：Rust 启动 sidecar → stdin 一次性传递密钥 → Node sidecar 使用 DeepSeek Provider → 引用校验 → React 界面；
- 会话级费用保护已落地：请求数、单次生成 token、会话 token 上限，服务端在调用前拒绝超额请求，且没有隐式重试；
- 单实例已启用：第二次启动退出自身并聚焦已有窗口，不启动第二个 sidecar；
- Windows 0.11.0 安装包已生成并完成升级、同版本重装、数据持久化、旧 `.rwbackup` 兼容验证；
- 开发版在线路径已用本地 DeepSeek 模拟器完成 13/13 UI 级联调，覆盖真实选区、引用校验与在线回答标识；
- 用户反馈的“模型选择界面显示不全”已定位并修复：通用对话框固定 440px 宽导致右侧裁切；现在对话框按内容加宽、自身滚动，并在打开动画结束后完全不透明。

本报告明确区分三类结论：

1. **本地 Windows 实机已验证**：安装、升级、重装、单实例、凭据、模式、Mock 链路、本地模拟在线链路、数据持久化；
2. **静态审查完成**：Linux 兼容边界；
3. **未验证**：全新 Windows 机器（无 WebView2/无开发工具）上的安装与卸载流程；Linux 编译与 GUI 运行。

## 二、基线与构建

### 2.1 基线

| 项目 | 值 |
| --- | --- |
| 分支 | `phase10-tauri-desktop` → 新建 `phase11-desktop-ai` |
| 最后提交 | `0181f6c` |
| Phase 10 版本 | 0.10.0 |
| Phase 10 安装包 | `Research Workspace_0.10.0_x64-setup.exe`（保留未覆盖） |
| `npm run check` 基线 | 63 个测试文件 / 1316 项 |
| 正式数据目录 | `C:\Users\user\AppData\Local\com.researchworkspace.desktop\webview` |
| 磁盘 | D 盘剩余约 269 GB（构建前） |

### 2.2 Phase 11 构建结果

| 项目 | 值 |
| --- | --- |
| 版本 | 0.11.0（`package.json`、`Cargo.toml`、`tauri.conf.json`） |
| Tauri | 2.12.4 |
| 单实例插件 | `tauri-plugin-single-instance` 2.5.4 |
| 凭据访问 | `windows-sys` 0.61.2，直接调用 `CredWriteW` / `CredReadW` / `CredDeleteW` |
| Node sidecar | 打包的 Node 24.14.1（`rw-node.exe`） |
| 构建方式 | 原生 Windows MSVC（`scripts/desktop/msvc-env.cmd` + `npm run desktop:build`） |
| 可执行文件 | `src-tauri/target/release/research-workspace.exe`（6,232,576 字节，SHA-256 `6bc6355992aa40b4714857022feff3b12c1c9f54323225d87be7661684f465a0`） |
| 安装包 | `src-tauri/target/release/bundle/nsis/Research Workspace_0.11.0_x64-setup.exe`（27.55 MiB） |
| 安装包 SHA-256 | `a7f48e474cfb73f18ecb37e9fc0f28f7383ea27468779878f24837e2d6c08362` |
| 安装位置 | `D:\Research Workspace`（NSIS currentUser，无 UAC） |
| 安装内容 | `research-workspace.exe`、`sidecar/rw-node.exe`、`sidecar/server/`、`uninstall.exe` |

构建命令：

```bat
call "D:\VS CODE\VC\Auxiliary\Build\vcvars64.bat"
set "RUSTUP_HOME=D:\Rust\rustup"
set "CARGO_HOME=D:\Rust\cargo"
set "PATH=D:\Rust\cargo\bin;%PATH%"
npm run desktop:build
```

本轮修复了 `scripts/desktop/msvc-env.cmd` 的一个真实缺陷：`endlocal` 只保留了 `PATH`，丢掉了 `vcvars64` 设置的 `INCLUDE`/`LIB`/`LIBPATH`，导致 `vswhom-sys` 的 C++ 构建以“cl.exe 退出码 2、无错误文本”失败。修复后 release 构建稳定通过。

## 三、Gate 0：架构与安全审查结论

保留 Phase 10 已验证的架构，不重写 Rust 后端：

```text
Tauri 应用进程
  ├─ WebView2（React 生产构建，无远程脚本）
  ├─ Rust 壳
  │    ├─ Windows Credential Manager（仅 Windows，当前用户）
  │    ├─ 单实例守卫（按 bundle identifier）
  │    └─ sidecar 生命周期 / 每次启动随机 Bearer / 实例 id / 模式与预算
  └─ rw-node.exe（打包的 Node 24）
       ├─ 127.0.0.1 临时端口（AI_PORT=0）
       ├─ Host / Origin / Bearer / instanceId 校验
       ├─ Mock 或 DeepSeek Provider（端点固定为官方）
       └─ 引用校验、难点协议、知识关系校验、费用预算
```

关键决策：

1. **密钥不进入环境变量或命令行参数**。Rust 在 spawn 后通过子进程 stdin 写入一行 `RW_AI_SECRET {"apiKey":"…"}`；sidecar 只接受一次，20 秒内未收到则退出在线模式。
2. **sidecar 环境仍然 `env_clear()`**，只恢复 Windows 必需变量、会话令牌、实例 id、模式、预算和白名单来源；父进程的 `DEEPSEEK_API_KEY`、代理、Provider 选择都不会进入子进程。
3. **密钥只在 Rust 与 sidecar 内存中存在**。Rust 在写入后立即覆盖本地字符串与 JSON 字节；sidecar 创建 Provider 后丢弃自己的额外引用。JavaScript 字符串无法可靠清零，这是运行期内存的已知边界。
4. **凭据由 Rust 独占**。前端 IPC 只有 `ai_credentials_status`（布尔）、`set_ai_api_key`（单向写入）、`delete_ai_api_key`；没有读取明文的接口。
5. **开发版使用独立凭据目标** `ResearchWorkspace/DeepSeekApiKey.dev`，避免验收脚本覆盖正式 Key；正式版为 `ResearchWorkspace/DeepSeekApiKey`。
6. **不启用通用文件系统/shell 权限**。Tauri capabilities 仍只有 `core:default`；没有 fs、shell、http、updater、telemetry 插件。
7. **端点固定**。正式桌面只接受 `https://api.deepseek.com`；测试模拟器仅能在 debug 构建中通过 `RW_AI_TEST_UPSTREAM`（且必须是回环地址）启用，release 构建没有该分支。
8. **数据位置不变**。项目、论文、批注在 WebView2 LocalStorage/IndexedDB；预算设置是普通 JSON（`%APPDATA%\com.researchworkspace.desktop\ai-preferences.json`），不含密钥；备份 `.rwbackup` 不包含凭据。

## 四、Task A：系统级 API Key 管理

### 4.1 存储方案

- Windows 正式版：Credential Manager，`CRED_TYPE_GENERIC`，`CRED_PERSIST_LOCAL_MACHINE`，目标名 `ResearchWorkspace/DeepSeekApiKey`，当前 Windows 用户作用域；
- 读取、写入、删除分别调用 `CredReadW`、`CredWriteW`、`CredDeleteW`，`CredFree` 释放系统缓冲区；
- 写入前校验：8–512 个字符、仅可打印 ASCII、去首尾空白；拒绝空值、空格、非 ASCII；
- 删除不存在的凭据视为成功（目标状态已满足）；
- 凭据读取失败只返回“Windows 错误码 + 动作”，不回显内容；
- Linux：`credentials.rs` 保留同一接口，但当前实现明确返回“尚未接入系统凭据存储，Linux 版本未验证”，不伪装已支持。

### 4.2 安全验收

| 要求 | 结果 | 证据 |
| --- | --- | --- |
| 前端只看到已配置/未配置 | 通过 | `AiSettingsDialog` 只渲染布尔状态；IPC 无读取接口 |
| 密钥不进入 LocalStorage | 通过 | 正式版写入测试 Key 后，`JSON.stringify(localStorage)` 不含 Key |
| 密钥不进入 IndexedDB/WebView 数据 | 通过 | 递归扫描 `%LOCALAPPDATA%\com.researchworkspace.desktop\webview` 未发现 Key |
| 密钥不进入普通 JSON 配置 | 通过 | `ai-preferences.json` 仅含预算，扫描不含 Key |
| 密钥不进入 URL/命令行/控制台/日志/错误弹窗 | 通过 | 密钥仅走 stdin；sidecar stderr/stdout 扫描不含 Key；Rust 错误不含内容 |
| 删除后不继续使用旧凭据 | 通过 | 删除即停止在线 sidecar 并回到 Mock；重启后仍为未配置 |
| 首次输入可通过受控 IPC 传递 | 通过 | 输入框 → `set_ai_api_key` → Credential Manager；保存后输入框清空 |
| 替换 Key | 通过 | 在线模式下替换会重启 sidecar 并重新经 stdin 注入 |
| 不启用通用 fs/shell | 通过 | `capabilities/default.json` 仅 `core:default` |

### 4.3 Rust 凭据存储测试

`cargo test credentials`：3/3 通过。

- 使用随机测试目标 `ResearchWorkspace/__test__/<uuid>`，不触碰正式凭据；
- 覆盖写入→读回→删除、删除不存在的凭据、覆盖旧值；
- 测试后清理测试目标。

## 五、Task B：桌面版 Mock / DeepSeek 模式切换

### 5.1 运行规则

1. **每次启动固定为离线 Mock**，即使上次会话使用过在线模式；不持久化模式选择；
2. 在线模式必须已有系统凭据；未配置时 `set_ai_mode` 返回错误；
3. 切换模式 = 停止旧 sidecar → 生成新令牌/新实例 id → 重新 spawn → 在线模式从 Credential Manager 重新读取并注入 Key；
4. Rust 校验 ready 行的 `desktopInstance`、`provider`、`online`、`model`，任何不匹配都停止子进程并显示失败；
5. 前端不能设置 base URL、模型、Provider；API 端点只来自 Rust 的固定配置；
6. 不使用 8787；sidecar 每次绑定临时回环端口；
7. Provider 失败不会回退到 Mock 或另一个付费模型；失败如实显示；
8. Mock 回答在界面和响应中始终标注 `provider=mock`、`online=false`，不会伪装成真实 AI；
9. 应用启动、恢复备份、导入论文均不发起模型请求；
10. Phase 5 自动难点分析在在线模式下需要**与当前服务实例绑定的会话级显式同意**；切换模式/重启服务会撤销同意，自动分析暂停，直到用户重新确认。

### 5.2 验收

- 正式安装版：默认 Mock → 写入测试 Key → 在线模式成功启动 `deepseek-flash` → 健康状态 `online=true` → 会话请求数保持 `0 / 50` → 切回 Mock → 重启仍默认 Mock；
- 在线模式启动没有任何模型调用，证明“切换模式本身不计费”；
- 开发版本地模拟器：真实选区 → 在线提问 → 回答经 sidecar/provider/引用校验返回 → 引用 `[1] 第 1 页` 通过校验 → 模拟器收到请求且只发送到本地回环；
- 8787 陷阱测试仍为 0 请求（Phase 10 回归）。

## 六、Task C：完整 AI 阅读链路

本轮没有重写 AI 协议，复用 Phase 4–9 的提示词、引用校验、难点协议和知识关系校验。桌面在线模式下已验证：

| 能力 | 实现/验证 |
| --- | --- |
| 普通 AI 对话 | 桌面 UI → Rust 传输 → sidecar `/api/ai/ask`；本地模拟器 13/13 |
| 「向这段文字提问」 | 真实 PDF 选区、页码、论文哈希随请求发送；模拟器请求体检查通过 |
| 英文原文解释与翻译 | 复用现有 `explain/translate` 模式；Provider 切换不影响提示词与校验 |
| 数学公式讲解与 KaTeX | Phase 10 桌面 KaTeX 回归 44/44 中仍通过 |
| 主动难点分析 | 单页、需开启、在线需会话级同意；模式切换会暂停自动分析 |
| 知识概念与关系建议 | Node 级在线模拟测试验证 2 个概念 + 1 条 `definition` 关系，引用逐字校验通过；关系仍为建议，不会自动确认 |
| 加载/失败/取消 | 既有 UI 状态保留；取消会中止上游请求；sidecar 中途退出会显示失败并可重启 |
| sidecar 重启 | 新令牌、新实例 id；前端每次请求重新取传输信息 |
| 失败不破坏数据 | AI/知识失败只写入状态字符串，不写项目/笔记/知识库 |
| 上下文范围 | AI 面板显示“选中/同页上下文/合计字数”；知识面板显示计划发送字数；难点一次一页 |
| 私有论文告知 | 在线模式确认框与面板费用提示明确说明发送范围；Mock 模式明确“不发起在线调用” |

本地模拟器覆盖的异常：

- 合法引用、非法引用（不在原文中的引文被丢弃并提示）；
- 合法知识建议（概念、关系、逐字引文）；
- 401 / 402 / 429 / 5xx 映射为 `auth` / `insufficient-balance` / `rate-limit` / `upstream`；
- 超时（504 `timeout`）、用户取消（连接中止，服务仍可用）；
- 损坏/不完整 JSON、协议损坏（沿用既有解析与恢复规则）；
- sidecar 中途异常退出与重启（Phase 10 生命周期回归 + Phase 11 模式切换）。

## 七、Task D：费用控制

### 7.1 服务端预算

默认值（可在 AI 设置中修改）：

| 限制 | 默认 | 范围 |
| --- | --- | --- |
| 会话请求数（含失败尝试） | 50 | 1–1000 |
| 单次生成 token（含思考） | 8192 | 256–32000 |
| 会话 token 上界 | 200,000 | 256–10,000,000 |

实现要点：

- 每次调用前以“估算输入 token + 本次生成上限”做**悲观上界检查**，并在调用前预留；并发请求不会各自通过后一起超额；
- 达到限制返回 HTTP 429 `budget-exceeded`，消息说明是请求数还是 token 预算；
- 失败请求也计入请求次数，防止重试循环绕过预算；
- 未返回 usage 的调用按预留下界计入，并标记 `exactTokens=false`；
- Provider 不重试；客户端不重试；难点失败页不会自动循环重试；
- 重启 sidecar 视为新会话，计数清零；修改预算也会重启服务并清零。

### 7.2 用量与估算

健康检查新增：

- `usage`：请求数、输入/输出/推理 token、总 token、是否精确、估算费用、成本是否已知；
- `budget`：当前会话上限；
- `pricing`：模型、价格版本日期、来源、估算依据、可靠性。

价格配置 `server/pricing.mjs`：

- 明确记录读取日期 `2026-10-18` 与来源 `api-docs.deepseek.com/quick_start/pricing`；
- `deepseek-flash` 使用**峰值、缓存未命中输入价与峰值输出价**做保守估算；
- 按 1 USD = 8 CNY 折算；
- 未配置价格的模型返回 `known=false`、`estimatedCostCny=null`，界面明确显示“费用估算不可靠”，不猜测；
- UI 明确区分：token 用量来自模型服务；费用是估算，不是账单。

### 7.3 验收

- 单元/服务测试覆盖：请求上限、会话 token 上限、失败尝试计数、Mock 不受付费预算限制、未知模型估算不可靠、已知模型成本计算；
- 桌面 UI 显示 `本次会话请求 0 / 50`、输入/输出 token、会话 token 预算、费用估算；
- 在线模式启动后未发起请求时计数为 0，证明没有隐式调用。

## 八、Task E：单实例保护

采用 `tauri-plugin-single-instance` 2.5.4：

- 插件注册在 builder 最开始，键为应用 bundle identifier；
- 第二次启动时，第二个进程退出；已有实例收到回调后 `unminimize` + `show` + `set_focus`；
- 不结束同名进程，不启动第二个 sidecar，不并发写同一 WebView 数据目录；
- 开发版标识符 `com.researchworkspace.desktop.dev` 与正式版不同，因此两者可以并存，互不抢实例；
- 关闭后重新启动正常，不残留锁。

正式安装版实测（Phase 11 桌面验收）：

| 检查 | 结果 |
| --- | --- |
| 第二次启动进程自行退出 | 通过 |
| 只有一个 `research-workspace.exe` | 通过 |
| 只有一个 `rw-node.exe` sidecar | 通过 |
| 已有窗口被取消最小化并带到前台 | 通过（`GetForegroundWindow` 等于主窗口句柄） |
| 原窗口仍可交互 | 通过 |
| 关闭重开正常 | 通过 |

## 九、Task F：独立安装与数据可靠性

### 9.1 升级前备份（项目目录外）

按要求先备份，未删除任何数据：

- 目录：`D:\Research Workspace Backups\phase11-pre-upgrade-2026-10-19\`
- WebView2 数据完整副本：`webview\`（约 38,172,511 字节）
- 应用自身导出的备份：`pre-upgrade.rwbackup`（2,292,430 字节）

### 9.2 升级与持久化

| 阶段 | 项目 | 论文 | 笔记 | 概念 | 关系 | 拒绝 |
| --- | --- | --- | --- | --- | --- | --- |
| 0.10.0 升级前 | 10 | 19 | 11 | 11 | 3 | 1 |
| 0.11.0 升级后 | 10 | 19 | 11 | 11 | 3 | 1（立即可读） |
| 运行 Phase 10 桌面回归后 | 11 | 21 | 12 | 12 | 3 | 1 |
| 0.11.0 同版本重装后 | 11 | 21 | 12 | 12 | 3 | 1 |
| 最终 Phase 11 验收后 | 11 | 21 | 12 | 12 | 3 | 1 |

- 项目 schema 5、知识 schema v2 保持不变；
- 旧 `.rwbackup`（Phase 9 研究流程）在桌面版导入成功，拒绝记录与已确认关系保留；
- 备份导出/恢复、恢复日志、写保护逻辑未改动；
- 同版本重装后数据仍在；应用标识符与 WebView 数据目录未改变。

### 9.3 无 Node / 无开发工具链启动

在 PATH 仅为 `C:\Windows\System32;C:\Windows;C:\Windows\System32\Wbem` 的进程中启动安装版：

- 应用启动，AI 状态为离线 Mock；
- sidecar 路径为 `D:\Research Workspace\sidecar\rw-node.exe`，不是全局 Node；
- IPC 取得服务地址/令牌，健康检查为 mock/offline；
- 通过 sidecar 完成一次离线问答（HTTP 200）；
- 7/7 检查通过。

这证明运行期不依赖 Node.js、Rust/Cargo 或 MSVC，但**不是全新机器验证**：本机已安装 WebView2，应用也是本项目安装的。

### 9.4 全新 Windows 环境

**未验证。** 本机可用的隔离环境检查结果：

- Windows Sandbox 可选功能不可用；
- Hyper-V 不可用；
- VMware Workstation 存在，但只有 Ubuntu 虚拟机，没有 Windows 虚拟机。

因此以下项目仍待真机/虚拟机验证：

- 未安装 Node.js 的干净 Windows 机器安装；
- WebView2 完全缺失时的 bootstrapper 行为；
- 卸载 → 重装的完整流程；
- 不同 Windows 用户/权限配置下的 Credential Manager 行为。

### 9.5 卸载与数据保留策略

- 未执行卸载（避免破坏当前正式数据）；
- NSIS 卸载器不会主动删除 `%LOCALAPPDATA%\com.researchworkspace.desktop\webview`；
- Credential Manager 中的 `ResearchWorkspace/DeepSeekApiKey` 也不会由卸载器删除；
- 建议：卸载前先在 AI 设置中删除 Key，并导出 `.rwbackup`；如确认不再使用，再手动清理应用数据目录；
- 本轮没有实现卸载钩子来删除凭据，这是有意的保守选择，避免卸载器误删用户仍需要的凭据。

## 十、用户反馈的界面缺陷与修复

### 10.1 现象

用户截图显示 AI 设置对话框右侧被裁切：DeepSeek 模式卡片只露出左侧，统计列显示不全；对话框底部也溢出窗口。

### 10.2 根因

- 通用 `.dialog.glass` 固定 `width: min(440px, calc(100vw - 32px))`；
- AI 设置内容按 760px 双列排版，`overflow` 未在对话框层处理；
- 结果：右侧内容被 440px 容器裁掉，底部没有高度上限。

### 10.3 修复

- `.dialog:has(.ai-settings)`：宽度 `min(780px, calc(100vw - 32px))`，最大高度 `min(88vh, 900px)`，`overflow-y: auto`；
- `.ai-settings`：宽度 100%，取消内层固定宽度与内层滚动，只保留对话框一个滚动容器；
- 窄屏 `max-width: 900px`：对话框宽度 `calc(100vw - 16px)`，模式卡片/统计/预算改为单列；
- 对话框背景改为不透明主题底色 + 顶部 sheen，避免侧栏/正文文字透过设置内容；
- 在线模式卡片模型名改为常量 `deepseek-flash`。此前在 Mock 模式下它读取 `health.model`，会错误显示 `mock-1`。

### 10.4 验证

在最终安装版 0.11.0 的真实窗口中测量：

- 视口 1024×689（125% 缩放下的 1280×860 窗口）；
- 对话框宽 756.6px，右边界 890.3px，未超出视口；
- 两张模式卡片右边界分别 501.3px / 859.2px，均小于对话框右边界；
- 无右侧裁切，对话框在视口内；
- 打开动画结束后 `opacity=1`，截图内容清晰可读；
- 截图：`docs/screenshots-phase11/inspect-ai-settings-final.png`（修复后）、用户反馈时的旧截图对照见同一目录的诊断截图。

## 十一、测试数据只读清单

已生成只读清单：`docs/phase11-cleanup-inventory.json`。

当前正式应用数据：

- 项目 11、论文 21、笔记 12、概念 12、关系 3；
- 所有 11 个项目名称均匹配“验收/测试/Phase/真实精读/演示”启发式，**疑似**均为 Phase 9/10/11 验收数据；
- 这些项目之间没有共享论文（`sharedWithProjects` 均为 1）；
- 部分项目包含批注或概念，删除项目不会自动删除论文/批注/概念，清单中逐项列出；
- 本轮没有删除、清空、重建任何项目或知识库数据。

清理必须在用户明确批准具体范围后执行；建议先导出 `.rwbackup` 并保留项目目录外的备份。

## 十二、Linux 兼容性边界

状态：**静态审查完成，未在 Linux 上编译或图形运行**。

- 凭据存储：Windows Credential Manager 实现为 `#[cfg(windows)]`；Linux 分支明确返回“尚未接入系统凭据存储，Linux 版本未验证”，应用仍可离线运行；
- 单实例插件：使用的 `tauri-plugin-single-instance` 2.5.4 在 Linux 上依赖 zbus/D-Bus，需在目标发行版验证；
- sidecar 名称仍为 `rw-node.exe`（Linux 上是 ELF 文件），资源路径由 Tauri 资源目录提供；
- Origin 白名单包含 `tauri://localhost`；
- WebKitGTK 下的 PDF.js module worker、CMap、KaTeX 字体、AppImage 资源路径均未验证；
- 本轮没有在科研服务器或任何 Linux 机器上安装桌面环境。

Phase 10 的 `docs/Phase10-Linux构建说明.md` 仍适用；本轮新增的凭据接口与单实例插件需要在该清单中增补实测项。

## 十三、测试与回归汇总

| 测试 | 结果 | 说明 |
| --- | --- | --- |
| `npm run check` | 66 文件 / **1341 项通过** | typecheck + eslint + prettier + vitest |
| `npm run build` | 通过 | Vite 生产构建 |
| Rust `cargo check` | 通过 | release 依赖与单实例插件 |
| Rust `cargo test credentials` | **3/3** | 真实 Credential Manager，随机测试目标 |
| Tauri release 构建 | 通过 | NSIS 安装包 27.55 MiB |
| `verify:desktop`（0.11.0 候选） | **44/44** | Phase 10 全量桌面回归；在仅影响 AI 设置对话框的 CSS 修正前运行 |
| `verify:desktop-dev`（0.11.0 候选） | **17/17** | 开发模式 PDF/笔记/主题/Mock |
| `verify:desktop-phase11`（最终安装包） | **37/37** | 凭据、模式、费用可见性、单实例、数据持久化 |
| `verify:desktop-isolated`（最终安装包） | **7/7** | 无 Node/Rust/MSVC 的 PATH |
| `verify:desktop-online-sim`（最终源码） | **13/13** | 本地 DeepSeek 模拟器 + 真实桌面 UI/选区/引用 |
| `verify:reader` | **27/27** | 浏览器阅读器回归 |
| `verify:backup` | **39/39** | 备份/恢复/冲突/回滚回归 |
| `verify:ai` | **54/54** | AI 阅读、取消、超时、日志隐私、对比度 |
| `verify:annotations` | **26/26** | 批注/锚点回归 |
| 知识回放 | **12/12，0 个不变量问题** | Phase 8.1 真实响应零费用回放 |

证据目录（未纳入 Git，按 Phase 0–10 的惯例保留在磁盘）：

- `docs/screenshots-phase11/2026-10-19T07-50-04-desktop-ai/`（37/37，最终安装包）
- `docs/screenshots-phase11/2026-10-19T07-50-38-isolated-env/`（7/7）
- `docs/screenshots-phase11/2026-10-19T07-51-00-dev-online/`（13/13）
- `docs/screenshots-phase11/inspect-ai-settings-final.png`（对话框修复后）
- `docs/screenshots-phase10/2026-10-19T05-13-50-desktop/`（44/44）
- `docs/screenshots-phase10/2026-10-19T05-19-32-dev/`（17/17）

## 十四、本轮实际缺陷与修复

1. **MSVC 环境丢失 INCLUDE/LIB**：`msvc-env.cmd` 的 `endlocal` 只保留 PATH，`vswhom-sys` 的 C++ 编译失败；已保留 `INCLUDE`/`LIB`/`LIBPATH`/`VSCMD_ARG_TGT_ARCH`。
2. **AI 设置对话框右侧裁切、底部溢出**：通用 440px 宽 + 760px 内容 + 无高度上限；已用 `:has(.ai-settings)` 加宽、限高、单滚动容器并改为不透明背景。
3. **在线模式卡片显示 `mock-1`**：Mock 模式下读取了 `health.model`；已改为常量 `deepseek-flash`。
4. **开发在线模拟脚本未进入 MSVC 环境**：`tauri dev` 首次启动失败；已通过 `msvc-env.cmd` 启动。
5. **模拟器引文提取读错消息**：只读系统消息，导致“没有可引用的选区”；已遍历全部消息并取出 `[selection]` 段落。
6. **历史截图被回归脚本覆盖**：运行 `verify:reader` 时更新了 `docs/screenshots-reader/` 下 7 张受 Git 跟踪的截图；已在提交前用 `git checkout` 恢复，未进入本轮提交。

## 十五、本地 Git 提交

- `b249e22` `Phase 11: add Desktop AI credentials, modes and cost controls`
  - Rust：`credentials.rs`、`main.rs`（凭据、模式、预算、单实例、stdin 密钥通道）
  - sidecar：`config.mjs`、`desktop.mjs`、`index.mjs`、`pricing.mjs`
  - 前端：AI 设置对话框、状态角标、侧栏入口、模式/费用类型、难点自动分析同意
  - 测试：预算/价格/在线模拟/凭据/UI
  - 脚本：Phase 11 桌面验收、开发在线模拟、隔离 PATH、只读清单、备份导出
  - 版本：0.10.0 → 0.11.0
- 本报告与只读清单随后单独提交；未执行远程 push。

## 十六、待授权的真实 DeepSeek 小规模上线验收方案

本轮**未**使用真实 DeepSeek API；Phase 8.1 的 ¥2 测试授权**不**延续到本轮或以后。建议在用户明确授权后执行：

1. **前置**
   - 用户在本机 AI 设置中输入真实 Key（不通过聊天、文件或命令行传递）；
   - 先导出 `.rwbackup` 并保留项目目录外副本；
   - 将预算设为：请求 ≤ 4 次、单次生成 ≤ 4096 tokens、会话 ≤ 60,000 tokens；
   - 确认为 Mock 启动，再显式切换到在线模式，并确认费用提示。

2. **用例（只读现有论文，不批量扫描）**
   - 第 1 次：单页选中一段英文，执行“解释这段话”，检查引用逐字校验、模型名、在线标识；
   - 第 2 次：单页公式，执行“解释数学公式”，检查 KaTeX 与引用；
   - 第 3 次：同一页的“向这段文字提问”，检查上下文范围与 token/费用统计；
   - 第 4 次：知识分析，检查概念/关系建议、引文校验、关系不自动确认；若预算不足则停止，不重试。

3. **检查**
   - 每次都记录 `instanceId`、模型、输入/输出 tokens、估算费用、状态；
   - 确认费用估算与官方账单的差异，更新价格配置日期或标记估算不可靠；
   - 确认失败（401/402/429/5xx/超时）没有重试、没有回退、没有破坏笔记/知识；
   - 完成后切回 Mock，删除 Key，导出一次备份并校验。

4. **停止条件**
   - 达到 4 次请求或会话 token 上限；
   - 出现 402/401 或任何非预期模型；
   - 用户在任意时刻要求停止。

## 十七、交付物索引

- 安装包：`src-tauri/target/release/bundle/nsis/Research Workspace_0.11.0_x64-setup.exe`
- SHA-256：`a7f48e474cfb73f18ecb37e9fc0f28f7383ea27468779878f24837e2d6c08362`
- 可执行文件：`src-tauri/target/release/research-workspace.exe`（SHA-256 `6bc6355992aa40b4714857022feff3b12c1c9f54323225d87be7661684f465a0`）
- 升级前备份：`D:\Research Workspace Backups\phase11-pre-upgrade-2026-10-19\`
- 只读测试数据清单：`docs/phase11-cleanup-inventory.json`
- 凭据目标：正式 `ResearchWorkspace/DeepSeekApiKey`；开发 `ResearchWorkspace/DeepSeekApiKey.dev`
- 预算配置：`%APPDATA%\com.researchworkspace.desktop\ai-preferences.json`（不含密钥）
- 应用数据：`%LOCALAPPDATA%\com.researchworkspace.desktop\webview`
- 证据截图：`docs/screenshots-phase11/`（不纳入 Git）

## 十八、停止点

Phase 11 到此停止：

- 未使用真实 DeepSeek API，未产生新的付费请求；
- 未执行远程 Git push、自动更新或线上发布；
- 未删除任何测试项目或用户数据；
- 未在 Linux 或科研服务器上安装桌面环境；
- 下一步（真实 Key 小规模在线验收）需要用户单独授权。
