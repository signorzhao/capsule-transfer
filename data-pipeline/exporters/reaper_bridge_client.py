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
from urllib.parse import quote

import requests

from common import PathManager
from exporters.reaper_webui_export import sanitize_path_for_lua

SECTION = "capsule_transfer"
BRIDGE_TIMEOUT_SECONDS = 180
POLL_INTERVAL_SECONDS = 0.2


class ReaperBridgeError(RuntimeError):
    """Raised when the persistent REAPER bridge is unavailable or fails."""


@dataclass
class BridgeStatus:
    webui_available: bool
    bridge_available: bool
    bridge_version: str = ""
    status: str = "unknown"
    error: str = ""

    def as_dict(self) -> Dict[str, Any]:
        return {
            "webui_available": self.webui_available,
            "bridge_available": self.bridge_available,
            "bridge_version": self.bridge_version,
            "status": self.status,
            "error": self.error,
        }


class ReaperBridgeClient:
    def __init__(self, host: str = "localhost", port: int = 9000, timeout: float = 3.0):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.base_url = f"http://{host}:{port}"

    def _get(self, path: str, timeout: Optional[float] = None) -> requests.Response:
        return requests.get(f"{self.base_url}{path}", timeout=timeout or self.timeout)

    def _reaper_api(self, command: str, timeout: Optional[float] = None) -> requests.Response:
        # REAPER's Web Interface accepts commands at /_/COMMAND.
        return self._get(f"/_/{command}", timeout=timeout)

    @staticmethod
    def _set_extstate_command(section: str, key: str, value: str) -> str:
        # Named command accepted by REAPER Web Interface.
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

    def get_extstate(self, key: str) -> str:
        resp = self._reaper_api(self._get_extstate_command(SECTION, key))
        if not resp.ok:
            raise ReaperBridgeError(f"读取 REAPER EXTSTATE 失败: HTTP {resp.status_code}")
        return resp.text.strip()

    def status(self) -> BridgeStatus:
        if not self.test_webui():
            return BridgeStatus(
                webui_available=False,
                bridge_available=False,
                error="无法连接 REAPER Web Interface，请确认 REAPER 已打开并启用 Web Interface。",
            )
        try:
            version = self.get_extstate("bridge_version")
            state = self.get_extstate("status") or "unknown"
            available = bool(version)
            return BridgeStatus(
                webui_available=True,
                bridge_available=available,
                bridge_version=version,
                status=state,
                error="" if available else "REAPER 已连接，但 Capsule Transfer Bridge 尚未运行。",
            )
        except Exception as exc:
            return BridgeStatus(
                webui_available=True,
                bridge_available=False,
                error=f"Bridge 状态读取失败: {exc}",
            )

    def ping(self) -> Dict[str, Any]:
        request_id = str(uuid.uuid4())
        self.set_extstate("result", "")
        self.set_extstate("command", json.dumps({"type": "ping", "request_id": request_id}, ensure_ascii=False))
        return self._wait_for_result(request_id, timeout=5)

    def _build_export_command(
        self,
        project_name: str,
        theme_name: str,
        render_preview: bool,
        capsule_type: str,
        export_dir: Optional[str],
        username: Optional[str],
    ) -> Dict[str, Any]:
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

    def export_capsule(
        self,
        project_name: str,
        theme_name: str,
        render_preview: bool = True,
        capsule_type: str = "magic",
        export_dir: Optional[str] = None,
        username: Optional[str] = None,
        timeout: int = BRIDGE_TIMEOUT_SECONDS,
    ) -> Dict[str, Any]:
        status = self.status()
        if not status.webui_available:
            raise ReaperBridgeError(status.error)
        if not status.bridge_available:
            raise ReaperBridgeError(status.error or "Capsule Transfer Bridge 尚未运行。")

        command = self._build_export_command(
            project_name=project_name,
            theme_name=theme_name,
            render_preview=render_preview,
            capsule_type=capsule_type,
            export_dir=export_dir,
            username=username,
        )
        request_id = command["request_id"]
        self.set_extstate("result", "")
        self.set_extstate("command", json.dumps(command, ensure_ascii=False))
        result = self._wait_for_result(request_id, timeout=timeout)
        result.setdefault("mode", "bridge")
        return result

    def _wait_for_result(self, request_id: str, timeout: int) -> Dict[str, Any]:
        start = time.time()
        last_raw = ""
        while time.time() - start < timeout:
            raw = self.get_extstate("result")
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
        raise ReaperBridgeError(f"等待 REAPER bridge 导出超时 ({timeout} 秒)")


def quick_bridge_export(
    project_name: str,
    theme_name: str,
    render_preview: bool = True,
    webui_port: int = 9000,
    capsule_type: str = "magic",
    export_dir: Optional[str] = None,
    username: Optional[str] = None,
) -> Dict[str, Any]:
    client = ReaperBridgeClient(port=webui_port)
    return client.export_capsule(
        project_name=project_name,
        theme_name=theme_name,
        render_preview=render_preview,
        capsule_type=capsule_type,
        export_dir=export_dir,
        username=username,
    )


def get_bridge_status(webui_port: int = 9000) -> Dict[str, Any]:
    return ReaperBridgeClient(port=webui_port).status().as_dict()
