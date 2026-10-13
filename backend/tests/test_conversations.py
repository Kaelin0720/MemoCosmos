import time
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from agent_helpers import ScriptedModel, auth, configure, decode_events, finished, submit
from fastapi.testclient import TestClient
from test_tags import assert_error

from app.core.settings import Settings
from app.main import create_app


@pytest.fixture
def agent_client(tmp_path):
    model = ScriptedModel()
    settings = Settings(tmp_path / "memory", tmp_path / "config")
    application = create_app(settings, model_factory=lambda config: model)
    with TestClient(application, base_url="http://127.0.0.1:8000") as client:
        headers = auth(client)
        configure(client, headers)
        yield client, headers, model


def new_conversation(client, headers):
    response = client.post("/api/v1/conversations", headers=headers, json={})
    assert response.status_code == 201
    return response.json()["id"]


def test_real_deep_agents_stream_and_read_only_tag_tool(agent_client):
    client, headers, model = agent_client
    tag = client.post(
        "/api/v1/tags", headers=headers, json={"name": "RAG", "description": "实际标签"}
    ).json()
    conversation = new_conversation(client, headers)
    run = submit(client, headers, conversation, "请查标签 RAG")
    response = client.get(f"/api/v1/runs/{run['id']}/events", headers=headers)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "no-store"
    events = decode_events(response)
    assert events[0][0] == "run.snapshot"
    assert events[-1][0] == "run.completed", events
    body = ""
    for event, data in events:
        if event == "run.snapshot":
            body = data["message"]["content"]
        elif event == "message.delta":
            body += data["delta"]
    assert body == events[-1][1]["message"]["content"] == "查到标签：RAG。"
    assert all(
        set(names) == {"list_tags", "search_memory", "read_note"} for names in model._bound_names
    )
    assert model._tool_results[0]["items"][0]["id"] == tag["id"]
    messages = client.get(f"/api/v1/conversations/{conversation}/messages", headers=headers).json()[
        "items"
    ]
    assert [item["role"] for item in messages] == ["user", "assistant"]
    assert messages[0]["content"] == "请查标签 RAG"
    assert messages[1]["content"] == body
    assert client.get("/api/v1/tags", headers=headers).json()["items"] == [tag]


def test_missing_config_saves_original_without_fake_reply(client, token_headers, monkeypatch):
    for key in ("CHAT_MODEL_BASE_URL", "CHAT_MODEL_NAME", "CHAT_MODEL_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    conversation = new_conversation(client, token_headers)
    run = submit(client, token_headers, conversation, "  原始消息保持空白  ")
    final = finished(client, token_headers, run["id"])
    assert final["status"] == "failed"
    assert final["error"]["code"] == "model_not_configured"
    items = client.get(
        f"/api/v1/conversations/{conversation}/messages", headers=token_headers
    ).json()["items"]
    assert items[0]["content"] == "  原始消息保持空白  "
    assert items[0]["status"] == "completed"
    assert items[1]["content"] == "" and items[1]["status"] == "failed"
    assert (
        client.get(f"/api/v1/conversations/{conversation}", headers=token_headers).json()[
            "active_run_id"
        ]
        is None
    )


def test_idempotency_and_busy_never_insert_extra_records(agent_client):
    client, headers, model = agent_client
    model.delay = 0.02
    conversation = new_conversation(client, headers)
    client_id = str(uuid4())
    first = submit(client, headers, conversation, "相同原文", client_id)
    same = submit(client, headers, conversation, "相同原文", client_id)
    assert same["id"] == first["id"]
    assert_error(
        client.post(
            f"/api/v1/conversations/{conversation}/messages",
            headers=headers,
            json={
                "client_message_id": client_id,
                "content": "不同原文",
            },
        ),
        409,
        "idempotency_conflict",
    )
    assert_error(
        client.post(
            f"/api/v1/conversations/{conversation}/messages",
            headers=headers,
            json={
                "client_message_id": str(uuid4()),
                "content": "第二条",
            },
        ),
        409,
        "conversation_busy",
    )
    by_id = client.get(
        f"/api/v1/conversations/{conversation}/runs/by-client-message/{client_id}", headers=headers
    )
    assert by_id.json()["id"] == first["id"]
    assert (
        client.get(
            f"/api/v1/conversations/{conversation.upper()}/runs/by-client-message/{client_id.upper()}",
            headers=headers,
        ).json()["id"]
        == first["id"]
    )
    assert finished(client, headers, first["id"])["status"] == "completed"
    repeated = submit(client, headers, conversation, "相同原文", client_id)
    assert repeated["id"] == first["id"]
    assert len(model._inputs) == 1
    assert (
        len(
            client.get(f"/api/v1/conversations/{conversation}/messages", headers=headers).json()[
                "items"
            ]
        )
        == 2
    )


def test_concurrent_submits_only_accept_one(agent_client):
    client, headers, model = agent_client
    model.delay = 0.03
    conversation = new_conversation(client, headers)

    def post(number):
        return client.post(
            f"/api/v1/conversations/{conversation}/messages",
            headers=headers,
            json={
                "client_message_id": str(uuid4()),
                "content": f"竞争 {number}",
            },
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(post, [1, 2]))
    assert sorted(response.status_code for response in responses) == [202, 409]
    accepted = next(response.json() for response in responses if response.status_code == 202)
    client.post(f"/api/v1/runs/{accepted['id']}/cancel", headers=headers, json={})
    assert (
        len(
            client.get(f"/api/v1/conversations/{conversation}/messages", headers=headers).json()[
                "items"
            ]
        )
        == 2
    )


def test_cancellation_preserves_partial_reply_and_stops_task(agent_client):
    client, headers, model = agent_client
    model.delay = 0.02
    model.reply = "一段足够长的部分回复。" * 30
    conversation = new_conversation(client, headers)
    run = submit(client, headers, conversation)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        messages = client.get(
            f"/api/v1/conversations/{conversation}/messages", headers=headers
        ).json()["items"]
        if messages[-1]["content"]:
            break
        time.sleep(0.005)
    assert messages[-1]["content"]
    stopped = client.post(f"/api/v1/runs/{run['id']}/cancel", headers=headers, json={}).json()
    assert stopped["status"] == "cancelled"
    time.sleep(0.04)
    partial = client.get(f"/api/v1/conversations/{conversation}/messages", headers=headers).json()[
        "items"
    ][-1]
    time.sleep(0.04)
    assert (
        client.get(f"/api/v1/conversations/{conversation}/messages", headers=headers).json()[
            "items"
        ][-1]
        == partial
    )
    assert partial["content"] and len(partial["content"]) < len(model.reply)
    assert partial["status"] == "cancelled"
    assert model._closed == 1
    assert (
        client.post(f"/api/v1/runs/{run['id']}/cancel", headers=headers, json={}).json() == stopped
    )
    events = decode_events(client.get(f"/api/v1/runs/{run['id']}/events", headers=headers))
    assert [event for event, _ in events] == ["run.snapshot", "run.cancelled"]
    assert events[-1][1]["message"] == partial


def test_history_recent_pages_title_and_budget(agent_client):
    client, headers, model = agent_client
    model.delay = 0
    conversation = new_conversation(client, headers)
    for number in range(14):
        run = submit(client, headers, conversation, f"第 {number} 轮")
        assert finished(client, headers, run["id"])["status"] == "completed"
    assert finished(client, headers, run["id"])["context_truncated"]
    context = [item for item in model._inputs[-1] if item.type != "system"]
    assert len(context) == 25
    assert context[0].content == "第 1 轮"
    page = client.get(
        f"/api/v1/conversations/{conversation}/messages?limit=3", headers=headers
    ).json()
    assert [item["seq"] for item in page["items"]] == [26, 27, 28]
    assert page["has_more"]
    earlier = client.get(
        f"/api/v1/conversations/{conversation}/messages?limit=3&before_seq=26", headers=headers
    ).json()
    assert [item["seq"] for item in earlier["items"]] == [23, 24, 25]
    details = client.get(f"/api/v1/conversations/{conversation}", headers=headers).json()
    assert details["title"] == "第 0 轮" and details["active_run_id"] is None
    next_run = submit(client, headers, conversation, "新" * 20000)
    final = finished(client, headers, next_run["id"])
    assert final["status"] == "completed"
    assert sum(len(item.content) for item in model._inputs[-1] if item.type != "system") <= 32000


def test_provider_errors_and_tracing_are_sanitized(agent_client, monkeypatch, caplog):
    client, headers, model = agent_client
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGCHAIN_TRACING_V2", "true")
    trace_uploads = []
    from langsmith import Client

    monkeypatch.setattr(Client, "create_run", lambda *args, **kwargs: trace_uploads.append(True))
    monkeypatch.setattr(Client, "update_run", lambda *args, **kwargs: trace_uploads.append(True))
    model.failure = True
    conversation = new_conversation(client, headers)
    run = submit(client, headers, conversation)
    final = finished(client, headers, run["id"])
    assert final["status"] == "failed" and final["error"]["code"] == "model_error"
    assert model._trace_flags == [False]
    assert trace_uploads == []
    events = client.get(f"/api/v1/runs/{run['id']}/events", headers=headers)
    assert "provider-error" not in events.text + caplog.text
    assert "test-only-secret" not in events.text + caplog.text
    assert decode_events(events)[-1][1]["message"]["content"] == ""


def test_character_budget_removes_whole_oldest_turn_and_keeps_history(agent_client):
    client, headers, model = agent_client
    model.delay = 0
    conversation = new_conversation(client, headers)
    for text in ("旧" * 10000, "新" * 10000, "本" * 20000):
        run = submit(client, headers, conversation, text)
        final = finished(client, headers, run["id"])
        assert final["status"] == "completed"
    context = [item for item in model._inputs[-1] if item.type != "system"]
    assert final["context_truncated"] and len(context) == 1
    # 预留工具证据预算，完整旧原文仍保存在下方历史中。
    assert context[-1].content == "本" * 20000
    assert sum(len(item.content) for item in context) <= 32000
    assert (
        len(
            client.get(f"/api/v1/conversations/{conversation}/messages", headers=headers).json()[
                "items"
            ]
        )
        == 6
    )


def test_stream_failure_keeps_partial_text_without_error_as_body(agent_client):
    client, headers, model = agent_client
    model.fail_after_chunks = 3
    conversation = new_conversation(client, headers)
    run = submit(client, headers, conversation)
    final = finished(client, headers, run["id"])
    assert final["status"] == "failed"
    items = client.get(f"/api/v1/conversations/{conversation}/messages", headers=headers).json()[
        "items"
    ]
    assert items[1]["content"] == model.reply[:6] and items[1]["status"] == "failed"
    assert "provider-error" not in items[1]["content"]


def test_tag_tool_is_limited_and_returns_real_excerpt(agent_client):
    client, headers, model = agent_client
    for number in range(25):
        assert (
            client.post(
                "/api/v1/tags",
                headers=headers,
                json={
                    "name": f"RAG {number}",
                    "description": "描述" * 200,
                },
            ).status_code
            == 201
        )
    conversation = new_conversation(client, headers)
    run = submit(client, headers, conversation, "查标签 RAG")
    assert finished(client, headers, run["id"])["status"] == "completed"
    result = model._tool_results[0]
    assert len(result["items"]) == 20 and result["has_more"]
    assert all(
        len(item["description"]) == 200 and item["description_truncated"]
        for item in result["items"]
    )
    assert client.get("/api/v1/tags", headers=headers).json()["total"] == 25


def test_secret_echo_across_chunks_never_enters_history(agent_client):
    client, headers, model = agent_client
    model.reply = "供应商文本 test-only-secret 中文。"
    conversation = new_conversation(client, headers)
    run = submit(client, headers, conversation)
    final = finished(client, headers, run["id"])
    assert final["status"] == "completed"
    events = client.get(f"/api/v1/runs/{run['id']}/events", headers=headers)
    assert "test-only-secret" not in events.text
    assert "敏感配置已隐藏" in events.text
    database = client.app.state.database_path
    assert b"test-only-secret" not in database.read_bytes()


@pytest.mark.parametrize("kind", ["timeout", "steps", "output"])
def test_limits_finish_with_real_failure_and_keep_partial(tmp_path, kind):
    settings = Settings(
        tmp_path / "memory",
        tmp_path / "config",
        run_timeout_seconds=0.03 if kind == "timeout" else 120,
        agent_max_steps=3 if kind == "steps" else 12,
        output_max_chars=5 if kind == "output" else 20000,
    )
    model = ScriptedModel(delay=0.01 if kind == "timeout" else 0, repeat_tools=kind == "steps")
    with TestClient(
        create_app(settings, model_factory=lambda config: model), base_url="http://127.0.0.1:8000"
    ) as client:
        headers = auth(client)
        configure(client, headers)
        conversation = new_conversation(client, headers)
        run = submit(client, headers, conversation)
        final = finished(client, headers, run["id"])
        assert final["status"] == "failed", final
        assert (
            final["error"]["code"]
            == {"timeout": "model_timeout", "steps": "agent_step_limit", "output": "output_limit"}[
                kind
            ]
        )
        items = client.get(
            f"/api/v1/conversations/{conversation}/messages", headers=headers
        ).json()["items"]
        assert items[0]["status"] == "completed"
        assert len(items[1]["content"]) <= settings.output_max_chars
        assert (
            client.get(f"/api/v1/conversations/{conversation}", headers=headers).json()[
                "active_run_id"
            ]
            is None
        )


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"client_message_id": "invalid", "content": "test"},
        {"client_message_id": str(uuid4()), "content": " "},
        {"client_message_id": str(uuid4()), "content": "x" * 20001},
        {"client_message_id": str(uuid4()), "content": None},
        {"client_message_id": str(uuid4()), "content": "test", "extra": True},
    ],
)
def test_invalid_messages_leave_no_partial_data(agent_client, body):
    client, headers, _ = agent_client
    conversation = new_conversation(client, headers)
    assert_error(
        client.post(f"/api/v1/conversations/{conversation}/messages", headers=headers, json=body),
        422,
        "validation_error",
    )
    assert (
        client.get(f"/api/v1/conversations/{conversation}/messages", headers=headers).json()[
            "items"
        ]
        == []
    )
