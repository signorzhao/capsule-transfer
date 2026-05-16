"""Flask routes for Capsule Transfer's persistent REAPER bridge.

The runtime export path is focus-safe and goes through the REAPER Web Interface
plus the long-running capsule_bridge.lua script. These routes help the frontend
show bridge readiness and perform the one-time bridge installation.
"""

from __future__ import annotations

import json
import platform
import subprocess
import time
from pathlib import Path
from typing import Callable


def _find_reaper_executable(load_config: Callable[[], dict]) -> Path | None:
    system = platform.system()
    cfg = load_config() or {}
    configured = cfg.get("reaper_path")
    if configured:
        p = Path(configured)
        if p.is_dir() and p.suffix == ".app":
            p = p / "Contents" / "MacOS" / "REAPER"
        elif p.is_dir() and platform.system() == "Windows":
            p = p / "reaper.exe"
        if p.exists() and p.is_file():
            return p

    if system == "Darwin":
        candidates = [
            Path("/Applications/REAPER.app/Contents/MacOS/REAPER"),
            Path("/Applications/REAPER64.app/Contents/MacOS/REAPER"),
            Path.home() / "Applications/REAPER.app/Contents/MacOS/REAPER",
        ]
    elif system == "Windows":
        candidates = [
            Path("C:/Program Files/REAPER (x64)/reaper.exe"),
            Path("C:/Program Files/REAPER (arm64)/reaper.exe"),
            Path("C:/Program Files/REAPER/reaper.exe"),
            Path("C:/Program Files (x86)/REAPER/reaper.exe"),
            Path.home() / "AppData/Local/Programs/REAPER/reaper.exe",
        ]
    else:
        import shutil
        found = shutil.which("reaper")
        candidates = [Path(found)] if found else [Path("/usr/bin/reaper")]

    for p in candidates:
        if p.exists() and p.is_file():
            return p
    return None


def _normalize_windows_reaper_path(path: str) -> Path:
    p = Path(path)
    if platform.system() == "Windows" and p.suffix.lower() != ".exe":
        p = p / "reaper.exe"
    return p.resolve()


def _run_reaper_script(reaper_exe: Path, lua_script: Path) -> tuple[bool, str]:
    system = platform.system()
    try:
        if system == "Windows":
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = 0
            subprocess.Popen(
                [str(reaper_exe), "-nonewinst", str(lua_script).replace("/", "\\")],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW,
                startupinfo=startupinfo,
            )
        else:
            subprocess.Popen(
                [str(reaper_exe), "-nonewinst", str(lua_script)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        return True, ""
    except Exception as exc:
        return False, str(exc)


def _read_install_result(client, timeout_seconds: float = 10.0) -> tuple[dict | None, str]:
    started = time.time()
    last_raw = ""
    while time.time() - started < timeout_seconds:
        try:
            raw = client.get_extstate("install_result")
        except Exception as exc:
            last_raw = f"EXTSTATE_READ_ERROR: {exc}"
            time.sleep(0.25)
            continue

        if raw:
            last_raw = raw
            try:
                return json.loads(raw), raw
            except Exception:
                # Raw protocol echoes or partial writes should not make install fatal.
                if raw.startswith("EXTSTATE "):
                    return None, raw
                return {"success": False, "message": raw}, raw
        time.sleep(0.25)
    return None, last_raw


def register_reaper_bridge_routes(app, ok, err, data_pipeline_dir: Path, load_config: Callable[[], dict]):
    @app.route("/api/reaper/bridge/status", methods=["GET"])
    def reaper_bridge_status():
        port = int((load_config() or {}).get("webui_port", 9000))
        try:
            from exporters.reaper_bridge_client import get_bridge_status
            status = get_bridge_status(webui_port=port)
        except Exception as exc:
            status = {
                "webui_available": False,
                "bridge_available": False,
                "bridge_version": "",
                "status": "unknown",
                "error": str(exc),
            }

        lua_dir = data_pipeline_dir / "lua_scripts"
        configured_reaper = _find_reaper_executable(load_config)
        bridge_exe_path = status.get("bridge_exe_path") or ""
        configured_reaper_path = str(configured_reaper) if configured_reaper else ""
        reaper_path_match = None
        if bridge_exe_path and configured_reaper_path:
            reaper_path_match = _normalize_windows_reaper_path(bridge_exe_path) == _normalize_windows_reaper_path(configured_reaper_path)
        status.update({
            "webui_port": port,
            "bridge_script": str(lua_dir / "capsule_bridge.lua"),
            "installer_script": str(lua_dir / "install_capsule_bridge.lua"),
            "configured_reaper_path": configured_reaper_path,
            "reaper_path_match": reaper_path_match,
        })
        return ok(status)

    @app.route("/api/reaper/bridge/ping", methods=["GET", "POST"])
    def ping_reaper_bridge():
        port = int((load_config() or {}).get("webui_port", 9000))
        try:
            from exporters.reaper_bridge_client import ReaperBridgeClient
            client = ReaperBridgeClient(port=port)
            result = client.ping()
            return ok({
                "ping": result,
                "diagnostics": client._diagnostics(),
            })
        except Exception as exc:
            diagnostics = ""
            try:
                from exporters.reaper_bridge_client import ReaperBridgeClient
                diagnostics = ReaperBridgeClient(port=port)._diagnostics()
            except Exception:
                diagnostics = ""
            return err(f"Bridge ping 失败: {exc}" + (f"\n诊断: {diagnostics}" if diagnostics else ""), 500)

    @app.route("/api/reaper/bridge/install", methods=["POST"])
    def install_reaper_bridge():
        cfg = load_config() or {}
        port = int(cfg.get("webui_port", 9000))
        lua_dir = data_pipeline_dir / "lua_scripts"
        bridge_script = lua_dir / "capsule_bridge.lua"
        installer_script = lua_dir / "install_capsule_bridge.lua"

        if not bridge_script.exists():
            return err(f"bridge 脚本不存在: {bridge_script}", 500)
        if not installer_script.exists():
            return err(f"bridge 安装脚本不存在: {installer_script}", 500)

        client = None
        webui_available = False
        try:
            from exporters.reaper_bridge_client import ReaperBridgeClient
            client = ReaperBridgeClient(port=port)
            webui_available = client.test_webui()
            if webui_available:
                client.set_extstate("install_bridge_source", str(bridge_script).replace("\\", "/"))
                client.set_extstate("install_result", "")
        except Exception:
            client = None
            webui_available = False

        reaper_exe = _find_reaper_executable(load_config)
        if not reaper_exe:
            return err("找不到 REAPER 可执行文件，请先在设置中配置 REAPER 路径。", 400)

        launched, launch_error = _run_reaper_script(reaper_exe, installer_script)
        if not launched:
            return err(f"启动 bridge 安装脚本失败: {launch_error}", 500)

        result_payload = None
        raw_result = ""
        if client and webui_available:
            result_payload, raw_result = _read_install_result(client, timeout_seconds=10)

        # If Web Interface polling is unavailable or the value is still empty,
        # the installer may still have been delivered to REAPER. Do not fail hard;
        # let the frontend re-check bridge status.
        if not result_payload:
            return ok({
                "installed": False,
                "pending": True,
                "message": "已发送安装命令。请确认 REAPER 已打开；几秒后点击“重新检测”。",
                "reaper_exe": str(reaper_exe),
                "webui_available": webui_available,
                "raw_install_result": raw_result,
            })

        if not result_payload.get("success"):
            return ok({
                "installed": False,
                "pending": False,
                "message": result_payload.get("message") or "Bridge 安装脚本返回失败",
                "reaper_exe": str(reaper_exe),
                "webui_available": webui_available,
                "raw_install_result": raw_result,
            })

        return ok({
            "installed": True,
            "pending": False,
            "message": result_payload.get("message") or "Capsule Transfer Bridge 已安装并启动",
            "reaper_exe": str(reaper_exe),
            "webui_available": webui_available,
            "raw_install_result": raw_result,
        })
