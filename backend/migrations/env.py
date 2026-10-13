from alembic import context

from app.core.settings import Settings
from app.db.models import Base
from app.db.session import build_engine


def migrate(connection) -> None:
    context.configure(connection=connection, target_metadata=Base.metadata)
    with context.begin_transaction():
        context.run_migrations()


connection = context.config.attributes.get("connection")
if connection is not None:
    migrate(connection)
else:
    # 手动 alembic upgrade head 使用与应用完全相同的目录校验和连接配置。
    engine = build_engine(Settings.from_env().database_path())
    try:
        with engine.connect() as connection:
            migrate(connection)
    finally:
        engine.dispose()
