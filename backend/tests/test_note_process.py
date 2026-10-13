import os
import signal
import sqlite3
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

import httpx
import pytest
from test_agent_process import free_port

pytestmark = pytest.mark.posix_storage


@contextmanager
def server(tmp_path, *, phase=None):
    environment = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("CHAT_MODEL_", "YIHE_"))
    }
    environment.update(
        YIHE_MEMORY_DIR=str(tmp_path / "memory"), YIHE_CONFIG_DIR=str(tmp_path / "config")
    )
    port = free_port()
    module = "app.main:app"
    if phase:
        module = "process_note_fixture:app"
        environment["YIHE_TEST_CRASH_PHASE"] = phase
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            module,
            "--app-dir",
            "tests",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--no-access-log",
        ],
        cwd=Path(__file__).resolve().parents[1],
        env=environment,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        with httpx.Client(
            base_url=f"http://127.0.0.1:{port}", timeout=5, trust_env=False
        ) as client:
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                assert process.poll() is None, "临时服务启动失败"
                try:
                    if client.get("/health").status_code == 200:
                        break
                except httpx.TransportError:
                    pass
                time.sleep(0.025)
            else:
                raise AssertionError("临时服务未就绪")
            token = client.get("/api/v1/bootstrap").json()["local_token"]
            yield process, client, {"X-Local-Token": token}
    finally:
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


@pytest.mark.parametrize("phase", ["intent", "temp", "hardlink", "published"])
def test_real_sigkill_recovers_same_note_operation_bytes_dates_and_version(tmp_path, phase):
    with server(tmp_path, phase=phase) as (process, client, headers):
        tag = client.post("/api/v1/tags", headers=headers, json={"name": "进程恢复标签"}).json()
        with pytest.raises(httpx.TransportError):
            client.post(
                "/api/v1/notes",
                headers=headers,
                json={
                    "title": "真实中断笔记",
                    "body": "\n中文正文  \r\n\n",
                    "tag_ids": [tag["id"]],
                },
            )
        process.wait(timeout=5)
        assert process.returncode == -signal.SIGKILL
    database = tmp_path / "memory/.assistant/memory.sqlite"
    with sqlite3.connect(database) as connection:
        note_id, created_at, updated_at, version = connection.execute(
            "SELECT id,created_at,updated_at,version FROM notes"
        ).fetchone()
        operation_id, target = connection.execute(
            "SELECT id,target_bytes FROM note_writes"
        ).fetchone()
    with server(tmp_path) as (_, client, restarted_headers):
        assert restarted_headers != headers
        response = client.get(f"/api/v1/notes/{note_id}", headers=restarted_headers)
        assert response.status_code == 200
        note = response.json()
        assert note["version"] == version == 1
        assert datetime.fromisoformat(note["created_at"]) == datetime.fromisoformat(created_at)
        assert datetime.fromisoformat(note["updated_at"]) == datetime.fromisoformat(updated_at)
        assert note["body"] == "\n中文正文  \r\n\n"
        assert (tmp_path / "memory/notes/topics" / (note_id + ".md")).read_bytes() == target
        assert client.get("/api/v1/notes", headers=restarted_headers).json()["total"] == 1
        with sqlite3.connect(database) as connection:
            assert connection.execute("SELECT created_at,updated_at FROM notes").fetchall() == [
                (created_at, updated_at)
            ]
            assert connection.execute("SELECT id,status FROM note_writes").fetchall() == [
                (operation_id, "completed")
            ]
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
