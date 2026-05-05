"""Sound Capsule LAN —— 本地 Flask 服务。

职责：
    1. 维护本地胶囊库（SQLite + 文件目录）
    2. 维护局域网联系人簿
    3. 接收来自其他局域网设备的胶囊（POST /api/p2p/import）
    4. 把本机胶囊发送给指定 IP/端口（POST /api/p2p/send）
    5. 暴露本机网络信息，便于在 UI 上显示给对方
"""

from __future__ import annotations

import io
import json
import logging
import os
import shutil
import time
import uuid as uuid_lib
from pathlib import Path

import requests
from flask import Flask, jsonify, request, send_file
from flask_cors import CORS

import sys

from bundle import build_bundle, extract_bundle
from db import Database
from net import network_info

# 引用仓库内 data-pipeline 中的 Reaper 导出模块
_DATA_PIPELINE = Path(__file__).resolve().parent.parent / "data-pipeline"
if _DATA_PIPELINE.exists():
    sys.path.insert(0, str(_DATA_PIPELINE))
    try:
        from common import PathManager
        PathManager.initialize(
            config_dir=str(_DATA_PIPELINE),
            export_dir=str(Path(__file__).resolve().parent / "data" / "capsules"),
            resource_dir=str(_DATA_PIPELINE),
        )
    except Exception as _pm_err:
        logging.getLogger("lan-capsule").warning("PathManager 初始化跳过: %s", _pm_err)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("lan-capsule")

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.getenv("LAN_CAPSULE_DATA_DIR", BASE_DIR / "data"))
CAPSULES_DIR = DATA_DIR / "capsules"
DB_PATH = DATA_DIR / "capsules.db"
CAPSULES_DIR.mkdir(parents=True, exist_ok=True)

PORT = int(os.getenv("LAN_CAPSULE_PORT", "5005"))
HOST = os.getenv("LAN_CAPSULE_HOST", "0.0.0.0")
SHARED_TOKEN = os.getenv("LAN_CAPSULE_SHARED_TOKEN", "").strip()

db = Database(DB_PATH)

app = Flask(__name__)
CORS(
    app,
    resources={r"/api/*": {"origins": os.getenv("LAN_CAPSULE_CORS", "*").split(",")}},
)


# ---------------------- 工具 ----------------------

def _err(msg: str, code: int = 400):
    return jsonify({"success": False, "error": msg}), code


def _ok(data=None, **kwargs):
    payload = {"success": True}
    if data is not None:
        payload["data"] = data
    payload.update(kwargs)
    return jsonify(payload)


def _check_shared_token() -> tuple[bool, str | None]:
    """若配置了共享密钥，校验请求头 X-Capsule-Token。"""
    if not SHARED_TOKEN:
        return True, None
    sent = request.headers.get("X-Capsule-Token", "")
    if sent != SHARED_TOKEN:
        return False, "shared token mismatch"
    return True, None


def _capsule_dir(uuid: str) -> Path:
    return CAPSULES_DIR / uuid


def _peer_label(ip: str, port: int) -> str:
    return f"{ip}:{port}"


# ---------------------- 健康检查 / 网络信息 ----------------------

@app.route("/api/health", methods=["GET"])
def health():
    return _ok({"status": "ok", "port": PORT})


@app.route("/api/network/info", methods=["GET"])
def get_network_info():
    info = network_info(PORT)
    info["shared_token_required"] = bool(SHARED_TOKEN)
    return _ok(info)


# ---------------------- 胶囊库 ----------------------

@app.route("/api/capsules", methods=["GET"])
def list_capsules():
    q = request.args.get("q")
    capsules = db.list_capsules(q=q)
    return _ok({"items": capsules, "count": len(capsules)})


@app.route("/api/capsules/<int:capsule_id>", methods=["GET"])
def get_capsule(capsule_id: int):
    cap = db.get_capsule_full(capsule_id)
    if not cap:
        return _err("胶囊不存在", 404)
    return _ok(cap)


@app.route("/api/capsules", methods=["POST"])
def create_capsule():
    """注册一个本地胶囊。

    支持两种用法：
    A) 上传 zip：multipart/form-data，字段 ``bundle``（zip 文件）+ 可选 ``meta``（JSON）
    B) 引用已有目录：JSON ``{ "name", "source_dir", "preview_audio?", "rpp_file?", ... }``
       —— ``source_dir`` 下所有文件会被复制到 data/capsules/<uuid>/
    """
    if "bundle" in request.files:
        f = request.files["bundle"]
        meta_extra = {}
        if "meta" in request.form:
            try:
                meta_extra = json.loads(request.form["meta"])
            except Exception:
                return _err("meta 字段不是合法 JSON", 400)
        try:
            manifest, final_dir, size_bytes = extract_bundle(f.stream, CAPSULES_DIR)
        except ValueError as e:
            return _err(str(e), 400)
        cap_meta = manifest.get("capsule") or {}
        cap_meta.update({k: v for k, v in meta_extra.items() if v is not None})
        cap = db.insert_capsule(
            uuid=cap_meta.get("uuid"),
            name=cap_meta.get("name") or final_dir.name,
            project_name=cap_meta.get("project_name"),
            capsule_type=cap_meta.get("capsule_type", "reaper"),
            file_path=str(final_dir.relative_to(DATA_DIR)),
            preview_audio=cap_meta.get("preview_audio"),
            rpp_file=cap_meta.get("rpp_file"),
            keywords=cap_meta.get("keywords"),
            description=cap_meta.get("description"),
            source_peer=None,
            size_bytes=size_bytes,
            tags=manifest.get("tags") or [],
            metadata=manifest.get("metadata") or {},
        )
        return _ok(cap, message="胶囊已导入"), 201

    payload = request.get_json(silent=True) or {}
    name = payload.get("name")
    source_dir = payload.get("source_dir")
    if not name or not source_dir:
        return _err("name 和 source_dir 必填", 400)
    src = Path(source_dir)
    if not src.exists() or not src.is_dir():
        return _err(f"源目录不存在: {source_dir}", 400)

    cap_uuid = payload.get("uuid") or str(uuid_lib.uuid4())
    target = _capsule_dir(cap_uuid)
    if target.exists():
        return _err("UUID 冲突，胶囊目录已存在", 409)
    shutil.copytree(src, target)
    size_bytes = sum(p.stat().st_size for p in target.rglob("*") if p.is_file())

    cap = db.insert_capsule(
        uuid=cap_uuid,
        name=name,
        project_name=payload.get("project_name"),
        capsule_type=payload.get("capsule_type", "reaper"),
        file_path=str(target.relative_to(DATA_DIR)),
        preview_audio=payload.get("preview_audio"),
        rpp_file=payload.get("rpp_file"),
        keywords=payload.get("keywords"),
        description=payload.get("description"),
        size_bytes=size_bytes,
        tags=payload.get("tags") or [],
        metadata=payload.get("metadata") or {},
    )
    return _ok(cap, message="胶囊已创建"), 201


@app.route("/api/capsules/<int:capsule_id>", methods=["DELETE"])
def delete_capsule(capsule_id: int):
    cap = db.get_capsule(capsule_id)
    if not cap:
        return _err("胶囊不存在", 404)
    if cap.get("file_path"):
        target = (DATA_DIR / cap["file_path"]).resolve()
        if target.exists() and CAPSULES_DIR.resolve() in target.parents:
            shutil.rmtree(target, ignore_errors=True)
    db.delete_capsule(capsule_id)
    return _ok({"id": capsule_id})


@app.route("/api/capsules/<int:capsule_id>/bundle", methods=["GET"])
def download_bundle(capsule_id: int):
    cap = db.get_capsule_full(capsule_id)
    if not cap:
        return _err("胶囊不存在", 404)
    capsule_root = (DATA_DIR / cap["file_path"]).resolve()
    if not capsule_root.exists():
        return _err("胶囊文件目录缺失", 410)
    blob = build_bundle(cap, capsule_root, sender=network_info(PORT))
    return send_file(
        io.BytesIO(blob),
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"{cap['uuid']}.capsule.zip",
    )


# ---------------------- Reaper 捕获 ----------------------

@app.route("/api/capsules/webui-export", methods=["OPTIONS", "POST"])
def webui_export():
    """通过 Reaper WebUI 捕获胶囊（复用 synesth/data-pipeline 导出模块）。"""
    if request.method == "OPTIONS":
        resp = jsonify({"status": "ok"})
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
        return resp

    try:
        from exporters.reaper_webui_export import quick_webui_export
    except ImportError as e:
        return _err(
            f"Reaper 导出模块不可用（请确认 synesth/data-pipeline 存在且依赖已安装）: {e}",
            501,
        )

    data = request.get_json(silent=True) or {}
    capsule_type = data.get("capsule_type", "magic")
    render_preview = data.get("render_preview", True)
    webui_port = int(data.get("webui_port", 9000))

    export_dir = data.get("export_dir") or str(CAPSULES_DIR)
    os.environ["SYNESTH_CAPSULE_OUTPUT"] = export_dir

    project_name = capsule_type
    theme_name = capsule_type
    username = data.get("username", "user")

    logger.info("Reaper webui-export: type=%s preview=%s dir=%s", capsule_type, render_preview, export_dir)

    result = quick_webui_export(
        project_name=project_name,
        theme_name=theme_name,
        render_preview=render_preview,
        webui_port=webui_port,
        capsule_type=capsule_type,
        export_dir=export_dir,
        username=username,
    )

    if not result.get("success"):
        return _err(result.get("error", "Reaper 导出失败"), 500)

    expected_name = result.get("capsule_name")
    capsule_dir_path = Path(export_dir) / expected_name if expected_name else None

    import time as _time
    waited = 0.0
    while capsule_dir_path and waited < 5:
        metadata_file = capsule_dir_path / "metadata.json"
        if metadata_file.exists():
            _time.sleep(0.3)
            break
        _time.sleep(0.3)
        waited += 0.3

    imported = None
    if capsule_dir_path and capsule_dir_path.exists():
        metadata_file = capsule_dir_path / "metadata.json"
        if metadata_file.exists():
            try:
                meta = json.loads(metadata_file.read_text("utf-8"))
            except Exception:
                meta = {}

            cap_uuid = meta.get("uuid") or meta.get("id") or str(uuid_lib.uuid4())
            name = meta.get("name") or expected_name or capsule_dir_path.name

            target = CAPSULES_DIR / cap_uuid
            if capsule_dir_path.resolve() != target.resolve():
                if target.exists():
                    shutil.rmtree(target)
                shutil.move(str(capsule_dir_path), str(target))
            size_bytes = sum(p.stat().st_size for p in target.rglob("*") if p.is_file())

            existing = db.get_capsule_by_uuid(cap_uuid)
            if existing:
                db.delete_capsule(existing["id"])

            tech = meta.get("info", {}) or {}
            plugins = meta.get("plugins", {}) or {}
            routing = meta.get("routing_info", {}) or {}

            imported = db.insert_capsule(
                uuid=cap_uuid,
                name=name,
                project_name=meta.get("project_name"),
                capsule_type=capsule_type,
                file_path=str(target.relative_to(DATA_DIR)),
                preview_audio=meta.get("preview_audio") or (meta.get("files") or {}).get("preview"),
                rpp_file=meta.get("rpp_file") or (meta.get("files") or {}).get("project"),
                keywords=meta.get("keywords"),
                description=meta.get("description"),
                size_bytes=size_bytes,
                metadata={
                    "bpm": tech.get("bpm"),
                    "duration": tech.get("length"),
                    "sample_rate": tech.get("sample_rate"),
                    "plugin_count": plugins.get("count"),
                    "plugin_list": plugins.get("list", []),
                    "has_sends": routing.get("has_sends"),
                    "has_folder_bus": routing.get("has_folder_bus"),
                    "tracks_included": routing.get("tracks_included"),
                },
            )

    resp_data = {
        "capsule_name": expected_name,
        "export_result": result,
    }
    if imported:
        resp_data["auto_imported"] = [imported]
        logger.info("Reaper 导出并入库: %s (id=%s)", imported.get("name"), imported.get("id"))
    else:
        resp_data["auto_imported"] = []
        logger.warning("Reaper 导出成功但未能自动入库: %s", expected_name)

    return _ok(resp_data, message="导出完成")


# ---------------------- 联系人 ----------------------

@app.route("/api/contacts", methods=["GET"])
def list_contacts():
    return _ok({"items": db.list_contacts()})


@app.route("/api/contacts", methods=["POST"])
def create_contact():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    ip = (data.get("ip") or "").strip()
    port = int(data.get("port") or 5005)
    note = data.get("note")
    if not name or not ip:
        return _err("name 和 ip 必填", 400)
    return _ok(db.upsert_contact(name=name, ip=ip, port=port, note=note)), 201


@app.route("/api/contacts/<int:contact_id>", methods=["DELETE"])
def delete_contact(contact_id: int):
    if not db.delete_contact(contact_id):
        return _err("联系人不存在", 404)
    return _ok({"id": contact_id})


@app.route("/api/contacts/ping", methods=["POST"])
def ping_contact():
    data = request.get_json(silent=True) or {}
    ip = data.get("ip")
    port = int(data.get("port") or 5005)
    if not ip:
        return _err("ip 必填", 400)
    started = time.time()
    try:
        r = requests.get(f"http://{ip}:{port}/api/health", timeout=2.0)
        ok = r.ok
        latency_ms = int((time.time() - started) * 1000)
        if ok:
            db.touch_contact(ip, port)
        return _ok({"online": ok, "latency_ms": latency_ms, "status": r.status_code})
    except Exception as e:
        return _ok({"online": False, "error": str(e)})


# ---------------------- 点对点收发 ----------------------

@app.route("/api/p2p/import", methods=["POST"])
def p2p_import():
    """接收对方发来的胶囊。"""
    ok, msg = _check_shared_token()
    if not ok:
        return _err(msg or "unauthorized", 401)

    if "bundle" not in request.files:
        return _err("缺少字段 bundle（zip 文件）", 400)

    f = request.files["bundle"]
    sender_ip = request.headers.get("X-Capsule-Peer-IP") or request.remote_addr or "unknown"
    sender_name = request.headers.get("X-Capsule-Peer-Name") or sender_ip
    peer_label = sender_name if sender_name == sender_ip else f"{sender_name} ({sender_ip})"

    transfer_id = db.insert_transfer(
        direction="receive",
        peer_ip=sender_ip,
        peer_name=sender_name,
        capsule_name=None,
        status="pending",
    )
    try:
        manifest, final_dir, size_bytes = extract_bundle(f.stream, CAPSULES_DIR)
    except ValueError as e:
        db.update_transfer(transfer_id, status="failed", error=str(e))
        return _err(str(e), 400)

    cap_meta = manifest.get("capsule") or {}
    # 若同 uuid 已存在记录，则替换
    existing = db.get_capsule_by_uuid(cap_meta.get("uuid", ""))
    if existing:
        db.delete_capsule(existing["id"])

    cap = db.insert_capsule(
        uuid=cap_meta.get("uuid"),
        name=cap_meta.get("name") or final_dir.name,
        project_name=cap_meta.get("project_name"),
        capsule_type=cap_meta.get("capsule_type", "reaper"),
        file_path=str(final_dir.relative_to(DATA_DIR)),
        preview_audio=cap_meta.get("preview_audio"),
        rpp_file=cap_meta.get("rpp_file"),
        keywords=cap_meta.get("keywords"),
        description=cap_meta.get("description"),
        source_peer=peer_label,
        size_bytes=size_bytes,
        tags=manifest.get("tags") or [],
        metadata=manifest.get("metadata") or {},
    )
    db.update_transfer(
        transfer_id,
        status="success",
        capsule_id=cap["id"],
        capsule_name=cap["name"],
        bytes_total=size_bytes,
        finished_at=_now_iso(),
    )
    logger.info("接收胶囊 %s 来自 %s (%d bytes)", cap["name"], peer_label, size_bytes)
    return _ok(cap, message="已接收并入库"), 201


@app.route("/api/p2p/send", methods=["POST"])
def p2p_send():
    """把本机胶囊发送给对方。"""
    data = request.get_json(silent=True) or {}
    capsule_id = data.get("capsule_id")
    target_ip = (data.get("target_ip") or "").strip()
    target_port = int(data.get("target_port") or 5005)
    target_name = data.get("target_name") or _peer_label(target_ip, target_port)
    if not capsule_id or not target_ip:
        return _err("capsule_id 与 target_ip 必填", 400)

    cap = db.get_capsule_full(int(capsule_id))
    if not cap:
        return _err("胶囊不存在", 404)
    capsule_root = (DATA_DIR / cap["file_path"]).resolve()
    if not capsule_root.exists():
        return _err("胶囊文件目录缺失", 410)

    self_info = network_info(PORT)
    blob = build_bundle(cap, capsule_root, sender=self_info)

    transfer_id = db.insert_transfer(
        direction="send",
        peer_ip=target_ip,
        peer_port=target_port,
        peer_name=target_name,
        capsule_id=cap["id"],
        capsule_name=cap["name"],
        status="pending",
        bytes_total=len(blob),
    )

    headers = {
        "X-Capsule-Peer-IP": self_info.get("ip", ""),
        "X-Capsule-Peer-Name": self_info.get("hostname", ""),
    }
    if SHARED_TOKEN:
        headers["X-Capsule-Token"] = SHARED_TOKEN

    files = {"bundle": (f"{cap['uuid']}.capsule.zip", io.BytesIO(blob), "application/zip")}

    try:
        resp = requests.post(
            f"http://{target_ip}:{target_port}/api/p2p/import",
            files=files,
            headers=headers,
            timeout=120,
        )
    except Exception as e:
        db.update_transfer(transfer_id, status="failed", error=str(e), finished_at=_now_iso())
        return _err(f"发送失败: {e}", 502)

    if not resp.ok:
        db.update_transfer(
            transfer_id,
            status="failed",
            error=f"HTTP {resp.status_code}: {resp.text[:200]}",
            finished_at=_now_iso(),
        )
        return _err(f"对方拒绝: HTTP {resp.status_code}", 502)

    db.update_transfer(transfer_id, status="success", finished_at=_now_iso())
    db.upsert_contact(name=target_name, ip=target_ip, port=target_port)
    return _ok(
        {
            "transfer_id": transfer_id,
            "bytes": len(blob),
            "remote": resp.json(),
        },
        message="已发送",
    )


@app.route("/api/transfers", methods=["GET"])
def list_transfers():
    return _ok({"items": db.list_transfers()})


# ---------------------- helpers ----------------------

def _now_iso() -> str:
    from datetime import datetime

    return datetime.utcnow().isoformat(timespec="seconds")


# ---------------------- 入口 ----------------------

if __name__ == "__main__":
    logger.info("Sound Capsule LAN 服务启动: %s:%d", HOST, PORT)
    logger.info("数据目录: %s", DATA_DIR)
    if SHARED_TOKEN:
        logger.info("已启用共享密钥（X-Capsule-Token）")
    app.run(host=HOST, port=PORT, debug=False, threaded=True)
