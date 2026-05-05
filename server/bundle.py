"""胶囊打包 / 解包：以 zip 形式在局域网间传输。

打包格式
--------
bundle.zip
├── manifest.json              # 胶囊元数据 + 标签 + 文件清单
└── files/                     # 全部文件（保持相对路径）
    ├── preview.wav            # 可选
    ├── project.rpp            # 可选
    └── audio/...              # 任意子目录
"""

from __future__ import annotations

import io
import json
import logging
import os
import shutil
import uuid as uuid_lib
import zipfile
from pathlib import Path
from typing import Any, BinaryIO

logger = logging.getLogger(__name__)

MANIFEST_NAME = "manifest.json"
FILES_PREFIX = "files/"
MAX_BUNDLE_BYTES = int(os.getenv("LAN_CAPSULE_MAX_BUNDLE_MB", "1024")) * 1024 * 1024


def _walk_files(root: Path):
    for path in root.rglob("*"):
        if path.is_file() and not path.name.startswith("."):
            yield path


def build_bundle(
    capsule: dict[str, Any],
    capsule_root: Path,
    sender: dict[str, Any] | None = None,
) -> bytes:
    """把单个胶囊打包成 zip，返回二进制内容。"""
    capsule_root = Path(capsule_root)
    if not capsule_root.exists() or not capsule_root.is_dir():
        raise FileNotFoundError(f"胶囊目录不存在: {capsule_root}")

    manifest = {
        "schema_version": 1,
        "capsule": {
            "uuid": capsule.get("uuid"),
            "name": capsule.get("name"),
            "project_name": capsule.get("project_name"),
            "capsule_type": capsule.get("capsule_type", "reaper"),
            "preview_audio": capsule.get("preview_audio"),
            "rpp_file": capsule.get("rpp_file"),
            "keywords": capsule.get("keywords"),
            "description": capsule.get("description"),
            "created_at": capsule.get("created_at"),
        },
        "tags": capsule.get("tags", []),
        "metadata": capsule.get("metadata", {}),
        "sender": sender or {},
        "files": [],
    }

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as z:
        for path in _walk_files(capsule_root):
            rel = path.relative_to(capsule_root).as_posix()
            arc = f"{FILES_PREFIX}{rel}"
            z.write(path, arcname=arc)
            manifest["files"].append({"path": rel, "size": path.stat().st_size})
        z.writestr(MANIFEST_NAME, json.dumps(manifest, ensure_ascii=False, indent=2))

    return buf.getvalue()


def extract_bundle(stream: BinaryIO, dest_root: Path) -> tuple[dict[str, Any], Path, int]:
    """解析上传的 zip 流，把文件解到 dest_root/<uuid>/，返回 (manifest, final_dir, size_bytes)。"""
    raw = stream.read(MAX_BUNDLE_BYTES + 1)
    if len(raw) > MAX_BUNDLE_BYTES:
        raise ValueError(
            f"包体超出限制（>{MAX_BUNDLE_BYTES // 1024 // 1024} MB），可调整 LAN_CAPSULE_MAX_BUNDLE_MB"
        )
    size_bytes = len(raw)

    with zipfile.ZipFile(io.BytesIO(raw), mode="r") as z:
        names = z.namelist()
        if MANIFEST_NAME not in names:
            raise ValueError("非法的胶囊包：缺少 manifest.json")
        manifest = json.loads(z.read(MANIFEST_NAME).decode("utf-8"))

        cap = manifest.get("capsule") or {}
        uuid_str = cap.get("uuid") or str(uuid_lib.uuid4())
        cap["uuid"] = uuid_str

        target_dir = Path(dest_root) / uuid_str
        if target_dir.exists():
            shutil.rmtree(target_dir)
        target_dir.mkdir(parents=True, exist_ok=True)

        for member in z.infolist():
            if member.is_dir():
                continue
            if member.filename == MANIFEST_NAME:
                continue
            if not member.filename.startswith(FILES_PREFIX):
                continue
            rel = member.filename[len(FILES_PREFIX):]
            if not rel or rel.startswith(("..", "/")) or ".." in Path(rel).parts:
                logger.warning("跳过可疑路径: %s", member.filename)
                continue
            out_path = target_dir / rel
            out_path.parent.mkdir(parents=True, exist_ok=True)
            with z.open(member) as src, open(out_path, "wb") as dst:
                shutil.copyfileobj(src, dst)

    return manifest, target_dir, size_bytes
