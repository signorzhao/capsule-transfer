"""本机网络信息工具。"""

from __future__ import annotations

import ipaddress
import socket
from typing import Any


def _is_private_or_loopback(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return addr.is_private or addr.is_loopback


def _is_loopback(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip).is_loopback
    except ValueError:
        return False


def _origin_host(origin: str) -> str:
    raw = (origin or "").strip().lower()
    if not raw or raw == "null":
        return raw
    try:
        from urllib.parse import urlparse
        parsed = urlparse(raw)
        return parsed.hostname or ""
    except Exception:
        return ""


def _is_allowed_local_webview_origin(origin: str) -> bool:
    """Allow desktop WebView origins to read the local Flask API.

    Flask-CORS in app.py has a conservative static allowlist. Tauri/WebView
    builds can use origins such as http://tauri.localhost or Origin: null, which
    makes fetch() fail even when Network panel shows the JSON response. This
    helper is intentionally only for API responses; non-LAN remote_addr blocking
    still happens in app.py before request handlers run.
    """
    origin = (origin or "").strip()
    if not origin:
        return False
    if origin == "null":
        return True
    host = _origin_host(origin)
    if host in {"localhost", "127.0.0.1", "::1", "tauri.localhost"}:
        return True
    return _is_private_or_loopback(host)


def _install_local_webview_cors_patch() -> None:
    try:
        from flask import Flask, request
    except Exception:
        return

    if getattr(Flask, "_capsule_lan_cors_patch", False):
        return

    original_process_response = Flask.process_response

    def process_response_with_local_cors(self, response):
        response = original_process_response(self, response)
        try:
            if request.path.startswith("/api/"):
                origin = request.headers.get("Origin", "")
                if _is_allowed_local_webview_origin(origin):
                    response.headers["Access-Control-Allow-Origin"] = origin
                    response.headers["Vary"] = "Origin"
                    response.headers.setdefault("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
                    response.headers.setdefault(
                        "Access-Control-Allow-Headers",
                        "Content-Type, X-Capsule-Token, X-Accept-Token, X-Capsule-Peer-IP, X-Capsule-Peer-Name, X-Capsule-Peer-ID, X-Capsule-Peer-Public-Key, X-Capsule-Peer-Signature, X-Capsule-Peer-Nonce, X-Capsule-Peer-Timestamp, X-Capsule-Bundle-SHA256",
                    )
        except Exception:
            pass
        return response

    Flask.process_response = process_response_with_local_cors
    Flask._capsule_lan_cors_patch = True


_install_local_webview_cors_patch()


def _candidate_ips() -> list[str]:
    """尽力找出本机在局域网中可被访问的 IP。"""
    ips: list[str] = []

    # 通过 UDP 探测路由的“出口” IP（不真正发包）
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(0.5)
            s.connect(("10.255.255.255", 1))
            ips.append(s.getsockname()[0])
    except Exception:
        pass

    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips:
                ips.append(ip)
    except Exception:
        pass

    # 过滤 loopback，但保底仍展示
    filtered = [ip for ip in ips if not ip.startswith("127.")]
    return filtered or ips or ["127.0.0.1"]


def network_info(port: int) -> dict[str, Any]:
    primary_ips = _candidate_ips()
    primary = primary_ips[0]
    return {
        "hostname": socket.gethostname(),
        "ip": primary,
        "all_ips": primary_ips,
        "port": port,
        "is_loopback": _is_loopback(primary),
        "is_private_lan": _is_private_or_loopback(primary),
        "allowed_for_lan_mode": _is_private_or_loopback(primary),
    }
