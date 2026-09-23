#!/usr/bin/env bash
set -euo pipefail

COMFYUI_ROOT="${COMFYUI_ROOT:-/root/ComfyUI}"
COMFYUI_PYTHON="${COMFYUI_PYTHON:-/root/miniconda3/bin/python}"
COMFYUI_PORT="${COMFYUI_PORT:-6006}"
RUNTIME_DIR="${COMFYUI_RUNTIME_DIR:-${COMFYUI_ROOT}/ccy}"
PID_FILE="${RUNTIME_DIR}/comfyui-ssh-worker.pid"
LOG_FILE="${RUNTIME_DIR}/comfyui-ssh-worker.log"

mkdir -p "${RUNTIME_DIR}"

if [[ -f "${PID_FILE}" ]]; then
  saved_pid="$(cat "${PID_FILE}")"
  if [[ "${saved_pid}" =~ ^[0-9]+$ ]] && kill -0 "${saved_pid}" 2>/dev/null; then
    echo "ComfyUI SSH worker is already running (PID ${saved_pid}, port ${COMFYUI_PORT})."
    exit 0
  fi
  rm -f "${PID_FILE}"
fi

cd "${COMFYUI_ROOT}"
nohup "${COMFYUI_PYTHON}" main.py \
  --listen 127.0.0.1 \
  --port "${COMFYUI_PORT}" \
  --enable-cors-header '*' \
  >>"${LOG_FILE}" 2>&1 &
worker_pid=$!
printf '%s' "${worker_pid}" >"${PID_FILE}"

for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${COMFYUI_PORT}/system_stats" >/dev/null; then
    echo "ComfyUI SSH worker started (PID ${worker_pid}, port ${COMFYUI_PORT})."
    exit 0
  fi
  if ! kill -0 "${worker_pid}" 2>/dev/null; then
    tail -n 80 "${LOG_FILE}" >&2 || true
    exit 1
  fi
  sleep 1
done

echo "ComfyUI did not become healthy within 60 seconds. See ${LOG_FILE}." >&2
exit 1
