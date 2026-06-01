"""Sound Capsule LAN —— 本地 Flask 服务（无数据库版本）。

所有胶囊数据基于文件系统 (manifest.json) 管理，联系人存储于 contacts.json。
支持绿色版打包，所有路径相对于程序自身目录。
"""

from __future__ import annotations

import io
import base64
import concurrent.futures
import hashlib
import ipaddress
import json
import logging
import os
import platform
import queue
import re
import shutil
import socket
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
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat, PublicFormat

from bundle import build_bundle, extract_bundle
from net import network_info

# ---------------------- 路径初始化（绿色版） ----------------------

if getattr(sys, "frozen", False):
    APP_DIR = Path(sys.executable).resolve().parent
else:
    APP_DIR = Path(__file__).resolve().parent

DATA_DIR = APP_DIR / "data"
CAPSULES_DIR = DATA_DIR / "capsules"
LOG_DIR = DATA_DIR / "logs"
CONTACTS_FILE = DATA_DIR / "contacts.json"
CAPSULE_FOLDERS_FILE = DATA_DIR / "capsule_folders.json"
IDENTITY_FILE = DATA_DIR / "peer_identity.json"
CONFIG_FILE = APP_DIR / "config.json"

CAPSULES_DIR.mkdir(parents=True, exist_ok=True)
LOG_DIR.mkdir(parents=True, exist_ok=True)
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
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(LOG_DIR / "capsule-transfer.log", encoding="utf-8"),
    ],
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


def _truthy(value) -> bool:
    return str(value).strip().lower() in ("1", "true", "yes", "on")


_config = load_config()
PORT = int(os.getenv("LAN_CAPSULE_PORT", _config.get("port", 5005)))
HOST = os.getenv("LAN_CAPSULE_HOST", _config.get("host", "0.0.0.0"))
SHARED_TOKEN = os.getenv("LAN_CAPSULE_SHARED_TOKEN", _config.get("shared_token", "")).strip()
ALLOW_PUBLIC_PEERS = _truthy(os.getenv("LAN_CAPSULE_ALLOW_PUBLIC_PEERS", _config.get("allow_public_peers", False)))
_REAPER_CAPTURE_LOCK = threading.Lock()

# receive_mode: "off" = 关闭接收, "confirm" = 验证接收, "auto" = 自动接收
_receive_mode_lock = threading.Lock()
_receive_mode = _config.get("receive_mode", "confirm")
_pending_requests: dict[str, dict] = {}
_pending_lock = threading.Lock()
_PENDING_TIMEOUT = 60
_sse_subscribers: list = []
_sse_lock = threading.Lock()
_plugin_inventory_cache: dict = {"expires_at": 0.0, "data": None}
_plugin_inventory_lock = threading.Lock()

def _configured_cors_origins() -> list[str]:
    env_origins = os.getenv("LAN_CAPSULE_ALLOWED_ORIGINS", "").strip()
    if env_origins:
        return [origin.strip() for origin in env_origins.split(",") if origin.strip()]
    cfg_origins = _config.get("allowed_origins")
    if isinstance(cfg_origins, list):
        return [str(origin).strip() for origin in cfg_origins if str(origin).strip()]
    return [
        "http://127.0.0.1:3100",
        "http://localhost:3100",
        f"http://127.0.0.1:{PORT}",
        f"http://localhost:{PORT}",
    ]


def _is_lan_ip(value: str | None) -> bool:
    if not value:
        return False
    try:
        ip = ipaddress.ip_address(str(value).split("%", 1)[0])
    except ValueError:
        return False
    if ip.is_unspecified or ip.is_multicast:
        return False
    return ip.is_loopback or ip.is_private or ip.is_link_local


def _is_lan_host(host: str | None) -> bool:
    if ALLOW_PUBLIC_PEERS:
        return True
    if _is_lan_ip(host):
        return True
    if not host:
        return False
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except OSError:
        return False
    return any(_is_lan_ip(info[4][0]) for info in infos)


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
    resources={r"/api/*": {"origins": _configured_cors_origins()}},
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=[
        "Content-Type",
        "X-Capsule-Token",
        "X-Accept-Token",
        "X-Capsule-Peer-IP",
        "X-Capsule-Peer-Name",
        "X-Capsule-Peer-ID",
        "X-Capsule-Peer-Public-Key",
        "X-Capsule-Peer-Signature",
        "X-Capsule-Peer-Nonce",
        "X-Capsule-Peer-Timestamp",
        "X-Capsule-Bundle-SHA256",
    ],
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


@app.before_request
def _block_public_api_access():
    if not request.path.startswith("/api/") or ALLOW_PUBLIC_PEERS:
        return None
    if not request.remote_addr or _is_lan_ip(request.remote_addr):
        return None
    logger.warning("已阻止非局域网 API 访问: %s %s from %s", request.method, request.path, request.remote_addr)
    return _err("已阻止非局域网 API 访问", 403)


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


def _b64_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64_decode(value: str) -> bytes:
    padded = value + "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def _public_key_fingerprint(public_key: str) -> str:
    return hashlib.sha256(public_key.encode("utf-8")).hexdigest()[:16]


def _get_local_identity() -> dict:
    identity = {}
    if IDENTITY_FILE.exists():
        try:
            identity = json.loads(IDENTITY_FILE.read_text("utf-8"))
        except Exception:
            identity = {}

    cfg = load_config()
    if not identity:
        identity = cfg.get("peer_identity") or {}
    private_key_b64 = identity.get("private_key") or ""
    public_key_b64 = identity.get("public_key") or ""
    if private_key_b64 and public_key_b64:
        peer_id = identity.get("peer_id") or hashlib.sha256(public_key_b64.encode("utf-8")).hexdigest()[:32]
        clean_identity = {
            "peer_id": peer_id,
            "public_key": public_key_b64,
            "private_key": private_key_b64,
            "fingerprint": _public_key_fingerprint(public_key_b64),
            "created_at": identity.get("created_at") or _now_iso(),
        }
        if not IDENTITY_FILE.exists():
            IDENTITY_FILE.write_text(json.dumps(clean_identity, ensure_ascii=False, indent=2), encoding="utf-8")
        if cfg.get("peer_identity"):
            cfg.pop("peer_identity", None)
            save_config(cfg)
        return clean_identity

    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key()
    private_raw = private_key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    public_raw = public_key.public_bytes(Encoding.Raw, PublicFormat.Raw)
    public_key_b64 = _b64_encode(public_raw)
    private_key_b64 = _b64_encode(private_raw)
    peer_id = hashlib.sha256(public_key_b64.encode("utf-8")).hexdigest()[:32]
    identity = {
        "peer_id": peer_id,
        "public_key": public_key_b64,
        "private_key": private_key_b64,
        "fingerprint": _public_key_fingerprint(public_key_b64),
        "created_at": _now_iso(),
    }
    IDENTITY_FILE.write_text(json.dumps(identity, ensure_ascii=False, indent=2), encoding="utf-8")
    return identity


def _peer_signature_payload(action: str, nonce: str, timestamp: str, extra: dict | None = None) -> bytes:
    payload = {"action": action, "nonce": nonce, "timestamp": timestamp, "extra": extra or {}}
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _sign_peer_payload(action: str, extra: dict | None = None) -> dict:
    identity = _get_local_identity()
    nonce = uuid_lib.uuid4().hex
    timestamp = str(int(time.time()))
    private_key = Ed25519PrivateKey.from_private_bytes(_b64_decode(identity["private_key"]))
    signature = private_key.sign(_peer_signature_payload(action, nonce, timestamp, extra))
    return {
        "peer_id": identity["peer_id"],
        "public_key": identity["public_key"],
        "nonce": nonce,
        "timestamp": timestamp,
        "signature": _b64_encode(signature),
    }


def _verify_peer_payload(public_key: str, action: str, nonce: str, timestamp: str, signature: str, extra: dict | None = None) -> tuple[bool, str]:
    try:
        ts = int(timestamp)
    except (TypeError, ValueError):
        return False, "peer timestamp invalid"
    if abs(time.time() - ts) > 5 * 60:
        return False, "peer signature expired"
    try:
        key = Ed25519PublicKey.from_public_bytes(_b64_decode(public_key))
        key.verify(_b64_decode(signature), _peer_signature_payload(action, nonce, timestamp, extra))
        return True, ""
    except (InvalidSignature, ValueError, TypeError) as exc:
        return False, f"peer signature invalid: {exc}"


def _identity_response() -> dict:
    identity = _get_local_identity()
    info = network_info(PORT)
    return {
        "peer_id": identity["peer_id"],
        "public_key": identity["public_key"],
        "fingerprint": identity["fingerprint"],
        "hostname": info.get("hostname", ""),
        "ip": info.get("ip", ""),
        "all_ips": info.get("all_ips", []),
        "port": PORT,
        "receive_mode": _get_receive_mode(),
    }


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
        "  [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr hWnd);\n"
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
        "if ([CapsuleWinFocus]::IsIconic($p.MainWindowHandle)) { "
        "  [CapsuleWinFocus]::ShowWindowAsync($p.MainWindowHandle, 9) | Out-Null "
        "} "
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


def _is_ignored_plugin_name(name: str) -> bool:
    normalized = _normalize_plugin_name(name)
    ignored = {
        "container",
        "fx container",
        "folder",
        "track channel mapper",
        "reainsert",
    }
    if normalized in ignored:
        return True
    if normalized.startswith("container "):
        return True
    return False


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
    required = [str(p).strip() for p in (plugin_list or []) if str(p).strip() and not _is_ignored_plugin_name(str(p))]
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


def _load_capsule_folders() -> dict:
    if CAPSULE_FOLDERS_FILE.exists():
        try:
            raw = json.loads(CAPSULE_FOLDERS_FILE.read_text("utf-8"))
        except Exception:
            raw = {}
    else:
        raw = {}

    folders = []
    seen = set()
    for item in raw.get("folders") or []:
        folder_id = str(item.get("id") or "").strip()
        name = str(item.get("name") or "").strip()
        if not folder_id or not name or folder_id in seen:
            continue
        seen.add(folder_id)
        folders.append({
            "id": folder_id,
            "name": name[:80],
            "parent_id": str(item.get("parent_id") or "").strip() or None,
            "created_at": item.get("created_at") or _now_iso(),
            "updated_at": item.get("updated_at") or item.get("created_at") or _now_iso(),
        })
    valid_ids = {folder["id"] for folder in folders}
    for folder in folders:
        if folder.get("parent_id") not in valid_ids:
            folder["parent_id"] = None

    memberships = {}
    raw_memberships = raw.get("memberships") or {}
    for folder_id, capsule_ids in raw_memberships.items():
        if folder_id not in seen:
            continue
        clean_ids = []
        clean_seen = set()
        for capsule_id in capsule_ids or []:
            capsule_id = str(capsule_id).strip()
            if capsule_id and capsule_id not in clean_seen:
                clean_seen.add(capsule_id)
                clean_ids.append(capsule_id)
        memberships[folder_id] = clean_ids

    return {"folders": folders, "memberships": memberships}


def _save_capsule_folders(data: dict):
    CAPSULE_FOLDERS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _folder_response(folder: dict, memberships: dict) -> dict:
    capsule_ids = memberships.get(folder["id"], [])
    return {**folder, "capsule_ids": capsule_ids, "count": len(capsule_ids)}


def _is_descendant_folder(data: dict, folder_id: str, maybe_descendant_id: str | None) -> bool:
    if not maybe_descendant_id:
        return False
    parent_by_id = {folder["id"]: folder.get("parent_id") for folder in data["folders"]}
    current = maybe_descendant_id
    visited = set()
    while current:
        if current == folder_id:
            return True
        if current in visited:
            return False
        visited.add(current)
        current = parent_by_id.get(current)
    return False


def _cleanup_capsule_folder_memberships(cap_id: str):
    data = _load_capsule_folders()
    changed = False
    for folder_id, capsule_ids in list(data["memberships"].items()):
        next_ids = [cid for cid in capsule_ids if cid != cap_id]
        if next_ids != capsule_ids:
            data["memberships"][folder_id] = next_ids
            changed = True
    if changed:
        _save_capsule_folders(data)


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


def _contact_host(contact: dict) -> str:
    return (contact.get("last_ip") or contact.get("ip") or "").strip()


def _contact_port(contact: dict) -> int:
    return int(contact.get("last_port") or contact.get("port") or 5005)


def _normalize_contact(contact: dict) -> dict:
    if "last_ip" not in contact:
        contact["last_ip"] = contact.get("ip", "")
    if "last_port" not in contact:
        contact["last_port"] = contact.get("port", 5005)
    contact["ip"] = contact.get("ip") or contact.get("last_ip") or ""
    contact["port"] = int(contact.get("port") or contact.get("last_port") or 5005)
    contact["trusted"] = bool(contact.get("peer_id") and contact.get("public_key"))
    if contact.get("public_key") and not contact.get("fingerprint"):
        contact["fingerprint"] = _public_key_fingerprint(contact["public_key"])
    return contact


def _normalize_contacts(contacts: list[dict]) -> list[dict]:
    return [_normalize_contact(c) for c in contacts]


def _find_contact_by_identity(contacts: list[dict], peer_id: str | None, public_key: str | None = None) -> dict | None:
    if not peer_id:
        return None
    for contact in contacts:
        if contact.get("peer_id") != peer_id:
            continue
        if public_key and contact.get("public_key") and contact.get("public_key") != public_key:
            return {"_identity_mismatch": True, **contact}
        return contact
    return None


def _probe_peer_identity(ip: str, port: int = 5005, timeout: float = 1.2) -> dict | None:
    if not ip:
        return None
    try:
        resp = requests.get(f"http://{ip}:{int(port)}/api/identity", timeout=timeout)
        if not resp.ok:
            return None
        data = resp.json().get("data") or {}
        if not data.get("peer_id") or not data.get("public_key"):
            return None
        data["ip"] = ip
        data["port"] = int(data.get("port") or port)
        data["fingerprint"] = data.get("fingerprint") or _public_key_fingerprint(data["public_key"])
        return data
    except Exception:
        return None


def _candidate_peer_ips() -> list[str]:
    info = network_info(PORT)
    candidates: list[str] = []
    for ip in info.get("all_ips", []):
        try:
            iface = ipaddress.ip_interface(f"{ip}/24")
        except ValueError:
            continue
        for host in iface.network.hosts():
            host_ip = str(host)
            if host_ip != ip and host_ip not in candidates:
                candidates.append(host_ip)
    return candidates[:512]


def _discover_peers(port: int = 5005, peer_id: str | None = None, public_key: str | None = None, timeout: float = 0.45) -> list[dict]:
    found: list[dict] = []
    local_identity = _get_local_identity()
    candidate_ips = _candidate_peer_ips()

    def probe(ip: str) -> dict | None:
        identity = _probe_peer_identity(ip, port=port, timeout=timeout)
        if not identity or identity.get("peer_id") == local_identity.get("peer_id"):
            return None
        if peer_id and identity.get("peer_id") != peer_id:
            return None
        if public_key and identity.get("public_key") != public_key:
            return None
        return identity

    with concurrent.futures.ThreadPoolExecutor(max_workers=32) as executor:
        futures = [executor.submit(probe, ip) for ip in candidate_ips]
        done, pending = concurrent.futures.wait(futures, timeout=max(2.0, timeout * len(futures) / 16 if futures else 0))
        for future in pending:
            future.cancel()
        for future in done:
            try:
                result = future.result()
            except Exception:
                result = None
            if result:
                found.append(result)
                if peer_id:
                    break
    return found


def _update_contact_from_identity(contact: dict, identity: dict, source: str = "identity") -> dict:
    contact["peer_id"] = identity.get("peer_id") or contact.get("peer_id", "")
    contact["public_key"] = identity.get("public_key") or contact.get("public_key", "")
    contact["fingerprint"] = identity.get("fingerprint") or _public_key_fingerprint(contact["public_key"])
    contact["trusted"] = bool(contact.get("peer_id") and contact.get("public_key"))
    contact["ip"] = identity.get("ip") or contact.get("ip", "")
    contact["port"] = int(identity.get("port") or contact.get("port") or 5005)
    contact["last_ip"] = contact["ip"]
    contact["last_port"] = contact["port"]
    contact["last_seen"] = _now_iso()
    contact["verified_at"] = _now_iso()
    contact["address_source"] = source
    return contact


def _resolve_target_peer(data: dict) -> tuple[dict | None, tuple[str, int, str] | None, str | None]:
    contacts = _normalize_contacts(_load_contacts())
    contact = None
    contact_id = data.get("contact_id")
    if contact_id is not None:
        try:
            cid = int(contact_id)
            contact = next((c for c in contacts if c.get("id") == cid), None)
        except (TypeError, ValueError):
            contact = None
    if not contact and data.get("target_peer_id"):
        contact = _find_contact_by_identity(contacts, data.get("target_peer_id"), data.get("target_public_key"))
        if contact and contact.get("_identity_mismatch"):
            return None, None, "联系人身份密钥不匹配，已阻止发送。"

    target_ip = (data.get("target_ip") or (_contact_host(contact) if contact else "") or "").strip()
    target_port = int(data.get("target_port") or (_contact_port(contact) if contact else 5005))
    target_name = data.get("target_name") or (contact.get("name") if contact else f"{target_ip}:{target_port}")
    expected_peer_id = (contact or {}).get("peer_id") or data.get("target_peer_id")
    expected_public_key = (contact or {}).get("public_key") or data.get("target_public_key")

    if target_ip and not _is_lan_host(target_ip):
        return contact, None, "目标地址不是本机或局域网地址，已阻止发送。"

    identity = _probe_peer_identity(target_ip, target_port) if target_ip else None
    if expected_peer_id:
        if not identity or identity.get("peer_id") != expected_peer_id or (expected_public_key and identity.get("public_key") != expected_public_key):
            discovered = _discover_peers(port=target_port, peer_id=expected_peer_id, public_key=expected_public_key)
            identity = discovered[0] if discovered else None
        if not identity:
            return contact, None, "无法找到该可信联系人当前地址。请确认对方在线，或临时填写当前 IP。"
        target_ip = identity["ip"]
        target_port = int(identity.get("port") or target_port)
        if not _is_lan_host(target_ip):
            return contact, None, "发现到的目标地址不是本机或局域网地址，已阻止发送。"
        if contact:
            _update_contact_from_identity(contact, identity, source="discover")
            _save_contacts(contacts)
    elif identity and contact:
        _update_contact_from_identity(contact, identity, source="direct")
        _save_contacts(contacts)

    if not target_ip:
        return contact, None, "缺少目标 IP"
    return contact, (target_ip, target_port, target_name), None


# ---------------------- 健康检查 / 网络信息 ----------------------

@app.route("/api/health", methods=["GET"])
def health():
    return _ok({"status": "ok", "port": PORT})


@app.route("/api/network/info", methods=["GET"])
def get_network_info():
    info = network_info(PORT)
    info["shared_token_required"] = bool(SHARED_TOKEN)
    identity = _get_local_identity()
    info["peer_id"] = identity["peer_id"]
    info["peer_fingerprint"] = identity["fingerprint"]
    return _ok(info)


@app.route("/api/identity", methods=["GET"])
def get_identity():
    return _ok(_identity_response())


@app.route("/api/peers/discover", methods=["GET", "POST"])
def discover_peers():
    data = request.get_json(silent=True) or {}
    peer_id = request.args.get("peer_id") or data.get("peer_id")
    public_key = request.args.get("public_key") or data.get("public_key")
    port = int(request.args.get("port") or data.get("port") or 5005)
    peers = _discover_peers(port=port, peer_id=peer_id, public_key=public_key)
    return _ok({"items": peers})


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


@app.route("/api/capsule-folders", methods=["GET"])
def list_capsule_folders():
    data = _load_capsule_folders()
    items = [_folder_response(folder, data["memberships"]) for folder in data["folders"]]
    return _ok({"items": items, "count": len(items)})


@app.route("/api/capsule-folders", methods=["POST"])
def create_capsule_folder():
    data = _load_capsule_folders()
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name") or "").strip()
    parent_id = str(payload.get("parent_id") or "").strip() or None
    if not name:
        return _err("分类名称不能为空", 400)
    if parent_id and not any(folder["id"] == parent_id for folder in data["folders"]):
        return _err("父分类不存在", 404)
    if any(folder["name"] == name and folder.get("parent_id") == parent_id for folder in data["folders"]):
        return _err("分类名称已存在", 409)
    now = _now_iso()
    folder = {
        "id": uuid_lib.uuid4().hex,
        "name": name[:80],
        "parent_id": parent_id,
        "created_at": now,
        "updated_at": now,
    }
    data["folders"].append(folder)
    data["memberships"][folder["id"]] = []
    _save_capsule_folders(data)
    return _ok(_folder_response(folder, data["memberships"]), message="分类已创建"), 201


@app.route("/api/capsule-folders/<folder_id>", methods=["PATCH"])
def update_capsule_folder(folder_id: str):
    data = _load_capsule_folders()
    folder = next((item for item in data["folders"] if item["id"] == folder_id), None)
    if not folder:
        return _err("分类不存在", 404)
    payload = request.get_json(silent=True) or {}

    if "name" in payload:
        name = str(payload.get("name") or "").strip()
        if not name:
            return _err("分类名称不能为空", 400)
        if any(item["id"] != folder_id and item["name"] == name and item.get("parent_id") == folder.get("parent_id") for item in data["folders"]):
            return _err("分类名称已存在", 409)
        folder["name"] = name[:80]

    if "parent_id" in payload:
        parent_id = str(payload.get("parent_id") or "").strip() or None
        if parent_id == folder_id:
            return _err("不能移动到自身下", 400)
        if parent_id and not any(item["id"] == parent_id for item in data["folders"]):
            return _err("目标分类不存在", 404)
        if _is_descendant_folder(data, folder_id, parent_id):
            return _err("不能移动到自己的子分类下", 400)
        if any(item["id"] != folder_id and item["name"] == folder["name"] and item.get("parent_id") == parent_id for item in data["folders"]):
            return _err("目标分类下已有同名分类", 409)
        folder["parent_id"] = parent_id

    folder["updated_at"] = _now_iso()
    _save_capsule_folders(data)
    return _ok(_folder_response(folder, data["memberships"]), message="分类已更新")


@app.route("/api/capsule-folders/<folder_id>/capsules", methods=["POST"])
def add_capsule_to_folder(folder_id: str):
    data = _load_capsule_folders()
    folder = next((item for item in data["folders"] if item["id"] == folder_id), None)
    if not folder:
        return _err("分类不存在", 404)
    payload = request.get_json(silent=True) or {}
    capsule_id = str(payload.get("capsule_id") or "").strip()
    if not capsule_id:
        return _err("capsule_id 必填", 400)
    cap = get_capsule_by_id(capsule_id)
    if not cap:
        return _err("胶囊不存在", 404)
    capsule_ids = data["memberships"].setdefault(folder_id, [])
    if cap["id"] not in capsule_ids:
        capsule_ids.append(cap["id"])
        folder["updated_at"] = _now_iso()
        _save_capsule_folders(data)
    return _ok(_folder_response(folder, data["memberships"]), message="已加入分类")


@app.route("/api/capsule-folders/<folder_id>/capsules/<cap_id>", methods=["DELETE"])
def remove_capsule_from_folder(folder_id: str, cap_id: str):
    data = _load_capsule_folders()
    folder = next((item for item in data["folders"] if item["id"] == folder_id), None)
    if not folder:
        return _err("分类不存在", 404)
    capsule_ids = data["memberships"].setdefault(folder_id, [])
    data["memberships"][folder_id] = [cid for cid in capsule_ids if cid != cap_id]
    folder["updated_at"] = _now_iso()
    _save_capsule_folders(data)
    return _ok(_folder_response(folder, data["memberships"]), message="已移出分类")


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
    cap = _capsule_from_dir(target)
    shutil.rmtree(target, ignore_errors=True)
    _cleanup_capsule_folder_memberships((cap or {}).get("id") or cap_id)
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

def _normalize_reaper_identity_path(value: str | None) -> str:
    normalized = str(value or "").strip().replace("\\", "/").rstrip("/")
    return normalized.lower() if platform.system() == "Windows" else normalized


def _desired_bridge_version() -> str:
    bridge_script = _DATA_PIPELINE / "lua_scripts" / "capsule_bridge.lua"
    try:
        bridge_text = bridge_script.read_text("utf-8", errors="ignore")
        version_match = re.search(r'BRIDGE_VERSION\s*=\s*"([^"]+)"', bridge_text)
        if version_match:
            return version_match.group(1)
    except Exception:
        pass
    return ""


def _reaper_setup_state(status: dict, desired_bridge_version: str, cfg: dict) -> tuple[str, str]:
    if not status.get("webui_available"):
        return "NEED_WEBUI", "没有连接到 REAPER Web Interface。请打开你要用于 Capsule Transfer 的 REAPER，并启用 Web browser interface。"
    if status.get("bridge_instance_conflict"):
        return "NEED_REPAIR", "检测到 REAPER Bridge 多实例冲突。请关闭多余的 REAPER，重启目标 REAPER 后重新检测。"
    if not status.get("bridge_available"):
        return "NEED_BRIDGE_INSTALL", "REAPER Web Interface 已连接，但 Capsule Transfer Bridge 尚未运行。请在当前 REAPER 中加载并运行安装脚本。"
    if desired_bridge_version and status.get("bridge_version") and status.get("bridge_version") != desired_bridge_version:
        return "NEED_REPAIR", "当前 REAPER Bridge 版本不是本机应用附带的版本。请在当前 REAPER 中重新运行安装脚本。"

    current_resource = status.get("bridge_resource_path") or ""
    confirmed_resource = cfg.get("confirmed_reaper_resource_path") or ""
    if not current_resource:
        return "NEED_REPAIR", "Bridge 未上报 REAPER 资源目录。请重启目标 REAPER 或重新运行安装脚本。"
    if not confirmed_resource:
        return "NOT_CONFIGURED", "Bridge 已连接。请确认这是你要用于 Capsule Transfer 的 REAPER，并保存绑定。"
    if _normalize_reaper_identity_path(current_resource) != _normalize_reaper_identity_path(confirmed_resource):
        return "MISMATCHED_REAPER", "当前连接的 REAPER 资源目录与已保存设置不一致。请确认是否打开了错误的 REAPER。"
    return "READY", "REAPER 设置已确认，可以捕获胶囊。"


def _build_reaper_bridge_status(webui_port: int | None = None, include_diagnostics: bool = False) -> dict:
    cfg = load_config()
    port = int(webui_port or cfg.get("webui_port", 9000))
    diagnostics = {}
    try:
        from exporters.reaper_bridge_client import ReaperBridgeClient
        client = ReaperBridgeClient(port=port, timeout=3.0 if include_diagnostics else 1.0)
        status = client.status().as_dict()
        if include_diagnostics:
            try:
                diagnostics = json.loads(client._diagnostics())
            except Exception:
                diagnostics = {}
    except Exception as exc:
        status = {"webui_available": False, "bridge_available": False, "error": str(exc)}

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

    lua_dir = _DATA_PIPELINE / "lua_scripts"
    desired_bridge_version = _desired_bridge_version()
    status.update(diagnostics)
    state, message = _reaper_setup_state(status, desired_bridge_version, cfg)
    if state != "READY":
        logger.info(
            "REAPER setup state: state=%s webui=%s bridge=%s status=%s phase=%s heartbeat_age=%s error=%s",
            state,
            status.get("webui_available"),
            status.get("bridge_available"),
            status.get("status"),
            status.get("export_phase"),
            status.get("heartbeat_age_seconds"),
            status.get("error"),
        )
    status.update({
        "app_dir": str(APP_DIR),
        "data_dir": str(DATA_DIR),
        "capsules_dir": str(CAPSULES_DIR),
        "data_pipeline_dir": str(_DATA_PIPELINE),
        "webui_port": port,
        "bridge_script": str(lua_dir / "capsule_bridge.lua"),
        "installer_script": str(lua_dir / "install_capsule_bridge.lua"),
        "installer_dir": str(lua_dir),
        "desired_bridge_version": desired_bridge_version,
        "path_manager": path_manager,
        "env_export_dir": os.environ.get("CAPSULE_TRANSFER_EXPORT_DIR", ""),
        "setup_state": state,
        "setup_message": message,
        "setup_confirmed": state == "READY",
        "can_capture": state == "READY",
        "confirmed_reaper_exe_path": cfg.get("confirmed_reaper_exe_path", ""),
        "confirmed_reaper_resource_path": cfg.get("confirmed_reaper_resource_path", ""),
        "confirmed_reaper_app_version": cfg.get("confirmed_reaper_app_version", ""),
        "confirmed_at": cfg.get("reaper_setup_confirmed_at", ""),
        "last_setup_state": cfg.get("reaper_setup_state", ""),
    })
    return status


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

    preflight = _build_reaper_bridge_status(webui_port)
    logger.info(
        "Reaper bridge preflight: state=%s selected=%s phase=%s bridge_status=%s heartbeat_age=%s",
        preflight.get("setup_state"),
        preflight.get("selected_item_count"),
        preflight.get("export_phase"),
        preflight.get("status"),
        preflight.get("heartbeat_age_seconds"),
    )
    if preflight.get("setup_state") != "READY":
        return jsonify({
            "success": False,
            "error": preflight.get("setup_message") or "REAPER 设置未完成。",
            "data": {
                "needs_setup": True,
                "setup_state": preflight.get("setup_state"),
                "bridge_status": preflight,
            },
        }), 400

    selected_count = preflight.get("selected_item_count")
    try:
        selected_count_int = int(selected_count)
    except (TypeError, ValueError):
        selected_count_int = None
    if selected_count_int is not None and selected_count_int <= 0:
        return jsonify({
            "success": False,
            "error": "请先在 REAPER 中选中要保存为胶囊的 Item。",
            "data": {
                "selected_items_required": True,
                "setup_state": preflight.get("setup_state"),
                "bridge_status": preflight,
            },
        }), 400

    if not _REAPER_CAPTURE_LOCK.acquire(blocking=False):
        return _err("已有 Reaper 捕获在进行中，请等待完成后再试", 429)

    try:
        started_at = time.time()
        result = quick_webui_export(
            project_name=capsule_type,
            theme_name=capsule_type,
            render_preview=render_preview,
            webui_port=webui_port,
            capsule_type=capsule_type,
            export_dir=export_dir,
            username=data.get("username", "user"),
        )
        logger.info(
            "Reaper bridge export result: elapsed=%.2fs success=%s capsule=%s preview_requested=%s preview_rendered=%s preview_audio=%s note=%s",
            time.time() - started_at,
            result.get("success"),
            result.get("capsule_name"),
            result.get("preview_requested"),
            result.get("preview_rendered"),
            result.get("preview_audio"),
            result.get("preview_note"),
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
    include_diagnostics = request.args.get("diagnostics") in {"1", "true", "yes"}
    status = _build_reaper_bridge_status(webui_port, include_diagnostics=include_diagnostics)
    cfg = load_config()
    cfg["reaper_setup_state"] = status.get("setup_state", "")
    save_config(cfg)
    return _ok(status)


def reaper_bridge_ping():
    webui_port = int(request.args.get("webui_port") or load_config().get("webui_port", 9000))
    try:
        from exporters.reaper_bridge_client import ReaperBridgeClient
        result = ReaperBridgeClient(port=webui_port).ping()
        return _ok(result)
    except Exception as exc:
        return _err(str(exc), 500)


@app.route("/api/reaper/bridge/confirm", methods=["POST"])
def confirm_reaper_bridge():
    webui_port = int((request.get_json(silent=True) or {}).get("webui_port") or load_config().get("webui_port", 9000))
    status = _build_reaper_bridge_status(webui_port)
    if not status.get("webui_available") or not status.get("bridge_available"):
        return _err(status.get("setup_message") or "当前 REAPER 尚未准备好，不能保存绑定。", 400)
    if status.get("setup_state") in {"NEED_WEBUI", "NEED_BRIDGE_INSTALL", "NEED_REPAIR"}:
        return _err(status.get("setup_message") or "当前 REAPER 设置仍需修复，不能保存绑定。", 400)
    resource_path = status.get("bridge_resource_path") or ""
    if not resource_path:
        return _err("Bridge 未上报 REAPER 资源目录，不能保存绑定。", 400)

    cfg = load_config()
    cfg.update({
        "confirmed_reaper_exe_path": status.get("bridge_exe_path") or "",
        "confirmed_reaper_resource_path": resource_path,
        "confirmed_reaper_app_version": status.get("bridge_app_version") or "",
        "webui_port": webui_port,
        "reaper_setup_state": "READY",
        "reaper_setup_confirmed_at": _now_iso(),
    })
    save_config(cfg)
    confirmed = _build_reaper_bridge_status(webui_port)
    return _ok(confirmed, message="已确认当前 REAPER 设置")


@app.route("/api/reaper/bridge/script-folder", methods=["POST"])
def open_reaper_bridge_script_folder():
    lua_dir = _DATA_PIPELINE / "lua_scripts"
    installer = lua_dir / "install_capsule_bridge.lua"
    if not lua_dir.exists():
        return _err(f"脚本目录不存在: {lua_dir}", 404)
    try:
        if platform.system() == "Darwin":
            subprocess.Popen(["open", str(lua_dir)])
        elif platform.system() == "Windows":
            subprocess.Popen(
                ["explorer.exe", str(lua_dir)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            _windows_raise_window([lua_dir.name, str(lua_dir), "File Explorer", "资源管理器"], ["explorer"], delay_ms=350, attempts=20)
        else:
            subprocess.Popen(["xdg-open", str(lua_dir)])
    except Exception as e:
        return _err(f"打开脚本目录失败: {e}", 500)
    return _ok({"folder": str(lua_dir), "installer_script": str(installer)}, message="已打开脚本目录")


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
    contacts = _normalize_contacts(_load_contacts())
    _save_contacts(contacts)
    return _ok({"items": contacts})


@app.route("/api/contacts", methods=["POST"])
def create_contact():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    ip = (data.get("ip") or "").strip()
    port = int(data.get("port") or 5005)
    note = data.get("note")
    if not name or not ip:
        return _err("name 和 ip 必填", 400)
    contacts = _normalize_contacts(_load_contacts())
    identity = _probe_peer_identity(ip, port)
    existing = None
    if identity:
        existing = _find_contact_by_identity(contacts, identity.get("peer_id"), identity.get("public_key"))
        if existing and existing.get("_identity_mismatch"):
            return _err("该 peer_id 已存在但公钥不同，已阻止覆盖联系人。", 409)
    if not existing:
        existing = next((c for c in contacts if _contact_host(c) == ip and _contact_port(c) == port), None)
    if existing:
        existing["name"] = name
        existing["ip"] = ip
        existing["port"] = port
        existing["last_ip"] = ip
        existing["last_port"] = port
        if note is not None:
            existing["note"] = note
        if identity:
            _update_contact_from_identity(existing, identity, source="manual")
    else:
        contact = {
            "id": _contacts_next_id(contacts),
            "name": name,
            "ip": ip,
            "port": port,
            "last_ip": ip,
            "last_port": port,
            "note": note or "",
            "last_seen": None,
            "created_at": _now_iso(),
        }
        if identity:
            _update_contact_from_identity(contact, identity, source="manual")
        contacts.append(_normalize_contact(contact))
    _save_contacts(contacts)
    target = existing or next((c for c in contacts if _contact_host(c) == ip and _contact_port(c) == port), None)
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
    contacts = _normalize_contacts(_load_contacts())
    contact = None
    if data.get("contact_id") is not None:
        try:
            contact = next((c for c in contacts if c.get("id") == int(data.get("contact_id"))), None)
        except (TypeError, ValueError):
            contact = None
    ip = data.get("ip") or (_contact_host(contact) if contact else "")
    port = int(data.get("port") or (_contact_port(contact) if contact else 5005))
    if not ip:
        return _err("ip 必填", 400)
    started = time.time()
    try:
        identity = _probe_peer_identity(ip, port, timeout=2.0)
        ok = bool(identity)
        latency_ms = int((time.time() - started) * 1000)
        if ok:
            for c in contacts:
                if (contact and c.get("id") == contact.get("id")) or (identity and c.get("peer_id") == identity.get("peer_id")) or (_contact_host(c) == ip and _contact_port(c) == port):
                    _update_contact_from_identity(c, identity, source="ping")
            _save_contacts(contacts)
        return _ok({"online": ok, "latency_ms": latency_ms, "identity": identity})
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
    try:
        _set_receive_mode(mode)
    except ValueError as e:
        return _err(str(e), 403)
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
    sender_peer_id = data.get("sender_peer_id") or ""
    sender_public_key = data.get("sender_public_key") or ""
    sender_signature = data.get("sender_signature") or ""
    sender_nonce = data.get("sender_nonce") or ""
    sender_timestamp = data.get("sender_timestamp") or ""
    capsule_name = data.get("capsule_name") or "胶囊"
    capsule_type = data.get("capsule_type") or ""
    size_bytes = data.get("size_bytes") or 0
    trusted_sender = False
    if sender_peer_id or sender_public_key or sender_signature:
        request_extra = {
            "capsule_id": data.get("capsule_id") or "",
            "capsule_name": capsule_name,
            "capsule_type": capsule_type,
            "size_bytes": size_bytes,
        }
        if not (sender_peer_id and sender_public_key and sender_signature and sender_nonce and sender_timestamp):
            return _err("发送方身份签名不完整", 401)
        ok, verify_msg = _verify_peer_payload(sender_public_key, "p2p_request", sender_nonce, sender_timestamp, sender_signature, request_extra)
        if not ok:
            return _err(verify_msg, 401)
        if hashlib.sha256(sender_public_key.encode("utf-8")).hexdigest()[:32] != sender_peer_id:
            return _err("发送方 peer_id 与公钥不匹配", 401)
        contacts = _normalize_contacts(_load_contacts())
        known = _find_contact_by_identity(contacts, sender_peer_id, sender_public_key)
        if known and known.get("_identity_mismatch"):
            return _err("发送方身份与已保存联系人不匹配", 403)
        if known:
            known["last_ip"] = sender_ip
            known["ip"] = sender_ip
            known["last_seen"] = _now_iso()
            known["verified_at"] = _now_iso()
            _save_contacts(contacts)
            trusted_sender = True

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
                "sender_peer_id": sender_peer_id,
                "sender_public_key": sender_public_key,
                "trusted_sender": trusted_sender,
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
        "sender_peer_id": sender_peer_id,
        "sender_public_key": sender_public_key,
        "trusted_sender": trusted_sender,
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
    bundle_bytes = f.read()
    bundle_sha256 = hashlib.sha256(bundle_bytes).hexdigest()
    sender_ip = request.headers.get("X-Capsule-Peer-IP") or request.remote_addr or "unknown"
    sender_name = request.headers.get("X-Capsule-Peer-Name") or sender_ip
    sender_peer_id = request.headers.get("X-Capsule-Peer-ID", "").strip()
    sender_public_key = request.headers.get("X-Capsule-Peer-Public-Key", "").strip()
    sender_signature = request.headers.get("X-Capsule-Peer-Signature", "").strip()
    sender_nonce = request.headers.get("X-Capsule-Peer-Nonce", "").strip()
    sender_timestamp = request.headers.get("X-Capsule-Peer-Timestamp", "").strip()
    sent_bundle_sha256 = request.headers.get("X-Capsule-Bundle-SHA256", "").strip()
    trusted_sender = False
    if sent_bundle_sha256 and sent_bundle_sha256 != bundle_sha256:
        return _err("bundle hash mismatch", 400)
    if sender_peer_id or sender_public_key or sender_signature:
        accept_token = request.headers.get("X-Accept-Token", "").strip()
        import_extra = {"accept_token": accept_token, "bundle_sha256": bundle_sha256}
        if not (sender_peer_id and sender_public_key and sender_signature and sender_nonce and sender_timestamp):
            return _err("发送方身份签名不完整", 401)
        ok, verify_msg = _verify_peer_payload(sender_public_key, "p2p_import", sender_nonce, sender_timestamp, sender_signature, import_extra)
        if not ok:
            return _err(verify_msg, 401)
        if hashlib.sha256(sender_public_key.encode("utf-8")).hexdigest()[:32] != sender_peer_id:
            return _err("发送方 peer_id 与公钥不匹配", 401)
        contacts = _normalize_contacts(_load_contacts())
        known = _find_contact_by_identity(contacts, sender_peer_id, sender_public_key)
        if known and known.get("_identity_mismatch"):
            return _err("发送方身份与已保存联系人不匹配", 403)
        if known:
            known["last_ip"] = sender_ip
            known["ip"] = sender_ip
            known["last_seen"] = _now_iso()
            known["verified_at"] = _now_iso()
            _save_contacts(contacts)
            trusted_sender = True
    peer_label = sender_name if sender_name == sender_ip else f"{sender_name} ({sender_ip})"

    try:
        manifest, final_dir, size_bytes = extract_bundle(io.BytesIO(bundle_bytes), CAPSULES_DIR)
    except ValueError as e:
        return _err(str(e), 400)

    manifest.setdefault("capsule", {})["source_peer"] = peer_label
    if sender_peer_id:
        manifest.setdefault("capsule", {})["source_peer_id"] = sender_peer_id
        manifest.setdefault("capsule", {})["source_peer_trusted"] = trusted_sender
    _write_manifest(final_dir, manifest)
    cap = _capsule_from_dir(final_dir)
    logger.info("接收胶囊 %s 来自 %s (%d bytes)", cap.get("name"), peer_label, size_bytes)
    _notify_sse({"type": "capsule_received", "capsule": {"name": cap.get("name"), "source": peer_label}})
    return _ok(cap, message="已接收并入库"), 201


@app.route("/api/p2p/send", methods=["POST"])
def p2p_send():
    data = request.get_json(silent=True) or {}
    capsule_id = data.get("capsule_id")
    contact, resolved, resolve_error = _resolve_target_peer(data)
    if resolve_error:
        return _err(resolve_error, 403 if "已阻止发送" in resolve_error else 404)
    target_ip, target_port, target_name = resolved or ("", 5005, "")
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
    request_extra = {
        "capsule_id": cap.get("uuid") or "",
        "capsule_name": cap.get("name") or "",
        "capsule_type": cap.get("capsule_type") or "",
        "size_bytes": len(blob),
    }
    request_signature = _sign_peer_payload("p2p_request", request_extra)
    try:
        req_resp = requests.post(
            f"http://{target_ip}:{target_port}/api/p2p/request",
            json={
                "sender_ip": self_info.get("ip", ""),
                "sender_name": self_info.get("hostname", ""),
                "sender_peer_id": request_signature["peer_id"],
                "sender_public_key": request_signature["public_key"],
                "sender_signature": request_signature["signature"],
                "sender_nonce": request_signature["nonce"],
                "sender_timestamp": request_signature["timestamp"],
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

    bundle_sha256 = hashlib.sha256(blob).hexdigest()
    import_signature = _sign_peer_payload("p2p_import", {"accept_token": accept_token, "bundle_sha256": bundle_sha256})
    headers = {
        "X-Capsule-Peer-IP": self_info.get("ip", ""),
        "X-Capsule-Peer-Name": self_info.get("hostname", ""),
        "X-Capsule-Peer-ID": import_signature["peer_id"],
        "X-Capsule-Peer-Public-Key": import_signature["public_key"],
        "X-Capsule-Peer-Signature": import_signature["signature"],
        "X-Capsule-Peer-Nonce": import_signature["nonce"],
        "X-Capsule-Peer-Timestamp": import_signature["timestamp"],
        "X-Capsule-Bundle-SHA256": bundle_sha256,
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

    contacts = _normalize_contacts(_load_contacts())
    existing = None
    if contact:
        existing = next((c for c in contacts if c.get("id") == contact.get("id")), None)
    if not existing:
        existing = next((c for c in contacts if _contact_host(c) == target_ip and _contact_port(c) == target_port), None)
    if existing:
        existing["ip"] = target_ip
        existing["port"] = target_port
        existing["last_ip"] = target_ip
        existing["last_port"] = target_port
        existing["last_seen"] = _now_iso()
        _save_contacts(contacts)
    else:
        contacts.append({
            "id": _contacts_next_id(contacts),
            "name": target_name,
            "ip": target_ip,
            "port": target_port,
            "last_ip": target_ip,
            "last_port": target_port,
            "note": "",
            "last_seen": _now_iso(),
            "created_at": _now_iso(),
        })
        _save_contacts(contacts)

    return _ok({"bytes": len(blob), "remote": resp.json(), "resolved_ip": target_ip, "resolved_port": target_port}, message="已发送")


# ---------------------- 设置 ----------------------

@app.route("/api/settings", methods=["GET"])
def get_settings():
    return _ok(load_config())


@app.route("/api/settings", methods=["PATCH"])
def update_settings():
    data = request.get_json(silent=True) or {}
    cfg = load_config()
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
