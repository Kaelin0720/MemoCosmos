import asyncio
import json
import os
import shutil
import subprocess
import sys
import threading
import time

import pytest
import uvicorn
from mcp import Client
from mcp.client.stdio import StdioServerParameters

from app.core.settings import Settings
from app.integrations.client import BridgeError, LocalClient, local_url
from app.integrations.codex_hook import CaptureQueue
from app.integrations.setup_plugin import generate
from app.main import create_app


def event(name, **values):
    return dict(hook_event_name=name, session_id="session", turn_id="turn", **values)


@pytest.mark.posix_storage
def test_capture_queue_replays_offline_turns_without_rescanning_transcripts(tmp_path):
    directory = tmp_path / "private"
    queue = CaptureQueue(directory)
    queue.receive(event("UserPromptSubmit", prompt="请记住RAG", transcript_path="/must/not/read"))
    queue.receive(event("Stop", last_assistant_message="完成解释"))
    queue.receive(event("Stop", last_assistant_message="完成解释"))
    assert queue.status()["pending"] == 1

    class Offline:
        def call(self, path, payload):
            raise BridgeError("service_unavailable", "offline")

    assert queue.flush(Offline())["pending"] == 1
    sent = []

    class Online:
        def call(self, path, payload):
            sent.append(payload)
            return dict(status="accepted", job_id="queued")

    reopened = CaptureQueue(directory)
    assert reopened.flush(Online())["delivered"] == 1
    assert sent[0]["user"] == "请记住RAG" and sent[0]["source"] == "codex"
    reopened.receive(event("Stop", last_assistant_message="完成解释"))
    reopened.flush(Online())
    assert len(sent) == 1
    reopened.receive(event("Stop", last_assistant_message="修订后的解释", stop_hook_active=True))
    reopened.flush(Online())
    assert len(sent) == 2 and sent[0]["turn_id"] != sent[1]["turn_id"]
    with reopened.connect() as db:
        assert db.execute("SELECT payload FROM outbox WHERE status='delivered'").fetchall() == [
            (None,),
            (None,),
        ]
    assert directory.stat().st_mode & 0o077 == 0
    assert queue.path.stat().st_mode & 0o077 == 0


@pytest.mark.posix_storage
def test_capture_skips_missing_pair_and_interrupted_turns_and_marks_truncation(tmp_path):
    queue = CaptureQueue(tmp_path / "private")
    queue.receive(event("Stop", last_assistant_message="没有用户输入"))
    assert queue.status()["pending"] == 0
    queue.receive(event("UserPromptSubmit", prompt="中" * 25000))
    queue.receive(event("Interrupt"))
    queue.receive(event("Stop", last_assistant_message="已中断"))
    assert queue.status()["pending"] == 0
    queue.receive(event("UserPromptSubmit", prompt="中" * 25000))
    queue.receive(event("Stop", last_assistant_message="解释"))
    with queue.connect() as db:
        captured = json.loads(db.execute("SELECT payload FROM outbox").fetchone()[0])
    assert captured["truncated"] and len(captured["user"]) == 20000


@pytest.mark.posix_storage
def test_permanent_capture_rejection_is_visible_and_not_retried_forever(tmp_path):
    queue = CaptureQueue(tmp_path / "private")
    queue.receive(event("UserPromptSubmit", prompt="内容"))
    queue.receive(event("Stop", last_assistant_message="回复"))

    class Rejected:
        def call(self, path, payload):
            raise BridgeError("local_request_rejected", "rejected", retryable=False)

    result = queue.flush(Rejected())
    assert result["blocked"] == 1 and result["pending"] == 0


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com:8000",
        "http://127.0.0.1.evil.test:8000",
        "http://user:secret@127.0.0.1:8000",
        "http://127.0.0.1:8000/path",
        "http://127.0.0.1:8000?key=secret",
        "file:///memory",
        "http://localhost",
    ],
)
def test_bridge_cannot_send_memory_to_remote_or_credential_urls(url):
    with pytest.raises(ValueError):
        local_url(url)


def test_bridge_reloads_session_token_and_ignores_proxy_environment(monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://must-not-be-used.invalid")
    bridge = LocalClient("http://127.0.0.1:8000")
    requests = []

    class Response:
        def __init__(self, payload):
            self.payload = payload

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def read(self, length):
            return json.dumps(self.payload).encode()

    class Opener:
        def open(self, request, timeout):
            requests.append(request)
            if request.full_url.endswith("bootstrap"):
                return Response(dict(local_token=f"token-{len(requests)}"))
            return Response(dict(items=[]))

    bridge.opener = Opener()
    bridge.call("/api/v1/integrations/recall", dict(tool="list_tags"))
    bridge.call("/api/v1/integrations/recall", dict(tool="list_tags"))
    assert requests[1].get_header("X-local-token") != requests[3].get_header("X-local-token")


def test_generated_plugin_runs_from_an_unrelated_working_directory(tmp_path):
    directory = generate(tmp_path / "插件 with spaces", "http://127.0.0.1:1")
    manifest = json.loads((directory / ".codex-plugin/plugin.json").read_text())
    assert manifest["name"] == "memocosmos"
    assert not (directory / "plugin.json").exists()
    assert manifest["mcpServers"] == "./.mcp.json"
    assert json.loads((directory / ".mcp.json").read_text()) == json.loads(
        (directory / "mcp-client.json").read_text()
    )
    hooks = json.loads((directory / "hooks/hooks.json").read_text())["hooks"]
    assert set(hooks) == {"UserPromptSubmit", "Stop", "Interrupt", "SessionStart"}
    with pytest.raises(ValueError):
        generate(directory)
    config = json.loads((directory / "mcp-client.json").read_text())["mcpServers"]["memocosmos"]

    async def scenario():
        async with Client(StdioServerParameters(**config, cwd=tmp_path)) as client:
            tools = (await client.list_tools()).tools
            assert len(tools) == 6
            result = await client.call_tool("search_memory", {"q": "RAG"})
            assert result.structured_content["error"] == "service_unavailable"
            assert "token" not in json.dumps(result.structured_content)

    asyncio.run(scenario())


@pytest.mark.posix_storage
def test_generated_capture_launcher_runs_from_an_unrelated_working_directory(tmp_path):
    directory = generate(tmp_path / "插件 with spaces", "http://127.0.0.1:1")
    environment = dict(os.environ)
    environment.pop("PYTHONPATH", None)
    result = subprocess.run(
        [
            sys.executable,
            str(directory / "bridge.py"),
            "capture",
            "status",
            "--data-dir",
            str(tmp_path / "data"),
        ],
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["pending"] == 0


def test_capture_rejects_unsupported_private_storage_before_creating_files(tmp_path, monkeypatch):
    monkeypatch.delattr(os, "O_NOFOLLOW", raising=False)
    directory = tmp_path / "capture"
    with pytest.raises(ValueError, match="POSIX.*WSL2"):
        CaptureQueue(directory)
    assert not directory.exists()


@pytest.mark.skipif(shutil.which("codex") is None, reason="Codex CLI is not installed")
def test_codex_discovers_generated_tools_and_untrusted_capture_hooks(tmp_path):
    directory = generate(tmp_path / "插件 with spaces", "http://127.0.0.1:1")
    home = tmp_path / "codex-home"
    home.mkdir()
    environment = dict(os.environ, CODEX_HOME=str(home))
    for command in (
        ["plugin", "marketplace", "add", str(directory), "--json"],
        ["plugin", "add", "memocosmos@memocosmos-local", "--json"],
    ):
        subprocess.run(
            ["codex", *command],
            env=environment,
            capture_output=True,
            check=True,
            timeout=15,
        )

    async def scenario():
        process = await asyncio.create_subprocess_exec(
            "codex",
            "--disable",
            "remote_plugin",
            "app-server",
            "--stdio",
            env=environment,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )

        async def request(identifier, method, params):
            process.stdin.write(
                (json.dumps(dict(id=identifier, method=method, params=params)) + "\n").encode()
            )
            await process.stdin.drain()

            async def response():
                while line := await process.stdout.readline():
                    message = json.loads(line)
                    if message.get("id") == identifier:
                        assert "error" not in message, message
                        return message["result"]
                raise AssertionError("Codex app-server exited before responding")

            return await asyncio.wait_for(response(), timeout=20)

        try:
            await request(
                1,
                "initialize",
                dict(
                    clientInfo=dict(name="memocosmos-test", version="0.1.2"),
                    capabilities=dict(experimentalApi=True),
                ),
            )
            process.stdin.write(b'{"method":"initialized"}\n')
            await process.stdin.drain()
            result = await request(2, "hooks/list", dict(cwds=[str(tmp_path)]))
            hooks = [hook for row in result["data"] for hook in row["hooks"]]
            assert {hook["eventName"] for hook in hooks} == {
                "sessionStart",
                "userPromptSubmit",
                "stop",
                "interrupt",
            }
            assert all(hook["trustStatus"] == "untrusted" for hook in hooks)
            result = await request(3, "mcpServerStatus/list", dict(limit=100))
            server = next(row for row in result["data"] if row.get("name") == "memocosmos")
            assert server.get("toolsError") is None
            assert len(server["tools"]) == 6
        finally:
            if process.returncode is None:
                process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except TimeoutError:
                process.kill()
                await process.wait()

    asyncio.run(scenario())


@pytest.mark.posix_storage
def test_stdio_tools_and_codex_capture_reach_a_real_loopback_service(tmp_path):
    import socket

    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    app = create_app(Settings(tmp_path / "memory", tmp_path / "config"))
    server = uvicorn.Server(uvicorn.Config(app, log_level="critical", access_log=False))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
    thread.start()
    bridge = LocalClient(f"http://127.0.0.1:{port}", timeout=2)
    try:
        for _ in range(100):
            if server.started:
                break
            time.sleep(0.02)
        assert server.started
        tag = bridge.call("/api/v1/tags", dict(name="RAG"))
        note = bridge.call(
            "/api/v1/notes", dict(title="RAG", body="从资料中召回依据", tag_ids=[tag["id"]])
        )
        queue = CaptureQueue(tmp_path / "capture")
        queue.receive(event("UserPromptSubmit", prompt="今天学习了RAG"))
        queue.receive(event("Stop", last_assistant_message="这是检索增强生成"))
        assert queue.flush(bridge)["delivered"] == 1
        directory = generate(tmp_path / "plugin", bridge.base_url)
        config = json.loads((directory / "mcp-client.json").read_text())["mcpServers"]["memocosmos"]

        async def scenario():
            async with Client(StdioServerParameters(**config, cwd=tmp_path)) as mcp:
                result = (await mcp.call_tool("search_memory", {"q": "RAG"})).structured_content
                assert result["items"][0]["note_id"] == note["id"]
                read = (
                    await mcp.call_tool(
                        "read_note", {"note_id": note["id"], "retrieval_id": result["retrieval_id"]}
                    )
                ).structured_content
                assert read["body"] == "从资料中召回依据"
                jobs = bridge.call("/api/v1/memory/jobs")
                job = (
                    await mcp.call_tool("get_memory_job", {"job_id": jobs["items"][0]["id"]})
                ).structured_content
                assert job["source"]["app"] == "codex"
                assert job["status"] == "pending"  # No model configured in this isolated service.

        asyncio.run(scenario())
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        listener.close()
    assert not thread.is_alive()
