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

## 上一阶段已执行门禁（`7b1f8654`）

历史 PR 中的 1811 项 Vitest、37 项 Rust 和桌面冒烟数字不代表本轮验收。

- `npm run check`：通过。TypeScript、ESLint、Prettier 和 **117 个文件 / 2335 项 Vitest，0 失败、0 跳过**。
- `npm run build`：通过；保留 Vite 既有的大于 500 kB chunk 提示，未通过提高阈值隐藏。
- 相比本轮施工基线净增 **524 项 JS/TS 回归**和 **15 项 Rust 回归**。后续 checkpoint 必须重新执行门禁，不能沿用此数目或结果。
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

### `88d1c79b` 安装资源比对与精确打包变换

[Actions 42212710072](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42212710072) 对应 HEAD `88d1c79bb9afeff6d95fd7e5cfe81f11bfaec183`，测试合并提交 `30ec0387e5f13b5b0d777420b03ab766172464ad` 的 tree 同为 `56e0f404419d3d4c62be8088250ad55756695434`。

- Node 22.13/24、2298 项测试、Chromium 22/22、Windows 52/52 Rust、release 与 NSIS 构建通过。构建标记、空账户/进程、实际 WebView2 与同次产物检查均通过，原镜像识别阻断解除。
- 静默安装退出码 0、安装版本校验通过，之后 `INSTALLED_RESOURCE_HASH_MISMATCH` 阻断；应用、Mock 和凭据测试均未运行。清理 PASS。[真实运行报告](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42212710072/artifacts/13499769285) 已保存，整条 Windows job 仍失败。
- 固定依赖 Tauri CLI 2.12.3 的[官方打包实现](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.3/crates/tauri-bundler/src/bundle.rs)会在 NSIS 打包前把主程序第一个 `__TAURI_BUNDLE_TYPE_VAR_UNK` 改为 `__TAURI_BUNDLE_TYPE_VAR_NSS`，完成后恢复构建目录原文件。因此直接要求安装后的主 EXE 与恢复后的构建 EXE 原始 hash 相等，是验收脚本的错误假设。
- 该次日志实际记录了 NSIS bundle-type patch，且无 patch 失败警告。下载产物的 SHA-256 与报告一致（`d657cf46fe736f76813530d31250beddfdc9bc2a70a4c6f211c157a0e9ef5d0a`）；仅静态提取的主 EXE 含两个 NSS 常量、无 UNK。本地未执行 Windows 程序，也没有据此声称应用运行成功。旧报告未保留三个比较项的 hash，不能反推它的全部比较结果。
- 后续校验只对构建字节的副本执行固定版本的精确首次 UNK→NSS 变换，再比较完整预期与安装字节的 SHA-256；绝不归一化安装字节、忽略字节区间或允许原始相等回退。Node/launcher 仍须原样完整相等；不支持的 CLI 版本、缺标记或其他字节变化继续失败关闭。安装退出码、版本与各资源 build/expected/installed hash 在断言失败前保存。
- 这是验收比较规则修正，不是放宽应用安全策略。新的精确提交仍须重新运行 Windows 安装与应用门禁。

### `69ae3d46` 安装校验通过，WebView2 连接与清理仍阻塞

[Actions 42216224997](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42216224997) 对应 HEAD `69ae3d4617a96a0567eeafeff8403097d37c2505`；测试合并提交 `e5d2e75d09701e04c4a74f34262a21992755cf5a` 的 tree 同为 `65a6a2c17148e8dc3b92324aa467d3a0c21629fc`。

- Node 22.13/24、2308 项测试、真实 Chromium 22/22、Windows 52/52 Rust、release 和 NSIS 构建通过。原立即强杀/重新打开恢复场景继续通过。
- 全新托管 Windows VM 的宿主检查、同次构建产物、静默安装与版本 0.13.2 校验通过。安装包 SHA-256 为 `11af85b4329ee69c2d3cf2e39e1829f41232bc999dbab055b07aaa8b7d5eb51f`，安装退出码为 0。
- 主 EXE 的完整安装字节 SHA-256 `91cc672e5c0b465f90ca4fee0dc48792af31d772f2e722d2020fb86386909bdd` 与精确 NSIS 变换后的预期相同；Node 和 launcher 完整原始 hash 也均相同。资源比对阻断已在实际执行中解除。
- 应用根进程启动后，45 秒内未获得 WebView2 调试页面，报告 `WEBVIEW2_CDP_OR_WINDOW_UNAVAILABLE`。Mock、假凭据、端点绑定、删除、重启和截图均未执行。清理另有 `process-stop` 未确认，最终状态为 **FAIL**、`cleanupIncomplete: true`，不能宣称没有残留进程。[实际报告](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42216224997/artifacts/13501931763) 保留这些结果。
- 现有证据不能区分 CDP 发现、连接初始化和页面创建失败，也不能确定原生清理失败原因；尚不能断言产品故障或宿主不支持桌面。已确认脚本每次完整连接只等待 2.5 秒，页面尚未出现即断开；后续脚本 checkpoint 将增加有界页面等待和脱敏阶段诊断，以及同一进程句柄的退出证据，不放宽产品安全设置或把不确定清理改成通过。
- 原任务要求的隔离 Windows PDF 导入/阅读、备份导出/恢复、强制退出、重启后数据持久化和无孤儿 sidecar，仍是必须完成或记录具体环境阻塞的门禁。窄运行脚本未覆盖这些流程，不代表它们不在任务范围内。

### `5f10bf3b` 连接阶段与退出确认的实际证据

[Actions 42220406169](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42220406169) 对应 HEAD `5f10bf3b7d1d8a6258cb2a53c42b7779b0e2ec0b`；测试合并提交 `97af749f290ea80c9127c650f1e6edcff81f1f1a` 的 tree 同为 `e574f4c2844191af53f66765044a01110e5995e9`。

- 本地冻结后 116 文件 / 2317 测试、TypeScript、ESLint、Prettier、生产构建和独立复审通过。远程 Node22 全部通过；Node24 的 2317 测试和构建通过，但从官方 Ubuntu 镜像下载 61.2 MB 中文字体包停滞近 18 分钟，触发 job 超时。该提交的 Chromium 验收未执行，不能沿用上一提交 22/22 的结果替代。
- Windows 52/52 Rust、release、NSIS、静默安装、版本和全部整文件 hash 通过。安装包 SHA-256 为 `826fde8e8a182768057ff06b432e1c88634a03354c09e29fb2afaddcb1fa1fa7`。[运行报告](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42220406169/artifacts/13504281167) 已回读。
- 45 秒内发生 37 次 CDP 发现请求，保留的最后 32 次均被拒绝连接，未进入 Playwright attach/page。已验证应用根进程存活，同时观察到一个 sidecar、六个所属 WebView2 进程及三个可见且有面积的应用窗口。因此不能说产品没有启动，也不能把本次原因归为旧页面等待逻辑。
- 清理正向确认应用根进程停止、sidecar 及大部分所属进程已不存在；一个已跟踪 WebView2 在查询映像路径时返回 Win32 错误 31，退出状态尚未获得，最终仍是 **FAIL / cleanupIncomplete**。错误 31 本身不代表退出，也不证明活进程残留。
- [Microsoft 当前安全指南](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security#for-an-elevated-host-app-use-appropriate-override-flags)说明 High Integrity 宿主忽略 `WEBVIEW2_*` 环境覆盖；[GitHub 托管 runner 说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#administrative-privileges)说明 Windows 默认管理员运行。尚未实测本次应用的 token/integrity 与实际调试参数，只能列为优先假设。后续 checkpoint 仅采集身份验证后的只读分类证据，不更改安全策略或产品设置。
- Mock、假凭据、截图、后续重启、PDF 与备份桌面流程仍未执行。独立修正字体准备的下载上限和可信文件校验，不跳过中文视觉前置条件；Windows 诊断与字体准备分别保留可回滚提交。

### `7b1f8654` 中文视觉恢复，Windows 提升权限阻塞已实测

[Actions 42225263617](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42225263617) 对应 HEAD `7b1f86541403d31dbde65f575efb5c88b5c9c2a0`；测试合并提交 `227e3a3f73c42e12433cab2728528c8450216edb` 与该 HEAD 的 tree 同为 `33bae585b8eb7c14b643f14a491bdbcf21ec401f`。Node22/24 两条通过，Windows job 失败，整条 CI 不是全绿。

- 冻结后的本地与远程均通过 117 文件 / 2335 项测试、类型检查、lint、格式与生产构建。Windows Rust 52/52、release、NSIS、75 项原生合成自测、静默安装、版本及三项整文件资源 hash 通过。
- 固定官方来源和 SHA-256 的中文字体准备约 2.6 秒完成。真实 Chromium 22/22 通过，原恢复成功后立即 SIGKILL 场景未插入等待；严格 checkpoint 与 PDF 保留，重启前 LocalStorage 确实为空，应用重放后恢复精确内容并退役 checkpoint。
- 独立实际查看 6 张截图，中文可读，1440×950 下恢复、重新检查、重新载入操作可见，无阻断性重叠或裁切。浏览器报告无外部/AI 请求或页面错误。这不是 Windows UI 验收。
- Windows 实际报告为 **FAIL / CDP_TIMEOUT / blocked=false**。存活应用 token 实测 elevation=true、high integrity；所属 WebView browser-candidate 无调试端口/地址参数。34 次发现尝试中保留的最后 32 次均拒绝连接，未进入 Playwright 页面或 IPC/Mock 断言。
- Microsoft 说明提升权限的 WebView 宿主会忽略环境覆盖；该证据支持当前环境与环境变量调试方案不兼容，但尚未做普通权限对照，不能排除全部其他因素。应用窗口、sidecar 和 WebView 确实已启动。
- 最终清理对 10 个已跟踪身份正向确认退出或不存在并 PASS。原映像查询 error31 保留，只有同句柄 signaled 与精确创建时间匹配才能使用退出专用证明；该分支不能授权终止进程。此结果不替代独立正常关闭或强退产品验收。
- [浏览器报告](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42225263617/artifacts/13506455375)、[真实截图](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42225263617/artifacts/13506355635)、[Windows 报告](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42225263617/artifacts/13506252556)和[NSIS 安装包](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42225263617/artifacts/13506536631)保留至 2026-11-20。安装包 SHA-256：`84b784efc7bce2400e3405c9d395431c02eb81c197ba584eccedc66fc368c527`。

当前继续独立 checkpoint，优先验证只降低本次测试进程权限的普通用户启动，再补 Windows 数据流程；不修改账户、UAC、ACL、策略或持久访问，不启用 WebView 安全覆盖。未执行的新流程仍为 NOT RUN，具体启动约束见 [Windows 运行验收范围](windows-runtime-acceptance.md)。

### 普通权限入口 checkpoint：提交前门禁

- 只增加受限的固定 probe/runtime 入口、验收辅助测试、CI 和文档；应用、服务、Rust 与依赖生产代码未改变。
- 最终冻结后 `npm run check` 通过：**118 文件 / 2347 项测试**，TypeScript、ESLint、Prettier 通过；`npm run build` 通过，既有大 chunk 提示保留。
- 独立原生设计和调用/报告复审通过，63 项定向辅助测试通过。缺失证明、矛盾退出码、不完整检查列表和未确认凭据清理均不能记为 PASS。
- Windows 原生编译、令牌、作业、普通桌面访问与实际应用流程尚未执行。新 CI 必须先通过无害探针，再构建与运行；失败时保留具体阶段和错误，不回退为提升权限运行，也不修补系统权限。

### `1c46b48b` 实际探针：调用者 token 校验失败

[Actions 42236056011](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42236056011) 对应 HEAD `1c46b48bc0412b43d312353856021d1da55d0f5e`。测试合并提交 `22823dbcb91ea51192f430c778717890ced7dbac` 与其 tree 均为 `20106077022e3f83a1e288d0892c9d96f972d5f1`。

- Node22/24 两条通过，远程 118 文件 / 2347 测试、构建及真实 Chromium 22/22 通过，原立即强杀恢复场景保留。该次截图尚未另行做像素复审。
- Windows 新 C# 编译、47 项原生合成测试通过；随后 `caller-token / TOKEN_REJECTED / win32Error=0` 失败。尚未执行 SAFER、作业创建或子驱动启动，凭据未触碰。后续构建、安装、WebView2/CDP、Mock、凭据和 Windows UI 检查均未执行，没有新 NSIS 安装包。
- [实际探针报告](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42236056011/artifacts/13511991333)的 ZIP SHA-256 已验证为 `d20945ec80be021681ac7b6ec88b9c1eb58c8d042038194e76c4de76e6d62fbb`。不能据此归因为产品故障，亦不能断言普通权限路线不可行。
- 旧字段将多处 token 查询/结构/账户校验拒绝合并为同一代码，且首次长度查询的非预期 API 错误会丢失具体数字。后续独立诊断 checkpoint 只保留固定允许列表中的查询字段与拒绝谓词、实际数值 Win32 错误；不输出 SID、LUID、原始缓冲区、环境或任意异常文本，不改变查询顺序、接受条件、令牌操作和清理路径。

### `74290a69` 定位固定大小 token 查询错误

[Actions 42238096155](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42238096155) 对应 HEAD `74290a692a0546cebc32a8ca0cafa59aab9fea6b`，测试合并提交 `db702ed8e7264bab24a6404b0344628fec51e14d` 与其 tree 同为 `7354f7d860817eec8a29cad97adb4e5e3e0f4c62`。Node22/24、118 文件 / 2350 测试与真实 Chromium 22/22 通过，Windows 失败。

- C# 编译与 57 项原生合成测试通过；[探针报告](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42238096155/artifacts/13512508611)精确记录 `elevation / size-query-error / Win32 24（ERROR_BAD_LENGTH）`，仍在 SAFER、作业或子驱动之前。ZIP SHA-256 为 `e53e10f6d0056e7c0ff0610c9599492058d919766f1a0dffbdc2d7fc07dc7667`。
- 泛用空缓冲区长度查询错误地假设所有字段都必须先返回 122。Microsoft 将 [TOKEN_ELEVATION](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_elevation) 定义为单个 DWORD；既有应用诊断的固定 4 字节读取也已在 Windows 实测成功。这确认了验收调用的问题，不代表产品故障或普通权限运行已成功。
- 下一 checkpoint 对已有的五种固定标量直接使用 4 字节缓冲区，必须 API 成功且返回长度恰为 4。变量长度查询不变，不把错误 24 当作成功、不重试其他启动方式、不修改任何 token 值判断或系统权限。模拟查询回归重现零长度请求返回 24，并要求实际标量读取器只调用一次非空 4 字节请求。真实平台结果仍待下一次 CI。

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

- Chromium 本地启动在 `process_singleton_posix.cc` 报 `socket() failed: Operation not permitted (1)`；普通执行与获批提权执行结果一致。**0 项浏览器断言在本地执行**。远程 Chromium 的实际执行结果按上方各精确提交分别记录，最新已完成的 `7b1f8654` 为 22/22。
- Linux 完整 Tauri 测试缺少 `glib-2.0`。已在隔离临时目录补齐 Windows Rust target 与官方 Debian binutils，完整 Tauri Windows debug 和 release/all-targets 交叉编译实际通过；这仍不是 Windows 程序执行、MSVC 链接或 NSIS 安装验收。
- 全新托管 Windows VM 已实际执行 `7b1f8654` 的静默安装、版本和完整资源校验；应用以提升权限运行且 CDP 端口连接被拒绝，后续交互与凭据测试未执行。10 个已跟踪身份的最终清理已正向确认；独立正常/强退验收未运行。不能沿用此前 PR 的冒烟结论。

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
3. `7b1f8654` 的 NSIS 静默安装、版本、资源校验及已跟踪身份的最终清理通过；Windows 交互、Credential Manager、独立生命周期与完整数据流程仍未执行。交叉编译或浏览器成功不替代这些检查。
4. 一次仅允许一个升级后的可编辑窗口；旧应用版本必须先关闭。Web Locks 不可用会明确阻断启动。
5. 孤立 PDF 仅处理恢复日志派生的候选，每次启动最多清理一个；未知或引用信息无法确认的文件保留，不做全盘盲删。
6. macOS/Linux 系统凭据后端仍未实现，不阻塞 Windows 代码整改，但不宣称跨平台在线 AI 支持。

**建议：等待当前提交的远程 CI 和隔离 Windows 桌面验收完成后再考虑合并 PR #3；本轮没有执行合并或部署。**
