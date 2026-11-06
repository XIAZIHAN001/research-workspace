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
| 恢复日志不可读和启动异常   | P1       | 两层 catch 都把无法判断的状态视为不存在，允许创建正常 store        | 已修复                 |
| 日志结构损坏               | P1       | 损坏对象被转成 null，缺少哈希、数量、大小边界                      | 已修复                 |
| 普通加载与恢复副本读取失败 | P1       | 读取失败被当作空数据/空槽，可能覆盖主数据或唯一恢复副本            | 已修复                 |
| 跨标签页恢复与正常写入     | P1       | 没有统一互斥协议，旧快照回滚可能覆盖并发写入                       | 已修复                 |
| AI 设置持久化              | P1       | 先改内存，再直接覆盖磁盘；写失败会不一致                           | 已修复                 |
| AI 生命周期并发            | P2       | 设置/凭据命令未统一串行化，停止子进程失败丢失所有权                | 已修复                 |
| PDF 恢复新增文件           | P2       | 无完整日志，失败或崩溃会遗留孤立文件                               | 已修复                 |
| 测试端口                   | P2       | 已使用 127.0.0.1:0，并非随机固定端口；OS 仍可能分配 fetch 禁止端口 | 已修复                 |
| CI                         | P2       | 没有自动门禁                                                       | 已配置                 |
| 凭据内存清理               | P2       | 需核对优化器与错误路径中的临时副本                                 | 已修复                 |
| AI 请求生命周期            | P2       | 三路重复逻辑；供应商在客户端取消后成功返回仍可能记为 200           | 已修复                 |
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

- `npm run check`：通过。TypeScript、ESLint、Prettier 和 **116 个文件 / 2298 项 Vitest，0 失败、0 跳过**。
- `npm run build`：通过；保留 Vite 既有的大于 500 kB chunk 提示，未通过提高阈值隐藏。
- 本轮新增 **487 项 JS/TS 回归**（首轮生产整改 245、崩溃验收脚本 9、持久化与冲突边界 190、Windows 验收脚本 26、中文视觉/时序验收脚本 17）和 **15 项 Rust 回归**。
- `cargo fmt --check`：通过。
- Windows GNU 目标完整 Tauri `cargo check --release --all-targets`：通过（包含测试代码类型检查）。
- 从当前源码构造的隔离 Rust 逻辑 harness：49/49 通过；不含 Windows Credential Manager 的实际调用验收。
- 浏览器脚本：`scripts/verify/stability.mjs`，包含 22 个计划检查（21 项功能 + 1 项中文视觉环境）；本地受环境阻塞，没有执行任何浏览器断言。
- GitHub Actions：包含 Node.js 22.13/24 全量门禁、Node24 隔离 Chromium 验收、Windows Rust fmt/test/release、Tauri/NSIS 与产物保存。远程结果以当前提交的 Checks 为准，定义工作流不代表执行通过。

## 首轮远程门禁与验收脚本收口

[Actions 42197348681](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42197348681) 对应 PR HEAD `34ddfea3a6f49bdab9148e37d4344ff1ed704d87`。GitHub 测试合并提交 `d4e85cc` 的 tree 与该 HEAD 完全相同；这不是合并 PR。

- Node 22.13：全部门禁通过。
- Node 24：全量测试和生产构建通过，Chromium 验收卡在主动 renderer 崩溃场景，不能记为通过。
- Windows MSVC：**52/52 Rust 测试**、release 检查和 NSIS 构建通过；安装包 28.73 MiB，已保存为 Actions artifact。这不是安装或交互验收。
- 验收脚本的两个崩溃场景先等待 `Page.crash` 命令回复，但 Chromium 可能在发出 crash 事件后不再回复该命令。已改为发送前注册带明确超时的 crash 事件，并以实际事件为准，保留所有锁交接和恢复断言。
- 新增 9 项脚本回归；8 分钟整体验收 watchdog 会先保存失败报告，再仅终止本次拥有的 Chromium 进程，并以退出码 1 结束。独立复审通过模拟卡死验证了启动和清理两条超时路径；模拟不冒充浏览器验收。
- 上述脚本补丁发布后，必须再次检查最新提交的全部远程门禁。首轮 Windows 成功不能替代后续 HEAD 检查。

## 第二轮 Chromium 验收与测试环境修正

[Actions 42199300006](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42199300006) 的 PR HEAD 为 `50149bd`。Node 22.13 门禁通过；Node 24 全量 2065 测试与生产构建通过，Chromium **13/19 通过、6 项失败**，失败报告已实际保存为 artifact。

- 原生锁竞争后的 renderer 崩溃交接、pagehide/BFCache 生命周期注入、partial 与 committed 日志恢复已在真实 Chromium 通过；CDP 等待修复生效。
- 一个失败来自脚本在重载后直接寻找项目页标题，而应用按设计回到首页。已改为通过既有侧栏打开已保存项目，并保留重载前后数据相等断言。
- PDF 渲染失败同时发现测试静态服务器遗漏 `.mjs` 的 JavaScript MIME 类型，导致 PDF.js 模块 worker 无法正确加载。已补齐；另外四个失败依赖该 PDF 导出前置步骤，不能计为通过。
- 保留浏览器报告的工作流现在在没有报告时直接失败，并分别保留指定的 `report.json` 与隔离合成数据截图，不上传真实工作区数据或凭据。
- 这些改动仅修正验收脚本/测试服务器和证据保存；最终结论仍须以修正后的最新提交远程执行为准。

## 第三轮真实强杀验收：确认恢复落盘窗口

[Actions 42200671581](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42200671581) 对应分支 HEAD `16beba41c8f88aa636b729559f10200c658413db`，实际测试合并提交为 `85546bde7289136a6b31428f6603ec1d78dcc308`；二者 tree 完全相同。Node 22.13 与 Windows Rust/NSIS 通过，Chromium **18/19 通过、1 项失败**。

- 已通过真实 PDF 导入、导出、备份恢复、失败回滚、PDF 提交后 renderer 崩溃恢复，以及锁交接与损坏日志检查。
- 唯一失败是成功恢复后立即 SIGKILL 整个持久 Chromium，再打开同一 profile 和 origin。恢复前后预期为完整项目/知识数据，重开时实际都为 null。
- 已排除 profile、origin 和隐身上下文不一致。Chromium 的 LocalStorage 会延后批量提交；同步 setItem 与回读只证明可见性，不证明落盘。原流程随后清除 IDB journal，使强杀窗口没有足够的持久恢复信息。
- 这是实际 P1，不能以固定等待、重试直到绿或删除断言解决。后续补丁需要同时覆盖成功恢复与失败回滚，并验证后续正常编辑不会被旧恢复副本覆盖。
- 已增加直接读取重启前后 LocalStorage、IDB journal/checkpoint 和 PDF 摘要的隔离证据，以及合成数据截图。截图不插入成功与立即强杀之间，不延长被测落盘窗口。

## 持久化检查点补丁与边界

- 恢复活动日志与最终状态检查点使用独立记录。新日志保留完整目标值及摘要，覆盖未变化的核心数据；发布最终状态与删除活动日志在同一个严格持久化 IDB 事务中完成。
- 已有及新增的必要 PDF 都经过内容校验和严格持久化屏障。无法获得 strict durability 时拒绝写入，不回退成弱保证。
- 成功恢复和失败回滚都保留可重放的最终状态，并冻结普通写入直到重载。重启时先验证整份快照、当前值与 PDF，再做恢复；未知状态不覆盖。
- 允许普通 store 创建前，严格持久化取消检查点的自动重放权限。保留副本不自动覆盖之后的有效编辑或刻意改回旧值；必要核心数据后来消失时失败关闭，并保留人工恢复证据。
- 旧版仅有摘要的 committed 日志若缺失目标数据，无法重建时明确阻断，不猜测或回滚已宣布成功的数据。新检查点必须明确包含项目、知识、复习和难点四类核心条目，不能用缺字段的截断副本放行空工作区。
- 已检测到并发冲突时，活动日志通过严格且匹配 ID 的 conflicted 标记永久停止自动重放；已发布检查点则严格取消重放权限，避免下一次启动覆盖刻意改回原值的编辑。若这次严格写入失败，界面保持冻结并移除重载按钮，明确要求人工恢复：运行时提示不是持久化标记，不能保证强行冷重启仍安全。该诊断窗口会保留原生独占锁，防止其他新版窗口趁机重放；页面退出后不能继续保证这种临时保护。
- 独立复审另复现了 PDF 异步复制期间旧窗口改数据被覆盖的情况。现在由同一份严格读取的原始快照生成指纹、合并依据和 journal.previous，并在写日志前与首次写 LocalStorage 前重新核对，改变则阻断保留证据。
- 浏览器新增完整旧日志/不完整旧日志分开验收，以及严格退役、后来编辑/回退保留、注入核心数据丢失后阻断的场景。原成功后立即 SIGKILL 的断言没有放宽；共 21 个真实浏览器计划场景。

限制：这不是把所有普通同步 LocalStorage 写入改成磁盘事务。检查点取消自动重放权限后，新的进程丢失事件可能需要人工恢复，不能冒险把旧副本自动写回。本地冻结后的 npm run check 已通过 114 文件 / 2255 项测试，生产构建通过；独立复审的 8 项边界反例与原覆盖复现通过。真实强杀回归的实际执行见下一节，不外推成所有断电或普通编辑的持久性保证。

## 第四轮真实强杀回归：21/21 通过

[Actions 42207760728](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42207760728) 对应分支 HEAD `e14684af52ddc42a51b8327c4618d4287c27a55e`。测试合并提交 `2aa2e55603cc3308ce8b57e6f93f2336faaedb9b` 与该 HEAD 的 tree 均为 `7a47ed5bc1f2c6b708f120fe8209a6eeda309bc7`。Node 22.13/24 全量门禁和真实 Chromium **21/21** 通过。

- Windows 同一运行的 **52/52 MSVC Rust 测试**、release check 和 NSIS 构建均通过，安装包 28.74 MiB；[安装包 artifact](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42207760728/artifacts/13498630678) 已保存。这仍不是安装后应用运行的验收。
- Chromium `156.0.8078.79` 的原始测试序列仍为成功恢复后立即强杀整个隔离进程，再用同一 profile/origin 重开；未插入等待、flush 或放宽断言。
- 重启后、应用启动前的只读诊断真实观察到 `rw.projects` / `rw.knowledge` 均为 null、LocalStorage 为空；严格持久化的完整 checkpoint 与所需 PDF 仍在。应用启动后重放得到完全一致的数据，PDF 字节 SHA-256 相同，检查点被严格退役。此前失败的 P1 在相同场景通过。
- 21 项同时包括真实 PDF 导入/阅读/导出/恢复、失败回滚、renderer 崩溃、整进程崩溃、原生锁竞争、损坏/不可读日志失败关闭、旧 committed 日志缺数据阻断。后续编辑/刻意回退保留与核心数据丢失阻断是注入场景，不冒充另一次真实进程崩溃。
- 报告中外部请求、AI 请求、页面异常均为零。浏览器 BFCache 仅注入生命周期事件，未声称真实 BFCache 导航通过。
- [原始 JSON 报告](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42207760728/artifacts/13497057844)及[12 张合成数据截图](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42207760728/artifacts/13497511712)已保存，保留期 14 天。
- 实际打开截图确认重启后项目及 PDF 页可见，但 Linux runner 中文字体缺失，汉字呈方框；中文视觉验收尚未通过。后续仅补测试环境字体和统一桌面视口，不据此修改应用字体或扩大产品功能。

这是隔离 Linux Chromium 对生产 Vite 构建的验收，不是 Windows/Tauri 安装后运行证明。最新提交仍须单独核对全部 CI，Windows 交互、凭据和进程生命周期检查不以网页成功代替。

## 后续独立 checkpoint：补齐真实平台验收证据

该 checkpoint `0035ee07ba786cc32d81074b4a3a857db396de26` 不改应用或服务生产代码，仅增加验收脚本、CI 与说明，以上一个全绿 `e14684af` 为回滚点。

- Ubuntu Node24 job 安装官方 `fonts-noto-cjk` / `fontconfig`。独立页面通过实际中文恢复标题、Chromium CDP 渲染字体与 Fontconfig 字符覆盖验证环境；单独记为第 22 项检查，不能替代其余 21 项功能检查。同步字体查询也受单调时钟截止时间约束，超时不能误报成功。
- 持久进程的两次页面都在导航前设为 1440×950；成功恢复 → 精确状态读取 → SIGKILL 的序列保持不变。该提交的中文截图已实际打开，备份确认框、重启后 PDF、侧栏与阻断警告中文字均正常，无原来的方框缺字。
- Windows 使用同一全新 GitHub 托管 job 的构建标记与精确 NSIS 产物，在安装后应用上检查 Mock、合成假凭据、端点绑定、删除与退出/重启；详情见 [Windows 运行验收范围](windows-runtime-acceptance.md)。未执行前保持 NOT RUN，缺环境、超时或断言失败会让门禁失败。
- 独立复审修复了新验收脚本自身的清理误报：若启动进程后所有权观察失败，保留子进程句柄并标记后代清理未确认，不能将清理记为 PASS。只清理本测试证明拥有的进程/假凭据，不删除不明状态；该问题未进入已发布产品代码。
- 报告与截图分别保存，缺少必需报告直接失败。Windows 消费者安装前置条件、升级/卸载和完整 PDF/备份桌面操作仍是另行验收项。
- 冻结实现后的本地 aggregate check：**116 文件 / 2295 项测试通过**；生产构建通过，原有大 chunk 提示保留。独立复审通过 23 项 Windows helper 测试、6 个实际清理函数故障注入，以及 17 项视觉/时序测试和 9 项崩溃 helper 测试。
- 此处记录的是提交前准备与本地测试，不是 Windows 运行成功记录；必须阅读该 checkpoint 精确提交的 CI 报告和实际截图。

### `0035ee07` 实际运行与诊断补丁

[Actions 42210528782](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42210528782) 的测试合并提交 `403c21883dee68433fc42eddcd462c7ea627a8d3` 与分支 HEAD tree 同为 `b6e61a0c7a0c8fa22491d2ffe31488f50c8b2380`。

- Node 22.13/24、2295 项测试、构建以及 **Chromium 22/22** 通过。实际 CDP 字体为本地 `Noto Sans CJK SC`，六个中文测试字形全部覆盖；原立即 SIGKILL 场景再次通过。[原始报告](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42210528782/artifacts/13498747443)与[已看图确认的截图](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42210528782/artifacts/13499120438)已保存。
- Windows 52/52 Rust 与 release check 通过，之后构建标记环境检查返回 NOT RUN 并以非零码退出。NSIS 构建、安装与运行未执行，不能说整条 CI 通过，也不是已证实的产品运行故障。
- 实际官方 runner 镜像为 `windows-2025-vs2026` / `20261030.294.1`。[对应镜像发布](https://github.com/actions/runner-images/releases/tag/win25-vs2026%2F20261030.294)使用新的 `ImageOS=win25-vs2026`，原校验只接受 `win` 加数字，已在便携测试中复现拒绝。旧运行没有保存构建标记报告且丢弃了具体拒绝代码，不能证明这是那次第一个或唯一失败的断言。
- 后续诊断补丁仅增加这个确证的官方镜像标识、保留脱敏的具体拒绝代码，并单独保存构建标记报告；不放宽托管 VM、显式 opt-in、空账户、源提交或产物检查。该补丁的本地全量 gate 为 116 文件 / 2298 项测试通过，26 项 Windows helper 定向测试与独立复审通过；安装后运行仍须再次以新提交的 CI 验证。

## 独立复审

复审不仅检查本轮 diff，也复查了受影响的旧路径。独立故障注入复现并关闭：

1. 未捕获的畸形 HTTP 请求地址使 sidecar 退出。
2. 负数/非有限/非安全整数 usage 污染预算；现按预留上界保守结算。
3. 切换供应商后旧进程停止失败，删除旧供应商 Key 仍可能跳过撤销。
4. IndexedDB 中已存在但值为 undefined 的 journal 被当作不存在。
5. 主数据读取失败，以及已占用恢复副本槽位读取失败，被当作空值导致覆盖。
6. 运行中后台 GC 暂停写入导致编辑动作丢失；现仅在启动前回收一个候选文件。

另补齐保留属性名模型的价格查询校验，未知模型不会被当成已有价格行或产生 NaN 费用。
初次代码复审未发现其余确定性 P0/P1/P2；后续真实强杀验收确认了上节所述 P1，初次结论不能覆盖该新证据。平台实际执行验收不可省略，也不是合并许可。

## 当前环境限制

- Chromium 本地启动在 `process_singleton_posix.cc` 报 `socket() failed: Operation not permitted (1)`；普通执行与获批提权执行结果一致。隔离浏览器脚本已准备，**0 项浏览器断言在本地执行**。新增 CI 将在具备 Chromium 的 runner 上执行该脚本，结果须单独核对。
- Linux 完整 Tauri 测试缺少 `glib-2.0`。已在隔离临时目录补齐 Windows Rust target 与官方 Debian binutils，完整 Tauri Windows debug 和 release/all-targets 交叉编译实际通过；这仍不是 Windows 程序执行、MSVC 链接或 NSIS 安装验收。
- 本轮未运行 Windows 图形桌面安装验收，不沿用此前 PR 的冒烟结论。

## Windows 桌面人工门禁

当前执行环境为 Linux，不能把 Chromium 网页验收或 Linux Rust 独立模块测试写成 Windows 桌面验收。
必须在真正隔离的 Windows 账户或全新 GitHub 托管 VM，对最新 NSIS 产物执行。仅修改 WebView、APPDATA 或 LOCALAPPDATA 目录不能隔离账户级凭据，不能代替这项要求：

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
2. 本地隔离 Chromium 启动受限；本地 22 项计划检查均未执行。
3. Windows 实机运行、Credential Manager、NSIS 安装与完整桌面验收仍需执行；交叉编译不替代这些检查。
4. 一次仅允许一个升级后的可编辑窗口；旧应用版本必须先关闭。Web Locks 不可用会明确阻断启动。
5. 孤立 PDF 仅处理恢复日志派生的候选，每次启动最多清理一个；未知或引用信息无法确认的文件保留，不做全盘盲删。
6. macOS/Linux 系统凭据后端仍未实现，不阻塞 Windows 代码整改，但不宣称跨平台在线 AI 支持。

**建议：等待当前提交的远程 CI 和隔离 Windows 桌面验收完成后再考虑合并 PR #3；本轮没有执行合并或部署。**
