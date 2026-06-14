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

    def test_compatible_bridge_update_does_not_require_reconfiguration(self):
        status = {
            "webui_available": True,
            "bridge_available": True,
            "bridge_version": "1.0.7",
            "bridge_resource_path": "C:/REAPER",
            "bridge_instance_conflict": "stale diagnostic",
        }
        state, message = self.module._reaper_setup_state(
            status,
            "1.0.8",
            {"confirmed_reaper_resource_path": "C:/REAPER"},
        )
        self.assertEqual(state, "READY")
        self.assertIn("compatible", message)

    def test_old_bridge_requires_upgrade(self):
        status = {
            "webui_available": True,
            "bridge_available": True,
            "bridge_version": "1.0.5",
            "bridge_resource_path": "C:/REAPER",
        }
        state, _ = self.module._reaper_setup_state(
            status,
            "1.0.8",
            {"confirmed_reaper_resource_path": "C:/REAPER"},
        )
        self.assertEqual(state, "NEED_REPAIR")

    def test_missing_resource_path_keeps_confirmed_connection_ready(self):
        status = {
            "webui_available": True,
            "bridge_available": True,
            "bridge_version": "1.0.8",
            "bridge_resource_path": "",
        }
        state, _ = self.module._reaper_setup_state(
            status,
            "1.0.8",
            {"confirmed_reaper_resource_path": "C:/REAPER"},
        )
        self.assertEqual(state, "READY")

    def test_existing_capsule_metadata_returns_without_sleep(self):
        capsule_dir = Path(self.app_dir.name) / "metadata-ready"
        capsule_dir.mkdir()
        metadata_file = capsule_dir / "metadata.json"
        metadata_file.write_text("{}", encoding="utf-8")

        with mock.patch.object(self.module.time, "sleep") as sleep:
            result = self.module._wait_for_capsule_metadata(capsule_dir)

        self.assertEqual(result, metadata_file)
        sleep.assert_not_called()

    def test_reaper_ready_status_cache_is_short_lived_and_port_scoped(self):
        ready = {
            "setup_state": "READY",
            "selected_item_count": 3,
            "webui_port": 9000,
        }
        self.module._cache_reaper_ready_status(9000, ready)

        cached = self.module._get_cached_reaper_ready_status(9000)
        self.assertEqual(cached["selected_item_count"], 3)
        self.assertIsNone(self.module._get_cached_reaper_ready_status(8080))

        with self.module._reaper_ready_cache_lock:
            self.module._reaper_ready_cache["created_at"] = (
                time.perf_counter()
                - self.module._REAPER_READY_CACHE_SECONDS
                - 0.1
            )
        self.assertIsNone(self.module._get_cached_reaper_ready_status(9000))

    def test_reaper_status_builder_reuses_recent_ready_result(self):
        cached = {
            "setup_state": "READY",
            "selected_item_count": 2,
            "webui_port": 9000,
        }
        with mock.patch.object(
            self.module,
            "_get_cached_reaper_ready_status",
            return_value=cached,
        ):
            result = self.module._build_reaper_bridge_status(
                9000,
                allow_cached_ready=True,
            )

        self.assertTrue(result["preflight_cached"])
        self.assertEqual(result["selected_item_count"], 2)

    def test_windows_capture_script_uses_lightweight_render_state(self):
        script_path = (
            SERVER_DIR.parent
            / "data-pipeline"
            / "lua_scripts"
            / "main_export2_windows.lua"
        )
        source = script_path.read_text(encoding="utf-8")

        self.assertNotIn("GetTrackStateChunk", source)
        self.assertNotIn("SetTrackStateChunk", source)
        self.assertNotIn("SetMediaItemSelected", source)
        self.assertIn('SetProjectNumericInfo("RENDER_CHANNELS", 2)', source)
        self.assertNotIn("RENDER_CHANNELS 2\nRENDER_1X", source)
        self.assertIn("local progressByteInterval = 16 * 1024 * 1024", source)
        self.assertIn('local waitMode = "skipped_output_ready"', source)
        self.assertNotIn('timing = "before_inline_render_setup"', source)
        self.assertIn('timing = "immediately_before_42230"', source)

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

    def test_capture_progress_status_uses_lightweight_extstate_reads(self):
        from exporters import reaper_bridge_client

        def read_extstate(_client, key, timeout=None, attempts=3):
            self.assertEqual(attempts, 1)
            if key == "export_phase":
                return "saving capsule: copying media"
            if key == "capture_progress":
                return '{"phase":"copying_media","current":2,"total":4}'
            raise AssertionError(f"unexpected EXTSTATE key: {key}")

        client = self.module.app.test_client()
        with mock.patch.object(
            reaper_bridge_client.ReaperBridgeClient,
            "get_extstate",
            autospec=True,
            side_effect=read_extstate,
        ):
            response = client.get("/api/reaper/bridge/status?capture=1")

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        data = response.get_json()["data"]
        self.assertEqual(data["export_phase"], "saving capsule: copying media")
        self.assertEqual(data["capture_progress"]["current"], 2)
        self.assertFalse(data["temporarily_unavailable"])

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
