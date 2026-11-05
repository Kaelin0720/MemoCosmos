"""Index bounded neighborhood reads without changing stored knowledge."""

from alembic import op

revision = "0005_relation_indexes"
down_revision = "0004_second_brain"
branch_labels = None
depends_on = None


def upgrade():
    op.create_index("ix_memory_relations_source_active", "memory_relations", ["source", "active"])
    op.create_index("ix_memory_relations_target_active", "memory_relations", ["target", "active"])


def downgrade():
    op.drop_index("ix_memory_relations_target_active", table_name="memory_relations")
    op.drop_index("ix_memory_relations_source_active", table_name="memory_relations")
