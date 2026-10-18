#!/usr/bin/env bash
# Prepares the WSL side of the Windows cross-build (Phase 10).
# Run as root inside WSL:  wsl.exe -u root bash scripts/desktop/setup-wsl-build.sh
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
export RUSTUP_HOME=/root/.rustup
export CARGO_HOME=/root/.cargo
export PATH="$CARGO_HOME/bin:/opt/node24/bin:$PATH"

echo "== apt packages =="
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl xz-utils build-essential pkg-config \
  clang lld llvm nsis file

echo "== Node 24 (Linux, for the Tauri CLI and Vite build) =="
if [ ! -x /opt/node24/bin/node ]; then
  curl -fsSL "https://nodejs.org/dist/v24.14.1/node-v24.14.1-linux-x64.tar.xz" -o /tmp/node24.tar.xz
  mkdir -p /opt
  tar -xJf /tmp/node24.tar.xz -C /opt
  rm -rf /opt/node24
  mv /opt/node-v24.14.1-linux-x64 /opt/node24
fi
/opt/node24/bin/node --version
/opt/node24/bin/npm --version

echo "== rustup =="
if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh
  sh /tmp/rustup-init.sh -y --profile minimal --default-toolchain stable
fi
rustc --version
cargo --version

echo "== Windows MSVC target =="
rustup target add x86_64-pc-windows-msvc

echo "== cargo-xwin =="
if [ ! -x "$CARGO_HOME/bin/cargo-xwin" ]; then
  cargo install --locked cargo-xwin
fi
cargo xwin --version

echo "== WSL build toolchain ready =="
clang --version | head -1
lld-link --version | head -1 || true
makensis -VERSION
