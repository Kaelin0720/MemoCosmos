"""单进程笔记协调：短数据库事务、受控文件发布、有界恢复。"""

from __future__ import annotations

import json
from contextlib import contextmanager
from threading import RLock
from uuid import UUID, uuid4

from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.core.errors import ApiError
from app.core.settings import Settings
from app.db.models import (
    DeletedOperation,
    MemoryJob,
    MemoryJobItem,
    MemoryRelation,
    MemorySetting,
    Note,
    NoteDeletion,
    NoteSection,
    NoteTag,
    NoteVersion,
    NoteWrite,
    Tag,
    TagAlias,
)
from app.schemas.notes import NoteCreate, NoteDetail, NoteList, NoteSummary, NoteUpdate
from app.schemas.tags import TagUpdate
from app.services.knowledge import record_confirmation
from app.services.tags import utc_timestamp
from app.vault.topic_files import FileIssue, TopicFiles, digest


def tag_views(tags) -> list[dict[str, str]]:
    result = []
    for tag in tags:
        try:
            if not isinstance(tag.name, str) or "\0" in tag.name:
                raise ValueError("invalid tag")
            tag.name.encode("utf-8")
        except (ValueError, UnicodeError):
            raise FileIssue("note_file_invalid", "关联标签文本无效，请先修正标签") from None
        result.append({"id": tag.id, "name": tag.name})
    return result


def tags_for(session: Session, note_id: str) -> list[dict[str, str]]:
    tags = session.scalars(
        select(Tag)
        .join(NoteTag, NoteTag.tag_id == Tag.id)
        .where(NoteTag.note_id == note_id)
        .order_by(Tag.id)
    )
    return tag_views(tags)


def frontmatter_value(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False)
    # YAML 不接受这些未转义控制符/行分隔符；其余中文保留可读文本。
    return "".join(
        f"\\u{ord(char):04x}" if 0x7F <= ord(char) <= 0x9F or char in ("\u2028", "\u2029") else char
        for char in encoded
    )


def document_prefix(note: Note, tags: list[dict[str, str]]) -> str:
    fields = {
        "id": note.id,
        "created_at": note.created_at,
        "updated_at": note.updated_at,
        "version": note.version,
        "tag_ids": [tag["id"] for tag in tags],
        "tags": [tag["name"] for tag in tags],
    }
    if note.source:
        fields["source"] = note.source
    if note.folder:
        fields["folder"] = note.folder
    lines = [f"{key}: {frontmatter_value(value)}" for key, value in fields.items()]
    return "---\n" + "\n".join(lines) + "\n---\n# " + note.title + "\n\n"


def document_bytes(note: Note, tags: list[dict[str, str]], body: str) -> bytes:
    return (document_prefix(note, tags) + body).encode("utf-8")


def body_from(data: bytes, note: Note, tags: list[dict[str, str]]) -> str:
    text = data.decode("utf-8")
    prefix = document_prefix(note, tags)
    if not text.startswith(prefix):
        raise FileIssue("external_note_changed", "文档元数据与目录不一致")
    return text[len(prefix) :]


def summary(note: Note, tags: list[dict[str, str]]) -> NoteSummary:
    error = None
    if note.sync_error_code:
        error = {
            "code": note.sync_error_code,
            "message": note.sync_error_message,
            "retryable": note.sync_retryable,
        }
    return NoteSummary(
        id=note.id,
        title=note.title,
        tags=tags,
        source=note.source,
        folder=note.folder,
        created_at=note.created_at,
        updated_at=note.updated_at,
        version=note.version,
        sync_status=note.sync_status,
        sync_error=error,
    )


class NoteService:
    def __init__(self, settings: Settings, sessions: sessionmaker):
        self.sessions = sessions
        self.files = TopicFiles(settings)
        # 笔记/文件业务串行；此锁不提供给聊天运行管理器。
        self.lock = RLock()
        self.write_lock = RLock()

    @contextmanager
    def _writing(self):
        with self.write_lock, self.sessions() as session:
            # 首条 DML 取得 SQLite 写锁，避免校验读之后被聊天写入推进 WAL 快照。
            # 没有匹配行，不改变业务数据；不在已启动事务内嵌套 BEGIN IMMEDIATE。
            session.execute(update(Note).where(Note.id == "").values(version=Note.version))
            yield session

    def recover_startup(self, limit: int = 100) -> None:
        with self.sessions() as session:
            deleting = list(
                session.scalars(
                    select(NoteDeletion.id).where(NoteDeletion.status == "pending").limit(limit)
                )
            )
        for note_id in deleting:
            try:
                with self.lock:
                    self._finish_delete(note_id)
            except ApiError:
                pass
        with self.lock, self.sessions() as session:
            ids = list(
                session.scalars(
                    select(NoteWrite.note_id)
                    .where(NoteWrite.status == "pending")
                    .order_by(NoteWrite.created_at, NoteWrite.id)
                    .limit(limit)
                )
            )
        for note_id in ids:
            with self.lock:
                self._recover(note_id)

    def list(self, q=None, tag_id=None, folder=None) -> NoteList:
        with self.lock, self.sessions() as session:
            statement = select(Note).where(~Note.id.in_(select(NoteDeletion.id)))
            if q:
                from sqlalchemy import func

                statement = statement.where(
                    func.instr(Note.normalized_title, q.strip().casefold()) > 0
                )
            if tag_id:
                statement = statement.where(
                    Note.id.in_(select(NoteTag.note_id).where(NoteTag.tag_id == tag_id))
                )
            if folder is not None:
                statement = statement.where(Note.folder == folder)
            notes = list(session.scalars(statement.order_by(Note.updated_at.desc(), Note.id)))
            try:
                items = [summary(note, tags_for(session, note.id)) for note in notes]
            except FileIssue:
                raise ApiError(503, "note_storage_unavailable", "关联标签元数据需要核对") from None
            return NoteList(items=items, total=len(items))

    @staticmethod
    def canonical_id(value: str) -> str:
        try:
            return str(UUID(value))
        except ValueError:
            raise ApiError(404, "note_not_found", "文档不存在") from None

    @staticmethod
    def _active(session: Session, note_id: str) -> NoteWrite | None:
        return session.scalar(
            select(NoteWrite).where(
                NoteWrite.note_id == note_id, NoteWrite.status.in_(("pending", "conflict"))
            )
        )

    @staticmethod
    def _creation_tags(session: Session, payload: NoteCreate):
        existing = session.scalar(
            select(Note).where(Note.normalized_title == payload.title.casefold())
        )
        if existing:
            raise ApiError(409, "note_title_exists", "同标题文档已存在", note_id=existing.id)
        try:
            tag_ids = [str(UUID(value)) for value in payload.tag_ids]
        except ValueError:
            raise ApiError(422, "invalid_tag_ids", "请选择已有且不重复的标签") from None
        tags = list(session.scalars(select(Tag).where(Tag.id.in_(tag_ids)).order_by(Tag.id)))
        if len(set(tag_ids)) != len(tag_ids) or len(tags) != len(tag_ids):
            raise ApiError(422, "invalid_tag_ids", "请选择已有且不重复的标签")
        try:
            return tags, tag_views(tags)
        except FileIssue:
            raise ApiError(422, "invalid_tag_ids", "关联标签文本无效，请先修正标签") from None

    def create(self, payload: NoteCreate, *, origin="manual", operation_key=None) -> NoteDetail:
        with self.lock:
            if operation_key:
                existing = self.operation_result(operation_key)
                if existing:
                    return existing
            with self.sessions() as session:
                self._creation_tags(session, payload)
            note_id = str(uuid4())
            try:
                self.files.prepare()
                self.files.ensure_absent(note_id)
            except FileIssue:
                raise ApiError(503, "note_storage_unavailable", "文档存储暂不可用") from None
            with self._writing() as session:
                # 路径预检之后，在真正的短写事务里重新核验目录占用和标签。
                tags, tag_view = self._creation_tags(session, payload)
                timestamp = utc_timestamp()
                note = Note(
                    id=note_id,
                    title=payload.title,
                    normalized_title=payload.title.casefold(),
                    source=payload.source,
                    folder=payload.folder,
                    created_at=timestamp,
                    updated_at=timestamp,
                    version=1,
                    sync_status="pending",
                    sync_retryable=False,
                )
                session.add(note)
                session.flush()
                session.add_all(NoteTag(note_id=note.id, tag_id=tag.id) for tag in tags)
                operation = self._intent(
                    session, note, tag_view, payload.body, "create", origin, operation_key
                )
                session.commit()  # 先持久化；此时尚不能宣称 Markdown 已保存。
                note_id, operation_id = note.id, operation.id
            self._recover(note_id)
            with self.sessions() as session:
                note = session.get(Note, note_id)
                if note.sync_status != "synced":
                    raise ApiError(
                        503,
                        "note_write_failed",
                        "文档尚未完成保存，请保留输入内容",
                        note_id=note_id,
                        operation_id=operation_id,
                        sync_status=note.sync_status,
                        retryable=note.sync_retryable,
                    )
            return self._detail(note_id)

    @staticmethod
    def _intent(
        session: Session,
        note: Note,
        tags: list[dict[str, str]],
        body: str,
        kind: str,
        origin="manual",
        operation_key=None,
    ) -> NoteWrite:
        data = document_bytes(note, tags, body)
        operation = NoteWrite(
            id=str(uuid4()),
            note_id=note.id,
            kind=kind,
            base_hash=note.confirmed_hash,
            target_hash=digest(data),
            target_bytes=data,
            target_tags=json.dumps(tags, ensure_ascii=True),
            target_version=note.version,
            status="pending",
            created_at=note.updated_at,
            origin=origin,
            operation_key=operation_key,
        )
        session.add(operation)
        return operation

    def _record_issue(self, note_id: str, issue: FileIssue) -> None:
        with self._writing() as session:
            note = session.get(Note, note_id)
            if note is None:
                return
            note.sync_status = "pending" if issue.retryable else "conflict"
            note.sync_error_code, note.sync_error_message = issue.code, issue.message
            note.sync_retryable = issue.retryable
            operation = self._active(session, note_id)
            if operation and not issue.retryable:
                operation.status = "conflict"
            session.commit()

    @staticmethod
    def _verify_operation(session: Session, note: Note, operation: NoteWrite) -> None:
        if (
            note.version != operation.target_version
            or note.confirmed_hash != operation.base_hash
            or operation.target_tags != json.dumps(tags_for(session, note.id), ensure_ascii=True)
            or digest(operation.target_bytes) != operation.target_hash
        ):
            raise FileIssue("external_note_changed", "文档状态已改变，写入已停止")

    def _recover(self, note_id: str) -> None:
        try:
            with self.sessions() as session:
                if session.get(NoteDeletion, note_id):
                    return
                note = session.get(Note, note_id)
                if note is None:
                    return
                operation = self._active(session, note_id)
                if operation is None or operation.status != "pending":
                    return
                self._verify_operation(session, note, operation)
                operation_id = operation.id
                data, base_hash = operation.target_bytes, operation.base_hash
            self.files.publish(note_id, operation_id, data, base_hash)
            self._confirm(note_id, operation_id)
        except FileIssue as issue:
            self._record_issue(note_id, issue)
        except OSError:
            self._record_issue(note_id, FileIssue("note_write_failed", "文档写入暂未完成", True))

    def _confirm(self, note_id: str, operation_id: str) -> None:
        # 文件读取/哈希不占共享写锁；业务锁仍禁止本进程叠加笔记操作。
        actual = self.files.read(note_id)
        actual_hash = digest(actual) if actual is not None else None
        with self._writing() as session:
            note = session.get(Note, note_id)
            operation = session.get(NoteWrite, operation_id)
            if operation is None or operation.status != "pending":
                raise FileIssue("external_note_changed", "文档状态已改变，写入已停止")
            self._verify_operation(session, note, operation)
            if actual_hash != operation.target_hash:
                raise FileIssue("external_note_changed", "文档文件已在应用外发生变化")
            note.confirmed_hash = operation.target_hash
            note.sync_status, note.sync_error_code, note.sync_error_message = "synced", None, None
            note.sync_retryable = False
            operation.status = "completed"
            record_confirmation(
                session,
                note,
                body_from(actual, note, tags_for(session, note_id)),
                tags_for(session, note_id),
                operation.origin,
            )
            session.commit()

    def get(self, note_id: str) -> NoteDetail:
        with self.lock:
            return self._detail(self.canonical_id(note_id))

    def _detail(self, note_id: str) -> NoteDetail:
        self._recover(note_id)
        with self.sessions() as session:
            if session.get(NoteDeletion, note_id):
                raise ApiError(404, "note_not_found", "文档已删除")
            note = session.get(Note, note_id)
            if note is None:
                raise ApiError(404, "note_not_found", "文档不存在")
            operation = self._active(session, note_id)
            if operation and note.sync_status == "pending":
                raise ApiError(
                    409,
                    "note_sync_pending",
                    "文档尚未完成同步，请保留输入内容",
                    note_id=note_id,
                    operation_id=operation.id,
                    sync_status="pending",
                    retryable=True,
                )
            try:
                tags = tags_for(session, note_id)
                data = self.files.read(note_id)
                if data is None:
                    raise FileIssue("note_file_missing", "已登记的文档文件不存在")
                if digest(data) != note.confirmed_hash:
                    raise FileIssue("external_note_changed", "文档文件已在应用外发生变化")
                if note.sync_status == "conflict":
                    raise FileIssue(
                        note.sync_error_code or "external_note_changed",
                        note.sync_error_message or "文档需要人工核对",
                    )
                body = body_from(data, note, tags)
            except FileIssue as issue:
                session.rollback()
                self._record_issue(note_id, issue)
                raise ApiError(
                    503 if issue.retryable else 409,
                    issue.code,
                    issue.message,
                    note_id=note_id,
                    sync_status="pending" if issue.retryable else "conflict",
                    retryable=issue.retryable,
                ) from None
            if (
                session.get(NoteVersion, (note.id, note.version)) is None
                or session.scalar(
                    select(NoteSection.note_id)
                    .where(NoteSection.note_id == note.id, NoteSection.version == note.version)
                    .limit(1)
                )
                is None
            ):
                with self._writing() as writer:
                    current = writer.get(Note, note_id)
                    self._historical_versions(writer, note_id)
                    record_confirmation(writer, current, body, tags, "legacy")
                    writer.commit()
            if note.sync_status == "pending":  # 暂时不可读、但没有写入意图的情况。
                # 用新写事务确认，避免共享聊天库的并发写入使读快照不能升级。
                view = summary(note, tags)
                with self._writing() as writer:
                    current = writer.get(Note, note_id)
                    current.sync_status = "synced"
                    current.sync_error_code, current.sync_error_message = None, None
                    current.sync_retryable = False
                    writer.commit()
                view.sync_status, view.sync_error = "synced", None
                return NoteDetail(**view.model_dump(), body=body)
            return NoteDetail(**summary(note, tags).model_dump(), body=body)

    @staticmethod
    def _historical_versions(session, note_id):
        operations = session.scalars(
            select(NoteWrite)
            .where(NoteWrite.note_id == note_id, NoteWrite.status == "completed")
            .order_by(NoteWrite.target_version)
        )
        for operation in operations:
            if session.get(NoteVersion, (note_id, operation.target_version)) is not None:
                continue
            try:
                if digest(operation.target_bytes) != operation.target_hash:
                    continue
                text = operation.target_bytes.decode("utf-8")
                marker = text.find("\n---\n", 4)
                if not text.startswith("---\n") or marker < 0:
                    continue
                metadata = dict(
                    (key, json.loads(value))
                    for key, value in (line.split(": ", 1) for line in text[4:marker].splitlines())
                )
                title, body = text[marker + 5 + 2 :].split("\n", 1)
                body = body[1:] if body.startswith("\n") else body
                if (
                    metadata.get("id") != note_id
                    or metadata.get("version") != operation.target_version
                ):
                    continue
                session.add(
                    NoteVersion(
                        note_id=note_id,
                        version=operation.target_version,
                        title=title,
                        body=body,
                        folder=metadata.get("folder", ""),
                        source=metadata.get("source", ""),
                        tags_json=operation.target_tags,
                        file_hash=operation.target_hash,
                        created_at=operation.created_at,
                        origin=operation.origin,
                    )
                )
            except (ValueError, UnicodeError, TypeError):
                continue

    def operation_result(self, operation_key):
        with self.sessions() as session:
            if session.get(DeletedOperation, operation_key):
                raise ApiError(409, "note_deleted", "此整理内容已删除，旧任务不能恢复")
            operation = session.scalar(
                select(NoteWrite).where(NoteWrite.operation_key == operation_key)
            )
            identifier = operation.note_id if operation else None
        return self._detail(identifier) if identifier else None

    @staticmethod
    def _expected(note, version):
        if note.version != version:
            raise ApiError(
                409,
                "note_version_conflict",
                "文档已有新版本，请保留草稿并重新读取",
                note_id=note.id,
                current_version=note.version,
            )

    def update(
        self,
        note_id,
        payload: NoteUpdate,
        *,
        origin="manual",
        operation_key=None,
        external_hash=None,
    ):
        note_id = self.canonical_id(note_id)
        with self.lock:
            if operation_key:
                existing = self.operation_result(operation_key)
                if existing:
                    return existing
            if external_hash is None:
                detail = self._detail(note_id)
                body = detail.body
            else:
                external = self.external(note_id)
                if external["file_hash"] != external_hash:
                    raise ApiError(409, "external_note_changed", "外部文档再次发生变化，请重新查看")
                body = external["body"]
            with self._writing() as session:
                note = session.get(Note, note_id)
                if note is None or session.get(NoteDeletion, note_id):
                    raise ApiError(404, "note_not_found", "文档不存在")
                self._expected(note, payload.expected_version)
                changes = payload.model_dump(exclude_unset=True, exclude={"expected_version"})
                new_body = changes.pop("body", body)
                tag_ids = changes.pop("tag_ids", None)
                tags = tags_for(session, note_id)
                if tag_ids is not None:
                    try:
                        canonical = [str(UUID(value)) for value in tag_ids]
                    except ValueError:
                        raise ApiError(422, "invalid_tag_ids", "请选择已有且不重复的标签") from None
                    found = list(
                        session.scalars(select(Tag).where(Tag.id.in_(canonical)).order_by(Tag.id))
                    )
                    if len(set(canonical)) != len(canonical) or len(found) != len(canonical):
                        raise ApiError(422, "invalid_tag_ids", "请选择已有且不重复的标签")
                    new_tags = tag_views(found)
                else:
                    new_tags = tags
                title = changes.get("title", note.title)
                duplicate = session.scalar(
                    select(Note.id).where(
                        Note.normalized_title == title.casefold(), Note.id != note_id
                    )
                )
                if duplicate:
                    raise ApiError(409, "note_title_exists", "同标题文档已存在", note_id=duplicate)
                changed = (
                    external_hash is not None
                    or new_body != body
                    or new_tags != tags
                    or any(getattr(note, k) != v for k, v in changes.items())
                )
                classification_changed = new_tags != tags or (
                    "folder" in changes and changes["folder"] != note.folder
                )
                if not changed:
                    if origin == "manual" and tag_ids == [] and not note.manual_classification:
                        note.manual_classification = True
                        session.commit()
                    return detail
                previous = self._active(session, note_id)
                if previous:
                    previous.status = "superseded"
                    session.flush()
                for key, value in changes.items():
                    setattr(note, key, value)
                note.normalized_title = note.title.casefold()
                if tag_ids is not None:
                    session.execute(delete(NoteTag).where(NoteTag.note_id == note_id))
                    session.add_all(NoteTag(note_id=note_id, tag_id=t["id"]) for t in new_tags)
                if origin == "manual" and (classification_changed or tag_ids == []):
                    note.manual_classification = True
                note.version += 1
                note.updated_at = utc_timestamp()
                note.sync_status, note.sync_error_code, note.sync_error_message = (
                    "pending",
                    None,
                    None,
                )
                note.sync_retryable = False
                if external_hash is not None:
                    note.confirmed_hash = external_hash
                session.flush()
                self._intent(session, note, new_tags, new_body, "update", origin, operation_key)
                session.commit()
            return self._detail(note_id)

    def versions(self, note_id):
        note_id = self.canonical_id(note_id)
        with self.lock:
            with self.sessions() as session:
                if session.get(Note, note_id) is None or session.get(NoteDeletion, note_id):
                    raise ApiError(404, "note_not_found", "文档不存在")
            try:
                self._detail(note_id)
            except ApiError:
                pass  # 文件冲突时仍可查看已确认的历史。
            with self.sessions() as session:
                total = session.scalar(
                    select(func.count())
                    .select_from(NoteVersion)
                    .where(NoteVersion.note_id == note_id)
                )
                all_versions = list(
                    session.scalars(
                        select(NoteVersion)
                        .where(NoteVersion.note_id == note_id)
                        .order_by(NoteVersion.version.desc())
                        .limit(20)
                    )
                )
                return dict(
                    items=[
                        dict(
                            version=v.version,
                            title=v.title,
                            body=v.body,
                            folder=v.folder,
                            source=v.source,
                            tags=json.loads(v.tags_json),
                            created_at=v.created_at,
                            origin=v.origin,
                        )
                        for v in all_versions[:20]
                    ],
                    total=total,
                )

    def external(self, note_id):
        note_id = self.canonical_id(note_id)
        with self.lock, self.sessions() as session:
            note = session.get(Note, note_id)
            if note is None or session.get(NoteDeletion, note_id):
                raise ApiError(404, "note_not_found", "文档不存在")
            try:
                data = self.files.read(note_id)
                if data is None:
                    raise FileIssue("note_file_missing", "已登记的文档文件不存在")
                text = data.decode("utf-8")
                if text.startswith("---\n"):
                    marker = text.find("\n---\n", 4)
                    if marker < 0:
                        raise FileIssue("note_file_invalid", "外部文档头部格式无法解析")
                    text = text[marker + 5 :]
                if not text.startswith("# ") or "\n" not in text:
                    raise FileIssue("note_file_invalid", "外部文档需要单行主标题")
                title, body = text[2:].split("\n", 1)
                body = body[1:] if body.startswith("\n") else body
                NoteUpdate(expected_version=note.version, title=title, body=body)
                return dict(
                    note_id=note_id,
                    current_version=note.version,
                    file_hash=digest(data),
                    title=title,
                    body=body,
                )
            except (FileIssue, ValueError) as exc:
                raise ApiError(
                    409,
                    getattr(exc, "code", "note_file_invalid"),
                    getattr(exc, "message", "外部文档格式无效"),
                ) from None

    def import_external(self, note_id, payload):
        with self.lock:
            external = self.external(note_id)
            if external["file_hash"] != payload.file_hash:
                raise ApiError(409, "external_note_changed", "外部文档再次发生变化，请重新查看")
            return self.update(
                note_id,
                NoteUpdate(
                    expected_version=payload.expected_version,
                    title=external["title"],
                    body=external["body"],
                ),
                origin="external",
                external_hash=payload.file_hash,
            )

    def delete(self, note_id, expected_version):
        note_id = self.canonical_id(note_id)
        with self.lock:
            with self.sessions() as session:
                fence = session.get(NoteDeletion, note_id)
                if fence:
                    if fence.version != expected_version:
                        raise ApiError(409, "note_version_conflict", "删除版本不一致")
                    if fence.status == "completed":
                        return
                else:
                    note = session.get(Note, note_id)
                    if note is None:
                        raise ApiError(404, "note_not_found", "文档不存在")
                    self._expected(note, expected_version)
                    if self._active(session, note_id):
                        raise ApiError(409, "note_sync_pending", "请先处理未完成的文档保存")
                    try:
                        actual = self.files.read(note_id)
                        if actual is not None:
                            TopicFiles._check_baseline(actual, note.confirmed_hash)
                    except FileIssue as exc:
                        if exc.code != "note_file_missing":
                            raise ApiError(409, exc.code, exc.message) from None
                    title_hash, confirmed_hash = (
                        digest(note.normalized_title.encode()),
                        note.confirmed_hash,
                    )
            if not fence:
                with self._writing() as session:
                    session.add(
                        NoteDeletion(
                            id=note_id,
                            version=expected_version,
                            title_hash=title_hash,
                            file_hash=confirmed_hash,
                            status="pending",
                            deleted_at=utc_timestamp(),
                        )
                    )
                    session.commit()
            self._finish_delete(note_id)

    def _finish_delete(self, note_id):
        with self.sessions() as session:
            fence = session.get(NoteDeletion, note_id)
            if fence is None or fence.status == "completed":
                return
            file_hash = fence.file_hash
        try:
            self.files.remove(note_id, file_hash)
        except FileIssue as exc:
            raise ApiError(503 if exc.retryable else 409, exc.code, exc.message) from None
        with self._writing() as session:
            written_jobs = set()
            for key in session.scalars(
                select(NoteWrite.operation_key).where(
                    NoteWrite.note_id == note_id, NoteWrite.operation_key.is_not(None)
                )
            ):
                written_jobs.add(key.split(":", 1)[0])
                if session.get(DeletedOperation, key) is None:
                    session.add(DeletedOperation(operation_key=key, note_id=note_id))
            related_jobs = set(
                session.scalars(
                    select(MemoryJobItem.job_id).where(MemoryJobItem.note_id == note_id)
                )
            )
            related_jobs.update(written_jobs)
            for job in session.scalars(select(MemoryJob)):
                if (
                    job.id in related_jobs
                    or note_id in (job.plan_json or "")
                    or note_id in (job.context_json or "")
                ):
                    job.plan_json, job.context_json = None, None
                    job.reason, job.question = "关联笔记已删除，旧整理内容已清理", ""
                    if job.status not in ("completed", "skipped"):
                        job.status = "skipped"
            for cls in (MemoryJobItem, NoteWrite, NoteVersion, NoteSection, NoteTag):
                session.execute(delete(cls).where(cls.note_id == note_id))
            session.execute(
                delete(MemoryRelation).where(
                    (MemoryRelation.source == note_id) | (MemoryRelation.target == note_id)
                )
            )
            session.execute(delete(Note).where(Note.id == note_id))
            session.get(NoteDeletion, note_id).status = "completed"
            session.execute(
                update(MemorySetting)
                .where(MemorySetting.id == 1)
                .values(index_revision=MemorySetting.index_revision + 1)
            )
            session.commit()

    def _related(self, tag_id: str) -> list[str]:
        with self.sessions() as session:
            return list(session.scalars(select(NoteTag.note_id).where(NoteTag.tag_id == tag_id)))

    def _prepare_tag_change(self, ids: list[str]) -> dict[str, str | None]:
        bodies: dict[str, str | None] = {}
        for note_id in ids:
            self._recover(note_id)
            with self.sessions() as session:
                note = session.get(Note, note_id)
                operation = self._active(session, note_id)
                if note.sync_status == "conflict":
                    bodies[note_id] = None  # 目录可以变化，外部文件和旧载荷不重放。
                    continue
                if operation and operation.kind == "create":
                    raise ApiError(
                        409,
                        "note_sync_pending",
                        "关联文档尚未完成保存，标签暂未改变",
                        note_id=note_id,
                        sync_status="pending",
                        retryable=True,
                    )
                if operation:  # 元数据任务可在确认基线之后由新的标签事务取代。
                    try:
                        actual = self.files.read(note_id)
                        TopicFiles._check_baseline(actual, note.confirmed_hash)
                        bodies[note_id] = body_from(
                            operation.target_bytes, note, tags_for(session, note_id)
                        )
                    except FileIssue as issue:
                        session.rollback()
                        self._record_issue(note_id, issue)
                        if issue.retryable:
                            raise ApiError(
                                409,
                                "note_sync_pending",
                                "关联文档暂不可同步，标签暂未改变",
                                note_id=note_id,
                                sync_status="pending",
                                retryable=True,
                            ) from None
                        bodies[note_id] = None
                else:
                    try:
                        bodies[note_id] = self._detail(note_id).body
                    except ApiError as exc:
                        if exc.status_code == 409:
                            bodies[note_id] = None
                        else:
                            raise ApiError(
                                409,
                                "note_sync_pending",
                                "关联文档暂不可读，标签暂未改变",
                                note_id=note_id,
                                sync_status="pending",
                                retryable=True,
                            ) from None
        return bodies

    def update_tag(self, tag_id: str, payload: TagUpdate) -> Tag:
        with self.lock:
            with self.sessions() as session:
                tag = session.get(Tag, tag_id)
                if tag is None:
                    raise ApiError(404, "tag_not_found", "标签不存在")
                if payload.name is not None:
                    duplicate = session.scalar(
                        select(Tag).where(
                            Tag.normalized_name == payload.name.casefold(), Tag.id != tag_id
                        )
                    )
                    if duplicate:
                        raise ApiError(409, "duplicate_tag", "标签名称已存在")
                changed = payload.name is not None and payload.name != tag.name
            bodies = self._prepare_tag_change(self._related(tag_id)) if changed else {}
            with self._writing() as session:
                tag = session.get(Tag, tag_id)
                if changed:
                    session.merge(
                        TagAlias(
                            normalized_name=tag.normalized_name,
                            tag_id=tag.id,
                            deleted=False,
                            updated_at=utc_timestamp(),
                        )
                    )
                if payload.name is not None:
                    tag.name, tag.normalized_name = payload.name, payload.name.casefold()
                if payload.description is not None:
                    tag.description = payload.description
                tag.updated_at = utc_timestamp()
                try:
                    self._tag_intents(session, bodies, tag.updated_at)
                    session.commit()
                except IntegrityError:
                    session.rollback()
                    raise ApiError(409, "duplicate_tag", "标签名称已存在") from None
                result = tag
            for note_id in bodies:
                self._recover(note_id)
            return result

    def delete_tag(self, tag_id: str) -> None:
        with self.lock:
            with self.sessions() as session:
                if session.get(Tag, tag_id) is None:
                    raise ApiError(404, "tag_not_found", "标签不存在")
            bodies = self._prepare_tag_change(self._related(tag_id))
            with self._writing() as session:
                tag = session.get(Tag, tag_id)
                aliases = list(session.scalars(select(TagAlias).where(TagAlias.tag_id == tag_id)))
                for alias in aliases:
                    alias.deleted, alias.tag_id, alias.updated_at = True, None, utc_timestamp()
                session.merge(
                    TagAlias(
                        normalized_name=tag.normalized_name,
                        tag_id=None,
                        deleted=True,
                        updated_at=utc_timestamp(),
                    )
                )
                session.execute(delete(NoteTag).where(NoteTag.tag_id == tag_id))
                session.delete(session.get(Tag, tag_id))
                for note_id in bodies:
                    session.get(Note, note_id).manual_classification = True
                self._tag_intents(session, bodies, utc_timestamp())
                session.commit()
            for note_id in bodies:
                self._recover(note_id)

    def _tag_intents(self, session: Session, bodies: dict[str, str | None], timestamp: str) -> None:
        session.flush()
        for note_id, body in bodies.items():
            note = session.get(Note, note_id)
            previous = self._active(session, note_id)
            if previous:
                previous.status = "superseded"
                session.flush()
            note.version += 1
            note.updated_at = timestamp
            if body is not None:
                note.sync_status, note.sync_error_code, note.sync_error_message = (
                    "pending",
                    None,
                    None,
                )
                note.sync_retryable = False
                self._intent(session, note, tags_for(session, note_id), body, "metadata")
