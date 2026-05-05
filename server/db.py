"""精简的 SQLite 数据访问层，仅服务局域网胶囊场景。"""

from __future__ import annotations

import json
import logging
import sqlite3
import uuid as uuid_lib
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable

logger = logging.getLogger(__name__)

SCHEMA_PATH = Path(__file__).parent / "schema.sql"


class Database:
    def __init__(self, db_path: str | Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    @contextmanager
    def conn(self) -> Iterable[sqlite3.Connection]:
        c = sqlite3.connect(
            str(self.db_path),
            timeout=15.0,
            check_same_thread=False,
        )
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL;")
        c.execute("PRAGMA foreign_keys=ON;")
        try:
            yield c
            c.commit()
        finally:
            c.close()

    def _init_schema(self) -> None:
        sql = SCHEMA_PATH.read_text(encoding="utf-8")
        with self.conn() as c:
            c.executescript(sql)

    # ----- capsules -----
    def list_capsules(self, q: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
        sql = "SELECT * FROM capsules"
        args: list[Any] = []
        if q:
            sql += " WHERE name LIKE ? OR project_name LIKE ? OR keywords LIKE ?"
            like = f"%{q}%"
            args = [like, like, like]
        sql += " ORDER BY created_at DESC LIMIT ?"
        args.append(limit)
        with self.conn() as c:
            return [dict(r) for r in c.execute(sql, args)]

    def get_capsule(self, capsule_id: int) -> dict[str, Any] | None:
        with self.conn() as c:
            row = c.execute("SELECT * FROM capsules WHERE id = ?", (capsule_id,)).fetchone()
            return dict(row) if row else None

    def get_capsule_by_uuid(self, uuid: str) -> dict[str, Any] | None:
        with self.conn() as c:
            row = c.execute("SELECT * FROM capsules WHERE uuid = ?", (uuid,)).fetchone()
            return dict(row) if row else None

    def get_capsule_full(self, capsule_id: int) -> dict[str, Any] | None:
        cap = self.get_capsule(capsule_id)
        if not cap:
            return None
        with self.conn() as c:
            tags = [
                dict(r)
                for r in c.execute(
                    "SELECT lens, word_id, word_cn, word_en, x, y FROM capsule_tags WHERE capsule_id = ?",
                    (capsule_id,),
                )
            ]
            meta_row = c.execute(
                "SELECT bpm, duration, sample_rate, plugin_count, plugin_list, has_sends, has_folder_bus, tracks_included FROM capsule_metadata WHERE capsule_id = ?",
                (capsule_id,),
            ).fetchone()
            metadata = dict(meta_row) if meta_row else {}
            if metadata.get("plugin_list"):
                try:
                    metadata["plugin_list"] = json.loads(metadata["plugin_list"])
                except Exception:
                    pass
        cap["tags"] = tags
        cap["metadata"] = metadata
        return cap

    def insert_capsule(
        self,
        *,
        name: str,
        file_path: str,
        uuid: str | None = None,
        project_name: str | None = None,
        capsule_type: str = "reaper",
        preview_audio: str | None = None,
        rpp_file: str | None = None,
        keywords: str | None = None,
        description: str | None = None,
        source_peer: str | None = None,
        size_bytes: int = 0,
        tags: list[dict[str, Any]] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        cap_uuid = uuid or str(uuid_lib.uuid4())
        with self.conn() as c:
            cur = c.execute(
                """
                INSERT INTO capsules
                    (uuid, name, project_name, capsule_type, file_path,
                     preview_audio, rpp_file, keywords, description,
                     source_peer, size_bytes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    cap_uuid,
                    name,
                    project_name,
                    capsule_type,
                    file_path,
                    preview_audio,
                    rpp_file,
                    keywords,
                    description,
                    source_peer,
                    size_bytes,
                ),
            )
            cid = cur.lastrowid
            if tags:
                c.executemany(
                    "INSERT INTO capsule_tags(capsule_id, lens, word_id, word_cn, word_en, x, y) VALUES (?,?,?,?,?,?,?)",
                    [
                        (
                            cid,
                            t.get("lens", ""),
                            t.get("word_id"),
                            t.get("word_cn"),
                            t.get("word_en"),
                            t.get("x"),
                            t.get("y"),
                        )
                        for t in tags
                    ],
                )
            if metadata:
                pl = metadata.get("plugin_list")
                if isinstance(pl, list):
                    pl_str = json.dumps(pl, ensure_ascii=False)
                else:
                    pl_str = pl
                c.execute(
                    """
                    INSERT INTO capsule_metadata
                        (capsule_id, bpm, duration, sample_rate,
                         plugin_count, plugin_list, has_sends,
                         has_folder_bus, tracks_included)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        cid,
                        metadata.get("bpm"),
                        metadata.get("duration"),
                        metadata.get("sample_rate"),
                        metadata.get("plugin_count"),
                        pl_str,
                        int(bool(metadata.get("has_sends"))) if metadata.get("has_sends") is not None else None,
                        int(bool(metadata.get("has_folder_bus"))) if metadata.get("has_folder_bus") is not None else None,
                        metadata.get("tracks_included"),
                    ),
                )
        return self.get_capsule(cid)  # type: ignore[return-value]

    def delete_capsule(self, capsule_id: int) -> bool:
        with self.conn() as c:
            cur = c.execute("DELETE FROM capsules WHERE id = ?", (capsule_id,))
            return cur.rowcount > 0

    # ----- contacts -----
    def list_contacts(self) -> list[dict[str, Any]]:
        with self.conn() as c:
            return [dict(r) for r in c.execute("SELECT * FROM contacts ORDER BY name")]

    def upsert_contact(
        self, *, name: str, ip: str, port: int = 5005, note: str | None = None
    ) -> dict[str, Any]:
        with self.conn() as c:
            c.execute(
                """
                INSERT INTO contacts(name, ip, port, note) VALUES (?,?,?,?)
                ON CONFLICT(ip, port) DO UPDATE SET name=excluded.name, note=excluded.note
                """,
                (name, ip, port, note),
            )
            row = c.execute(
                "SELECT * FROM contacts WHERE ip = ? AND port = ?", (ip, port)
            ).fetchone()
            return dict(row)

    def delete_contact(self, contact_id: int) -> bool:
        with self.conn() as c:
            cur = c.execute("DELETE FROM contacts WHERE id = ?", (contact_id,))
            return cur.rowcount > 0

    def touch_contact(self, ip: str, port: int) -> None:
        with self.conn() as c:
            c.execute(
                "UPDATE contacts SET last_seen = CURRENT_TIMESTAMP WHERE ip = ? AND port = ?",
                (ip, port),
            )

    # ----- transfers -----
    def insert_transfer(self, **fields: Any) -> int:
        cols = ",".join(fields.keys())
        placeholders = ",".join("?" for _ in fields)
        with self.conn() as c:
            cur = c.execute(
                f"INSERT INTO transfers({cols}) VALUES ({placeholders})",
                tuple(fields.values()),
            )
            return cur.lastrowid

    def update_transfer(self, transfer_id: int, **fields: Any) -> None:
        if not fields:
            return
        sets = ", ".join(f"{k} = ?" for k in fields)
        args = list(fields.values()) + [transfer_id]
        with self.conn() as c:
            c.execute(f"UPDATE transfers SET {sets} WHERE id = ?", args)

    def list_transfers(self, limit: int = 50) -> list[dict[str, Any]]:
        with self.conn() as c:
            return [
                dict(r)
                for r in c.execute(
                    "SELECT * FROM transfers ORDER BY started_at DESC LIMIT ?", (limit,)
                )
            ]
