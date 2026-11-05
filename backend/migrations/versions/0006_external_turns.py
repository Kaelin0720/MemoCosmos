"""Identify conversation turns received from external agent hosts."""

import sqlalchemy as sa
from alembic import op

revision = "0006_external_turns"
down_revision = "0005_relation_indexes"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "external_turns",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("source", sa.String(64), nullable=False),
        sa.Column("session_id", sa.String(200), nullable=False),
        sa.Column("turn_id", sa.String(200), nullable=False),
        sa.Column(
            "run_id", sa.String(36), sa.ForeignKey("agent_runs.id"), unique=True, nullable=False
        ),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("truncated", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("captured_at", sa.String(32), nullable=False),
        sa.UniqueConstraint("source", "session_id", "turn_id", name="uq_external_turn_identity"),
    )


def downgrade():
    op.drop_table("external_turns")
