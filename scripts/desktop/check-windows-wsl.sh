#!/usr/bin/env bash
# Compile-checks the Windows Tauri backend from WSL (no Windows SDK/VS installation needed).
set -euo pipefail

source /root/.cargo/env
export XWIN_CACHE_DIR=/root/.cache/xwin

cd /root/rw-build/src-tauri
cargo xwin check --target x86_64-pc-windows-msvc "$@"
