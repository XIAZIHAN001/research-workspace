#!/usr/bin/env bash
# Builds the Windows NSIS installer from WSL using cargo-xwin.
#
# Prerequisites (scripts/desktop/setup-wsl-build.sh):
#   rustup + x86_64-pc-windows-msvc, cargo-xwin, clang/lld, nsis, Node 24 for Linux.
#
# The sidecar runtime must be the Windows Node executable. Run, on Windows:
#   npm run desktop:prepare
# before this script. It does not run desktop:prepare here, because on Linux that would copy a
# Linux Node binary into a Windows bundle.
set -euo pipefail

SOURCE_DIR="/mnt/d/论文阅读解构项目"
BUILD_DIR="/root/rw-build"
NODE_BIN="/opt/node24/bin"
CARGO_ENV="/root/.cargo/env"

source "$CARGO_ENV"
export XWIN_CACHE_DIR=/root/.cache/xwin
export PATH="$NODE_BIN:$PATH"

if [ ! -f "$SOURCE_DIR/src-tauri/sidecar/manifest.json" ]; then
  echo "Missing src-tauri/sidecar/manifest.json. Run 'npm run desktop:prepare' on Windows first." >&2
  exit 2
fi

if ! grep -q '"platform": "win32"' "$SOURCE_DIR/src-tauri/sidecar/manifest.json"; then
  echo "The prepared sidecar is not a Windows runtime. Run 'npm run desktop:prepare' on Windows." >&2
  exit 2
fi

echo "== sync source =="
mkdir -p "$BUILD_DIR"
rsync -a --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude .cache \
  --exclude docs \
  --exclude "src-tauri/target" \
  "$SOURCE_DIR/" "$BUILD_DIR/"

cd "$BUILD_DIR"

echo "== frontend dependencies (Linux) =="
if [ ! -d node_modules ]; then
  npm ci --no-audit --no-fund
fi

echo "== frontend build =="
npm run build

echo "== skip beforeBuildCommand: dist is already built =="
node -e "const fs=require('fs');const p='src-tauri/tauri.conf.json';const c=JSON.parse(fs.readFileSync(p,'utf8'));c.build.beforeBuildCommand='';fs.writeFileSync(p,JSON.stringify(c,null,2)+'\n');"

echo "== Tauri Windows release build =="
npx tauri build \
  --runner cargo-xwin \
  --target x86_64-pc-windows-msvc \
  --config '{"build":{"beforeBuildCommand":""}}'

echo "== copy artifacts back to Windows =="
OUT="$SOURCE_DIR/src-tauri/target/phase10-windows"
mkdir -p "$OUT"
find src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis -maxdepth 1 -type f -name '*.exe' -exec cp {} "$OUT/" \;
cp src-tauri/target/x86_64-pc-windows-msvc/release/research-workspace.exe "$OUT/"
ls -lh "$OUT"
