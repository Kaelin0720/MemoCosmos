import asyncio
import time
from pathlib import Path

import pytest
from agent_helpers import auth, configure
from fastapi.testclient import TestClient
from mcp import Client
from sqlalchemy import func, select
from test_notes import make_note, make_tag

from app.core.errors import ApiError
from app.core.settings import Settings
from app.db.models import AgentRun, ExternalTurn, MemoryRelation, Message
from app.integrations.mcp_server import create_server
from app.main import create_app
from app.schemas.integrations import RecallRequest
from app.services.recall_sessions import RecallSessions


def turn(**changes):
    return dict(
        source="codex",
        session_id="host-session",
        turn_id="host-turn",
        user="我今天学习了RAG与向量检索",
        assistant="RAG使用检索材料补充上下文",
        occurred_at="2026-10-24T20:30:00+08:00",
        **changes,
    )


def capture(client, headers, payload=None):
    response = client.post("/api/v1/integrations/turns", headers=headers, json=payload or turn())
    assert response.status_code == 200, response.text
    return response.json()


def wait_job(client, headers, identifier):
    for _ in range(300):
        response = client.get(f"/api/v1/integrations/jobs/{identifier}", headers=headers)
        assert response.status_code == 200, response.text
        result = response.json()
        if result["status"] not in {"pending", "running"}:
            return result
        time.sleep(0.01)
    raise AssertionError("external memory job did not finish")


@pytest.mark.posix_storage
def test_external_turn_curates_real_notes_and_preserves_provenance(tmp_path):
    inputs = []

    async def planner(config, context):
        inputs.append(context)
        return dict(
            decision="apply",
            reason="记录学习知识",
            notes=[
                dict(
                    title="RAG",
                    body="检索材料用于补充上下文",
                    evidence="我今天学习了RAG与向量检索",
                    tags=["检索"],
                ),
                dict(
                    title="向量检索",
                    body="根据向量相似度召回",
                    evidence="我今天学习了RAG与向量检索",
                    tags=["检索"],
                ),
            ],
            relations=[
                dict(
                    source_index=0,
                    target_index=1,
                    relation="关联学习",
                    evidence="我今天学习了RAG与向量检索",
                )
            ],
        )

    settings = Settings(tmp_path / "memory", tmp_path / "config")
    with TestClient(
        create_app(settings, memory_planner=planner), base_url="http://127.0.0.1:8000"
    ) as client:
        headers = auth(client)
        configure(client, headers)
        client.put("/api/v1/memory/settings", headers=headers, json={"auto_memory": True})
        accepted = capture(client, headers)
        job = wait_job(client, headers, accepted["job_id"])
        assert job["status"] == "completed", job
        assert job["source"] == {
            "app": "codex",
            "session_id": "host-session",
            "turn_id": "host-turn",
        }
        assert len(job["notes"]) == 2
        assert inputs[0]["source"]["app"] == "codex"
        assert inputs[0]["source_message_time"] == "2026-10-24T12:30:00.000000+00:00"
        graph = client.get("/api/v1/memory/graph", headers=headers).json()
        assert len(graph["nodes"]) == 2 and graph["edges"]
        duplicate = capture(client, headers)
        assert duplicate["duplicate"] and duplicate["job_id"] == accepted["job_id"]
        assert len(inputs) == 1
        response = client.post(
            "/api/v1/integrations/turns", headers=headers, json={**turn(), "assistant": "不同内容"}
        )
        assert response.status_code == 409
        with client.app.state.session_factory() as db:
            assert db.scalar(select(func.count()).select_from(ExternalTurn)) == 1
            assert db.scalar(select(func.count()).select_from(AgentRun)) == 1
            assert db.scalar(select(func.count()).select_from(Message)) == 2
            facts = list(db.scalars(select(MemoryRelation).where(MemoryRelation.kind == "fact")))
            assert facts and facts[0].source_message_id == job["user_message_id"]
        exported = client.get("/api/v1/memory/export", headers=headers)
        restored = client.post(
            "/api/v1/memory/import",
            headers={**headers, "Content-Type": "application/octet-stream"},
            content=exported.content,
        )
        assert restored.status_code == 200, restored.text
        restored_path = restored.json()["memory_dir"]
    with TestClient(
        create_app(Settings(Path(restored_path), tmp_path / "other-config")),
        base_url="http://127.0.0.1:8000",
    ) as reopened:
        replay = capture(reopened, auth(reopened))
        assert replay["duplicate"] and replay["job_id"] == accepted["job_id"]


@pytest.mark.posix_storage
def test_disabled_capture_records_nothing_and_explicit_remember_still_queues(client, token_headers):
    client.put("/api/v1/memory/settings", headers=token_headers, json={"auto_memory": False})
    assert capture(client, token_headers)["status"] == "disabled"
    with client.app.state.session_factory() as db:
        assert db.scalar(select(func.count()).select_from(ExternalTurn)) == 0
        assert db.scalar(select(func.count()).select_from(Message)) == 0
    explicit = capture(client, token_headers, {**turn(), "user": "请记住RAG是检索增强生成"})
    assert explicit["job_id"]
    # No configured model: the durable job waits instead of pretending to save.
    job = client.get(
        f"/api/v1/integrations/jobs/{explicit['job_id']}", headers=token_headers
    ).json()
    assert job["status"] == "pending" and not job["notes"]


@pytest.mark.parametrize(
    "path,payload",
    [
        ("/api/v1/integrations/turns", turn()),
        ("/api/v1/integrations/recall", {"tool": "list_tags"}),
    ],
)
def test_integration_endpoints_preserve_local_auth_and_origin(client, token_headers, path, payload):
    assert client.post(path, json=payload).status_code == 401
    assert (
        client.post(
            path, headers={**token_headers, "Origin": "https://evil.invalid"}, json=payload
        ).status_code
        == 403
    )
    assert (
        client.post(
            path, headers={**token_headers, "Host": "evil.invalid"}, json=payload
        ).status_code
        == 400
    )


@pytest.mark.parametrize(
    "changes",
    [{"user": ""}, {"source": "../bad"}, {"occurred_at": "2026-10-24"}, {"system": "instructions"}],
)
def test_capture_rejects_invalid_input(client, token_headers, changes):
    assert (
        client.post(
            "/api/v1/integrations/turns", headers=token_headers, json={**turn(), **changes}
        ).status_code
        == 422
    )


@pytest.mark.posix_storage
def test_mcp_protocol_calls_real_local_retrieval_with_shared_budget(client, token_headers):
    tag = make_tag(client, token_headers)
    target = make_note(client, token_headers, [tag["id"]], title="切片", body="分段策略").json()
    root = make_note(
        client, token_headers, [tag["id"]], title="RAG", body=f"[切片](./{target['id']}.md)"
    ).json()

    class ApiBridge:
        def call(self, path, payload=None):
            response = client.request(
                "POST" if payload is not None else "GET", path, headers=token_headers, json=payload
            )
            assert response.status_code == 200, response.text
            return response.json()

    async def scenario():
        async with Client(create_server(ApiBridge())) as mcp:
            tools = (await mcp.list_tools()).tools
            assert {t.name for t in tools} == {
                "search_memory",
                "read_note",
                "explore_memory_graph",
                "list_tags",
                "ingest_turn",
                "get_memory_job",
            }
            assert (
                next(t for t in tools if t.name == "ingest_turn").annotations.read_only_hint
                is False
            )
            search = (await mcp.call_tool("search_memory", {"q": "RAG"})).structured_content
            assert {hit["note_id"] for hit in search["items"]} == {root["id"]}
            read = (
                await mcp.call_tool(
                    "read_note", {"note_id": target["id"], "retrieval_id": search["retrieval_id"]}
                )
            ).structured_content
            assert read["body"] == "分段策略"
            assert read["graph"]["already_provided_edge_ids"]
            assert read["retrieval_control"]["remaining_reads"] == 10
            again = (
                await mcp.call_tool(
                    "read_note", {"note_id": target["id"], "retrieval_id": search["retrieval_id"]}
                )
            ).structured_content
            assert again["already_read"]

    asyncio.run(scenario())


def test_recall_expiry_capacity_and_validation(client):
    sessions = RecallSessions(client.app.state.knowledge, ttl=-1, capacity=1)

    async def scenario():
        result = await sessions.call(RecallRequest(tool="list_tags"))
        with pytest.raises(ApiError) as expired:
            await sessions.call(
                RecallRequest(tool="list_tags", retrieval_id=result["retrieval_id"])
            )
        assert expired.value.code == "retrieval_expired"
        with pytest.raises(ApiError) as invalid:
            await sessions.call(RecallRequest(tool="search_memory", arguments={"max_hops": 3}))
        assert invalid.value.code == "validation_error"
        full = RecallSessions(client.app.state.knowledge, capacity=0)
        with pytest.raises(ApiError) as exhausted:
            await full.call(RecallRequest(tool="list_tags"))
        assert exhausted.value.code == "retrieval_capacity"

    asyncio.run(scenario())
