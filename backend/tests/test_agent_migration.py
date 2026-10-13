from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.db.models import Tag
from app.db.session import build_engine, run_migrations
from app.schemas.tags import TagCreate
from app.services.tags import TagService


def test_populated_stage_one_database_upgrades_without_changing_tags(tmp_path):
    engine = build_engine(tmp_path / "memory.sqlite")
    config = Config()
    config.set_main_option(
        "script_location", str(Path(__file__).resolve().parents[1] / "migrations")
    )
    try:
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, "0001_tags")
        sessions = sessionmaker(engine, expire_on_commit=False)
        with sessions() as session:
            TagService(session).create(TagCreate(name="RAG", description="保留旧资料"))
            before = [
                {column.name: getattr(tag, column.name) for column in Tag.__table__.columns}
                for tag in session.scalars(select(Tag))
            ]
        run_migrations(engine)
        with sessions() as session:
            after = [
                {column.name: getattr(tag, column.name) for column in Tag.__table__.columns}
                for tag in session.scalars(select(Tag))
            ]
        assert before == after
        with engine.connect() as connection:
            assert connection.exec_driver_sql("PRAGMA foreign_keys").scalar() == 1
            assert connection.exec_driver_sql("PRAGMA foreign_key_check").all() == []
            assert (
                connection.exec_driver_sql("SELECT version_num FROM alembic_version").scalar()
                == "0004_second_brain"
            )
    finally:
        engine.dispose()
