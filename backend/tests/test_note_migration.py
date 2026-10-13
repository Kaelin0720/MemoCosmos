from pathlib import Path
from uuid import uuid4

from alembic import command
from alembic.config import Config

from app.db.session import build_engine, run_migrations


def test_0003_upgrade_preserves_all_tag_conversation_message_run_fields(tmp_path):
    engine = build_engine(tmp_path / "legacy.sqlite")
    config = Config()
    config.set_main_option(
        "script_location", str(Path(__file__).resolve().parents[1] / "migrations")
    )
    try:
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, "0002_main_agent")
        conversation, run, user, assistant, tag = [str(uuid4()) for _ in range(5)]
        timestamp = "2026-10-10T12:34:56.000000+00:00"
        with engine.begin() as connection:
            connection.exec_driver_sql(
                "INSERT INTO tags VALUES (?,?,?,?,?,?,?)",
                (tag, "旧标签", "旧标签", "原来的描述", "ai", timestamp, timestamp),
            )
            connection.exec_driver_sql(
                "INSERT INTO conversations VALUES (?,?,?,?,?,?)",
                (conversation, "既有会话", timestamp, timestamp, None, 2),
            )
            connection.exec_driver_sql(
                "INSERT INTO agent_runs VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    run,
                    conversation,
                    str(uuid4()),
                    user,
                    assistant,
                    "failed",
                    "model_error",
                    "安全错误",
                    False,
                    timestamp,
                    timestamp,
                ),
            )
            connection.exec_driver_sql(
                "INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    user,
                    conversation,
                    1,
                    "user",
                    "用户原文  \n",
                    "completed",
                    run,
                    timestamp,
                    timestamp,
                ),
            )
            connection.exec_driver_sql(
                "INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    assistant,
                    conversation,
                    2,
                    "assistant",
                    "部分生成的中文",
                    "failed",
                    run,
                    timestamp,
                    timestamp,
                ),
            )
        tables = ("tags", "conversations", "agent_runs", "messages")
        with engine.connect() as connection:
            before = {
                table: connection.exec_driver_sql(f"SELECT * FROM {table} ORDER BY id").all()
                for table in tables
            }
        run_migrations(engine)
        with engine.connect() as connection:
            after = {
                table: connection.exec_driver_sql(f"SELECT * FROM {table} ORDER BY id").all()
                for table in tables
            }
            assert after == before
            assert connection.exec_driver_sql("PRAGMA foreign_key_check").all() == []
            assert (
                connection.exec_driver_sql("SELECT version_num FROM alembic_version").scalar()
                == "0004_second_brain"
            )
            for table in ("notes", "note_tags", "note_writes"):
                assert connection.exec_driver_sql(f"SELECT count(*) FROM {table}").scalar() == 0
    finally:
        engine.dispose()
