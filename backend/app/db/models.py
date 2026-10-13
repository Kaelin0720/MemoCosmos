from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Tag(Base):
    __tablename__ = "tags"
    __table_args__ = (
        UniqueConstraint("normalized_name", name="uq_tags_normalized_name"),
        CheckConstraint("length(name) BETWEEN 1 AND 80", name="ck_tags_name_length"),
        CheckConstraint("length(description) <= 1000", name="ck_tags_description_length"),
        CheckConstraint("created_by IN ('user', 'ai')", name="ck_tags_created_by"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    normalized_name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str] = mapped_column(String(1000), nullable=False)
    created_by: Mapped[str] = mapped_column(String(4), nullable=False)
    # SQLite 没有带时区的日期类型，存 ISO UTC 字符串，响应再解析为 datetime。
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)
    updated_at: Mapped[str] = mapped_column(String(32), nullable=False)


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)
    updated_at: Mapped[str] = mapped_column(String(32), nullable=False)
    active_run_id: Mapped[str | None] = mapped_column(String(36))
    last_seq: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class TagAlias(Base):
    __tablename__ = "tag_aliases"
    normalized_name: Mapped[str] = mapped_column(String(160), primary_key=True)
    tag_id: Mapped[str | None] = mapped_column(String(36))
    deleted: Mapped[bool] = mapped_column(nullable=False, default=False)
    updated_at: Mapped[str] = mapped_column(String(32), nullable=False)


class AgentRun(Base):
    __tablename__ = "agent_runs"
    __table_args__ = (
        UniqueConstraint("conversation_id", "client_message_id", name="uq_runs_client_message"),
        CheckConstraint(
            "status IN ('pending','running','completed','cancelled','failed','interrupted')",
            name="ck_runs_status",
        ),
        Index(
            "uq_runs_active_conversation",
            "conversation_id",
            unique=True,
            sqlite_where=text("status IN ('pending','running')"),
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False
    )
    client_message_id: Mapped[str] = mapped_column(String(36), nullable=False)
    # 逻辑引用消息，避免 run/message 外键相互依赖的插入环。
    user_message_id: Mapped[str] = mapped_column(String(36), nullable=False)
    assistant_message_id: Mapped[str] = mapped_column(String(36), nullable=False)
    status: Mapped[str] = mapped_column(String(12), nullable=False)
    error_code: Mapped[str | None] = mapped_column(String(80))
    error_message: Mapped[str | None] = mapped_column(String(200))
    context_truncated: Mapped[bool] = mapped_column(nullable=False, default=False)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)
    updated_at: Mapped[str] = mapped_column(String(32), nullable=False)


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        UniqueConstraint("conversation_id", "seq", name="uq_messages_sequence"),
        UniqueConstraint("run_id", "role", name="uq_messages_run_role"),
        CheckConstraint("role IN ('user','assistant')", name="ck_messages_role"),
        CheckConstraint(
            "status IN ('pending','running','completed','cancelled','failed','interrupted')",
            name="ck_messages_status",
        ),
        Index("ix_messages_conversation_seq", "conversation_id", "seq"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False
    )
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    role: Mapped[str] = mapped_column(String(9), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(12), nullable=False)
    run_id: Mapped[str] = mapped_column(ForeignKey("agent_runs.id"), nullable=False)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)
    updated_at: Mapped[str] = mapped_column(String(32), nullable=False)


class Note(Base):
    __tablename__ = "notes"
    __table_args__ = (
        UniqueConstraint("normalized_title", name="uq_notes_normalized_title"),
        CheckConstraint("version > 0", name="ck_notes_version"),
        CheckConstraint("sync_status IN ('synced','pending','conflict')", name="ck_notes_sync"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    normalized_title: Mapped[str] = mapped_column(String(400), nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    folder: Mapped[str] = mapped_column(String(240), nullable=False, default="")
    manual_classification: Mapped[bool] = mapped_column(nullable=False, default=False)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)
    updated_at: Mapped[str] = mapped_column(String(32), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    confirmed_hash: Mapped[str | None] = mapped_column(String(64))
    sync_status: Mapped[str] = mapped_column(String(8), nullable=False)
    sync_error_code: Mapped[str | None] = mapped_column(String(80))
    sync_error_message: Mapped[str | None] = mapped_column(String(200))
    sync_retryable: Mapped[bool] = mapped_column(nullable=False, default=False)


class NoteTag(Base):
    __tablename__ = "note_tags"
    __table_args__ = (Index("ix_note_tags_tag_id", "tag_id"),)

    note_id: Mapped[str] = mapped_column(
        ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True
    )
    tag_id: Mapped[str] = mapped_column(ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True)


class NoteWrite(Base):
    __tablename__ = "note_writes"
    __table_args__ = (
        CheckConstraint("kind IN ('create','metadata','update')", name="ck_note_writes_kind"),
        CheckConstraint(
            "status IN ('pending','completed','conflict','superseded')",
            name="ck_note_writes_status",
        ),
        Index(
            "uq_note_writes_active",
            "note_id",
            unique=True,
            sqlite_where=text("status IN ('pending','conflict')"),
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    note_id: Mapped[str] = mapped_column(ForeignKey("notes.id"), nullable=False)
    kind: Mapped[str] = mapped_column(String(8), nullable=False)
    base_hash: Mapped[str | None] = mapped_column(String(64))
    target_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    target_bytes: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    target_tags: Mapped[str] = mapped_column(Text, nullable=False)
    target_version: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(10), nullable=False)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)
    origin: Mapped[str] = mapped_column(String(24), nullable=False, default="manual")
    operation_key: Mapped[str | None] = mapped_column(String(100), unique=True)


class NoteVersion(Base):
    __tablename__ = "note_versions"
    note_id: Mapped[str] = mapped_column(ForeignKey("notes.id"), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    folder: Mapped[str] = mapped_column(String(240), nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    tags_json: Mapped[str] = mapped_column(Text, nullable=False)
    file_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)
    origin: Mapped[str] = mapped_column(String(24), nullable=False)


class NoteSection(Base):
    __tablename__ = "note_sections"
    note_id: Mapped[str] = mapped_column(ForeignKey("notes.id"), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, primary_key=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    heading: Mapped[str] = mapped_column(String(400), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    event_date: Mapped[str | None] = mapped_column(String(10))
    event_end_date: Mapped[str | None] = mapped_column(String(10))
    recorded_date: Mapped[str] = mapped_column(String(10), nullable=False)


class NoteDeletion(Base):
    __tablename__ = "note_deletions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    title_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    file_hash: Mapped[str | None] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(12), nullable=False)
    deleted_at: Mapped[str] = mapped_column(String(32), nullable=False)


class DeletedOperation(Base):
    __tablename__ = "deleted_operations"
    operation_key: Mapped[str] = mapped_column(String(100), primary_key=True)
    note_id: Mapped[str] = mapped_column(String(36), nullable=False)


class MemorySetting(Base):
    __tablename__ = "memory_settings"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    auto_memory: Mapped[bool] = mapped_column(nullable=False, default=True)
    index_revision: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class MemoryJob(Base):
    __tablename__ = "memory_jobs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending','running','completed','skipped',"
            "'needs_confirmation','failed','interrupted')",
            name="ck_memory_jobs_status",
        ),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id"), nullable=False)
    run_id: Mapped[str] = mapped_column(ForeignKey("agent_runs.id"), unique=True, nullable=False)
    user_message_id: Mapped[str] = mapped_column(ForeignKey("messages.id"), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    phase: Mapped[str] = mapped_column(String(16), nullable=False, default="planning")
    reason: Mapped[str] = mapped_column(Text, nullable=False, default="")
    question: Mapped[str] = mapped_column(Text, nullable=False, default="")
    error_code: Mapped[str | None] = mapped_column(String(80))
    error_message: Mapped[str | None] = mapped_column(String(200))
    plan_json: Mapped[str | None] = mapped_column(Text)
    context_json: Mapped[str | None] = mapped_column(Text)
    clarification: Mapped[str] = mapped_column(Text, nullable=False, default="")
    confirmed: Mapped[bool] = mapped_column(nullable=False, default=False)
    manual_request: Mapped[bool] = mapped_column(nullable=False, default=False)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)
    updated_at: Mapped[str] = mapped_column(String(32), nullable=False)


class MemoryJobItem(Base):
    __tablename__ = "memory_job_items"
    job_id: Mapped[str] = mapped_column(ForeignKey("memory_jobs.id"), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, primary_key=True)
    note_id: Mapped[str] = mapped_column(ForeignKey("notes.id"), nullable=False)
    action: Mapped[str] = mapped_column(String(8), nullable=False)


class MemoryRelation(Base):
    __tablename__ = "memory_relations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    source: Mapped[str] = mapped_column(ForeignKey("notes.id"), nullable=False)
    target: Mapped[str] = mapped_column(ForeignKey("notes.id"), nullable=False)
    source_version: Mapped[int] = mapped_column(Integer, nullable=False)
    target_version: Mapped[int] = mapped_column(Integer, nullable=False)
    relation: Mapped[str] = mapped_column(String(80), nullable=False)
    kind: Mapped[str] = mapped_column(String(12), nullable=False)
    evidence: Mapped[str] = mapped_column(Text, nullable=False)
    source_message_id: Mapped[str | None] = mapped_column(ForeignKey("messages.id"))
    active: Mapped[bool] = mapped_column(nullable=False, default=True)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)
