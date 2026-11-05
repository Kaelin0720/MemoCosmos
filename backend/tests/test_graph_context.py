import asyncio
import json
from uuid import uuid4

import pytest
from agent_helpers import ScriptedModel, auth, configure, finished, submit
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, ToolMessage
from test_notes import make_note, make_tag, note_path

from app.agent.memory_tools import make_memory_tools
from app.core.settings import Settings
from app.main import create_app
from app.services.graph_context import graph_context, has_knowledge


def linked_notes(client, headers):
    tag = make_tag(client, headers, "LangChain")
    leaf = make_note(client, headers, [tag["id"]], title="长期记忆", body="保留跨会话信息").json()
    middle = make_note(
        client, headers, [tag["id"]], title="检索", body=f"[记忆](./{leaf['id']}.md)"
    ).json()
    root = make_note(
        client, headers, [tag["id"]], title="LangChain", body=f"[检索](./{middle['id']}.md)"
    ).json()
    return root, middle, leaf


@pytest.mark.posix_storage
def test_graph_keeps_original_direction_evidence_and_versions(client, token_headers):
    root, middle, leaf = linked_notes(client, token_headers)
    result = graph_context(client.app.state.knowledge, [leaf["id"]], token_budget=4000)
    assert {node["id"] for node in result["nodes"]} == {middle["id"], leaf["id"]}
    assert {(edge["source"], edge["target"]) for edge in result["edges"]} == {
        (middle["id"], leaf["id"]),
    }
    assert all(edge["kind"] == "reference" and edge["evidence"] for edge in result["edges"])
    assert all(edge["source_version"] == edge["target_version"] == 1 for edge in result["edges"])
    assert all(node["citation"].endswith(node["id"]) for node in result["nodes"])
    assert result["budget"]["used_tokens"] <= 4000
    assert result["traversal"]["max_hops"] == 1
    search = client.app.state.knowledge.search(q="LangChain")
    assert search["graph"]["nodes"] and search["graph"]["edges"]


@pytest.mark.posix_storage
def test_graph_omits_stale_routes_and_shares_tool_cache(client, token_headers):
    root, middle, _ = linked_notes(client, token_headers)
    tools = {tool.name: tool for tool in make_memory_tools(client.app.state.knowledge)}

    async def run():
        args = dict(note_ids=[root["id"]], token_budget=3000)
        initial = json.loads(await tools["explore_memory_graph"].ainvoke(args))
        assert initial["edges"]
        repeated = json.loads(await tools["explore_memory_graph"].ainvoke(args))
        assert repeated["already_read"]

    asyncio.run(run())
    tiny = graph_context(client.app.state.knowledge, [root["id"]], token_budget=100)
    assert tiny["truncated"] and tiny["budget"]["used_tokens"] <= 100
    note_path(client, middle["id"]).write_text("# 检索\n\n未经确认的外部变动")
    result = graph_context(client.app.state.knowledge, [root["id"]])
    assert result["edges"] == []
    assert all(node["id"] != middle["id"] for node in result["nodes"])


@pytest.mark.posix_storage
def test_graph_lights_only_documents_with_body_and_updates_after_save(client, token_headers):
    tag = make_tag(client, token_headers)
    note = make_note(
        client, token_headers, [tag["id"]], body="# 主题\n\n## 来源\n\n2026-10-22"
    ).json()
    graph = client.app.state.knowledge.graph()
    assert next(n for n in graph["nodes"] if n["id"] == note["id"])["has_knowledge"] is False
    response = client.patch(
        f"/api/v1/notes/{note['id']}",
        headers=token_headers,
        json={"expected_version": 1, "body": "# 主题\n\n知识正文"},
    )
    assert response.status_code == 200
    node = next(n for n in client.app.state.knowledge.graph()["nodes"] if n["id"] == note["id"])
    assert node["has_knowledge"] is True and node["version"] == 2


@pytest.mark.parametrize(
    "body",
    ["", "# 标题\n\n", "---\ntags: [RAG]\n---\n# 标题\n", "# 标题\n\n## Source\n\n2026-10-22"],
)
def test_metadata_is_not_knowledge(body):
    assert not has_knowledge(body)


def test_provenance_section_does_not_hide_later_knowledge():
    assert has_knowledge("# 主题\n\n## 来源\n\n2026-10-22\n\n## 概念\n\n真正的知识正文")


@pytest.mark.posix_storage
def test_graph_drops_a_document_that_changes_during_retrieval(client, token_headers, monkeypatch):
    root, middle, _ = linked_notes(client, token_headers)
    knowledge = client.app.state.knowledge
    original, reads = knowledge.notes.get, 0

    def change_on_recheck(identifier):
        nonlocal reads
        note = original(identifier)
        if identifier == root["id"]:
            reads += 1
            if reads > 1:
                return note.model_copy(update={"version": note.version + 1})
        return note

    monkeypatch.setattr(knowledge.notes, "get", change_on_recheck)
    result = graph_context(knowledge, [root["id"]], token_budget=4000)
    assert result["truncated"] and root["id"] in result["unavailable_note_ids"]
    assert all(root["id"] not in (edge["source"], edge["target"]) for edge in result["edges"])
    assert any(node["id"] == middle["id"] for node in result["nodes"])


@pytest.mark.posix_storage
def test_real_agent_exposes_graph_to_the_model_for_reasoning(tmp_path):
    class GraphModel(ScriptedModel):
        def _response(self, messages):
            self._inputs.append(messages)
            last = messages[-1]
            if last.type == "human":
                name, args = "search_memory", {"q": "LangChain"}
            elif isinstance(last, ToolMessage) and last.name == "search_memory":
                result = json.loads(last.content)
                self._tool_results.append(result)
                name, args = (
                    "explore_memory_graph",
                    {
                        "note_ids": [result["items"][0]["note_id"]],
                        "token_budget": 3000,
                    },
                )
            else:
                result = json.loads(last.content)
                self._tool_results.append(result)
                assert result["already_provided_edge_ids"]
                assert self._tool_results[0]["graph"]["edges"]
                return AIMessage(
                    content="关系依据已提供；引用关系不等于因果，进一步结论需要正文支持。"
                )
            return AIMessage(
                content="",
                tool_calls=[dict(name=name, args=args, id=str(uuid4()), type="tool_call")],
            )

    model = GraphModel(delay=0)
    with TestClient(
        create_app(
            Settings(tmp_path / "memory", tmp_path / "config"), model_factory=lambda _: model
        ),
        base_url="http://127.0.0.1:8000",
    ) as client:
        headers = auth(client)
        linked_notes(client, headers)
        configure(client, headers)
        conversation = client.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
        run = submit(client, headers, conversation, "LangChain和记忆之间是什么关系")
        assert finished(client, headers, run["id"])["status"] == "completed"
        assert model._tool_results[-1]["already_provided_edge_ids"]
