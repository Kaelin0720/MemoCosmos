import json
import os
import socket
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

import httpx

BACKEND_ROOT = Path(__file__).resolve().parents[1]


@contextmanager
def process_server(tmp_path, port):
    environment = {
        **os.environ,
        "YIHE_MEMORY_DIR": str(tmp_path / "memory"),
        "YIHE_CONFIG_DIR": str(tmp_path / "config"),
        "CHAT_MODEL_PROVIDER": "openai_compatible",
        "CHAT_MODEL_BASE_URL": "https://example.invalid/v1",
        "CHAT_MODEL_NAME": "test-process-model",
        "CHAT_MODEL_API_KEY": "process-only-test-key",
        "RUN_TIMEOUT_SECONDS": "120",
        "AGENT_MAX_STEPS": "12",
    }
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "process_agent_fixture:app",
            "--app-dir",
            "tests",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--no-access-log",
        ],
        cwd=BACKEND_ROOT,
        env=environment,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        with httpx.Client(
            base_url=f"http://127.0.0.1:{port}", timeout=3, trust_env=False
        ) as client:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                assert process.poll() is None, "临时测试进程意外退出"
                try:
                    if client.get("/health").status_code == 200:
                        break
                except httpx.TransportError:
                    pass
                time.sleep(0.025)
            else:
                raise AssertionError("临时测试 API 未就绪")
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


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def send(client, headers):
    conversation = client.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
    payload = {"client_message_id": str(uuid4()), "content": "真实进程中文原文"}
    response = client.post(
        f"/api/v1/conversations/{conversation}/messages", headers=headers, json=payload
    )
    assert response.status_code == 202
    return conversation, response.json(), payload


def first_delta_then_disconnect(client, headers, run_id):
    with client.stream("GET", f"/api/v1/runs/{run_id}/events", headers=headers) as response:
        assert response.status_code == 200
        for line in response.iter_lines():
            if line.startswith("data: "):
                data = json.loads(line[6:])
                if "delta" in data:
                    assert data["delta"]
                    return
    raise AssertionError("没有收到真实 HTTP 增量")


def test_real_http_disconnect_cancel_and_terminal_reconnect(tmp_path):
    with process_server(tmp_path, free_port()) as (_, client, headers):
        conversation, run, _ = send(client, headers)
        first_delta_then_disconnect(client, headers, run["id"])
        assert (
            client.get(f"/api/v1/runs/{run['id']}", headers=headers).json()["status"] == "running"
        )
        cancelled = client.post(f"/api/v1/runs/{run['id']}/cancel", headers=headers, json={}).json()
        assert cancelled["status"] == "cancelled"
        messages = client.get(
            f"/api/v1/conversations/{conversation}/messages", headers=headers
        ).json()["items"]
        assert messages[0]["content"] == "真实进程中文原文"
        assert messages[1]["content"] and messages[1]["status"] == "cancelled"
        events = client.get(f"/api/v1/runs/{run['id']}/events", headers=headers)
        assert "event: run.snapshot" in events.text and "event: run.cancelled" in events.text
        time.sleep(0.1)
        assert (
            client.get(f"/api/v1/conversations/{conversation}/messages", headers=headers).json()[
                "items"
            ]
            == messages
        )


def test_process_kill_restart_retains_partial_and_does_not_resume_model(tmp_path):
    port = free_port()
    with process_server(tmp_path, port) as (process, client, headers):
        conversation, run, payload = send(client, headers)
        first_delta_then_disconnect(client, headers, run["id"])
        process.kill()
        process.wait(timeout=5)
    with process_server(tmp_path, port) as (_, client, new_headers):
        assert new_headers != headers
        final = client.get(f"/api/v1/runs/{run['id']}", headers=new_headers).json()
        assert final["status"] == "interrupted" and final["error"]["code"] == "run_interrupted"
        messages = client.get(
            f"/api/v1/conversations/{conversation}/messages", headers=new_headers
        ).json()["items"]
        assert messages[0]["content"] == payload["content"] and messages[0]["status"] == "completed"
        assert messages[1]["content"] and messages[1]["status"] == "interrupted"
        response = client.post(
            f"/api/v1/conversations/{conversation}/messages", headers=new_headers, json=payload
        )
        assert response.status_code == 202 and response.json()["id"] == run["id"]
        assert response.json()["status"] == "interrupted"
        time.sleep(0.1)
        assert (
            client.get(
                f"/api/v1/conversations/{conversation}/messages", headers=new_headers
            ).json()["items"]
            == messages
        )
