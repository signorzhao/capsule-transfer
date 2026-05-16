"""REAPER export entrypoint for Capsule Transfer.

Default behavior is now focus-safe: export commands are sent to a persistent
Lua bridge running inside REAPER via Web Interface EXTSTATE. This module keeps
the historical public API name (quick_webui_export) so server/app.py and older
callers do not need to change.

Legacy -nonewinst launching is intentionally not used by default because it can
cause REAPER to steal focus. It can be reintroduced behind an explicit user
compatibility setting, but the safe bridge path is the production default.
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional


def get_export_temp_dir() -> Path:
    """Return the temp directory used by legacy scripts and diagnostics."""
    if platform.system() == "Windows":
        temp_base = Path(tempfile.gettempdir()) / "synest_export"
    else:
        temp_base = Path("/tmp/synest_export")
    temp_base.mkdir(parents=True, exist_ok=True)
    return temp_base


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


class ReaperWebUIExporter:
    """Focus-safe REAPER exporter backed by the persistent bridge."""

    def __init__(self, host: str = "localhost", port: int = 9000):
        self.host = host
        self.port = port
        self.base_url = f"http://{host}:{port}"

    def test_connection(self) -> bool:
        """Test REAPER Web Interface reachability."""
        try:
            import requests
            response = requests.get(self.base_url, timeout=5)
            return response.status_code == 200
        except Exception:
            return False

    def _find_reaper_executable(self) -> Optional[Path]:
        """Find REAPER executable for diagnostics/install flows, not export."""
        system = platform.system()

        config_candidates = []
        if system == "Darwin":
            config_candidates = [
                Path.home() / "Library/Application Support/CapsuleTransfer/config.json",
                Path.home() / "Library/Application Support/com.soundcapsule.app/config.json",
            ]
        elif system == "Windows":
            appdata = os.environ.get("APPDATA", str(Path.home() / "AppData/Roaming"))
            config_candidates = [
                Path(appdata) / "CapsuleTransfer/config.json",
                Path(appdata) / "com.soundcapsule.app/config.json",
            ]
        else:
            config_candidates = [
                Path.home() / ".config/CapsuleTransfer/config.json",
                Path.home() / ".config/com.soundcapsule.app/config.json",
            ]

        for config_path in config_candidates:
            try:
                if config_path.exists():
                    config = json.loads(config_path.read_text("utf-8"))
                    reaper_path = config.get("reaper_path")
                    if reaper_path:
                        reaper_exe = Path(reaper_path)
                        if reaper_exe.is_dir() and reaper_exe.suffix == ".app":
                            reaper_exe = reaper_exe / "Contents" / "MacOS" / "REAPER"
                        if reaper_exe.exists() and reaper_exe.is_file():
                            return reaper_exe
            except Exception:
                pass

        if system == "Darwin":
            paths = [
                Path("/Applications/REAPER.app/Contents/MacOS/REAPER"),
                Path("/Applications/REAPER64.app/Contents/MacOS/REAPER"),
                Path.home() / "Applications/REAPER.app/Contents/MacOS/REAPER",
            ]
        elif system == "Windows":
            paths = [
                Path("C:/Program Files/REAPER (x64)/reaper.exe"),
                Path("C:/Program Files/REAPER (arm64)/reaper.exe"),
                Path("C:/Program Files/REAPER/reaper.exe"),
                Path("C:/Program Files (x86)/REAPER/reaper.exe"),
                Path.home() / "AppData/Local/Programs/REAPER/reaper.exe",
            ]
        else:
            reaper_in_path = shutil.which("reaper")
            if reaper_in_path:
                return Path(reaper_in_path)
            paths = [Path("/usr/bin/reaper")]

        for path in paths:
            if path.exists():
                return path
        return None

    def prepare_export_config(self, config: Dict[str, Any]) -> bool:
        """Validate export config paths for compatibility with old callers."""
        try:
            export_dir = config.get("export_dir")
            if export_dir:
                config["export_dir"] = sanitize_path_for_lua(export_dir)
            return True
        except Exception:
            return False

    def export_via_webui(
        self,
        project_name: str,
        theme_name: str,
        render_preview: bool = True,
        capsule_type: str = "magic",
        export_dir: str | None = None,
        username: str | None = None,
    ) -> Dict[str, Any]:
        """Export using the persistent bridge without launching/foregrounding REAPER."""
        if not username:
            username = "user"

        try:
            from exporters.reaper_bridge_client import ReaperBridgeClient, ReaperBridgeError, quick_bridge_export

            result = quick_bridge_export(
                project_name=project_name,
                theme_name=theme_name,
                render_preview=render_preview,
                webui_port=self.port,
                capsule_type=capsule_type,
                export_dir=export_dir,
                username=username,
            )
            result.setdefault("mode", "bridge")
            result.setdefault("success", bool(result.get("success")))
            return result
        except Exception as exc:
            error = str(exc)
            diagnostics = ""
            bridge_status: Dict[str, Any] = {}
            try:
                client = ReaperBridgeClient(port=self.port)
                bridge_status = client.status().as_dict()
                diagnostics = client._diagnostics()
            except Exception:
                pass
            return {
                "success": False,
                "mode": "bridge",
                "needs_bridge_install": "Bridge 尚未运行" in error or "尚未运行" in error,
                "webui_required": "Web Interface" in error or "无法连接" in error,
                "error": error,
                "diagnostics": diagnostics,
                "bridge_status": bridge_status,
                "export_phase": bridge_status.get("export_phase", ""),
            }


def quick_webui_export(
    project_name: str,
    theme_name: str,
    render_preview: bool = True,
    webui_port: int = 9000,
    capsule_type: str = "magic",
    export_dir: str | None = None,
    username: str | None = None,
) -> Dict[str, Any]:
    """Compatibility wrapper used by server/app.py.

    Despite the historical name, this now uses the persistent REAPER bridge by
    default and never launches REAPER as part of export.
    """
    exporter = ReaperWebUIExporter(port=webui_port)
    return exporter.export_via_webui(
        project_name=project_name,
        theme_name=theme_name,
        render_preview=render_preview,
        capsule_type=capsule_type,
        export_dir=export_dir,
        username=username,
    )


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 3:
        print("用法: python reaper_webui_export.py <项目名> <主题名> [渲染预览:1/0] [WebUI端口]")
        sys.exit(1)

    project = sys.argv[1]
    theme = sys.argv[2]
    preview = len(sys.argv) > 2 and sys.argv[3] == "1"
    port = int(sys.argv[4]) if len(sys.argv) > 4 else 9000

    result = quick_webui_export(project, theme, preview, port)
    if result.get("success"):
        print(f"\n✅ 导出成功: {result.get('capsule_name')}")
    else:
        print(f"\n❌ 导出失败: {result.get('error')}")
        sys.exit(1)
