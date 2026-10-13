import sqlite3
from collections.abc import Iterator
from pathlib import Path

from alembic import command
from alembic.config import Config
from fastapi import Request
from sqlalchemy import Engine, create_engine, event
from sqlalchemy.engine import URL
from sqlalchemy.orm import Session


def build_engine(database_path: Path) -> Engine:
    database_path.parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(
        URL.create("sqlite", database=str(database_path)),
        connect_args={"check_same_thread": False, "autocommit": False, "timeout": 5},
    )

    @event.listens_for(engine, "connect")
    def configure_connection(connection: sqlite3.Connection, _record: object) -> None:
        previous_autocommit = connection.autocommit
        connection.autocommit = True
        try:
            with_connection = connection.cursor()
            try:
                with_connection.execute("PRAGMA foreign_keys=ON")
                with_connection.execute("PRAGMA journal_mode=WAL")
                with_connection.execute("PRAGMA busy_timeout=5000")
            finally:
                with_connection.close()
            connection.create_function("unicode_casefold", 1, str.casefold, deterministic=True)
        finally:
            connection.autocommit = previous_autocommit

    return engine


def run_migrations(engine: Engine) -> None:
    config = Config()
    config.set_main_option(
        "script_location", str(Path(__file__).resolve().parents[2] / "migrations")
    )
    # 所有迁移在服务接受请求前执行，连接与事务由应用统一持有。
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "head")


def get_session(request: Request) -> Iterator[Session]:
    with request.app.state.session_factory() as session:
        yield session
