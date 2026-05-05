#!/usr/bin/env bash
# Sound Capsule LAN —— 启动前端 Vite dev server
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
WEBAPP_DIR="${ROOT_DIR}/webapp"

cd "${WEBAPP_DIR}"
if [ ! -d node_modules ]; then
  echo "[lan-capsule] 安装前端依赖..."
  npm install
fi
exec npm run dev
