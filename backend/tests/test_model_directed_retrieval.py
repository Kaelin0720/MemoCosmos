import asyncio
import json
from uuid import uuid4

import pytest
from agent_helpers import ScriptedModel, auth, configure, finished, submit
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage
from pydantic import ValidationError
from test_notes import make_note, make_tag

from app.agent.memory_tools import GraphQuery, SearchQuery, make_memory_tools
from app.core.settings import Settings
from app.main import create_app
from app.services.graph_context import graph_context


@pytest.mark.posix_storage
def test_reading_selected_neighbor_automatically_exposes_its_own_relations(client, token_headers):
    tag = make_tag(client, token_headers)
    leaf = make_note(client, token_headers, [tag["id"]], title="窗口", body="末端独有正文").json()
    middle = make_note(
        client, token_headers, [tag["id"]], title="切片", body=f"中间正文 [窗口](./{leaf['id']}.md)"
    ).json()
    root = make_note(
        client, token_headers, [tag["id"]], title="RAG", body=f"[切片](./{middle['id']}.md)"
    ).json()
    tools = {tool.name: tool for tool in make_memory_tools(client.app.state.knowledge)}

    async def scenario():
        found = json.loads(await tools["search_memory"].ainvoke({"q": "RAG"}))
        assert {item["note_id"] for item in found["items"]} == {root["id"]}
        assert leaf["id"] not in json.dumps(found)
        selected = json.loads(await tools["read_note"].ainvoke({"note_id": middle["id"]}))
        assert "中间正文" in selected["body"]
        assert leaf["id"] in {n["id"] for n in selected["graph"]["nodes"]}
        assert "末端独有正文" not in json.dumps(selected, ensure_ascii=False)
        assert selected["retrieval_control"]["can_continue"]

    asyncio.run(scenario())


@pytest.mark.posix_storage
def test_large_adjacency_can_be_paged_without_skipping_edges(client, token_headers):
    tag = make_tag(client, token_headers)
    children = [
        make_note(client, token_headers, [tag["id"]], title=f"细节{i}", body="邻居私有正文").json()
        for i in range(14)
    ]
    root = make_note(
        client,
        token_headers,
        [tag["id"]],
        title="主题",
        body="\n".join(f"[细节](./{child['id']}.md)" for child in children),
    ).json()
    seen, cursor = set(), None
    for _ in range(20):
        page = graph_context(
            client.app.state.knowledge, [root["id"]], after=cursor, token_budget=1800
        )
        ids = {edge["id"] for edge in page["edges"]}
        assert not ids & seen
        seen |= ids
        assert "邻居私有正文" not in json.dumps(page, ensure_ascii=False)
        if not page["continuations"]:
            break
        following = page["continuations"][0]["after"]
        assert following is not None and following != cursor
        cursor = following
    else:
        pytest.fail("relationship pagination did not finish")
    assert len(seen) == len(children)


@pytest.mark.posix_storage
@pytest.mark.parametrize("expand", [False, True])
def test_agent_decides_to_stop_or_follow_more_than_three_relationships(tmp_path, expand):
    titles = ["LangChain", "RAG", "切片策略", "重叠窗口", "窗口计算"]

    class ChoosingModel(ScriptedModel):
        def _response(self, messages):
            self._inputs.append(messages)
            if messages[-1].type == "human":
                name, args = "search_memory", {"q": "LangChain"}
            else:
                result = json.loads(messages[-1].content)
                self._tool_results.append(result)
                assert result["retrieval_control"]["can_continue"]
                index = len(self._tool_results)
                if not expand or index == len(titles):
                    source = (
                        result.get("citation") or f"yihe://notes/{result['items'][0]['note_id']}"
                    )
                    return AIMessage(content=f"已有足够依据回答，来源 {source}")
                selected = next(n for n in result["graph"]["nodes"] if n["title"] == titles[index])
                name, args = "read_note", {"note_id": selected["id"]}
            return AIMessage(
                content="",
                tool_calls=[dict(name=name, args=args, id=str(uuid4()), type="tool_call")],
            )

    model = ChoosingModel(delay=0)
    with TestClient(
        create_app(
            Settings(tmp_path / "memory", tmp_path / "config"), model_factory=lambda _: model
        ),
        base_url="http://127.0.0.1:8000",
    ) as client:
        headers = auth(client)
        root_tag = make_tag(client, headers, "LangChain")
        other_tag = make_tag(client, headers, "细节")
        unrelated = make_note(
            client, headers, [other_tag["id"]], title="烹饪", body="不应该读取的无关正文"
        ).json()
        following = None
        notes = []
        for title in reversed(titles):
            body = f"{title}的正文"
            if following:
                body += f"\n[进一步说明](./{following['id']}.md)"
            if title == titles[0]:
                body += f"\n[无关分支](./{unrelated['id']}.md)"
            following = make_note(
                client,
                headers,
                [root_tag["id"] if title == titles[0] else other_tag["id"]],
                title=title,
                body=body,
            ).json()
            notes.append(following)
        # A cycle at the leaf must not cause an automatic revisit of its parent.
        leaf = notes[0]
        client.patch(
            f"/api/v1/notes/{leaf['id']}",
            headers=headers,
            json={"expected_version": 1, "body": f"答案正文 [上一层](./{notes[1]['id']}.md)"},
        )
        configure(client, headers)
        conversation = client.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
        run = submit(client, headers, conversation, "LangChain中的窗口计算如何理解")
        final = finished(client, headers, run["id"])
        assert final["status"] == "completed", (
            final.get("error"),
            [(r.get("title"), r.get("retrieval_control")) for r in model._tool_results],
        )
        assert len(model._tool_results) == (len(titles) if expand else 1)
        assert "不应该读取的无关正文" not in json.dumps(model._tool_results, ensure_ascii=False)
        read_ids = [r["note_id"] for r in model._tool_results if "note_id" in r]
        assert len(set(read_ids)) == len(read_ids)
        if expand:
            assert read_ids[-1] == leaf["id"]
        else:
            assert read_ids == []


@pytest.mark.posix_storage
def test_budget_stop_does_not_continue_reading_database(client, token_headers, monkeypatch):
    tag = make_tag(client, token_headers)
    note = make_note(client, token_headers, [tag["id"]], body="必要正文" * 2000).json()
    knowledge = client.app.state.knowledge
    tools = {tool.name: tool for tool in make_memory_tools(knowledge, budget=900)}
    original, reads = knowledge.notes.get, []

    def counted(identifier):
        reads.append(identifier)
        return original(identifier)

    monkeypatch.setattr(knowledge.notes, "get", counted)

    async def scenario():
        result = json.loads(await tools["read_note"].ainvoke({"note_id": note["id"]}))
        assert result["truncated"] and not result["retrieval_control"]["can_continue"]
        assert result["retrieval_control"]["stop_reason"] == "evidence_budget"
        previous = len(reads)
        stopped = json.loads(await tools["read_note"].ainvoke({"note_id": note["id"]}))
        assert stopped["retrieval_control"]["stop_reason"] == "evidence_budget"
        assert len(reads) == previous

    asyncio.run(scenario())


def test_model_cannot_request_fixed_multihop_expansion():
    with pytest.raises(ValidationError):
        SearchQuery(max_hops=3)
    with pytest.raises(ValidationError):
        GraphQuery(note_ids=[str(uuid4())], max_hops=3)
    with pytest.raises(ValidationError):
        GraphQuery(note_ids=[str(uuid4()), str(uuid4())], after=str(uuid4()))


@pytest.mark.posix_storage
def test_read_conflict_can_be_rechecked_instead_of_caching_the_error(
    client, token_headers, monkeypatch
):
    tag = make_tag(client, token_headers)
    note = make_note(client, token_headers, [tag["id"]], title="主题", body="已确认知识").json()
    knowledge = client.app.state.knowledge
    tools = {tool.name: tool for tool in make_memory_tools(knowledge)}
    original, calls = knowledge.notes.get, 0

    def changed_on_final_check(identifier):
        nonlocal calls
        calls += 1
        current = original(identifier)
        if calls == 4:
            return current.model_copy(update={"version": current.version + 1})
        return current

    monkeypatch.setattr(knowledge.notes, "get", changed_on_final_check)

    async def scenario():
        conflict = json.loads(await tools["read_note"].ainvoke({"note_id": note["id"]}))
        assert conflict["error"] == "version_conflict"
        retry = json.loads(await tools["read_note"].ainvoke({"note_id": note["id"]}))
        assert retry["body"] == "已确认知识" and not retry.get("already_read")

    asyncio.run(scenario())


@pytest.mark.posix_storage
def test_search_discards_excerpt_changed_while_collecting_relationships(
    client, token_headers, monkeypatch
):
    tag = make_tag(client, token_headers)
    note = make_note(client, token_headers, [tag["id"]], title="RAG", body="已确认知识").json()
    knowledge = client.app.state.knowledge
    original, calls = knowledge.notes.get, 0

    def changed_on_final_check(identifier):
        nonlocal calls
        calls += 1
        current = original(identifier)
        if calls >= 4:
            return current.model_copy(update={"version": current.version + 1})
        return current

    monkeypatch.setattr(knowledge.notes, "get", changed_on_final_check)
    result = knowledge.search(q="RAG")
    assert result["items"] == [] and result["truncated"]
    assert all(n["id"] != note["id"] for n in result["graph"]["nodes"])
