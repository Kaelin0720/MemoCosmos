"""第一轮：统一标签池，不创建文档、图谱或 Agent 数据表。"""

import sqlalchemy as sa
from alembic import op

revision = "0001_tags"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "tags",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("normalized_name", sa.String(160), nullable=False),
        sa.Column("description", sa.String(1000), nullable=False),
        sa.Column("created_by", sa.String(4), nullable=False),
        sa.Column("created_at", sa.String(32), nullable=False),
        sa.Column("updated_at", sa.String(32), nullable=False),
        sa.UniqueConstraint("normalized_name", name="uq_tags_normalized_name"),
        sa.CheckConstraint("length(name) BETWEEN 1 AND 80", name="ck_tags_name_length"),
        sa.CheckConstraint("length(description) <= 1000", name="ck_tags_description_length"),
        sa.CheckConstraint("created_by IN ('user', 'ai')", name="ck_tags_created_by"),
    )


def downgrade() -> None:
    op.drop_table("tags")
