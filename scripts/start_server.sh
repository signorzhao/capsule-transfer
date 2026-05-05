#!/usr/bin/env bash
# Sound Capsule LAN —— 启动后端 Flask 服务
# 用法：
#   bash scripts/start_server.sh          # 默认 0.0.0.0:5005
#   LAN_CAPSULE_PORT=6000 bash scripts/start_server.sh

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="${ROOT_DIR}/server"
VENV_DIR="${ROOT_DIR}/.venv"

if [ ! -d "${VENV_DIR}" ]; then
  echo "[lan-capsule] 创建虚拟环境 ${VENV_DIR}"
  python3 -m venv "${VENV_DIR}"
fi

# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

pip install --quiet --disable-pip-version-check -r "${SERVER_DIR}/requirements.txt"

if [ -f "${ROOT_DIR}/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT_DIR}/.env"
  set +a
fi

cd "${SERVER_DIR}"
exec python app.py
