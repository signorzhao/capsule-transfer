"""Capsule bundle creation and transactional extraction."""

from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import re
import shutil
import stat
import tempfile
import time
import uuid as uuid_lib
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO

logger = logging.getLogger(__name__)

MANIFEST_NAME = "manifest.json"
FILES_PREFIX = "files/"
MAX_BUNDLE_BYTES = int(os.getenv("LAN_CAPSULE_MAX_BUNDLE_MB", "1024")) * 1024 * 1024
MAX_EXTRACTED_BYTES = int(os.getenv("LAN_CAPSULE_MAX_EXTRACTED_MB", "4096")) * 1024 * 1024
MAX_ARCHIVE_FILES = int(os.getenv("LAN_CAPSULE_MAX_ARCHIVE_FILES", "20000"))
MAX_COMPRESSION_RATIO = int(os.getenv("LAN_CAPSULE_MAX_COMPRESSION_RATIO", "250"))
COPY_CHUNK_BYTES = 1024 * 1024
STAGING_DIR_NAME = ".staging"


class BundleConflictError(ValueError):
    """Raised when an imported capsule would replace an existing capsule."""


def _walk_files(root: Path):
    for path in root.rglob("*"):
        if path.is_file() and not path.name.startswith("."):
            yield path


def _manifest(capsule: dict[str, Any], sender: dict[str, Any] | None) -> dict[str, Any]:
    return {
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


def build_bundle_file(
    capsule: dict[str, Any],
    capsule_root: Path,
    output_path: Path,
    sender: dict[str, Any] | None = None,
) -> Path:
    """Write a capsule ZIP directly to disk and return its path."""
    capsule_root = Path(capsule_root)
    output_path = Path(output_path)
    if not capsule_root.exists() or not capsule_root.is_dir():
        raise FileNotFoundError(f"胶囊目录不存在: {capsule_root}")

    manifest = _manifest(capsule, sender)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(output_path, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path in _walk_files(capsule_root):
                rel = path.relative_to(capsule_root).as_posix()
                if rel == MANIFEST_NAME:
                    continue
                archive.write(path, arcname=f"{FILES_PREFIX}{rel}")
                manifest["files"].append({
                    "path": rel,
                    "size": path.stat().st_size,
                    "sha256": sha256_file(path),
                })
            archive.writestr(
                MANIFEST_NAME,
                json.dumps(manifest, ensure_ascii=False, indent=2),
            )
    except Exception:
        output_path.unlink(missing_ok=True)
        raise
    return output_path


def build_bundle(
    capsule: dict[str, Any],
    capsule_root: Path,
    sender: dict[str, Any] | None = None,
) -> bytes:
    """Compatibility wrapper. Prefer build_bundle_file for large bundles."""
    buf = io.BytesIO()
    manifest = _manifest(capsule, sender)
    capsule_root = Path(capsule_root)
    if not capsule_root.exists() or not capsule_root.is_dir():
        raise FileNotFoundError(f"胶囊目录不存在: {capsule_root}")
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in _walk_files(capsule_root):
            rel = path.relative_to(capsule_root).as_posix()
            if rel == MANIFEST_NAME:
                continue
            archive.write(path, arcname=f"{FILES_PREFIX}{rel}")
            manifest["files"].append({
                "path": rel,
                "size": path.stat().st_size,
                "sha256": sha256_file(path),
            })
        archive.writestr(MANIFEST_NAME, json.dumps(manifest, ensure_ascii=False, indent=2))
    return buf.getvalue()


def copy_stream_to_file(
    stream: BinaryIO,
    output_path: Path,
    max_bytes: int = MAX_BUNDLE_BYTES,
    progress_callback=None,
) -> tuple[int, str]:
    """Copy an upload to disk while enforcing size and computing SHA256."""
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    size_bytes = 0
    try:
        with output_path.open("wb") as dst:
            while True:
                chunk = stream.read(COPY_CHUNK_BYTES)
                if not chunk:
                    break
                size_bytes += len(chunk)
                if size_bytes > max_bytes:
                    raise ValueError(
                        f"包体超出限制（>{max_bytes // 1024 // 1024} MB），"
                        "可调整 LAN_CAPSULE_MAX_BUNDLE_MB"
                    )
                digest.update(chunk)
                dst.write(chunk)
                if progress_callback:
                    progress_callback(size_bytes)
    except Exception:
        output_path.unlink(missing_ok=True)
        raise
    return size_bytes, digest.hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as src:
        while True:
            chunk = src.read(COPY_CHUNK_BYTES)
            if not chunk:
                return digest.hexdigest()
            digest.update(chunk)


def _safe_capsule_id(value: Any) -> str:
    capsule_id = str(value or uuid_lib.uuid4()).strip()
    if (
        not capsule_id
        or capsule_id in {".", ".."}
        or len(capsule_id) > 128
        or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for char in capsule_id)
    ):
        raise ValueError("manifest 中的胶囊 UUID 非法")
    return capsule_id


def _safe_member_path(filename: str) -> PurePosixPath:
    if not filename.startswith(FILES_PREFIX):
        raise ValueError(f"压缩包包含非法顶层文件: {filename}")
    rel = filename[len(FILES_PREFIX):]
    if not rel or "\\" in rel or ":" in rel or "\x00" in rel:
        raise ValueError(f"压缩包包含非法路径: {filename}")
    path = PurePosixPath(rel)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError(f"压缩包包含路径穿越: {filename}")
    return path


def _is_symlink(member: zipfile.ZipInfo) -> bool:
    mode = member.external_attr >> 16
    return stat.S_ISLNK(mode)


def _validated_members(
    archive: zipfile.ZipFile,
) -> tuple[dict[str, Any], list[tuple[zipfile.ZipInfo, PurePosixPath]], int]:
    infos = archive.infolist()
    if len(infos) > MAX_ARCHIVE_FILES + 1:
        raise ValueError(f"压缩包文件数量超出限制（>{MAX_ARCHIVE_FILES}）")

    manifest_infos = [item for item in infos if item.filename == MANIFEST_NAME]
    if len(manifest_infos) != 1:
        raise ValueError("非法的胶囊包：manifest.json 缺失或重复")
    manifest_info = manifest_infos[0]
    if manifest_info.file_size > 4 * 1024 * 1024:
        raise ValueError("manifest.json 过大")
    try:
        manifest = json.loads(archive.read(manifest_info).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("manifest.json 无法解析") from exc
    if not isinstance(manifest, dict):
        raise ValueError("manifest.json 格式无效")

    members: list[tuple[zipfile.ZipInfo, PurePosixPath]] = []
    total_size = 0
    actual_files: dict[str, int] = {}
    for member in infos:
        if member.filename == MANIFEST_NAME:
            continue
        if member.is_dir():
            _safe_member_path(member.filename.rstrip("/"))
            continue
        if _is_symlink(member):
            raise ValueError(f"压缩包不允许符号链接: {member.filename}")
        rel = _safe_member_path(member.filename)
        total_size += member.file_size
        if total_size > MAX_EXTRACTED_BYTES:
            raise ValueError(
                f"解压后总大小超出限制（>{MAX_EXTRACTED_BYTES // 1024 // 1024} MB）"
            )
        if (
            member.file_size > COPY_CHUNK_BYTES
            and (
                member.compress_size == 0
                or member.file_size / member.compress_size > MAX_COMPRESSION_RATIO
            )
        ):
            raise ValueError(f"压缩比异常，拒绝解压: {member.filename}")
        rel_name = rel.as_posix()
        if rel_name in actual_files:
            raise ValueError(f"压缩包包含重复文件: {rel_name}")
        actual_files[rel_name] = member.file_size
        members.append((member, rel))

    declared = manifest.get("files")
    if isinstance(declared, list):
        declared_files: dict[str, dict[str, Any]] = {}
        for item in declared:
            if not isinstance(item, dict):
                raise ValueError("manifest 文件清单格式无效")
            path = str(item.get("path") or "")
            size = item.get("size")
            if path in declared_files or not isinstance(size, int) or size < 0:
                raise ValueError("manifest 文件清单格式无效")
            sha256 = item.get("sha256")
            if sha256 is not None and (
                not isinstance(sha256, str)
                or not re.fullmatch(r"[0-9a-fA-F]{64}", sha256)
            ):
                raise ValueError("manifest 文件 SHA256 格式无效")
            declared_files[path] = {
                "size": size,
                "sha256": sha256.lower() if isinstance(sha256, str) else None,
            }
        if {path: item["size"] for path, item in declared_files.items()} != actual_files:
            raise ValueError("manifest 文件清单与压缩包内容不一致")
    return manifest, members, total_size


def _ensure_disk_space(path: Path, required_bytes: int) -> None:
    reserve = int(os.getenv("LAN_CAPSULE_DISK_RESERVE_MB", "256")) * 1024 * 1024
    free_bytes = shutil.disk_usage(path).free
    if free_bytes < required_bytes + reserve:
        raise ValueError("磁盘空间不足")


def cleanup_staging(dest_root: Path, max_age_seconds: int = 24 * 60 * 60) -> int:
    """Remove abandoned staging entries older than max_age_seconds."""
    staging_root = Path(dest_root) / STAGING_DIR_NAME
    if not staging_root.exists():
        return 0
    cutoff = time.time() - max_age_seconds
    removed = 0
    for entry in staging_root.iterdir():
        try:
            if entry.stat().st_mtime >= cutoff:
                continue
            if entry.is_dir():
                shutil.rmtree(entry)
            else:
                entry.unlink()
            removed += 1
        except OSError:
            logger.warning("无法清理暂存项: %s", entry, exc_info=True)
    return removed


def import_bundle_file(
    bundle_path: Path,
    dest_root: Path,
    *,
    replace_existing: bool = False,
) -> tuple[dict[str, Any], Path, int]:
    """Validate, extract to staging, then atomically publish a capsule."""
    bundle_path = Path(bundle_path)
    dest_root = Path(dest_root)
    dest_root.mkdir(parents=True, exist_ok=True)
    staging_root = dest_root / STAGING_DIR_NAME
    staging_root.mkdir(parents=True, exist_ok=True)
    work_dir = Path(tempfile.mkdtemp(prefix="import-", dir=staging_root))
    extracted_dir = work_dir / "capsule"
    backup_dir: Path | None = None
    final_dir: Path | None = None
    published = False
    try:
        with zipfile.ZipFile(bundle_path, mode="r") as archive:
            manifest, members, total_size = _validated_members(archive)
            capsule = manifest.setdefault("capsule", {})
            capsule_id = _safe_capsule_id(capsule.get("uuid"))
            capsule["uuid"] = capsule_id
            _ensure_disk_space(dest_root, total_size)
            extracted_dir.mkdir()
            resolved_root = extracted_dir.resolve()
            for member, rel in members:
                output_path = extracted_dir.joinpath(*rel.parts)
                resolved_output = output_path.resolve()
                if resolved_output != resolved_root and resolved_root not in resolved_output.parents:
                    raise ValueError(f"压缩包包含路径穿越: {member.filename}")
                output_path.parent.mkdir(parents=True, exist_ok=True)
                digest = hashlib.sha256()
                with archive.open(member) as src, output_path.open("wb") as dst:
                    while True:
                        chunk = src.read(COPY_CHUNK_BYTES)
                        if not chunk:
                            break
                        digest.update(chunk)
                        dst.write(chunk)
                declared_item = next(
                    (
                        item
                        for item in manifest.get("files", [])
                        if isinstance(item, dict) and item.get("path") == rel.as_posix()
                    ),
                    None,
                )
                expected_sha256 = (declared_item or {}).get("sha256")
                if expected_sha256 and digest.hexdigest() != expected_sha256.lower():
                    raise ValueError(f"文件 SHA256 校验失败: {rel.as_posix()}")
            (extracted_dir / MANIFEST_NAME).write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

        final_dir = dest_root / capsule_id
        if final_dir.exists():
            if not replace_existing:
                raise BundleConflictError("UUID 冲突，胶囊目录已存在")
            backup_dir = staging_root / f"backup-{capsule_id}-{uuid_lib.uuid4().hex}"
            os.replace(final_dir, backup_dir)
        try:
            os.replace(extracted_dir, final_dir)
            published = True
        except Exception:
            if backup_dir and backup_dir.exists() and not final_dir.exists():
                os.replace(backup_dir, final_dir)
            raise
        if backup_dir and backup_dir.exists():
            shutil.rmtree(backup_dir, ignore_errors=True)
        return manifest, final_dir, bundle_path.stat().st_size
    finally:
        if not published and backup_dir and backup_dir.exists() and final_dir is not None:
            if not final_dir.exists():
                os.replace(backup_dir, final_dir)
        shutil.rmtree(work_dir, ignore_errors=True)


def extract_bundle(
    stream: BinaryIO,
    dest_root: Path,
    *,
    replace_existing: bool = False,
) -> tuple[dict[str, Any], Path, int]:
    """Compatibility wrapper that spools an upload before transactional import."""
    dest_root = Path(dest_root)
    staging_root = dest_root / STAGING_DIR_NAME
    staging_root.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix="upload-", suffix=".zip", dir=staging_root)
    os.close(fd)
    temp_path = Path(temp_name)
    try:
        copy_stream_to_file(stream, temp_path)
        return import_bundle_file(
            temp_path,
            dest_root,
            replace_existing=replace_existing,
        )
    finally:
        temp_path.unlink(missing_ok=True)
