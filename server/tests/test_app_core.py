from __future__ import annotations

import importlib
import hashlib
import logging
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))
DATA_PIPELINE_DIR = SERVER_DIR.parent / "data-pipeline"
if str(DATA_PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(DATA_PIPELINE_DIR))

import bundle


class AppCoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app_dir = tempfile.TemporaryDirectory()
        cls.previous_app_dir = os.environ.get("CAPSULE_TRANSFER_APP_DIR")
        os.environ["CAPSULE_TRANSFER_APP_DIR"] = cls.app_dir.name
        sys.modules.pop("app", None)
        cls.module = importlib.import_module("app")

    @classmethod
    def tearDownClass(cls):
        sys.modules.pop("app", None)
        app_root = Path(cls.app_dir.name).resolve()
        for handler in list(logging.getLogger().handlers):
            filename = getattr(handler, "baseFilename", None)
            if filename and app_root in Path(filename).resolve().parents:
                logging.getLogger().removeHandler(handler)
                handler.close()
        if cls.previous_app_dir is None:
            os.environ.pop("CAPSULE_TRANSFER_APP_DIR", None)
        else:
            os.environ["CAPSULE_TRANSFER_APP_DIR"] = cls.previous_app_dir
        cls.app_dir.cleanup()

    def test_plugin_matching_accepts_normalized_and_tokenized_names(self):
        installed = {
            self.module._normalize_plugin_name("FabFilter Pro-Q 3 (VST3)"),
            self.module._normalize_plugin_name("Valhalla VintageVerb"),
        }
        self.assertTrue(
            self.module._plugin_available("VST3: FabFilter Pro-Q 3", installed)
        )
        self.assertTrue(
            self.module._plugin_available("ValhallaVintageVerb", installed)
        )
        self.assertFalse(self.module._plugin_available("Missing Synth", installed))

    def test_cockos_builtin_is_available_without_plugin_inventory(self):
        with mock.patch.object(
            self.module,
            "_load_plugin_inventory",
            return_value={"available": False, "plugin_names": set(), "count": 0},
        ):
            status = self.module._capsule_plugin_status(
                ["ReaLimit (Cockos)", "Third Party Synth"]
            )
        self.assertEqual(status["available"], 1)
        self.assertEqual(status["unknown"], 1)
        self.assertIn("ReaLimit (Cockos)", status["present_plugins"])

    def test_peer_signature_rejects_modified_payload(self):
        signed = self.module._sign_peer_payload(
            "p2p_request",
            {"capsule_id": "one", "size_bytes": 10},
        )
        ok, _ = self.module._verify_peer_payload(
            signed["public_key"],
            "p2p_request",
            signed["nonce"],
            signed["timestamp"],
            signed["signature"],
            {"capsule_id": "two", "size_bytes": 10},
        )
        self.assertFalse(ok)

    def test_peer_signature_rejects_expired_timestamp(self):
        signed = self.module._sign_peer_payload("p2p_request", {})
        expired = str(int(time.time()) - 3600)
        ok, message = self.module._verify_peer_payload(
            signed["public_key"],
            "p2p_request",
            signed["nonce"],
            expired,
            signed["signature"],
            {},
        )
        self.assertFalse(ok)
        self.assertIn("expired", message)

    def _create_send_capsule(self, capsule_id: str) -> Path:
        capsule_dir = self.module.CAPSULES_DIR / capsule_id
        capsule_dir.mkdir()
        (capsule_dir / "clip.wav").write_bytes(b"simulated-audio")
        self.module._write_manifest(
            capsule_dir,
            {
                "schema_version": 1,
                "capsule": {
                    "uuid": capsule_id,
                    "name": f"Send {capsule_id}",
                    "capsule_type": "reaper",
                },
                "metadata": {},
                "tags": [],
            },
        )
        self.addCleanup(lambda: shutil.rmtree(capsule_dir, ignore_errors=True))
        return capsule_dir

    @staticmethod
    def _fake_response(status_code: int, payload: dict):
        return SimpleNamespace(
            status_code=status_code,
            ok=200 <= status_code < 300,
            json=lambda: payload,
        )

    def test_p2p_send_simulation_auto_accepts_and_streams_bundle(self):
        capsule_id = "send-success"
        self._create_send_capsule(capsule_id)
        events = []
        uploaded = {}

        def fake_post(url, **kwargs):
            if url.endswith("/api/p2p/request"):
                return self._fake_response(
                    200,
                    {"success": True, "data": {"accept_token": "accepted-token"}},
                )
            self.assertTrue(url.endswith("/api/p2p/import"))
            stream = kwargs["data"]
            chunks = []
            while True:
                chunk = stream.read(1024)
                if not chunk:
                    break
                chunks.append(chunk)
            uploaded["body"] = b"".join(chunks)
            uploaded["headers"] = kwargs["headers"]
            return self._fake_response(201, {"success": True, "data": {"id": capsule_id}})

        client = self.module.app.test_client()
        with (
            mock.patch.object(
                self.module,
                "_resolve_target_peer",
                return_value=(None, ("127.0.0.2", 5005, "Simulated Receiver"), None),
            ),
            mock.patch.object(self.module.requests, "post", side_effect=fake_post),
            mock.patch.object(self.module, "_notify_sse", side_effect=events.append),
        ):
            response = client.post(
                "/api/p2p/send",
                json={"capsule_id": capsule_id, "target_ip": "127.0.0.2", "task_id": "sim-send"},
            )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        body = response.get_json()["data"]
        self.assertEqual(body["bytes"], len(uploaded["body"]))
        self.assertEqual(
            uploaded["headers"]["X-Capsule-Bundle-SHA256"],
            hashlib.sha256(uploaded["body"]).hexdigest(),
        )
        phases = [event.get("phase") for event in events if event.get("type") == "transfer_progress"]
        self.assertIn("transferring", phases)
        self.assertEqual(phases[-1], "completed")

    def test_p2p_send_simulation_handles_rejection(self):
        capsule_id = "send-rejected"
        self._create_send_capsule(capsule_id)
        request_response = self._fake_response(
            202,
            {"success": True, "data": {"request_id": "pending-one"}},
        )
        rejected_response = self._fake_response(
            200,
            {"success": True, "data": {"status": "rejected"}},
        )
        client = self.module.app.test_client()
        with (
            mock.patch.object(
                self.module,
                "_resolve_target_peer",
                return_value=(None, ("127.0.0.2", 5005, "Simulated Receiver"), None),
            ),
            mock.patch.object(self.module.requests, "post", return_value=request_response),
            mock.patch.object(self.module.requests, "get", return_value=rejected_response),
            mock.patch.object(self.module.time, "sleep"),
        ):
            response = client.post(
                "/api/p2p/send",
                json={"capsule_id": capsule_id, "target_ip": "127.0.0.2"},
            )
        self.assertEqual(response.status_code, 403)
        self.assertIn("拒绝", response.get_json()["error"])

    def test_p2p_send_simulation_handles_confirmation_timeout(self):
        capsule_id = "send-timeout"
        self._create_send_capsule(capsule_id)
        request_response = self._fake_response(
            202,
            {"success": True, "data": {"request_id": "pending-timeout"}},
        )
        client = self.module.app.test_client()
        with (
            mock.patch.object(
                self.module,
                "_resolve_target_peer",
                return_value=(None, ("127.0.0.2", 5005, "Simulated Receiver"), None),
            ),
            mock.patch.object(self.module.requests, "post", return_value=request_response),
            mock.patch.object(self.module, "_PENDING_TIMEOUT", 0),
        ):
            response = client.post(
                "/api/p2p/send",
                json={"capsule_id": capsule_id, "target_ip": "127.0.0.2"},
            )
        self.assertEqual(response.status_code, 408)
        self.assertIn("超时", response.get_json()["error"])

    def test_p2p_send_simulation_handles_upload_disconnect(self):
        capsule_id = "send-disconnect"
        self._create_send_capsule(capsule_id)
        events = []
        disconnect_error = OSError("simulated receiver disconnect")
        responses = [
            self._fake_response(
                200,
                {"success": True, "data": {"accept_token": "accepted-token"}},
            ),
            disconnect_error,
        ]
        client = self.module.app.test_client()
        with (
            mock.patch.object(
                self.module,
                "_resolve_target_peer",
                return_value=(None, ("127.0.0.2", 5005, "Simulated Receiver"), None),
            ),
            mock.patch.object(self.module.requests, "post", side_effect=responses),
            mock.patch.object(self.module, "_notify_sse", side_effect=events.append),
        ):
            response = client.post(
                "/api/p2p/send",
                json={"capsule_id": capsule_id, "target_ip": "127.0.0.2"},
            )
        self.assertEqual(str(disconnect_error), "simulated receiver disconnect")
        self.assertEqual(response.status_code, 502)
        self.assertEqual(
            [event for event in events if event.get("phase") == "error"][-1]["error"],
            "simulated receiver disconnect",
        )

    def test_p2p_request_simulation_rejects_insufficient_disk(self):
        client = self.module.app.test_client()
        previous_mode = self.module._receive_mode
        self.module._receive_mode = "auto"
        try:
            with mock.patch.object(self.module, "_receive_has_disk_space", return_value=False):
                response = client.post(
                    "/api/p2p/request",
                    json={"capsule_name": "Large", "size_bytes": 1024},
                )
            self.assertEqual(response.status_code, 400)
            self.assertIn("磁盘空间不足", response.get_json()["error"])
        finally:
            self.module._receive_mode = previous_mode

    def test_p2p_import_accepts_raw_zip_and_rejects_uuid_conflict(self):
        source = Path(self.app_dir.name) / "fixture"
        source.mkdir()
        (source / "clip.wav").write_bytes(b"audio")
        archive = Path(self.app_dir.name) / "fixture.zip"
        bundle.build_bundle_file(
            {"uuid": "route-test", "name": "Route test"},
            source,
            archive,
        )
        payload = archive.read_bytes()
        previous_mode = self.module._receive_mode
        self.module._receive_mode = "auto"
        events = []
        try:
            client = self.module.app.test_client()
            with mock.patch.object(self.module, "_notify_sse", side_effect=events.append):
                response = client.post(
                    "/api/p2p/import",
                    data=payload,
                    content_type="application/zip",
                    headers={
                        "X-Capsule-Task-ID": "route-task",
                        "X-Capsule-Name": "Route test",
                        "X-Capsule-Peer-Name": "Studio PC",
                    },
                )
            self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
            self.assertTrue(
                (self.module.CAPSULES_DIR / "route-test" / "clip.wav").is_file()
            )

            conflict = client.post(
                "/api/p2p/import",
                data=payload,
                content_type="application/zip",
            )
            self.assertEqual(conflict.status_code, 409)
            self.assertEqual(
                (self.module.CAPSULES_DIR / "route-test" / "clip.wav").read_bytes(),
                b"audio",
            )
            progress_events = [item for item in events if item.get("type") == "transfer_progress"]
            self.assertTrue(progress_events)
            self.assertEqual(progress_events[-1]["task_id"], "route-task")
            self.assertEqual(progress_events[-1]["capsule_name"], "Route test")
            self.assertEqual(progress_events[-1]["peer_name"], "Studio PC")
            self.assertEqual(progress_events[-1]["phase"], "completed")
        finally:
            self.module._receive_mode = previous_mode

    def test_bridge_status_serializes_capture_progress(self):
        from exporters.reaper_bridge_client import BridgeStatus

        status = BridgeStatus(
            webui_available=True,
            bridge_available=True,
            capture_progress={
                "phase": "copying_media",
                "current_file": "kick.wav",
                "current": 2,
                "total": 4,
                "bytes_done": 50,
                "bytes_total": 100,
            },
        )
        self.assertEqual(status.as_dict()["capture_progress"]["bytes_done"], 50)

    def test_import_finalize_failure_rolls_back_published_directory(self):
        source = Path(self.app_dir.name) / "rollback-fixture"
        source.mkdir()
        (source / "clip.wav").write_bytes(b"audio")
        archive = Path(self.app_dir.name) / "rollback-fixture.zip"
        bundle.build_bundle_file(
            {"uuid": "rollback-test", "name": "Rollback test"},
            source,
            archive,
        )
        previous_mode = self.module._receive_mode
        self.module._receive_mode = "auto"
        try:
            client = self.module.app.test_client()
            with mock.patch.object(
                self.module,
                "_write_manifest",
                side_effect=OSError("simulated manifest failure"),
            ):
                response = client.post(
                    "/api/p2p/import",
                    data=archive.read_bytes(),
                    content_type="application/zip",
                )
            self.assertEqual(response.status_code, 500)
            self.assertFalse((self.module.CAPSULES_DIR / "rollback-test").exists())
        finally:
            self.module._receive_mode = previous_mode


if __name__ == "__main__":
    unittest.main()
