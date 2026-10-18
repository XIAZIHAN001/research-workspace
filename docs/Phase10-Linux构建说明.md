# Phase 10 Linux 桌面构建说明

状态：**静态审查完成，编译与图形运行未在本轮验证。**
本轮 Windows 构建使用的是本机 Visual Studio + D 盘 Rust；用户要求删除 WSL 中的临时构建环境，
因此没有在 Linux 上实际编译，也没有可用的 Linux 图形会话。以下内容区分了“代码已检查”、
“Linux 编译”和“Linux GUI 实跑”，三者不能互相替代。

## 1. 代码层已做的兼容处理

| 项目 | 现状 |
| --- | --- |
| 平台相关路径 | Rust 中唯一的 Windows 分支是 `#[cfg(target_os = "windows")]` 的 `data_directory` 与 `native_path` 的 `\\?\` 去前缀；没有硬编码 `C:\` / `D:\` 业务路径 |
| sidecar 名称 | 统一为 `sidecar/rw-node.exe`（Linux 上是 ELF 文件，扩展名只是统一资源名）；`prepare-sidecar.mjs` 在非 Windows 上 `chmod 755` |
| sidecar 资源目录 | 发布版使用 `resource_dir()/sidecar`；Windows 安装在 `D:\Research Workspace\sidecar`，Linux 由 Tauri 资源目录提供 |
| WebView Origin | `AI_ALLOWED_ORIGINS` 同时包含 `http://tauri.localhost`、`https://tauri.localhost`、`tauri://localhost`，覆盖 Windows 与 Linux/macOS |
| 数据目录 | Windows 显式固定为 `%LOCALAPPDATA%\com.researchworkspace.desktop\webview`；Linux 使用 Tauri/WebKitGTK 的应用数据目录（`~/.local/share/<identifier>`），未单独覆盖 |
| 生命周期 | 正常退出由 `RunEvent::Exit` 停止子进程；崩溃/强杀由 stdin EOF + 父 PID 看门狗兜底，平台无关 |
| CSP | 生产 CSP 不含远程脚本源；`connect-src` 允许 `http://127.0.0.1:*`，Linux WebKitGTK 同样适用 |
| 开发/生产隔离 | 开发模式使用 `src-tauri/tauri.dev.conf.json`，标识符为 `com.researchworkspace.desktop.dev`，不与安装版共用 WebView 数据 |

## 2. 构建前置条件（Ubuntu 24.04 建议）

Tauri v2 的 Linux WebView 是 **WebKitGTK 4.1**，Ubuntu 22.04 默认源可能只有 4.0；优先使用
Ubuntu 24.04。不要在科研服务器上擅自安装 GUI 依赖；以下步骤应在专用桌面/虚拟机中执行。

```bash
sudo apt update
sudo apt install -y \
  build-essential curl wget file pkg-config libssl-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf \
  libxdo-dev libx11-dev libxi-dev libxcursor-dev libxrandr-dev libxinerama-dev
```

工具链：

```bash
# Rust（stable，Linux 主机不需要 MSVC）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
source "$HOME/.cargo/env"

# Node 24 + npm
node --version   # 需要 >= 22.13
npm ci
```

## 3. 构建命令

```bash
cd /path/to/项目
npm ci

# 在 Linux 上运行：把当前 Linux Node 复制成 sidecar/rw-node.exe，并设置可执行位
npm run desktop:prepare

# 前端生产构建 + Tauri 打包（覆盖配置里的 Windows NSIS 目标）
npm run build
npx tauri build --bundles deb,appimage
```

产物位置：

- `src-tauri/target/release/<app-binary>`
- `src-tauri/target/release/bundle/deb/*.deb`
- `src-tauri/target/release/bundle/appimage/*.AppImage`

注意：`tauri.conf.json` 的 `bundle.targets` 是 `["nsis"]`（Windows 安装包）。Linux 构建必须用
`--bundles deb,appimage` 覆盖，不能直接沿用默认目标。

## 4. 运行与验证清单（Linux 上待执行）

1. 安装 `.deb` 或运行 AppImage；确认应用从 Tauri 生产资源启动，而不是 `tauri dev`。
2. 确认 `rw-node.exe`（ELF）由应用启动，只监听 `127.0.0.1` 的临时端口，且不是 8787。
3. 用同一份 PDF 验证：文字层、翻页、缩放、高亮、笔记。
4. 验证 AI 面板显示“离线 Mock”，提问可返回 Mock 回答；确认没有真实付费调用。
5. 关闭应用，确认 sidecar 退出；强杀应用，确认 5–10 秒内无孤儿 sidecar。
6. 重启应用，确认 LocalStorage/IndexedDB 数据仍在；导入/导出 `.rwbackup`。
7. 检查 WebKitGTK 控制台：PDF.js 的 module worker、CMap/标准字体、KaTeX 字体是否加载成功。

## 5. 已知风险与未验证项

- **PDF.js + WebKitGTK**：pdf.js 6 使用 module worker；WebKitGTK 版本较旧时可能退回主线程或加载失败，
  需要实机验证 worker 与 CMap 路径。
- **KaTeX 字体**：构建产物包含字体文件，理论上不依赖 CDN；WebKitGTK 的字体回退仍需实机确认。
- **WebKit 数据目录**：Linux 未显式设置 `data_directory`，数据持久化依赖 Tauri/WebKitGTK 的默认应用数据目录；
  未在 Linux 上做“关闭→重开→重装”验证。
- **AppImage 资源路径**：`resource_dir()` 在 AppImage 挂载环境下返回的路径需要在真实 AppImage 中确认。
- **桌面窗口**：Linux 的窗口装饰/缩放由桌面环境决定，未验证。
- 本轮**没有**在 Linux 上执行 `cargo build`、`tauri build` 或 GUI 启动；上表是静态代码审查结论。
