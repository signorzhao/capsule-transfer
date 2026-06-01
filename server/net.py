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
