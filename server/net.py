"""本机网络信息工具。"""

from __future__ import annotations

import socket
from typing import Any


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
    }
