"""增量增加目录、已确认版本、章节索引、记忆任务和证据关系。"""

import sqlalchemy as sa
from alembic import op

revision = "0004_second_brain"
down_revision = "0003_notes"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "tag_aliases",
        sa.Column("normalized_name", sa.String(160), primary_key=True),
        sa.Column("tag_id", sa.String(36)),
        sa.Column("deleted", sa.Boolean(), nullable=False),
        sa.Column("updated_at", sa.String(32), nullable=False),
    )
    op.add_column("notes", sa.Column("folder", sa.String(240), nullable=False, server_default=""))
    op.add_column(
        "notes",
        sa.Column("manual_classification", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    with op.batch_alter_table("note_writes") as batch:
        batch.drop_constraint("ck_note_writes_kind", type_="check")
        batch.create_check_constraint(
            "ck_note_writes_kind", "kind IN ('create','metadata','update')"
        )
        batch.add_column(
            sa.Column("origin", sa.String(24), nullable=False, server_default="manual")
        )
        batch.add_column(sa.Column("operation_key", sa.String(100)))
        batch.create_unique_constraint("uq_note_write_operation_key", ["operation_key"])
    op.create_table(
        "note_versions",
        sa.Column("note_id", sa.String(36), sa.ForeignKey("notes.id"), primary_key=True),
        sa.Column("version", sa.Integer(), primary_key=True),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("folder", sa.String(240), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("tags_json", sa.Text(), nullable=False),
        sa.Column("file_hash", sa.String(64), nullable=False),
        sa.Column("created_at", sa.String(32), nullable=False),
        sa.Column("origin", sa.String(24), nullable=False),
    )
    op.create_table(
        "note_sections",
        sa.Column("note_id", sa.String(36), sa.ForeignKey("notes.id"), primary_key=True),
        sa.Column("position", sa.Integer(), primary_key=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("heading", sa.String(400), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("event_date", sa.String(10)),
        sa.Column("event_end_date", sa.String(10)),
        sa.Column("recorded_date", sa.String(10), nullable=False),
    )
    op.create_table(
        "note_deletions",
        "tag_aliases",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("title_hash", sa.String(64), nullable=False),
        sa.Column("file_hash", sa.String(64)),
        sa.Column("status", sa.String(12), nullable=False),
        sa.Column("deleted_at", sa.String(32), nullable=False),
    )
    op.create_table(
        "deleted_operations",
        sa.Column("operation_key", sa.String(100), primary_key=True),
        sa.Column("note_id", sa.String(36), nullable=False),
    )
    op.create_table(
        "memory_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("auto_memory", sa.Boolean(), nullable=False),
        sa.Column("index_revision", sa.Integer(), nullable=False),
    )
    op.execute("INSERT INTO memory_settings VALUES (1,1,0)")
    op.create_table(
        "memory_jobs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "conversation_id", sa.String(36), sa.ForeignKey("conversations.id"), nullable=False
        ),
        sa.Column(
            "run_id", sa.String(36), sa.ForeignKey("agent_runs.id"), unique=True, nullable=False
        ),
        sa.Column("user_message_id", sa.String(36), sa.ForeignKey("messages.id"), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("phase", sa.String(16), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("error_code", sa.String(80)),
        sa.Column("error_message", sa.String(200)),
        sa.Column("plan_json", sa.Text()),
        sa.Column("context_json", sa.Text()),
        sa.Column("clarification", sa.Text(), nullable=False),
        sa.Column("confirmed", sa.Boolean(), nullable=False),
        sa.Column("manual_request", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.String(32), nullable=False),
        sa.Column("updated_at", sa.String(32), nullable=False),
        sa.CheckConstraint(
            "status IN ('pending','running','completed','skipped',"
            "'needs_confirmation','failed','interrupted')",
            name="ck_memory_jobs_status",
        ),
    )
    op.create_table(
        "memory_job_items",
        sa.Column("job_id", sa.String(36), sa.ForeignKey("memory_jobs.id"), primary_key=True),
        sa.Column("position", sa.Integer(), primary_key=True),
        sa.Column("note_id", sa.String(36), sa.ForeignKey("notes.id"), nullable=False),
        sa.Column("action", sa.String(8), nullable=False),
    )
    op.create_table(
        "memory_relations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("source", sa.String(36), sa.ForeignKey("notes.id"), nullable=False),
        sa.Column("target", sa.String(36), sa.ForeignKey("notes.id"), nullable=False),
        sa.Column("source_version", sa.Integer(), nullable=False),
        sa.Column("target_version", sa.Integer(), nullable=False),
        sa.Column("relation", sa.String(80), nullable=False),
        sa.Column("kind", sa.String(12), nullable=False),
        sa.Column("evidence", sa.Text(), nullable=False),
        sa.Column("source_message_id", sa.String(36), sa.ForeignKey("messages.id")),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.String(32), nullable=False),
    )


def downgrade():
    for name in (
        "memory_relations",
        "memory_job_items",
        "memory_jobs",
        "memory_settings",
        "note_sections",
        "note_versions",
        "deleted_operations",
        "note_deletions",
    ):
        op.drop_table(name)
    with op.batch_alter_table("note_writes") as batch:
        batch.drop_constraint("uq_note_write_operation_key", type_="unique")
        batch.drop_column("operation_key")
        batch.drop_column("origin")
        batch.drop_constraint("ck_note_writes_kind", type_="check")
        batch.create_check_constraint("ck_note_writes_kind", "kind IN ('create','metadata')")
    op.drop_column("notes", "manual_classification")
    op.drop_column("notes", "folder")
