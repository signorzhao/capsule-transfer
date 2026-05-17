"""Sound Capsule LAN —— 本地 Flask 服务（无数据库版本）。

所有胶囊数据基于文件系统 (manifest.json) 管理，联系人存储于 contacts.json。
支持绿色版打包，所有路径相对于程序自身目录。
"""

from __future__ import annotations

import io
import json
import logging
import os
import platform
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid as uuid_lib
from datetime import datetime, timezone
from pathlib import Path

import requests
from flask import Flask, Response, jsonify, request, send_file
from flask_cors import CORS

from bundle import build_bundle, extract_bundle
from net import network_info

# ---------------------- 路径初始化（绿色版） ----------------------

if getattr(sys, "frozen", False):
    APP_DIR = Path(sys.executable).resolve().parent
else:
    APP_DIR = Path(__file__).resolve().parent

DATA_DIR = APP_DIR / "data"
CAPSULES_DIR = DATA_DIR / "capsules"
CONTACTS_FILE = DATA_DIR / "contacts.json"
CONFIG_FILE = APP_DIR / "config.json"

CAPSULES_DIR.mkdir(parents=True, exist_ok=True)
os.environ["CAPSULE_TRANSFER_EXPORT_DIR"] = str(CAPSULES_DIR)
os.environ["SYNESTH_CAPSULE_OUTPUT"] = str(CAPSULES_DIR)

# 引用 data-pipeline 中的 Reaper 导出模块。
_DATA_PIPELINE = APP_DIR / "data-pipeline"
if not _DATA_PIPELINE.exists():
    _DATA_PIPELINE = APP_DIR.parent / "data-pipeline"
if _DATA_PIPELINE.exists():
    sys.path.insert(0, str(_DATA_PIPELINE))
    try:
        from common import PathManager
        PathManager.initialize(
            config_dir=str(_DATA_PIPELINE),
            export_dir=str(CAPSULES_DIR),
            resource_dir=str(_DATA_PIPELINE),
        )
        PathManager.get_instance().update_export_dir(str(CAPSULES_DIR))
    except Exception as _pm_err:
        logging.getLogger("lan-capsule").warning("PathManager 初始化跳过: %s", _pm_err)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("lan-capsule")


# ---------------------- 配置管理 ----------------------

def load_config() -> dict:
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text("utf-8"))
        except Exception:
            pass
    return {}


def save_config(cfg: dict):
    CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


_config = load_config()
PORT = int(os.getenv("LAN_CAPSULE_PORT", _config.get("port", 5005)))
HOST = os.getenv("LAN_CAPSULE_HOST", _config.get("host", "0.0.0.0"))
SHARED_TOKEN = os.getenv("LAN_CAPSULE_SHARED_TOKEN", _config.get("shared_token", "")).strip()
_REAPER_CAPTURE_LOCK = threading.Lock()

# receive_mode: "off" = 关闭接收, "confirm" = 验证接收, "auto" = 自动接收
_receive_mode_lock = threading.Lock()
_receive_mode = _config.get("receive_mode", "auto")
_pending_requests: dict[str, dict] = {}
_pending_lock = threading.Lock()
_PENDING_TIMEOUT = 60
_sse_subscribers: list = []
_sse_lock = threading.Lock()
_plugin_inventory_cache: dict = {"expires_at": 0.0, "data": None}
_plugin_inventory_lock = threading.Lock()

app = Flask(__name__, static_folder=None)

# 前端静态文件服务（绿色版内嵌前端 build 产物）
_WEBAPP_DIR = APP_DIR / "webapp"
if not _WEBAPP_DIR.exists():
    _WEBAPP_DIR = APP_DIR.parent / "webapp" / "dist"
if not _WEBAPP_DIR.exists():
    _WEBAPP_DIR = APP_DIR.parent / "webapp"

if _WEBAPP_DIR.exists():
    from flask import send_from_directory

    @app.route("/")
    def serve_index():
        return send_from_directory(str(_WEBAPP_DIR), "index.html")

    @app.route("/<path:path>")
    def serve_static(path):
        if path.startswith("api/"):
            from flask import abort
            abort(404)
        file_path = _WEBAPP_DIR / path
        if file_path.exists() and file_path.is_file():
            return send_from_directory(str(_WEBAPP_DIR), path)
        return send_from_directory(str(_WEBAPP_DIR), "index.html")

CORS(
    app,
    resources={r"/api/*": {"origins": "*"}},
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-Capsule-Token", "X-Accept-Token"],
)


# ---------------------- 工具 ----------------------

def _err(msg: str, code: int = 400):
    return jsonify({"success": False, "error": msg}), code


def _ok(data=None, **kwargs):
    payload = {"success": True}
    if data is not None:
        payload["data"] = data
    payload.update(kwargs)
    return jsonify(payload)


def _check_shared_token() -> tuple[bool, str | None]:
    if not SHARED_TOKEN:
        return True, None
    sent = request.headers.get("X-Capsule-Token", "")
    if sent != SHARED_TOKEN:
        return False, "shared token mismatch"
    return True, None


def _get_receive_mode() -> str:
    with _receive_mode_lock:
        return _receive_mode


def _set_receive_mode(mode: str):
    global _receive_mode
    with _receive_mode_lock:
        _receive_mode = mode
    cfg = load_config()
    cfg["receive_mode"] = mode
    save_config(cfg)


def _cleanup_expired_requests():
    now = time.time()
    with _pending_lock:
        expired = [k for k, v in _pending_requests.items() if now - v["created_at"] > _PENDING_TIMEOUT]
        for k in expired:
            del _pending_requests[k]


def _notify_sse(event_data: dict):
    msg = f"data: {json.dumps(event_data, ensure_ascii=False)}\n\n"
    with _sse_lock:
        dead = []
        for q in _sse_subscribers:
            try:
                q.put(msg)
            except Exception:
                dead.append(q)
        for q in dead:
            if q in _sse_subscribers:
                _sse_subscribers.remove(q)


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat(timespec="seconds")


def _ps_single_quote(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _windows_raise_window(titles: list[str] | None = None, process_names: list[str] | None = None, delay_ms: int = 500, attempts: int = 12):
    if platform.system() != "Windows":
        return
    titles = titles or []
    process_names = process_names or []
    title_expr = "@(" + ",".join(_ps_single_quote(t) for t in titles if t) + ")"
    process_expr = "@(" + ",".join(_ps_single_quote(p) for p in process_names if p) + ")"
    if title_expr == "@()" and process_expr == "@()":
        return
    script = (
        f"Start-Sleep -Milliseconds {int(delay_ms)}; "
        "Add-Type @\"\n"
        "using System;\n"
        "using System.Runtime.InteropServices;\n"
        "public class CapsuleWinFocus {\n"
        "  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);\n"
        "  [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);\n"
        "}\n"
        "\"@; "
        "$wshell = New-Object -ComObject WScript.Shell; "
        f"$titles = {title_expr}; "
        f"$processNames = {process_expr}; "
        f"for ($i = 0; $i -lt {int(attempts)}; $i++) {{ "
        "$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }; "
        "foreach ($p in $procs) { "
        "$nameMatch = $processNames -contains $p.ProcessName; "
        "$titleMatch = $false; "
        "foreach ($title in $titles) { if ($p.MainWindowTitle -like \"*$title*\") { $titleMatch = $true; break } } "
        "if ($nameMatch -or $titleMatch) { "
        "[CapsuleWinFocus]::ShowWindowAsync($p.MainWindowHandle, 9) | Out-Null; "
        "[CapsuleWinFocus]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; "
        "$wshell.AppActivate($p.Id) | Out-Null; "
        "exit 0 "
        "} "
        "} "
        "Start-Sleep -Milliseconds 250 "
        "}"
    )
    subprocess.Popen(
        ["powershell.exe", "-NoProfile", "-WindowStyle", "Hidden", "-Command", script],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


# Bridge routes: status + one-time install. Registered early so the frontend can
# diagnose REAPER before any capture attempt.
try:
    from reaper_bridge_routes import register_reaper_bridge_routes
    register_reaper_bridge_routes(app, _ok, _err, _DATA_PIPELINE, load_config)
except Exception as _bridge_routes_err:
    logger.warning("REAPER Bridge routes 注册失败: %s", _bridge_routes_err)


# ---------------------- 胶囊文件系统管理 ----------------------

def _read_manifest(capsule_dir: Path) -> dict | None:
    mf = capsule_dir / "manifest.json"
    if not mf.exists():
        meta = capsule_dir / "metadata.json"
        if meta.exists():
            try:
                raw = json.loads(meta.read_text("utf-8"))
                plugins = raw.get("plugins") or {}
                metadata = raw.get("info", {}) or {}
                metadata["plugin_count"] = plugins.get("count", 0)
                metadata["plugin_list"] = plugins.get("list", [])
                return {"capsule": raw, "tags": [], "metadata": metadata}
            except Exception:
                return None
        return None
    try:
        return json.loads(mf.read_text("utf-8"))
    except Exception:
        return None


def _write_manifest(capsule_dir: Path, manifest: dict):
    (capsule_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _safe_filename_stem(name: str) -> str:
    cleaned = "".join("_" if ch in '<>:"/\\|?*' or ord(ch) < 32 else ch for ch in name.strip())
    cleaned = cleaned.rstrip(" .")
    return cleaned[:120] or "capsule"


def _unique_child_path(parent: Path, filename: str, current: Path | None = None) -> Path:
    candidate = parent / filename
    if current and candidate.resolve() == current.resolve():
        return candidate
    if not candidate.exists():
        return candidate
    stem = candidate.stem
    suffix = candidate.suffix
    for idx in range(2, 1000):
        candidate = parent / f"{stem}_{idx}{suffix}"
        if current and candidate.resolve() == current.resolve():
            return candidate
        if not candidate.exists():
            return candidate
    raise RuntimeError("无法生成唯一的文件名")


def _find_capsule_rpp(capsule_dir: Path, manifest: dict | None = None) -> Path | None:
    cap = (manifest or {}).get("capsule") or {}
    if cap.get("rpp_file"):
        rpp_path = capsule_dir / cap["rpp_file"]
        if rpp_path.exists():
            return rpp_path
    rpps = sorted(capsule_dir.glob("*.rpp"))
    return rpps[0] if rpps else None


def _update_metadata_file(capsule_dir: Path, name: str, rpp_file: str | None = None):
    meta_path = capsule_dir / "metadata.json"
    if not meta_path.exists():
        return
    try:
        meta = json.loads(meta_path.read_text("utf-8"))
    except Exception:
        return
    meta["name"] = name
    if rpp_file:
        meta["rpp_file"] = rpp_file
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def _dir_size(d: Path) -> int:
    return sum(p.stat().st_size for p in d.rglob("*") if p.is_file())


def _get_dir_ctime(d: Path) -> str:
    try:
        st = d.stat()
        ts = st.st_birthtime if hasattr(st, "st_birthtime") else st.st_ctime
        return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds")
    except Exception:
        return ""


def _normalize_plugin_name(name: str) -> str:
    text = str(name or "").lower()
    text = re.sub(r"^(vst3i?|vsti?|clap|aui?|js|dxi?)\s*:\s*", "", text)
    text = re.sub(r"^[a-z0-9]+\s*:\s*", "", text)
    text = re.sub(r"\.(dll|vst3|vst|component|clap|so|dylib)$", "", text)
    text = re.sub(r"\([^)]*\)", " ", text)
    text = re.sub(r"\b(mono|stereo|x64|x86|vst3?|au|clap|component|plugin|effect|instrument)\b", " ", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _plugin_tokens(name: str) -> set[str]:
    normalized = _normalize_plugin_name(name)
    return {token for token in normalized.split() if len(token) >= 3 and not token.isdigit()}


def _reaper_resource_candidates() -> list[Path]:
    candidates: list[Path] = []
    system = platform.system()
    if system == "Windows":
        appdata = os.environ.get("APPDATA")
        if appdata:
            candidates.append(Path(appdata) / "REAPER")
    elif system == "Darwin":
        candidates.append(Path.home() / "Library" / "Application Support" / "REAPER")
    else:
        candidates.extend([Path.home() / ".config" / "REAPER", Path.home() / ".reaper"])

    cfg = load_config()
    configured = cfg.get("reaper_resource_path")
    if configured:
        candidates.insert(0, Path(configured))

    unique: list[Path] = []
    seen = set()
    for path in candidates:
        key = str(path)
        if key not in seen:
            unique.append(path)
            seen.add(key)
    return unique


def _parse_vstplugins_ini(path: Path) -> set[str]:
    names: set[str] = set()
    try:
        lines = path.read_text("utf-8", errors="ignore").splitlines()
    except Exception:
        return names

    for line in lines:
        line = line.strip()
        if not line or line.startswith("[") or line.startswith(";") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key_name = Path(key.strip()).stem
        for candidate in [key_name, *re.split(r"[,!]+", value)]:
            normalized = _normalize_plugin_name(candidate)
            if normalized and len(normalized) > 1:
                names.add(normalized)
    return names


def _load_plugin_inventory() -> dict:
    now = time.time()
    with _plugin_inventory_lock:
        cached = _plugin_inventory_cache.get("data")
        if cached and now < float(_plugin_inventory_cache.get("expires_at", 0)):
            return cached

        plugin_names: set[str] = set()
        files: list[str] = []
        for resource_dir in _reaper_resource_candidates():
            if not resource_dir.exists():
                continue
            for ini in sorted(resource_dir.glob("reaper-vstplugins*.ini")):
                parsed = _parse_vstplugins_ini(ini)
                if parsed:
                    plugin_names.update(parsed)
                    files.append(str(ini))

        data = {
            "available": bool(files),
            "plugin_names": plugin_names,
            "files": files,
            "count": len(plugin_names),
        }
        _plugin_inventory_cache["data"] = data
        _plugin_inventory_cache["expires_at"] = now + 60
        return data


def _plugin_available(required_name: str, installed: set[str]) -> bool:
    normalized = _normalize_plugin_name(required_name)
    if not normalized:
        return True
    if normalized in installed:
        return True
    required_tokens = _plugin_tokens(required_name)
    for name in installed:
        if len(normalized) >= 4 and (normalized in name or name in normalized):
            return True
        installed_tokens = _plugin_tokens(name)
        if required_tokens and installed_tokens:
            overlap = required_tokens & installed_tokens
            if len(overlap) >= min(2, len(required_tokens)):
                return True
    return False


def _capsule_plugin_status(plugin_list: list) -> dict:
    required = [str(p).strip() for p in (plugin_list or []) if str(p).strip()]
    unique_required = []
    seen = set()
    for name in required:
        key = _normalize_plugin_name(name)
        if key and key not in seen:
            unique_required.append(name)
            seen.add(key)

    inventory = _load_plugin_inventory()
    installed = inventory.get("plugin_names") or set()
    if not unique_required:
        return {"total": 0, "available": 0, "missing": 0, "unknown": 0, "missing_plugins": [], "inventory_available": bool(inventory.get("available"))}
    if not inventory.get("available"):
        return {"total": len(unique_required), "available": 0, "missing": 0, "unknown": len(unique_required), "missing_plugins": [], "inventory_available": False}

    missing = [name for name in unique_required if not _plugin_available(name, installed)]
    present = [name for name in unique_required if name not in missing]
    return {
        "total": len(unique_required),
        "available": len(unique_required) - len(missing),
        "missing": len(missing),
        "unknown": 0,
        "missing_plugins": missing,
        "present_plugins": present[:20],
        "inventory_available": True,
        "inventory_count": int(inventory.get("count") or 0),
    }


def _capsule_from_dir(capsule_dir: Path) -> dict | None:
    manifest = _read_manifest(capsule_dir)
    if not manifest:
        return None
    cap = manifest.get("capsule") or {}
    uuid = cap.get("uuid") or capsule_dir.name
    metadata = manifest.get("metadata") or {}
    plugin_list = metadata.get("plugin_list") or ((metadata.get("plugins") or {}).get("list") if isinstance(metadata.get("plugins"), dict) else None) or []
    result = {
        "id": uuid,
        "uuid": uuid,
        "name": cap.get("name") or capsule_dir.name,
        "project_name": cap.get("project_name"),
        "capsule_type": cap.get("capsule_type", "reaper"),
        "preview_audio": cap.get("preview_audio"),
        "rpp_file": cap.get("rpp_file"),
        "keywords": cap.get("keywords"),
        "description": cap.get("description"),
        "source_peer": cap.get("source_peer"),
        "size_bytes": _dir_size(capsule_dir),
        "created_at": cap.get("created_at") or _get_dir_ctime(capsule_dir),
        "tags": manifest.get("tags", []),
        "metadata": metadata,
    }
    result["plugin_status"] = _capsule_plugin_status(plugin_list)
    return result


def scan_capsules(q: str | None = None) -> list[dict]:
    items = []
    if not CAPSULES_DIR.exists():
        return items
    for sub in sorted(CAPSULES_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if not sub.is_dir() or sub.name.startswith("."):
            continue
        cap = _capsule_from_dir(sub)
        if cap:
            if q:
                q_lower = q.lower()
                if q_lower not in (cap.get("name") or "").lower() and q_lower not in (cap.get("keywords") or "").lower():
                    continue
            items.append(cap)
    return items


def get_capsule_by_id(cap_id: str) -> dict | None:
    d = CAPSULES_DIR / cap_id
    if d.exists() and d.is_dir():
        return _capsule_from_dir(d)
    for sub in CAPSULES_DIR.iterdir():
        if sub.is_dir():
            c = _capsule_from_dir(sub)
            if c and c["uuid"] == cap_id:
                return c
    return None


def get_capsule_dir_by_id(cap_id: str) -> Path | None:
    d = CAPSULES_DIR / cap_id
    if d.exists() and d.is_dir():
        return d
    for sub in CAPSULES_DIR.iterdir():
        if sub.is_dir():
            c = _capsule_from_dir(sub)
            if c and c["uuid"] == cap_id:
                return sub
    return None


# ---------------------- 联系人文件管理 ----------------------

def _load_contacts() -> list[dict]:
    if CONTACTS_FILE.exists():
        try:
            return json.loads(CONTACTS_FILE.read_text("utf-8"))
        except Exception:
            pass
    return []


def _save_contacts(contacts: list[dict]):
    CONTACTS_FILE.write_text(json.dumps(contacts, ensure_ascii=False, indent=2), encoding="utf-8")


def _contacts_next_id(contacts: list[dict]) -> int:
    return max((c.get("id", 0) for c in contacts), default=0) + 1


# ---------------------- 健康检查 / 网络信息 ----------------------

@app.route("/api/health", methods=["GET"])
def health():
    return _ok({"status": "ok", "port": PORT})


@app.route("/api/network/info", methods=["GET"])
def get_network_info():
    info = network_info(PORT)
    info["shared_token_required"] = bool(SHARED_TOKEN)
    return _ok(info)


@app.route("/api/events", methods=["GET"])
def events():
    q: queue.Queue[str] = queue.Queue()
    with _sse_lock:
        _sse_subscribers.append(q)

    def stream():
        try:
            yield ": connected\n\n"
            while True:
                try:
                    yield q.get(timeout=25)
                except queue.Empty:
                    yield ": heartbeat\n\n"
        finally:
            with _sse_lock:
                if q in _sse_subscribers:
                    _sse_subscribers.remove(q)

    return Response(stream(), mimetype="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------------------- 胶囊库 ----------------------

@app.route("/api/capsules", methods=["GET"])
def list_capsules():
    q = request.args.get("q")
    capsules = scan_capsules(q=q)
    return _ok({"items": capsules, "count": len(capsules)})


@app.route("/api/capsules/<cap_id>", methods=["GET"])
def get_capsule(cap_id: str):
    cap = get_capsule_by_id(cap_id)
    if not cap:
        return _err("胶囊不存在", 404)
    return _ok(cap)


@app.route("/api/capsules", methods=["POST"])
def create_capsule():
    if "bundle" in request.files:
        f = request.files["bundle"]
        try:
            manifest, final_dir, _size_bytes = extract_bundle(f.stream, CAPSULES_DIR)
        except ValueError as e:
            return _err(str(e), 400)
        _write_manifest(final_dir, manifest)
        return _ok(_capsule_from_dir(final_dir), message="胶囊已导入"), 201

    payload = request.get_json(silent=True) or {}
    name = payload.get("name")
    source_dir = payload.get("source_dir")
    if not name or not source_dir:
        return _err("name 和 source_dir 必填", 400)
    src = Path(source_dir)
    if not src.exists() or not src.is_dir():
        return _err(f"源目录不存在: {source_dir}", 400)

    cap_uuid = payload.get("uuid") or str(uuid_lib.uuid4())
    target = CAPSULES_DIR / cap_uuid
    if target.exists():
        return _err("UUID 冲突，胶囊目录已存在", 409)
    shutil.copytree(src, target)

    manifest = {
        "schema_version": 1,
        "capsule": {
            "uuid": cap_uuid,
            "name": name,
            "project_name": payload.get("project_name"),
            "capsule_type": payload.get("capsule_type", "reaper"),
            "preview_audio": payload.get("preview_audio"),
            "rpp_file": payload.get("rpp_file"),
            "keywords": payload.get("keywords"),
            "description": payload.get("description"),
            "created_at": _now_iso(),
        },
        "tags": payload.get("tags") or [],
        "metadata": payload.get("metadata") or {},
    }
    _write_manifest(target, manifest)
    return _ok(_capsule_from_dir(target), message="胶囊已创建"), 201


@app.route("/api/capsules/<cap_id>", methods=["DELETE"])
def delete_capsule(cap_id: str):
    target = get_capsule_dir_by_id(cap_id)
    if not target:
        return _err("胶囊不存在", 404)
    shutil.rmtree(target, ignore_errors=True)
    return _ok({"id": cap_id})


@app.route("/api/capsules/<cap_id>", methods=["PATCH"])
def update_capsule(cap_id: str):
    target = get_capsule_dir_by_id(cap_id)
    if not target:
        return _err("胶囊不存在", 404)
    manifest = _read_manifest(target)
    if not manifest:
        return _err("manifest 读取失败", 500)
    data = request.get_json(silent=True) or {}
    new_name = data.get("name")
    if new_name and new_name.strip():
        clean_name = new_name.strip()
        safe_stem = _safe_filename_stem(clean_name)
        cap = manifest.setdefault("capsule", {})
        rpp_path = _find_capsule_rpp(target, manifest)
        new_rpp_name = None
        if rpp_path:
            try:
                new_rpp_path = _unique_child_path(target, f"{safe_stem}.rpp", current=rpp_path)
                if new_rpp_path.resolve() != rpp_path.resolve():
                    rpp_path.rename(new_rpp_path)
                new_rpp_name = new_rpp_path.name
            except Exception as e:
                return _err(f"重命名 RPP 文件失败: {e}", 500)
        cap["name"] = clean_name
        if new_rpp_name:
            cap["rpp_file"] = new_rpp_name
        _update_metadata_file(target, clean_name, new_rpp_name)
        _write_manifest(target, manifest)
    return _ok(_capsule_from_dir(target))


@app.route("/api/capsules/<cap_id>/preview", methods=["GET"])
def capsule_preview(cap_id: str):
    target = get_capsule_dir_by_id(cap_id)
    if not target:
        return _err("胶囊不存在", 404)
    manifest = _read_manifest(target)
    if manifest:
        cap = manifest.get("capsule") or {}
        if cap.get("preview_audio"):
            p = target / cap["preview_audio"]
            if p.exists():
                mime = "audio/ogg" if p.suffix.lower() == ".ogg" else "audio/wav"
                return send_file(str(p), mimetype=mime)
    for ext in ("*.ogg", "*.wav"):
        files = list(target.glob(ext))
        if files:
            f = files[0]
            mime = "audio/ogg" if f.suffix.lower() == ".ogg" else "audio/wav"
            return send_file(str(f), mimetype=mime)
    return _err("无预览音频文件", 404)


@app.route("/api/capsules/<cap_id>/open-rpp", methods=["POST"])
def open_capsule_rpp(cap_id: str):
    target = get_capsule_dir_by_id(cap_id)
    if not target:
        return _err("胶囊不存在", 404)
    manifest = _read_manifest(target)
    rpp_path = None
    if manifest:
        cap = manifest.get("capsule") or {}
        if cap.get("rpp_file"):
            rpp_path = target / cap["rpp_file"]
    if not rpp_path or not rpp_path.exists():
        rpps = list(target.glob("*.rpp"))
        if rpps:
            rpp_path = rpps[0]
    if not rpp_path or not rpp_path.exists():
        return _err("未找到 RPP 工程文件", 404)
    try:
        if platform.system() == "Darwin":
            subprocess.Popen(["open", str(rpp_path)])
        elif platform.system() == "Windows":
            os.startfile(str(rpp_path))
            _windows_raise_window(["REAPER", rpp_path.stem], ["reaper"], delay_ms=700, attempts=20)
        else:
            subprocess.Popen(["xdg-open", str(rpp_path)])
    except Exception as e:
        return _err(f"打开 RPP 失败: {e}", 500)
    return _ok({"rpp": str(rpp_path), "message": "已打开"})


@app.route("/api/capsules/<cap_id>/open-folder", methods=["POST"])
def open_capsule_folder(cap_id: str):
    target = get_capsule_dir_by_id(cap_id)
    if not target:
        return _err("胶囊不存在", 404)
    try:
        if platform.system() == "Darwin":
            subprocess.Popen(["open", str(target)])
        elif platform.system() == "Windows":
            subprocess.Popen(
                ["explorer.exe", str(target)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            _windows_raise_window([target.name, str(target), "File Explorer", "资源管理器"], ["explorer"], delay_ms=350, attempts=20)
        else:
            subprocess.Popen(["xdg-open", str(target)])
    except Exception as e:
        return _err(f"打开胶囊文件夹失败: {e}", 500)
    return _ok({"folder": str(target), "message": "已打开"})


@app.route("/api/capsules/<cap_id>/bundle", methods=["GET"])
def download_bundle(cap_id: str):
    target = get_capsule_dir_by_id(cap_id)
    if not target:
        return _err("胶囊不存在", 404)
    cap = _capsule_from_dir(target)
    if not cap:
        return _err("manifest 读取失败", 500)
    blob = build_bundle(cap, target, sender=network_info(PORT))
    return send_file(
        io.BytesIO(blob),
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"{cap['uuid']}.capsule.zip",
    )


# ---------------------- Reaper 捕获 ----------------------

@app.route("/api/capsules/webui-export", methods=["OPTIONS", "POST"])
def webui_export():
    if request.method == "OPTIONS":
        resp = jsonify({"status": "ok"})
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
        return resp

    try:
        from exporters.reaper_webui_export import quick_webui_export
    except ImportError as e:
        return _err(f"Reaper 导出模块不可用: {e}", 501)

    data = request.get_json(silent=True) or {}
    capsule_type = data.get("capsule_type", "magic")
    render_preview = data.get("render_preview", True)
    webui_port = int(data.get("webui_port", 9000))
    export_dir = str(CAPSULES_DIR)
    os.environ["CAPSULE_TRANSFER_EXPORT_DIR"] = export_dir
    os.environ["SYNESTH_CAPSULE_OUTPUT"] = export_dir

    logger.info("Reaper bridge export: type=%s preview=%s dir=%s", capsule_type, render_preview, export_dir)

    if not _REAPER_CAPTURE_LOCK.acquire(blocking=False):
        return _err("已有 Reaper 捕获在进行中，请等待完成后再试", 429)

    try:
        result = quick_webui_export(
            project_name=capsule_type,
            theme_name=capsule_type,
            render_preview=render_preview,
            webui_port=webui_port,
            capsule_type=capsule_type,
            export_dir=export_dir,
            username=data.get("username", "user"),
        )
    finally:
        _REAPER_CAPTURE_LOCK.release()

    if not result.get("success"):
        error_payload = {
            "mode": result.get("mode", "bridge"),
            "needs_bridge_install": bool(result.get("needs_bridge_install")),
            "webui_required": bool(result.get("webui_required")),
            "diagnostics": result.get("diagnostics") or result.get("bridge_diagnostics") or "",
            "export_phase": result.get("export_phase") or "",
            "bridge_status": result.get("bridge_status") or {},
        }
        return jsonify({"success": False, "error": result.get("error", "Reaper 导出失败"), "data": error_payload}), 500

    expected_name = result.get("capsule_name")
    capsule_dir_path = Path(export_dir) / expected_name if expected_name else None

    waited = 0.0
    while capsule_dir_path and waited < 5:
        metadata_file = capsule_dir_path / "metadata.json"
        if metadata_file.exists():
            time.sleep(0.3)
            break
        time.sleep(0.3)
        waited += 0.3

    imported = None
    if capsule_dir_path and capsule_dir_path.exists():
        metadata_file = capsule_dir_path / "metadata.json"
        if metadata_file.exists():
            try:
                meta = json.loads(metadata_file.read_text("utf-8"))
            except Exception:
                meta = {}

            cap_uuid = meta.get("uuid") or meta.get("id") or str(uuid_lib.uuid4())
            name = meta.get("name") or expected_name or capsule_dir_path.name
            final_target = capsule_dir_path
            preview_name = meta.get("preview_audio") or (meta.get("files") or {}).get("preview")
            preview_requested = bool(render_preview or result.get("preview_requested"))
            if preview_requested and preview_name:
                preview_path = capsule_dir_path / preview_name
                if preview_path.exists():
                    result["preview_rendered"] = True
                    result["preview_audio"] = preview_name
                    result["preview_note"] = "preview rendered"
                elif result.get("preview_rendered") is False:
                    preview_name = ""
                    result["preview_audio"] = ""
                    result["preview_note"] = result.get("preview_note") or "preview requested but skipped on Windows"
                else:
                    preview_waited = 0.0
                    while not preview_path.exists() and preview_waited < 5:
                        time.sleep(0.5)
                        preview_waited += 0.5
                    if preview_path.exists():
                        result["preview_rendered"] = True
                        result["preview_audio"] = preview_name
                        result["preview_note"] = "preview rendered"
                    else:
                        preview_name = ""
                        result["preview_audio"] = ""
                        result["preview_note"] = "preview requested but output file was not found"

            tech = meta.get("info", {}) or {}
            plugins = meta.get("plugins", {}) or {}
            routing = meta.get("routing_info", {}) or {}
            manifest = {
                "schema_version": 1,
                "capsule": {
                    "uuid": cap_uuid,
                    "name": name,
                    "project_name": meta.get("project_name"),
                    "capsule_type": capsule_type,
                    "preview_audio": preview_name,
                    "rpp_file": meta.get("rpp_file") or (meta.get("files") or {}).get("project"),
                    "keywords": meta.get("keywords"),
                    "description": meta.get("description"),
                    "created_at": _now_iso(),
                },
                "tags": [],
                "metadata": {
                    "bpm": tech.get("bpm"),
                    "duration": tech.get("length"),
                    "sample_rate": tech.get("sample_rate"),
                    "plugin_count": plugins.get("count"),
                    "plugin_list": plugins.get("list", []),
                    "has_sends": routing.get("has_sends"),
                    "has_folder_bus": routing.get("has_folder_bus"),
                    "tracks_included": routing.get("tracks_included"),
                },
            }
            _write_manifest(final_target, manifest)
            imported = _capsule_from_dir(final_target)

    resp_data = {"capsule_name": expected_name, "export_result": result}
    if imported:
        resp_data["auto_imported"] = [imported]
        logger.info("Reaper 导出并入库: %s", imported.get("name"))
    else:
        resp_data["auto_imported"] = []
        logger.warning("Reaper 导出成功但未能自动入库: %s", expected_name)

    return _ok(resp_data, message="导出完成")


def reaper_bridge_status():
    webui_port = int(request.args.get("webui_port") or load_config().get("webui_port", 9000))
    try:
        from exporters.reaper_bridge_client import ReaperBridgeClient
        client = ReaperBridgeClient(port=webui_port)
        status = client.status().as_dict()
        try:
            diagnostics = json.loads(client._diagnostics())
        except Exception:
            diagnostics = {}
    except Exception as exc:
        status = {"webui_available": False, "bridge_available": False, "error": str(exc)}
        diagnostics = {}

    path_manager = {}
    try:
        pm = PathManager.get_instance()
        path_manager = {
            "export_dir": str(pm.export_dir),
            "resource_dir": str(pm.resource_dir),
            "lua_scripts_dir": str(pm.lua_scripts_dir),
        }
    except Exception:
        pass

    desired_bridge_version = ""
    bridge_script = _DATA_PIPELINE / "lua_scripts" / "capsule_bridge.lua"
    try:
        bridge_text = bridge_script.read_text("utf-8", errors="ignore")
        version_match = re.search(r'BRIDGE_VERSION\s*=\s*"([^"]+)"', bridge_text)
        if version_match:
            desired_bridge_version = version_match.group(1)
    except Exception:
        pass

    status.update(diagnostics)
    status.update({
        "app_dir": str(APP_DIR),
        "data_dir": str(DATA_DIR),
        "capsules_dir": str(CAPSULES_DIR),
        "data_pipeline_dir": str(_DATA_PIPELINE),
        "desired_bridge_version": desired_bridge_version,
        "path_manager": path_manager,
        "env_export_dir": os.environ.get("CAPSULE_TRANSFER_EXPORT_DIR", ""),
    })
    return _ok(status)


def reaper_bridge_ping():
    webui_port = int(request.args.get("webui_port") or load_config().get("webui_port", 9000))
    try:
        from exporters.reaper_bridge_client import ReaperBridgeClient
        result = ReaperBridgeClient(port=webui_port).ping()
        return _ok(result)
    except Exception as exc:
        return _err(str(exc), 500)


if "reaper_bridge_status" in app.view_functions:
    app.view_functions["reaper_bridge_status"] = reaper_bridge_status
else:
    app.add_url_rule("/api/reaper/bridge/status", "reaper_bridge_status", reaper_bridge_status, methods=["GET"])

if "reaper_bridge_ping" in app.view_functions:
    app.view_functions["reaper_bridge_ping"] = reaper_bridge_ping
else:
    app.add_url_rule("/api/reaper/bridge/ping", "reaper_bridge_ping", reaper_bridge_ping, methods=["GET"])


# ---------------------- 联系人 ----------------------

@app.route("/api/contacts", methods=["GET"])
def list_contacts():
    return _ok({"items": _load_contacts()})


@app.route("/api/contacts", methods=["POST"])
def create_contact():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    ip = (data.get("ip") or "").strip()
    port = int(data.get("port") or 5005)
    note = data.get("note")
    if not name or not ip:
        return _err("name 和 ip 必填", 400)
    contacts = _load_contacts()
    existing = next((c for c in contacts if c["ip"] == ip and c["port"] == port), None)
    if existing:
        existing["name"] = name
        if note is not None:
            existing["note"] = note
    else:
        contacts.append({
            "id": _contacts_next_id(contacts),
            "name": name,
            "ip": ip,
            "port": port,
            "note": note or "",
            "last_seen": None,
            "created_at": _now_iso(),
        })
    _save_contacts(contacts)
    target = next((c for c in contacts if c["ip"] == ip and c["port"] == port), None)
    return _ok(target), 201


@app.route("/api/contacts/<int:contact_id>", methods=["DELETE"])
def delete_contact(contact_id: int):
    contacts = _load_contacts()
    new_list = [c for c in contacts if c.get("id") != contact_id]
    if len(new_list) == len(contacts):
        return _err("联系人不存在", 404)
    _save_contacts(new_list)
    return _ok({"id": contact_id})


@app.route("/api/contacts/ping", methods=["POST"])
def ping_contact():
    data = request.get_json(silent=True) or {}
    ip = data.get("ip")
    port = int(data.get("port") or 5005)
    if not ip:
        return _err("ip 必填", 400)
    started = time.time()
    try:
        r = requests.get(f"http://{ip}:{port}/api/health", timeout=2.0)
        ok = r.ok
        latency_ms = int((time.time() - started) * 1000)
        if ok:
            contacts = _load_contacts()
            for c in contacts:
                if c["ip"] == ip and c["port"] == port:
                    c["last_seen"] = _now_iso()
            _save_contacts(contacts)
        return _ok({"online": ok, "latency_ms": latency_ms, "status": r.status_code})
    except Exception as e:
        return _ok({"online": False, "error": str(e)})


# ---------------------- 点对点收发 ----------------------

@app.route("/api/p2p/receive-mode", methods=["GET"])
def get_receive_mode():
    return _ok({"mode": _get_receive_mode()})


@app.route("/api/p2p/receive-mode", methods=["PATCH"])
def set_receive_mode():
    data = request.get_json(silent=True) or {}
    mode = data.get("mode", "").strip()
    if mode not in ("off", "confirm", "auto"):
        return _err("mode 必须是 off / confirm / auto", 400)
    _set_receive_mode(mode)
    logger.info("接收模式已切换为: %s", mode)
    return _ok({"mode": mode})


@app.route("/api/p2p/request", methods=["POST"])
def p2p_request():
    mode = _get_receive_mode()
    if mode == "off":
        return _err("对方已关闭接收", 403)

    data = request.get_json(silent=True) or {}
    sender_ip = data.get("sender_ip") or request.remote_addr or "unknown"
    sender_name = data.get("sender_name") or sender_ip
    capsule_name = data.get("capsule_name") or "胶囊"
    capsule_type = data.get("capsule_type") or ""
    size_bytes = data.get("size_bytes") or 0

    if mode == "auto":
        token = str(uuid_lib.uuid4())
        with _pending_lock:
            _pending_requests[token] = {
                "id": token,
                "sender_ip": sender_ip,
                "sender_name": sender_name,
                "capsule_name": capsule_name,
                "capsule_type": capsule_type,
                "size_bytes": size_bytes,
                "status": "accepted",
                "created_at": time.time(),
            }
        return _ok({"accept_token": token, "auto_accepted": True})

    _cleanup_expired_requests()
    req_id = str(uuid_lib.uuid4())
    req_data = {
        "id": req_id,
        "sender_ip": sender_ip,
        "sender_name": sender_name,
        "capsule_name": capsule_name,
        "capsule_type": capsule_type,
        "size_bytes": size_bytes,
        "status": "pending",
        "created_at": time.time(),
    }
    with _pending_lock:
        _pending_requests[req_id] = req_data

    _notify_sse({"type": "transfer_request", "request": req_data})
    return _ok({"request_id": req_id, "status": "pending", "timeout": _PENDING_TIMEOUT}, message="等待对方确认"), 202


@app.route("/api/p2p/pending", methods=["GET"])
def p2p_pending():
    _cleanup_expired_requests()
    with _pending_lock:
        items = [v for v in _pending_requests.values() if v["status"] == "pending"]
    return _ok({"items": items})


@app.route("/api/p2p/accept/<req_id>", methods=["POST"])
def p2p_accept(req_id):
    with _pending_lock:
        req = _pending_requests.get(req_id)
        if not req:
            return _err("请求不存在或已过期", 404)
        if req["status"] != "pending":
            return _err("请求已处理", 409)
        req["status"] = "accepted"
    logger.info("已接受来自 %s 的传输请求", req["sender_name"])
    return _ok({"accept_token": req_id})


@app.route("/api/p2p/reject/<req_id>", methods=["POST"])
def p2p_reject(req_id):
    with _pending_lock:
        req = _pending_requests.get(req_id)
        if not req:
            return _err("请求不存在或已过期", 404)
        if req["status"] != "pending":
            return _err("请求已处理", 409)
        req["status"] = "rejected"
    logger.info("已拒绝来自 %s 的传输请求", req["sender_name"])
    return _ok({"status": "rejected"})


@app.route("/api/p2p/request-status/<req_id>", methods=["GET"])
def p2p_check_request(req_id):
    _cleanup_expired_requests()
    with _pending_lock:
        req = _pending_requests.get(req_id)
    if not req:
        return _err("请求不存在或已过期", 404)
    result = {"status": req["status"]}
    if req["status"] == "accepted":
        result["accept_token"] = req_id
    return _ok(result)


@app.route("/api/p2p/import", methods=["POST"])
def p2p_import():
    mode = _get_receive_mode()
    if mode == "off":
        return _err("接收已关闭", 403)

    ok, msg = _check_shared_token()
    if not ok:
        return _err(msg or "unauthorized", 401)

    if mode == "confirm":
        token = request.headers.get("X-Accept-Token", "").strip()
        if not token:
            return _err("缺少确认令牌（X-Accept-Token）", 403)
        with _pending_lock:
            req = _pending_requests.get(token)
            if not req or req["status"] != "accepted":
                return _err("确认令牌无效或未被接受", 403)
            del _pending_requests[token]

    if "bundle" not in request.files:
        return _err("缺少字段 bundle（zip 文件）", 400)

    f = request.files["bundle"]
    sender_ip = request.headers.get("X-Capsule-Peer-IP") or request.remote_addr or "unknown"
    sender_name = request.headers.get("X-Capsule-Peer-Name") or sender_ip
    peer_label = sender_name if sender_name == sender_ip else f"{sender_name} ({sender_ip})"

    try:
        manifest, final_dir, size_bytes = extract_bundle(f.stream, CAPSULES_DIR)
    except ValueError as e:
        return _err(str(e), 400)

    manifest.setdefault("capsule", {})["source_peer"] = peer_label
    _write_manifest(final_dir, manifest)
    cap = _capsule_from_dir(final_dir)
    logger.info("接收胶囊 %s 来自 %s (%d bytes)", cap.get("name"), peer_label, size_bytes)
    _notify_sse({"type": "capsule_received", "capsule": {"name": cap.get("name"), "source": peer_label}})
    return _ok(cap, message="已接收并入库"), 201


@app.route("/api/p2p/send", methods=["POST"])
def p2p_send():
    data = request.get_json(silent=True) or {}
    capsule_id = data.get("capsule_id")
    target_ip = (data.get("target_ip") or "").strip()
    target_port = int(data.get("target_port") or 5005)
    target_name = data.get("target_name") or f"{target_ip}:{target_port}"
    if not capsule_id or not target_ip:
        return _err("capsule_id 与 target_ip 必填", 400)

    capsule_root = get_capsule_dir_by_id(str(capsule_id))
    if not capsule_root:
        return _err("胶囊不存在", 404)
    cap = _capsule_from_dir(capsule_root)
    if not cap:
        return _err("胶囊文件目录缺失", 410)

    self_info = network_info(PORT)
    blob = build_bundle(cap, capsule_root, sender=self_info)
    try:
        req_resp = requests.post(
            f"http://{target_ip}:{target_port}/api/p2p/request",
            json={
                "sender_ip": self_info.get("ip", ""),
                "sender_name": self_info.get("hostname", ""),
                "capsule_id": cap.get("uuid"),
                "capsule_name": cap.get("name"),
                "capsule_type": cap.get("capsule_type"),
                "size_bytes": len(blob),
            },
            timeout=15,
        )
        req_body = req_resp.json()
    except Exception as e:
        return _err(f"请求确认失败: {e}", 502)

    if req_resp.status_code == 403:
        return _err("对方已关闭接收", 403)
    if not req_resp.ok:
        return _err(f"请求确认失败: HTTP {req_resp.status_code}", 502)

    req_data = req_body.get("data", {})
    accept_token = req_data.get("accept_token")
    if not accept_token:
        request_id = req_data.get("request_id")
        if not request_id:
            return _err("对方返回格式异常", 502)
        deadline = time.time() + _PENDING_TIMEOUT
        while time.time() < deadline:
            time.sleep(1.0)
            try:
                check_resp = requests.get(
                    f"http://{target_ip}:{target_port}/api/p2p/request-status/{request_id}",
                    timeout=3,
                )
                if check_resp.ok:
                    check_data = check_resp.json().get("data", {})
                    status = check_data.get("status")
                    if status == "accepted":
                        accept_token = check_data.get("accept_token")
                        break
                    if status == "rejected":
                        return _err("对方拒绝了传输请求", 403)
            except Exception:
                pass
        if not accept_token:
            return _err("等待确认超时，对方未响应", 408)

    headers = {
        "X-Capsule-Peer-IP": self_info.get("ip", ""),
        "X-Capsule-Peer-Name": self_info.get("hostname", ""),
        "X-Accept-Token": accept_token,
    }
    if SHARED_TOKEN:
        headers["X-Capsule-Token"] = SHARED_TOKEN

    files = {"bundle": (f"{cap['uuid']}.capsule.zip", io.BytesIO(blob), "application/zip")}
    try:
        resp = requests.post(
            f"http://{target_ip}:{target_port}/api/p2p/import",
            files=files,
            headers=headers,
            timeout=120,
        )
    except Exception as e:
        return _err(f"发送失败: {e}", 502)
    if not resp.ok:
        return _err(f"对方拒绝: HTTP {resp.status_code}", 502)

    contacts = _load_contacts()
    existing = next((c for c in contacts if c["ip"] == target_ip and c["port"] == target_port), None)
    if not existing:
        contacts.append({
            "id": _contacts_next_id(contacts),
            "name": target_name,
            "ip": target_ip,
            "port": target_port,
            "note": "",
            "last_seen": _now_iso(),
            "created_at": _now_iso(),
        })
        _save_contacts(contacts)

    return _ok({"bytes": len(blob), "remote": resp.json()}, message="已发送")


# ---------------------- 设置 ----------------------

@app.route("/api/settings", methods=["GET"])
def get_settings():
    return _ok(load_config())


@app.route("/api/settings", methods=["PATCH"])
def update_settings():
    data = request.get_json(silent=True) or {}
    cfg = load_config()
    if "reaper_path" in data:
        cfg["reaper_path"] = data["reaper_path"]
    if "webui_port" in data:
        cfg["webui_port"] = int(data["webui_port"])
    if "port" in data:
        cfg["port"] = int(data["port"])
    if "shared_token" in data:
        cfg["shared_token"] = data["shared_token"]
    if "receive_mode" in data:
        mode = data["receive_mode"]
        if mode in ("off", "confirm", "auto"):
            cfg["receive_mode"] = mode
            _set_receive_mode(mode)
    save_config(cfg)
    return _ok(cfg)


# ---------------------- 入口 ----------------------

if __name__ == "__main__":
    logger.info("Sound Capsule LAN 服务启动: %s:%d", HOST, PORT)
    logger.info("程序目录: %s", APP_DIR)
    logger.info("数据目录: %s", DATA_DIR)
    if SHARED_TOKEN:
        logger.info("已启用共享密钥（X-Capsule-Token）")
    app.run(host=HOST, port=PORT, debug=False, threaded=True)
