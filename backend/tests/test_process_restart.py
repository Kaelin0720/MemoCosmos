"""用真实 HTTP 和两个独立服务进程验证持久化，数据只放在 pytest 临时目录。"""

import os
import socket
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

import httpx

BACKEND_ROOT = Path(__file__).resolve().parents[1]


@contextmanager
def running_server(memory_dir, port):
    environment = {
        **os.environ,
        "YIHE_MEMORY_DIR": str(memory_dir),
        "YIHE_CONFIG_DIR": str(memory_dir.parent / (memory_dir.name + "-config")),
    }
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--no-access-log",
        ],
        cwd=BACKEND_ROOT,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        with httpx.Client(
            base_url=f"http://127.0.0.1:{port}", timeout=1, trust_env=False
        ) as client:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise AssertionError(f"服务启动失败：{process.communicate()[0]}")
                try:
                    if client.get("/health").status_code == 200:
                        break
                except httpx.TransportError:
                    pass
                time.sleep(0.05)
            else:
                raise AssertionError("本地服务未在 10 秒内就绪")
            yield client
    finally:
        process.terminate()
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()


def test_real_http_crud_and_process_restart(tmp_path):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    memory_dir = tmp_path / "http-memory"

    with running_server(memory_dir, port) as client:
        assert client.get("/health").json() == {"status": "ok"}
        token = client.get("/api/v1/bootstrap").json()["local_token"]
        headers = {"X-Local-Token": token, "Origin": "http://127.0.0.1:3000"}
        response = client.post(
            "/api/v1/tags",
            headers=headers,
            json={"name": "网络验证", "description": "仅限临时测试库"},
        )
        assert response.status_code == 201
        created = response.json()
        assert (
            client.post("/api/v1/tags", headers=headers, json={"name": "网络验证"}).status_code
            == 409
        )
        updated = client.patch(
            f"/api/v1/tags/{created['id']}", headers=headers, json={"description": "重启前更新"}
        ).json()
        assert updated["id"] == created["id"]
        assert updated["created_at"] == created["created_at"]
        assert client.get("/api/v1/tags", headers=headers, params={"q": "重启前"}).json() == {
            "items": [updated],
            "total": 1,
        }

    with running_server(memory_dir, port) as client:
        new_token = client.get("/api/v1/bootstrap").json()["local_token"]
        assert new_token != token
        assert client.get("/api/v1/tags", headers={"X-Local-Token": token}).status_code == 401
        headers = {"X-Local-Token": new_token}
        assert client.get("/api/v1/tags", headers=headers).json() == {
            "items": [updated],
            "total": 1,
        }
        assert client.delete(f"/api/v1/tags/{created['id']}", headers=headers).status_code == 204
        assert client.get("/api/v1/tags", headers=headers).json()["total"] == 0
