import json

import httpx2
import openai
from agent_helpers import auth, configure, finished, submit
from fastapi.testclient import TestClient

from app.agent.main_agent import openai_compatible_model
from app.core.settings import Settings
from app.main import create_app


def test_real_chatopenai_adapter_uses_configured_protocol_and_no_retry(tmp_path, monkeypatch):
    captured = []
    original = openai.AsyncOpenAI

    def response(request):
        captured.append(request)
        chunks = []
        for text in ("真实", "适配器", "中文回复"):
            chunks.append(
                "data: "
                + json.dumps(
                    {
                        "id": "test-completion",
                        "object": "chat.completion.chunk",
                        "created": 1,
                        "model": "user-selected-model",
                        "choices": [
                            {"index": 0, "delta": {"content": text}, "finish_reason": None}
                        ],
                    },
                    ensure_ascii=False,
                )
                + "\n\n"
            )
        chunks.append(
            'data: {"id":"test-completion","object":"chat.completion.chunk",'
            '"created":1,"model":"user-selected-model","choices":'
            '[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
        )
        chunks.append("data: [DONE]\n\n")
        return httpx2.Response(
            200, headers={"Content-Type": "text/event-stream"}, content="".join(chunks).encode()
        )

    def client(**kwargs):
        kwargs["http_client"] = httpx2.AsyncClient(transport=httpx2.MockTransport(response))
        return original(**kwargs)

    monkeypatch.setattr(openai, "AsyncOpenAI", client)
    constructed = []

    def factory(config):
        model = openai_compatible_model(config)
        constructed.append(model)
        return model

    settings = Settings(tmp_path / "memory", tmp_path / "config")
    with TestClient(
        create_app(settings, model_factory=factory), base_url="http://127.0.0.1:8000"
    ) as api:
        headers = auth(api)
        configure(api, headers, model="user-selected-model")
        conversation = api.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
        run = submit(api, headers, conversation, "验证适配器")
        final = finished(api, headers, run["id"])
        assert final["status"] == "completed", final
        message = api.get(f"/api/v1/conversations/{conversation}/messages", headers=headers).json()[
            "items"
        ][-1]
        assert message["content"] == "真实适配器中文回复"
    assert len(captured) == 1
    request = captured[0]
    assert str(request.url) == "https://example.invalid/v1/chat/completions"
    assert request.headers["authorization"] == "Bearer test-only-secret"
    payload = json.loads(request.content)
    assert payload["model"] == "user-selected-model" and payload["stream"] is True
    assert [tool["function"]["name"] for tool in payload["tools"]] == [
        "list_tags",
        "search_memory",
        "read_note",
    ]
    assert constructed[0].max_retries == 0 and constructed[0].use_responses_api is False
    assert constructed[0].root_async_client.is_closed()


def test_real_adapter_http_failure_is_not_retried_or_exposed(tmp_path, monkeypatch):
    captured = []
    original = openai.AsyncOpenAI

    def response(request):
        captured.append(request)
        return httpx2.Response(
            401,
            json={
                "error": {
                    "message": "provider-error test-only-secret",
                    "type": "authentication_error",
                }
            },
        )

    def client(**kwargs):
        kwargs["http_client"] = httpx2.AsyncClient(transport=httpx2.MockTransport(response))
        return original(**kwargs)

    monkeypatch.setattr(openai, "AsyncOpenAI", client)
    settings = Settings(tmp_path / "memory", tmp_path / "config")
    with TestClient(create_app(settings), base_url="http://127.0.0.1:8000") as api:
        headers = auth(api)
        configure(api, headers)
        conversation = api.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
        run = submit(api, headers, conversation)
        final = finished(api, headers, run["id"])
        assert final["status"] == "failed" and final["error"]["code"] == "model_error"
        assert "test-only-secret" not in str(final)
        assert "provider-error" not in str(final)
    assert len(captured) == 1


def test_real_http_chat_then_background_plan_then_next_chat_owns_independent_clients(tmp_path):
    import threading
    import time
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    calls = []

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            calls.append(payload)
            planning = "后台记忆整理器" in payload["messages"][0]["content"]
            result = (
                json.dumps(
                    {"decision": "skip", "reason": "当前没有新增长期知识"}, ensure_ascii=False
                )
                if planning
                else "真实协议回复"
            )
            frames = []
            for text in (result[: len(result) // 2], result[len(result) // 2 :]):
                chunk = {
                    "id": "real-protocol",
                    "object": "chat.completion.chunk",
                    "created": 1,
                    "model": payload["model"],
                    "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}],
                }
                frames.append("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n")
            frames.append("data: [DONE]\n\n")
            body = "".join(frames).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with TestClient(
            create_app(Settings(tmp_path / "memory", tmp_path / "config")),
            base_url="http://127.0.0.1:8000",
        ) as api:
            headers = auth(api)
            response = api.put(
                "/api/v1/agent/config",
                headers=headers,
                json={
                    "base_url": f"http://127.0.0.1:{server.server_port}/v1",
                    "api_key": "temporary-protocol-key",
                    "model": "test-model",
                },
            )
            assert response.status_code == 200
            conversation = api.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
            for text in ("第一轮", "第二轮"):
                run = submit(api, headers, conversation, text)
                assert finished(api, headers, run["id"])["status"] == "completed"
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    jobs = api.get("/api/v1/memory/jobs", headers=headers).json()["items"]
                    job = next((job for job in jobs if job["run_id"] == run["id"]), None)
                    if job and job["status"] not in ("pending", "running"):
                        break
                    time.sleep(0.01)
                assert job["status"] == "skipped", job
            assert len(calls) == 4
            assert sum("tools" in payload for payload in calls) == 2
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
