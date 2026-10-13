"""SQLite 一致快照与受控 Markdown；导入只写全新源码外目录。"""

import io
import json
import os
import shutil
import sqlite3
import stat
import tempfile
import zipfile
from pathlib import Path
from uuid import UUID

from sqlalchemy import select

from app.core.errors import ApiError
from app.core.model_config import ModelConfigStore
from app.core.settings import SOURCE_ROOT
from app.db.models import Base, Note, NoteDeletion, NoteWrite
from app.schemas.notes import NoteUpdate
from app.services.notes import document_prefix
from app.vault.topic_files import digest

MAX_ARCHIVE = 100 * 1024 * 1024
HEAD = "0004_second_brain"


class MemoryArchive:
    def __init__(self, settings, notes, config_store=None):
        self.settings, self.notes = settings, notes
        self.config_store = config_store or ModelConfigStore(settings)

    def export(self):
        initial = self.config_store.snapshot().config
        with self.notes.lock:
            self.notes.recover_startup()
            with self.notes.sessions() as session:
                if session.scalar(
                    select(NoteWrite.id).where(NoteWrite.status.in_(("pending", "conflict")))
                ) or session.scalar(
                    select(NoteDeletion.id).where(NoteDeletion.status == "pending")
                ):
                    raise ApiError(
                        409, "memory_export_conflict", "请先完成保存或处理文件冲突，再导出"
                    )
                ids = list(session.scalars(select(Note.id)))
            files = {}
            for identifier in ids:
                self.notes.get(identifier)  # 核对实际哈希，不导出目录宣称的未确认正文。
                files[f"notes/topics/{identifier}.md"] = self.notes.files.read(identifier)
            with tempfile.TemporaryDirectory(prefix="yihe-export-") as temporary:
                snapshot = Path(temporary) / "memory.sqlite"
                with self.notes.write_lock:
                    raw = self.notes.sessions.kw["bind"].raw_connection()
                    source = raw.driver_connection
                    try:
                        previous = source.autocommit
                        source.autocommit = True
                        with sqlite3.connect(snapshot, autocommit=True) as target:
                            source.backup(target)
                    finally:
                        source.autocommit = previous
                        raw.close()
                # 构建一份全新的紧凑数据库，避免原快照的空闲页带出已删除正文。
                compact = Path(temporary) / "export.sqlite"
                with sqlite3.connect(snapshot, autocommit=True) as target:
                    target.execute("VACUUM INTO ?", (str(compact),))
                files[".assistant/memory.sqlite"] = compact.read_bytes()
            if len(files) > 5000 or sum(len(data) for data in files.values()) > MAX_ARCHIVE:
                raise ApiError(
                    413, "memory_export_large", "记忆包超过本次支持的100MiB或文件数量上限"
                )
            current = self.config_store.snapshot().config
            keys = {config.api_key.encode("utf-8") for config in (initial, current) if config}
            if any(key in data for key in keys for data in files.values()):
                raise ApiError(
                    409,
                    "memory_export_secret",
                    "记忆内容中包含当前模型密钥，已阻止导出。请删除含密钥的记录，或吊销并更换该密钥。",
                )
            manifest = dict(
                format_version=1,
                database_version=HEAD,
                counts={"notes": len(ids), "files": len(files)},
                files={
                    name: {"sha256": digest(data), "size": len(data)}
                    for name, data in files.items()
                },
            )
            output = io.BytesIO()
            with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
                for name, data in files.items():
                    archive.writestr(name, data)
            return output.getvalue()

    def restore(self, data):
        if len(data) > MAX_ARCHIVE:
            raise ApiError(413, "memory_import_large", "记忆包最大100MiB")
        restored = None
        try:
            files = {}
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                entries = archive.infolist()
                if len(entries) > 5001 or sum(e.file_size for e in entries) > MAX_ARCHIVE:
                    raise ValueError("archive limit")
                for entry in entries:
                    name = entry.filename
                    kind = stat.S_IFMT(entry.external_attr >> 16)
                    parts = name.split("/")
                    if (
                        kind not in (0, stat.S_IFREG)
                        or "\\" in name
                        or any(p in ("", ".", "..") for p in parts)
                        or name in files
                        or "\0" in name
                        or name.startswith("/")
                        or ":" in name
                    ):
                        raise ValueError("unsafe entry")
                    if name not in ("manifest.json", ".assistant/memory.sqlite"):
                        if (
                            not name.startswith("notes/topics/")
                            or len(parts) != 3
                            or not name.endswith(".md")
                        ):
                            raise ValueError("unexpected entry")
                        identifier = name.removeprefix("notes/topics/").removesuffix(".md")
                        if str(UUID(identifier)) != identifier:
                            raise ValueError("invalid note id")
                    if entry.file_size > MAX_ARCHIVE or (
                        name == "manifest.json" and entry.file_size > 2 * 1024 * 1024
                    ):
                        raise ValueError("large file")
                    content = archive.read(entry)
                    if len(content) != entry.file_size:
                        raise ValueError("size mismatch")
                    files[name] = content
            manifest = json.loads(files.pop("manifest.json"))
            if (
                manifest.get("format_version") != 1
                or manifest.get("database_version") != HEAD
                or set(manifest["files"]) != set(files)
            ):
                raise ValueError("manifest mismatch")
            for name, content in files.items():
                if manifest["files"][name] != {"sha256": digest(content), "size": len(content)}:
                    raise ValueError("hash mismatch")
                if name.endswith(".md"):
                    content.decode("utf-8")
            with tempfile.TemporaryDirectory(prefix="yihe-import-check-") as temporary:
                database = Path(temporary) / "memory.sqlite"
                database.write_bytes(files[".assistant/memory.sqlite"])
                with sqlite3.connect(database, autocommit=True) as connection:
                    connection.execute("PRAGMA trusted_schema=OFF")
                    objects = connection.execute(
                        "SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
                    ).fetchall()
                    expected = set(Base.metadata.tables) | {"alembic_version"}
                    actual = {name for name, kind, _ in objects if kind == "table"}
                    if actual != expected or any(
                        kind not in ("table", "index") or (sql and "VIRTUAL TABLE" in sql.upper())
                        for _, kind, sql in objects
                    ):
                        raise ValueError("invalid schema")
                    for name, table in Base.metadata.tables.items():
                        columns = {
                            row[1] for row in connection.execute(f'PRAGMA table_info("{name}")')
                        }
                        if columns != set(table.columns.keys()):
                            raise ValueError("invalid columns")
                    if connection.execute("SELECT version_num FROM alembic_version").fetchall() != [
                        (HEAD,)
                    ]:
                        raise ValueError("unsupported migration")
                    if (
                        connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]
                        or connection.execute("PRAGMA foreign_key_check").fetchall()
                    ):
                        raise ValueError("invalid database")
                    notes = connection.execute(
                        "SELECT id,confirmed_hash,sync_status,version FROM notes"
                    ).fetchall()
                    expected_files = {".assistant/memory.sqlite"} | {
                        f"notes/topics/{n[0]}.md" for n in notes
                    }
                    if expected_files != set(files) or manifest["counts"] != {
                        "notes": len(notes),
                        "files": len(files),
                    }:
                        raise ValueError("note count mismatch")
                    if (
                        connection.execute(
                            "SELECT 1 FROM note_writes "
                            "WHERE status IN ('pending','conflict') LIMIT 1"
                        ).fetchone()
                        or connection.execute(
                            "SELECT 1 FROM note_deletions WHERE status='pending' LIMIT 1"
                        ).fetchone()
                    ):
                        raise ValueError("incomplete storage")
                    for identifier, file_hash, status, version in notes:
                        if (
                            status != "synced"
                            or digest(files[f"notes/topics/{identifier}.md"]) != file_hash
                        ):
                            raise ValueError("unconfirmed file")
                        record = connection.execute(
                            "SELECT file_hash FROM note_versions WHERE note_id=? AND version=?",
                            (identifier, version),
                        ).fetchone()
                        if not record or record[0] != file_hash:
                            raise ValueError("missing confirmed version")
                        connection.row_factory = sqlite3.Row
                        attributes = dict(
                            connection.execute(
                                "SELECT * FROM notes WHERE id=?", (identifier,)
                            ).fetchone()
                        )
                        registered = Note(**attributes)
                        tags = [
                            dict(id=row["id"], name=row["name"])
                            for row in connection.execute(
                                "SELECT tags.id,tags.name FROM tags "
                                "JOIN note_tags ON tags.id=note_tags.tag_id "
                                "WHERE note_tags.note_id=? ORDER BY tags.id",
                                (identifier,),
                            )
                        ]
                        text = files[f"notes/topics/{identifier}.md"].decode("utf-8")
                        prefix = document_prefix(registered, tags)
                        if not text.startswith(prefix):
                            raise ValueError("note metadata mismatch")
                        NoteUpdate(
                            expected_version=version,
                            title=registered.title,
                            body=text[len(prefix) :],
                            folder=registered.folder,
                            source=registered.source,
                        )
                        connection.row_factory = None
                    connection.execute(
                        "UPDATE messages SET status='interrupted' "
                        "WHERE status IN ('pending','running')"
                    )
                    connection.execute(
                        "UPDATE agent_runs SET status='interrupted',error_code='run_interrupted',"
                        "error_message='恢复包中的运行已中断' "
                        "WHERE status IN ('pending','running')"
                    )
                    connection.execute("UPDATE conversations SET active_run_id=NULL")
                    connection.execute(
                        "UPDATE memory_jobs SET status='interrupted',"
                        "reason='恢复后的任务需要明确重试' "
                        "WHERE status IN ('pending','running')"
                    )
                files[".assistant/memory.sqlite"] = database.read_bytes()
            # 校验使用临时目录，最终发布到记忆库旁的持久目录，权限0700。
            restore_root = self.settings.memory_dir.resolve().parent / "restored"
            if restore_root.is_symlink():
                raise ValueError("restore directory symlink")
            restore_root.mkdir(mode=0o700, exist_ok=True)
            restore_root = restore_root.resolve()
            protected = [
                SOURCE_ROOT,
                self.settings.memory_dir.resolve(),
                self.settings.model_config_path().parent.resolve(),
            ]
            if any(
                restore_root.is_relative_to(p) or p.is_relative_to(restore_root) for p in protected
            ):
                raise ValueError("restore boundary")
            restored = Path(tempfile.mkdtemp(prefix="yihe-", dir=restore_root))
            if restored.resolve().is_relative_to(SOURCE_ROOT):
                raise ValueError("restore directory boundary")
            self._publish(restored, files)
            return dict(
                memory_dir=str(restored),
                requires_restart=True,
                message="已恢复到独立目录，当前记忆库未切换。"
                "使用启动器 --memory-dir 指定此目录后重启。",
            )
        except (
            ValueError,
            KeyError,
            TypeError,
            OSError,
            sqlite3.Error,
            zipfile.BadZipFile,
            RuntimeError,
        ):
            if restored:
                shutil.rmtree(restored)
            raise ApiError(
                422, "memory_import_invalid", "记忆包校验失败：请检查格式、路径、哈希和数据库版本"
            ) from None

    @staticmethod
    def _publish(restored, files):
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        root = os.open(restored, flags)
        try:
            expected = os.fstat(root)
            for name, content in files.items():
                current = os.stat(restored, follow_symlinks=False)
                if (expected.st_dev, expected.st_ino) != (current.st_dev, current.st_ino):
                    raise ValueError("restore directory changed")
                handles = [os.dup(root)]
                try:
                    parts = name.split("/")
                    for part in parts[:-1]:
                        try:
                            os.mkdir(part, mode=0o700, dir_fd=handles[-1])
                            os.fsync(handles[-1])
                        except FileExistsError:
                            pass
                        handles.append(os.open(part, flags, dir_fd=handles[-1]))
                    descriptor = os.open(
                        parts[-1],
                        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                        0o600,
                        dir_fd=handles[-1],
                    )
                    with os.fdopen(descriptor, "wb") as file:
                        file.write(content)
                        file.flush()
                        os.fsync(file.fileno())
                    os.fsync(handles[-1])
                finally:
                    for handle in reversed(handles):
                        os.close(handle)
            current = os.stat(restored, follow_symlinks=False)
            if (expected.st_dev, expected.st_ino) != (current.st_dev, current.st_ino):
                raise ValueError("restore directory changed")
            os.fsync(root)
            parent = os.open(restored.parent, flags)
            try:
                os.fsync(parent)
            finally:
                os.close(parent)
        finally:
            os.close(root)
