"""主题文档目录、关联和可恢复文件意图；保留标签及主智能体记录。"""

import sqlalchemy as sa
from alembic import op

revision = "0003_notes"
down_revision = "0002_main_agent"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "notes",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("normalized_title", sa.String(400), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("created_at", sa.String(32), nullable=False),
        sa.Column("updated_at", sa.String(32), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("confirmed_hash", sa.String(64)),
        sa.Column("sync_status", sa.String(8), nullable=False),
        sa.Column("sync_error_code", sa.String(80)),
        sa.Column("sync_error_message", sa.String(200)),
        sa.Column("sync_retryable", sa.Boolean(), nullable=False),
        sa.UniqueConstraint("normalized_title", name="uq_notes_normalized_title"),
        sa.CheckConstraint("version > 0", name="ck_notes_version"),
        sa.CheckConstraint("sync_status IN ('synced','pending','conflict')", name="ck_notes_sync"),
    )
    op.create_table(
        "note_tags",
        sa.Column(
            "note_id",
            sa.String(36),
            sa.ForeignKey("notes.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "tag_id", sa.String(36), sa.ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True
        ),
    )
    op.create_index("ix_note_tags_tag_id", "note_tags", ["tag_id"])
    op.create_table(
        "note_writes",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("note_id", sa.String(36), sa.ForeignKey("notes.id"), nullable=False),
        sa.Column("kind", sa.String(8), nullable=False),
        sa.Column("base_hash", sa.String(64)),
        sa.Column("target_hash", sa.String(64), nullable=False),
        sa.Column("target_bytes", sa.LargeBinary(), nullable=False),
        sa.Column("target_tags", sa.Text(), nullable=False),
        sa.Column("target_version", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("created_at", sa.String(32), nullable=False),
        sa.CheckConstraint("kind IN ('create','metadata')", name="ck_note_writes_kind"),
        sa.CheckConstraint(
            "status IN ('pending','completed','conflict','superseded')",
            name="ck_note_writes_status",
        ),
    )
    op.create_index(
        "uq_note_writes_active",
        "note_writes",
        ["note_id"],
        unique=True,
        sqlite_where=sa.text("status IN ('pending','conflict')"),
    )


def downgrade() -> None:
    op.drop_table("note_writes")
    op.drop_table("note_tags")
    op.drop_table("notes")
