"""Client for the persistent Capsule Transfer REAPER bridge.

The bridge runs inside REAPER as lua_scripts/capsule_bridge.lua and communicates
through REAPER Web Interface EXTSTATE commands. This path does not launch or
foreground REAPER; the user may keep REAPER minimized after selecting items.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import quote, unquote

import requests

from common import PathManager

SECTION = "capsule_transfer"
BRIDGE_TIMEOUT_SECONDS = 45
PREVIEW_BRIDGE_TIMEOUT_SECONDS = 120
POLL_INTERVAL_SECONDS = 0.2
HEARTBEAT_STALE_SECONDS = 10


class ReaperBridgeError(RuntimeError):
    """Raised when the persistent REAPER bridge is unavailable or fails."""


def sanitize_path_for_lua(path: str) -> str:
    """Convert a filesystem path to a Lua-friendly absolute path string."""
    if not path:
        return ""
    is_absolute = Path(path).is_absolute()
    if not is_absolute and len(path) >= 2 and path[1] == ":":
        is_absolute = True
    if not is_absolute:
        raise ValueError(f"export_dir 必须是绝对路径: {path}")
    return path.replace("\\", "/")


def parse_extstate_reply(text: str, section: str, key: str) -> str:
    raw = (text or "").strip()
    if not raw:
        return ""
    for line in raw.splitlines():
        line = line.strip()
        parts = line.split(None, 3)
        if len(parts) >= 3 and parts[0] == "EXTSTATE" and parts[1] == section and parts[2] == key:
            return unquote(parts[3].strip()) if len(parts) >= 4 else ""
    return unquote(raw)


@dataclass
class BridgeStatus:
    webui_available: bool
    bridge_available: bool
    bridge_version: str = ""
    status: str = "unknown"
    error: str = ""
    export_phase: str = ""
    last_result_debug: str = ""
    heartbeat: str = ""
    heartbeat_age_seconds: Optional[float] = None
    bridge_protocol: int = 1
    bridge_exe_path: str = ""
    bridge_app_version: str = ""
    bridge_resource_path: str = ""
    bridge_project_path: str = ""
    selected_item_count: Optional[int] = None
    bridge_instance_id: str = ""
    bridge_instance_conflict: str = ""

    def as_dict(self) -> Dict[str, Any]:
        return {
            "webui_available": self.webui_available,
            "bridge_available": self.bridge_available,
            "bridge_version": self.bridge_version,
            "status": self.status,
            "error": self.error,
            "export_phase": self.export_phase,
            "last_result_debug": self.last_result_debug,
            "heartbeat": self.heartbeat,
            "heartbeat_age_seconds": self.heartbeat_age_seconds,
            "bridge_protocol": self.bridge_protocol,
            "bridge_exe_path": self.bridge_exe_path,
            "bridge_app_version": self.bridge_app_version,
            "bridge_resource_path": self.bridge_resource_path,
            "bridge_project_path": self.bridge_project_path,
            "selected_item_count": self.selected_item_count,
            "bridge_instance_id": self.bridge_instance_id,
            "bridge_instance_conflict": self.bridge_instance_conflict,
        }


class ReaperBridgeClient:
    def __init__(self, host: str = "127.0.0.1", port: int = 9000, timeout: float = 3.0):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.base_url = f"http://{host}:{port}"

    def _get(self, path: str, timeout: Optional[float] = None) -> requests.Response:
        resp = requests.get(f"{self.base_url}{path}", timeout=timeout or self.timeout)
        if not resp.encoding or resp.encoding.lower() in {"iso-8859-1", "latin-1"}:
            resp.encoding = "utf-8"
        return resp

    def _reaper_api(self, command: str, timeout: Optional[float] = None) -> requests.Response:
        return self._get(f"/_/{command}", timeout=timeout)

    @staticmethod
    def _set_extstate_command(section: str, key: str, value: str) -> str:
        return f"SET/EXTSTATE/{quote(section, safe='')}/{quote(key, safe='')}/{quote(value, safe='')}"

    @staticmethod
    def _get_extstate_command(section: str, key: str) -> str:
        return f"GET/EXTSTATE/{quote(section, safe='')}/{quote(key, safe='')}"

    def test_webui(self) -> bool:
        try:
            return self._get("/", timeout=self.timeout).ok
        except Exception:
            return False

    def set_extstate(self, key: str, value: str) -> None:
        resp = self._reaper_api(self._set_extstate_command(SECTION, key, value))
        if not resp.ok:
            raise ReaperBridgeError(f"写入 REAPER EXTSTATE 失败: HTTP {resp.status_code}")

    def get_extstate(self, key: str, timeout: Optional[float] = None) -> str:
        last_exc = None
        for attempt in range(3):
            try:
                resp = self._reaper_api(self._get_extstate_command(SECTION, key), timeout=timeout)
                break
            except Exception as exc:
                last_exc = exc
                if attempt == 2:
                    raise
                time.sleep(0.15)
        else:
            raise last_exc or ReaperBridgeError("read REAPER EXTSTATE failed")
        if not resp.ok:
            raise ReaperBridgeError(f"读取 REAPER EXTSTATE 失败: HTTP {resp.status_code}")
        return parse_extstate_reply(resp.text, SECTION, key)

    def get_extstate_best_effort(self, key: str, timeout: float = 10.0) -> str:
        try:
            return self.get_extstate(key, timeout=timeout)
        except Exception:
            return ""

    def status(self) -> BridgeStatus:
        if not self.test_webui():
            return BridgeStatus(False, False, error="无法连接 REAPER Web Interface，请确认 REAPER 已打开并启用 Web Interface。")
        try:
            v2_version = self.get_extstate("bridge_version_v2")
            v2_heartbeat = self.get_extstate("heartbeat_v2")
            version = v2_version or self.get_extstate("bridge_version")
            state = self.get_extstate("status") or "unknown"
            phase = self.get_extstate("export_phase")
            last_result = self.get_extstate("last_result_debug")
            heartbeat = v2_heartbeat or self.get_extstate("heartbeat")
            bridge_exe_path = self.get_extstate("bridge_exe_path")
            bridge_app_version = self.get_extstate("bridge_app_version")
            bridge_resource_path = self.get_extstate("bridge_resource_path")
            bridge_project_path = self.get_extstate("bridge_project_path")
            bridge_instance_id = self.get_extstate("bridge_instance_id")
            bridge_instance_conflict = self.get_extstate("bridge_instance_conflict")
            selected_item_count = None
            try:
                selected_item_count = int(self.get_extstate("selected_item_count") or "0")
            except (TypeError, ValueError):
                selected_item_count = None
            bridge_protocol = 2 if v2_version and v2_heartbeat else 1
            heartbeat_age = None
            heartbeat_fresh = False
            try:
                heartbeat_age = max(0.0, time.time() - float(heartbeat))
                heartbeat_fresh = heartbeat_age <= HEARTBEAT_STALE_SECONDS
            except (TypeError, ValueError):
                heartbeat_age = None

            has_version = bool(version) and not version.startswith("EXTSTATE")
            available = has_version and (heartbeat_fresh or state == "exporting")
            if available:
                error = ""
            elif has_version and heartbeat:
                age = f"{heartbeat_age:.1f}" if heartbeat_age is not None else "unknown"
                error = f"Capsule Transfer Bridge 心跳已停止（{age} 秒未更新），请在设置中重新安装 / 启动 Bridge。"
            elif has_version:
                error = "REAPER 已连接，但 Capsule Transfer Bridge 没有心跳，请重新安装 / 启动 Bridge。"
            else:
                error = "REAPER 已连接，但 Capsule Transfer Bridge 尚未运行。"
            return BridgeStatus(
                webui_available=True,
                bridge_available=available,
                bridge_version=version if available else "",
                status=state,
                error=error,
                export_phase=phase,
                last_result_debug=last_result,
                heartbeat=heartbeat,
                heartbeat_age_seconds=heartbeat_age,
                bridge_protocol=bridge_protocol,
                bridge_exe_path=bridge_exe_path,
                bridge_app_version=bridge_app_version,
                bridge_resource_path=bridge_resource_path,
                bridge_project_path=bridge_project_path,
                selected_item_count=selected_item_count,
                bridge_instance_id=bridge_instance_id,
                bridge_instance_conflict=bridge_instance_conflict,
            )
        except Exception as exc:
            return BridgeStatus(True, False, error=f"Bridge 状态读取失败: {exc}")

    @staticmethod
    def _transport_keys(status: BridgeStatus) -> tuple[str, str]:
        if status.bridge_protocol >= 2:
            return "command_v2", "result_v2"
        return "command", "result"

    def ping(self) -> Dict[str, Any]:
        status = self.status()
        if not status.webui_available:
            raise ReaperBridgeError(status.error)
        if not status.bridge_available:
            raise ReaperBridgeError(status.error or "Capsule Transfer Bridge 尚未运行。")

        request_id = str(uuid.uuid4())
        command_key, result_key = self._transport_keys(status)
        self.set_extstate(result_key, "")
        self.set_extstate("export_phase", "python sending ping")
        self.set_extstate("last_command_debug", json.dumps({"type": "ping", "request_id": request_id}, ensure_ascii=False))
        self.set_extstate(command_key, json.dumps({"type": "ping", "request_id": request_id}, ensure_ascii=False))
        return self._wait_for_result(request_id, timeout=5, result_key=result_key)

    def _build_export_command(self, project_name: str, theme_name: str, render_preview: bool, capsule_type: str, export_dir: Optional[str], username: Optional[str]) -> Dict[str, Any]:
        pm = PathManager.get_instance()
        main_export = pm.get_lua_script("main_export2.lua")
        main_export_windows = pm.get_lua_script("main_export2_windows.lua")
        command: Dict[str, Any] = {
            "type": "export_capsule",
            "request_id": str(uuid.uuid4()),
            "project_name": project_name,
            "theme_name": theme_name,
            "render_preview": bool(render_preview),
            "capsule_type": capsule_type or "magic",
            "username": username or "user",
            "main_export_lua": sanitize_path_for_lua(str(main_export.resolve())) if main_export.exists() else "",
            "main_export_windows_lua": sanitize_path_for_lua(str(main_export_windows.resolve())) if main_export_windows.exists() else "",
        }
        if export_dir:
            command["export_dir"] = sanitize_path_for_lua(export_dir)
        return command

    def export_capsule(self, project_name: str, theme_name: str, render_preview: bool = True, capsule_type: str = "magic", export_dir: Optional[str] = None, username: Optional[str] = None, timeout: int = BRIDGE_TIMEOUT_SECONDS) -> Dict[str, Any]:
        status = self.status()
        if not status.webui_available:
            raise ReaperBridgeError(status.error)
        if not status.bridge_available:
            raise ReaperBridgeError(status.error or "Capsule Transfer Bridge 尚未运行。")
        if status.status == "exporting":
            raise ReaperBridgeError("Capsule Transfer Bridge 正在处理另一个导出，请等待完成后再试。")

        command = self._build_export_command(project_name, theme_name, render_preview, capsule_type, export_dir, username)
        request_id = command["request_id"]
        command_key, result_key = self._transport_keys(status)
        self.set_extstate(result_key, "")
        self.set_extstate("last_result_debug", "")
        self.set_extstate("export_phase", "python sending command")
        self.set_extstate("last_command_debug", json.dumps(command, ensure_ascii=False))
        self.set_extstate(command_key, json.dumps(command, ensure_ascii=False))
        result = self._wait_for_result(request_id, timeout=timeout, result_key=result_key)
        result.setdefault("mode", "bridge")
        return result

    def _diagnostics(self) -> str:
        fields = {}
        for key in ["bridge_version_v2", "bridge_version", "bridge_exe_path", "bridge_app_version", "bridge_resource_path", "bridge_project_path", "bridge_instance_id", "bridge_instance_conflict", "selected_item_count", "status", "heartbeat_v2", "heartbeat", "export_phase", "preview_render_debug", "preview_search_debug", "command_v2", "command", "last_command_debug", "last_result_debug", "result_v2", "result"]:
            try:
                value = self.get_extstate(key)
            except Exception as exc:
                value = f"<read error: {exc}>"
            if value and len(value) > 600:
                value = value[:600] + "..."
            fields[key] = value
        return json.dumps(fields, ensure_ascii=False)

    def _wait_for_result(self, request_id: str, timeout: int, result_key: str = "result") -> Dict[str, Any]:
        start = time.time()
        last_raw = ""
        last_read_error = ""
        while time.time() - start < timeout:
            try:
                raw = self.get_extstate(result_key)
            except Exception as exc:
                # REAPER's Web Interface can briefly stop answering while the
                # Windows render helper starts or exits. Treat those as transient
                # read misses; the bridge result may already be written.
                last_read_error = str(exc)
                time.sleep(POLL_INTERVAL_SECONDS)
                continue
            if raw and raw != last_raw:
                last_raw = raw
                try:
                    data = json.loads(raw)
                except json.JSONDecodeError:
                    time.sleep(POLL_INTERVAL_SECONDS)
                    continue
                if data.get("request_id") == request_id:
                    return data
            time.sleep(POLL_INTERVAL_SECONDS)
        for key in (result_key, "result_v2", "result", "last_result_debug"):
            raw = self.get_extstate_best_effort(key, timeout=10.0)
            if not raw:
                continue
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if data.get("request_id") == request_id:
                return data
        raise ReaperBridgeError(f"等待 REAPER bridge 导出超时 ({timeout} 秒)。诊断: {self._diagnostics()}")


def quick_bridge_export(project_name: str, theme_name: str, render_preview: bool = True, webui_port: int = 9000, capsule_type: str = "magic", export_dir: Optional[str] = None, username: Optional[str] = None) -> Dict[str, Any]:
    client = ReaperBridgeClient(port=webui_port)
    timeout = PREVIEW_BRIDGE_TIMEOUT_SECONDS if render_preview else BRIDGE_TIMEOUT_SECONDS
    try:
        return client.export_capsule(project_name=project_name, theme_name=theme_name, render_preview=render_preview, capsule_type=capsule_type, export_dir=export_dir, username=username, timeout=timeout)
    except Exception:
        raw_last_command = client.get_extstate_best_effort("last_command_debug", timeout=10.0)
        try:
            last_command = json.loads(raw_last_command or "{}")
        except json.JSONDecodeError:
            diagnostics = json.loads(client._diagnostics())
            try:
                last_command = json.loads(diagnostics.get("last_command_debug") or "{}")
            except json.JSONDecodeError:
                last_command = {}
        request_id = last_command.get("request_id")
        for key in ("result_v2", "result", "last_result_debug"):
            raw_result = client.get_extstate_best_effort(key, timeout=10.0)
            try:
                data = json.loads(raw_result or "{}")
            except json.JSONDecodeError:
                continue
            if request_id and data.get("request_id") == request_id and data.get("success") is True:
                data.setdefault("mode", "bridge")
                return data
        diagnostics = json.loads(client._diagnostics())
        for key in ("result_v2", "result", "last_result_debug"):
            try:
                data = json.loads(diagnostics.get(key) or "{}")
            except json.JSONDecodeError:
                continue
            if request_id and data.get("request_id") == request_id and data.get("success") is True:
                data.setdefault("mode", "bridge")
                return data
        raise


def get_bridge_status(webui_port: int = 9000) -> Dict[str, Any]:
    return ReaperBridgeClient(port=webui_port).status().as_dict()
