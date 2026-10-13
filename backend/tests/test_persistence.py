import sqlite3

import pytest
from fastapi.testclient import TestClient
from test_tags import assert_error

from app.core.settings import SOURCE_ROOT, Settings
from app.main import create_app


def test_database_and_ids_survive_restart_while_token_rotates(tmp_path):
    settings = Settings(tmp_path / "memory")
    with TestClient(create_app(settings), base_url="http://localhost:8000") as first:
        old_token = first.get("/api/v1/bootstrap").json()["local_token"]
        created = first.post(
            "/api/v1/tags", headers={"X-Local-Token": old_token}, json={"name": "重启验证"}
        ).json()
    assert settings.database_path().is_file()
    with sqlite3.connect(settings.database_path()) as connection:
        assert (
            connection.execute("SELECT version_num FROM alembic_version").fetchone()[0]
            == "0004_second_brain"
        )
        assert connection.execute("SELECT count(*) FROM tags").fetchone()[0] == 1

    with TestClient(create_app(settings), base_url="http://localhost:8000") as second:
        token = second.get("/api/v1/bootstrap").json()["local_token"]
        assert token != old_token
        assert_error(
            second.get("/api/v1/tags", headers={"X-Local-Token": old_token}),
            401,
            "invalid_local_token",
        )
        assert second.get("/api/v1/tags", headers={"X-Local-Token": token}).json() == {
            "items": [created],
            "total": 1,
        }


def test_memory_dir_env_must_be_absolute_and_outside_source(monkeypatch, tmp_path):
    monkeypatch.setenv("YIHE_MEMORY_DIR", str(tmp_path / "configured-memory"))
    assert (
        Settings.from_env().database_path()
        == tmp_path / "configured-memory/.assistant/memory.sqlite"
    )
    for invalid in [SOURCE_ROOT, SOURCE_ROOT / "backend/data", "relative-memory"]:
        monkeypatch.setenv("YIHE_MEMORY_DIR", str(invalid))
        with pytest.raises(ValueError):
            Settings.from_env().database_path()


def test_database_symlink_cannot_escape_memory_dir(tmp_path):
    memory_dir = tmp_path / "memory"
    memory_dir.mkdir()
    try:
        (memory_dir / ".assistant").symlink_to(SOURCE_ROOT, target_is_directory=True)
    except OSError:
        pytest.skip("This OS user cannot create a directory symlink")
    with pytest.raises(ValueError):
        Settings(memory_dir).database_path()
