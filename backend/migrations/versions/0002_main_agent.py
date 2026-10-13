"""增量添加原始会话、消息和主智能体运行；不改变标签表。"""

import sqlalchemy as sa
from alembic import op

revision = "0002_main_agent"
down_revision = "0001_tags"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "conversations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("created_at", sa.String(32), nullable=False),
        sa.Column("updated_at", sa.String(32), nullable=False),
        sa.Column("active_run_id", sa.String(36)),
        sa.Column("last_seq", sa.Integer(), nullable=False),
    )
    op.create_table(
        "agent_runs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "conversation_id",
            sa.String(36),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("client_message_id", sa.String(36), nullable=False),
        sa.Column("user_message_id", sa.String(36), nullable=False),
        sa.Column("assistant_message_id", sa.String(36), nullable=False),
        sa.Column("status", sa.String(12), nullable=False),
        sa.Column("error_code", sa.String(80)),
        sa.Column("error_message", sa.String(200)),
        sa.Column("context_truncated", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.String(32), nullable=False),
        sa.Column("updated_at", sa.String(32), nullable=False),
        sa.UniqueConstraint("conversation_id", "client_message_id", name="uq_runs_client_message"),
        sa.CheckConstraint(
            "status IN ('pending','running','completed','cancelled','failed','interrupted')",
            name="ck_runs_status",
        ),
    )
    op.create_index(
        "uq_runs_active_conversation",
        "agent_runs",
        ["conversation_id"],
        unique=True,
        sqlite_where=sa.text("status IN ('pending','running')"),
    )
    op.create_table(
        "messages",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "conversation_id",
            sa.String(36),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(9), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("status", sa.String(12), nullable=False),
        sa.Column("run_id", sa.String(36), sa.ForeignKey("agent_runs.id"), nullable=False),
        sa.Column("created_at", sa.String(32), nullable=False),
        sa.Column("updated_at", sa.String(32), nullable=False),
        sa.UniqueConstraint("conversation_id", "seq", name="uq_messages_sequence"),
        sa.UniqueConstraint("run_id", "role", name="uq_messages_run_role"),
        sa.CheckConstraint("role IN ('user','assistant')", name="ck_messages_role"),
        sa.CheckConstraint(
            "status IN ('pending','running','completed','cancelled','failed','interrupted')",
            name="ck_messages_status",
        ),
    )
    op.create_index("ix_messages_conversation_seq", "messages", ["conversation_id", "seq"])


def downgrade() -> None:
    op.drop_table("messages")
    op.drop_table("agent_runs")
    op.drop_table("conversations")
