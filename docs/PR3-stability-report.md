# PR #3 稳定性整改与验收记录

## 施工基线

- 日期：2026-11-06。
- 仓库：`XIAZIHAN001/research-workspace`。
- 施工分支：`fix/final-audit-remediation`；禁止合并或修改 `main`。
- 远程、本地与 PR HEAD 均核对为 `c44af0a8cc8e9229f2e0670bb793963bf1eb6728`。
- 初始工作区干净；在独立云目录克隆，没有读取或覆盖用户本地工作区、真实凭据或论文数据。
- PR 当前 open、未合并；本轮开始时没有 GitHub check-runs，也没有 review comments。

## Phase A：确认的问题

| 范围                       | 严重程度 | 基线状态                                                           | 本轮处理               |
| -------------------------- | -------- | ------------------------------------------------------------------ | ---------------------- |
| 恢复日志不可读和启动异常   | P1       | 两层 catch 都把无法判断的状态视为不存在，允许创建正常 store        | 施工中                 |
| 日志结构损坏               | P1       | 损坏对象被转成 null，缺少哈希、数量、大小边界                      | 施工中                 |
| 普通加载与恢复副本读取失败 | P1       | 读取失败被当作空数据/空槽，可能覆盖主数据或唯一恢复副本            | 施工中                 |
| 跨标签页恢复与正常写入     | P1       | 没有统一互斥协议，旧快照回滚可能覆盖并发写入                       | 施工中                 |
| AI 设置持久化              | P1       | 先改内存，再直接覆盖磁盘；写失败会不一致                           | 施工中                 |
| AI 生命周期并发            | P2       | 设置/凭据命令未统一串行化，停止子进程失败丢失所有权                | 施工中                 |
| PDF 恢复新增文件           | P2       | 无完整日志，失败或崩溃会遗留孤立文件                               | 施工中                 |
| 测试端口                   | P2       | 已使用 127.0.0.1:0，并非随机固定端口；OS 仍可能分配 fetch 禁止端口 | 施工中                 |
| CI                         | P2       | 没有自动门禁                                                       | 施工中                 |
| 凭据内存清理               | P2       | 需核对优化器与错误路径中的临时副本                                 | 施工中                 |
| AI 请求生命周期            | P2       | 三路重复逻辑；供应商在客户端取消后成功返回仍可能记为 200           | 施工中                 |
| macOS/Linux 凭据与打包     | P3       | 非 Windows 凭据后端未实现                                          | 仅规划，不扩大发布范围 |

已有 RWK2 原子凭据记录、端点绑定、响应体限制、预算估算、摘要请求代际与难点扫描取消等不重复实现。

## 基线门禁（不是最终修改的验收）

环境：Linux x86_64，Node.js 24.22.1，npm 11.9.0。

- `npm ci`：通过（缓存放在隔离临时目录）。
- `npm run check`：通过。包括 TypeScript、ESLint、Prettier、103 文件 / 1811 项 Vitest。
- Rust stable 1.99.1 与 rustfmt 安装到隔离临时目录，未改用户工具链配置。
- Linux Tauri `cargo test`：依赖编译到系统库发现阶段被缺少 `glib-2.0` 阻塞；不是测试通过。

## 最终门禁

历史 PR 中的 1811 项 Vitest、37 项 Rust 和桌面冒烟数字不代表本轮验收。

- `npm run check`：通过。TypeScript、ESLint、Prettier 和 **112 个文件 / 2056 项 Vitest，0 失败、0 跳过**。
- `npm run build`：通过；保留 Vite 既有的大于 500 kB chunk 提示，未通过提高阈值隐藏。
- 本轮新增 **245 项 JS/TS 回归**（恢复/存储 196、AI 设置 8、服务/端口/预算 41）和 **15 项 Rust 回归**。
- `cargo fmt --check`：通过。
- Windows GNU 目标完整 Tauri `cargo check --release --all-targets`：通过（包含测试代码类型检查）。
- 从当前源码构造的隔离 Rust 逻辑 harness：49/49 通过；不含 Windows Credential Manager 的实际调用验收。
- 浏览器脚本：`scripts/verify/stability.mjs`，包含 19 个计划检查；本地受环境阻塞，没有执行任何浏览器断言。
- GitHub Actions：包含 Node.js 22.13/24 全量门禁、Node24 隔离 Chromium 验收、Windows Rust fmt/test/release、Tauri/NSIS 与产物保存。远程结果以当前提交的 Checks 为准，定义工作流不代表执行通过。

## 独立复审

复审不仅检查本轮 diff，也复查了受影响的旧路径。独立故障注入复现并关闭：

1. 未捕获的畸形 HTTP 请求地址使 sidecar 退出。
2. 负数/非有限/非安全整数 usage 污染预算；现按预留上界保守结算。
3. 切换供应商后旧进程停止失败，删除旧供应商 Key 仍可能跳过撤销。
4. IndexedDB 中已存在但值为 undefined 的 journal 被当作不存在。
5. 主数据读取失败，以及已占用恢复副本槽位读取失败，被当作空值导致覆盖。
6. 运行中后台 GC 暂停写入导致编辑动作丢失；现仅在启动前回收一个候选文件。

另补齐保留属性名模型的价格查询校验，未知模型不会被当成已有价格行或产生 NaN 费用。
复审没有发现仍未关闭的确定性 P0/P1/P2 代码问题；这不替代平台实际执行验收，也不是合并许可。

## 当前环境限制

- Chromium 本地启动在 `process_singleton_posix.cc` 报 `socket() failed: Operation not permitted (1)`；普通执行与获批提权执行结果一致。隔离浏览器脚本已准备，**0 项浏览器断言在本地执行**。新增 CI 将在具备 Chromium 的 runner 上执行该脚本，结果须单独核对。
- Linux 完整 Tauri 测试缺少 `glib-2.0`。已在隔离临时目录补齐 Windows Rust target 与官方 Debian binutils，完整 Tauri Windows debug 和 release/all-targets 交叉编译实际通过；这仍不是 Windows 程序执行、MSVC 链接或 NSIS 安装验收。
- 本轮未运行 Windows 图形桌面安装验收，不沿用此前 PR 的冒烟结论。

## Windows 桌面人工门禁

当前执行环境为 Linux，不能把 Chromium 网页验收或 Linux Rust 独立模块测试写成 Windows 桌面验收。
必须在隔离 Windows 账户或干净 WebView 数据目录，对最新 NSIS 产物执行：

1. 安装并启动，确认版本、提交与产物 SHA-256。
2. Mock 请求成功，无付费 API 调用。
3. 隔离假 Key 保存、端点绑定、换端点拒绝、删除后回到 Mock。
4. sidecar 停止与重启，快速设置切换，错误实例身份与启动失败提示。
5. PDF 导入、阅读、笔记保存；导出备份、恢复、强制退出与重启持久化。
6. journal 读失败/损坏、跨标签页竞争、恢复中止及 PDF 回收。
7. 退出和强杀后确认没有孤儿 sidecar。
8. 确认正式数据与真实凭据没有被访问或更改。

未执行项目必须保留为未验证，不以 CI 构建替代 GUI 验收。

## 凭据内存清理范围

Rust 拥有的密钥字符串、编码凭据及子进程 stdin 临时缓冲区使用 `zeroize`/RAII 清理，错误路径同样释放并清理。此保证不延伸到 JavaScript/Tauri IPC、HTTP Authorization 内部副本、操作系统管道或 Node/V8 内存。真实密钥未被读取、覆盖或删除；测试只使用虚构值和隔离后端。

## 跨平台后续计划（P3）

- 保留当前 Windows Credential Manager 后端和 RWK2 原子记录语义。
- 未来可在现有后端接口下实现 macOS Keychain、Linux Secret Service；不得降级为明文配置文件。
- 各平台都需验证凭据不可用时失败关闭、端点绑定、删除撤销、进程所有权与 EOF 看门狗。
- macOS 签名/公证、Linux WebKitGTK/Secret Service 会话依赖以及平台权限需独立发布验收。
- 当前只承诺 Windows 目标；非 Windows 在线 AI 仍不可用。

## 分阶段提交与文件范围

| 提交      | 问题范围                             | 主要文件                                                                                                                                | 验证                                                                      |
| --------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `b8863e5` | P1 恢复/存储与 P2 PDF 回收           | `main.tsx`、`workspaceAccess.ts`、`workspaceStartup.ts`、`restoreJournal.ts`、`backupService.ts`、各 store、BackupDialog/App 与回归测试 | 全量 2056 测试及对应故障注入                                              |
| `32ea088` | P1 设置原子性与 P2 凭据/进程生命周期 | `src-tauri/src/{main,credentials,preferences,lifecycle}.rs`、AI adapter/panel 与回归测试                                                | 49 Rust 逻辑测试、Windows release/all-targets 类型检查、13 项设置定向测试 |
| `10ccd75` | P2 服务生命周期/预算/端口/CI         | `server/index.mjs`、provider、pricing/tokenUsage/loopback、Actions、`scripts/verify/stability.mjs`                                      | 服务回归及全量门禁；浏览器/Windows 实际运行仍需远程或人工验证             |

本报告和 README 单独提交，保留上述代码提交的可追溯关系。未合并 PR，未修改 main。

## 尚未验证与合并建议

1. 远程 Actions 的准确提交结果必须另行检查；不能把工作流存在当作 CI 成功。
2. 本地隔离 Chromium 启动受限；本地 19 项计划检查均未执行。
3. Windows 实机运行、Credential Manager、NSIS 安装与完整桌面验收仍需执行；交叉编译不替代这些检查。
4. 一次仅允许一个升级后的可编辑窗口；旧应用版本必须先关闭。Web Locks 不可用会明确阻断启动。
5. 孤立 PDF 仅处理恢复日志派生的候选，每次启动最多清理一个；未知或引用信息无法确认的文件保留，不做全盘盲删。
6. macOS/Linux 系统凭据后端仍未实现，不阻塞 Windows 代码整改，但不宣称跨平台在线 AI 支持。

**建议：等待当前提交的远程 CI 和隔离 Windows 桌面验收完成后再考虑合并 PR #3；本轮没有执行合并或部署。**
