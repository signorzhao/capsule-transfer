from __future__ import annotations

import io
import hashlib
import json
import os
import sys
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

import bundle


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.capsules_dir = self.root / "capsules"
        self.capsules_dir.mkdir()

    def tearDown(self):
        self.temp_dir.cleanup()

    def _write_archive(self, path: Path, manifest: dict, files: dict[str, bytes]):
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, content in files.items():
                archive.writestr(name, content)
            archive.writestr(
                bundle.MANIFEST_NAME,
                json.dumps(manifest, ensure_ascii=False),
            )

    def _manifest(self, capsule_id: str, files: dict[str, bytes]) -> dict:
        return {
            "schema_version": 1,
            "capsule": {"uuid": capsule_id, "name": "Test"},
            "files": [
                {"path": name[len(bundle.FILES_PREFIX):], "size": len(content)}
                for name, content in files.items()
            ],
        }

    def test_build_and_import_round_trip(self):
        source = self.root / "source"
        (source / "Audio").mkdir(parents=True)
        (source / "Audio" / "clip.wav").write_bytes(b"audio-data")
        (source / "project.rpp").write_text("RPP", encoding="utf-8")
        (source / bundle.MANIFEST_NAME).write_text("old manifest", encoding="utf-8")
        archive_path = self.root / "bundle.zip"

        bundle.build_bundle_file(
            {"uuid": "capsule-1", "name": "Round trip"},
            source,
            archive_path,
        )
        manifest, final_dir, size_bytes = bundle.import_bundle_file(
            archive_path,
            self.capsules_dir,
        )

        self.assertEqual(manifest["capsule"]["uuid"], "capsule-1")
        self.assertEqual(final_dir, self.capsules_dir / "capsule-1")
        self.assertEqual((final_dir / "Audio" / "clip.wav").read_bytes(), b"audio-data")
        self.assertTrue((final_dir / bundle.MANIFEST_NAME).is_file())
        self.assertNotIn(
            bundle.MANIFEST_NAME,
            {item["path"] for item in manifest["files"]},
        )
        clip_entry = next(item for item in manifest["files"] if item["path"] == "Audio/clip.wav")
        self.assertEqual(
            clip_entry["sha256"],
            hashlib.sha256(b"audio-data").hexdigest(),
        )
        self.assertEqual(size_bytes, archive_path.stat().st_size)

    def test_copy_stream_enforces_limit_and_removes_partial_file(self):
        output = self.root / "upload.zip"
        with self.assertRaisesRegex(ValueError, "包体超出限制"):
            bundle.copy_stream_to_file(io.BytesIO(b"12345"), output, max_bytes=4)
        self.assertFalse(output.exists())

    def test_path_traversal_is_rejected_without_publishing(self):
        archive_path = self.root / "traversal.zip"
        files = {f"{bundle.FILES_PREFIX}../outside.txt": b"bad"}
        self._write_archive(archive_path, self._manifest("capsule-2", files), files)

        with self.assertRaisesRegex(ValueError, "路径穿越"):
            bundle.import_bundle_file(archive_path, self.capsules_dir)

        self.assertFalse((self.root / "outside.txt").exists())
        self.assertFalse((self.capsules_dir / "capsule-2").exists())

    def test_manifest_mismatch_is_rejected(self):
        archive_path = self.root / "mismatch.zip"
        files = {f"{bundle.FILES_PREFIX}clip.wav": b"audio"}
        manifest = self._manifest("capsule-3", files)
        manifest["files"][0]["size"] = 999
        self._write_archive(archive_path, manifest, files)

        with self.assertRaisesRegex(ValueError, "文件清单"):
            bundle.import_bundle_file(archive_path, self.capsules_dir)
        self.assertFalse((self.capsules_dir / "capsule-3").exists())

    def test_file_hash_mismatch_is_rejected(self):
        archive_path = self.root / "hash-mismatch.zip"
        files = {f"{bundle.FILES_PREFIX}clip.wav": b"audio"}
        manifest = self._manifest("capsule-hash", files)
        manifest["files"][0]["sha256"] = hashlib.sha256(b"different").hexdigest()
        self._write_archive(archive_path, manifest, files)

        with self.assertRaisesRegex(ValueError, "SHA256"):
            bundle.import_bundle_file(archive_path, self.capsules_dir)
        self.assertFalse((self.capsules_dir / "capsule-hash").exists())

    def test_disk_space_shortage_rejects_import_without_publishing(self):
        archive_path = self.root / "disk-full.zip"
        files = {f"{bundle.FILES_PREFIX}clip.wav": b"audio"}
        self._write_archive(archive_path, self._manifest("capsule-disk", files), files)

        with mock.patch.object(
            bundle.shutil,
            "disk_usage",
            return_value=SimpleNamespace(total=100, used=99, free=1),
        ):
            with self.assertRaisesRegex(ValueError, "磁盘空间不足"):
                bundle.import_bundle_file(archive_path, self.capsules_dir)
        self.assertFalse((self.capsules_dir / "capsule-disk").exists())

    def test_interrupted_stream_removes_partial_upload(self):
        class InterruptedStream:
            def __init__(self):
                self.calls = 0

            def read(self, _size):
                self.calls += 1
                if self.calls == 1:
                    return b"partial"
                raise OSError("simulated disconnect")

        output = self.root / "interrupted.zip"
        with self.assertRaisesRegex(OSError, "simulated disconnect"):
            bundle.copy_stream_to_file(InterruptedStream(), output)
        self.assertFalse(output.exists())

    def test_cleanup_staging_removes_only_expired_entries(self):
        staging = self.capsules_dir / bundle.STAGING_DIR_NAME
        old_entry = staging / "old"
        fresh_entry = staging / "fresh"
        old_entry.mkdir(parents=True)
        fresh_entry.mkdir()
        old_time = time.time() - 3600
        os.utime(old_entry, (old_time, old_time))

        removed = bundle.cleanup_staging(self.capsules_dir, max_age_seconds=60)

        self.assertEqual(removed, 1)
        self.assertFalse(old_entry.exists())
        self.assertTrue(fresh_entry.exists())

    def test_conflict_preserves_existing_capsule(self):
        existing = self.capsules_dir / "capsule-4"
        existing.mkdir()
        marker = existing / "keep.txt"
        marker.write_text("original", encoding="utf-8")
        archive_path = self.root / "conflict.zip"
        files = {f"{bundle.FILES_PREFIX}new.txt": b"new"}
        self._write_archive(archive_path, self._manifest("capsule-4", files), files)

        with self.assertRaises(bundle.BundleConflictError):
            bundle.import_bundle_file(archive_path, self.capsules_dir)

        self.assertEqual(marker.read_text(encoding="utf-8"), "original")
        self.assertFalse((existing / "new.txt").exists())

    def test_replace_failure_restores_existing_capsule(self):
        existing = self.capsules_dir / "capsule-5"
        existing.mkdir()
        marker = existing / "keep.txt"
        marker.write_text("original", encoding="utf-8")
        archive_path = self.root / "replace.zip"
        files = {f"{bundle.FILES_PREFIX}new.txt": b"new"}
        self._write_archive(archive_path, self._manifest("capsule-5", files), files)

        original_replace = os.replace
        calls = 0

        def fail_publish(source, destination):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("simulated publish failure")
            return original_replace(source, destination)

        with mock.patch.object(bundle.os, "replace", side_effect=fail_publish):
            with self.assertRaisesRegex(OSError, "simulated publish failure"):
                bundle.import_bundle_file(
                    archive_path,
                    self.capsules_dir,
                    replace_existing=True,
                )

        self.assertEqual(marker.read_text(encoding="utf-8"), "original")
        self.assertFalse((existing / "new.txt").exists())


if __name__ == "__main__":
    unittest.main()
