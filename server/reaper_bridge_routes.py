"""Flask routes for Capsule Transfer's persistent REAPER bridge.

The runtime export path is focus-safe and goes through the REAPER Web Interface
plus the long-running capsule_bridge.lua script. These routes only expose
diagnostics; bridge installation must be initiated by the user inside the
intended REAPER instance.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Callable


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
        desired_bridge_version = ""
        try:
            bridge_text = (lua_dir / "capsule_bridge.lua").read_text("utf-8", errors="ignore")
            version_match = re.search(r'BRIDGE_VERSION\s*=\s*"([^"]+)"', bridge_text)
            if version_match:
                desired_bridge_version = version_match.group(1)
        except Exception:
            pass
        status.update({
            "webui_port": port,
            "bridge_script": str(lua_dir / "capsule_bridge.lua"),
            "installer_script": str(lua_dir / "install_capsule_bridge.lua"),
            "desired_bridge_version": desired_bridge_version,
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
