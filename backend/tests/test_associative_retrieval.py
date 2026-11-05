import asyncio
import json

import pytest
from test_notes import make_note, make_tag, note_path

from app.agent.memory_tools import make_memory_tools


def search(client, headers, **params):
    response = client.get("/api/v1/memory/search", headers=headers, params=params)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.posix_storage
def test_tag_first_documents_with_relationships_but_no_automatic_expansion(client, token_headers):
    framework = make_tag(client, token_headers, "LangChain")
    retrieval = make_tag(client, token_headers, "RAG")
    memory = make_tag(client, token_headers, "记忆")
    leaf = make_note(
        client, token_headers, [memory["id"]], title="长期存储", body="保留必要事实"
    ).json()
    middle = make_note(
        client,
        token_headers,
        [retrieval["id"]],
        title="证据检索",
        body=f"读取[长期存储](./{leaf['id']}.md)",
    ).json()
    root = make_note(
        client,
        token_headers,
        [framework["id"]],
        title="框架基础",
        body=f"使用[证据检索](./{middle['id']}.md)",
    ).json()
    unrelated = make_note(
        client,
        token_headers,
        [memory["id"]],
        title="LangChain 提及",
        body="这份其他领域的文章含有相同关键词",
    ).json()
    result = search(client, token_headers, q="帮我找下LangChain相关知识")
    assert result["routing"]["tags"] == [{"id": framework["id"], "name": "LangChain"}]
    hits = {hit["note_id"]: hit for hit in result["items"]}
    assert set(hits) == {root["id"]}
    assert unrelated["id"] not in hits
    assert hits[root["id"]]["hop"] == 0
    assert result["routing"]["strategy"] == "documents_then_model_directed_relations"
    assert result["routing"]["expansion"] == "model_decides"
    assert {node["id"] for node in result["graph"]["nodes"]} == {root["id"], middle["id"]}
    assert leaf["id"] not in json.dumps(result)
    # A backreference must not turn search into an automatic recursive read.
    client.patch(
        f"/api/v1/notes/{leaf['id']}",
        headers=token_headers,
        json={"expected_version": 1, "body": f"回到[框架基础](./{root['id']}.md)"},
    )
    cyclic = search(client, token_headers, q="LangChain")
    assert {hit["note_id"] for hit in cyclic["items"]} == {root["id"]}


@pytest.mark.posix_storage
def test_strict_tag_intersection_budget_and_deleted_route(client, token_headers):
    tag = make_tag(client, token_headers, "RAG")
    other = make_tag(client, token_headers, "工作")
    target = make_note(
        client, token_headers, [other["id"]], title="不相关正文", body="中文事实" * 1500
    ).json()
    source = make_note(
        client,
        token_headers,
        [tag["id"]],
        title="RAG",
        body=f"## 检索\n\n{'知识内容' * 1000}\n\n[下一层](./{target['id']}.md)",
    ).json()
    result = search(client, token_headers, q="RAG", tag_ids=tag["id"], token_budget=120)
    assert all(hit["note_id"] == source["id"] for hit in result["items"])
    assert all(node["id"] == source["id"] for node in result["graph"]["nodes"])
    assert result["budget"]["used_tokens"] <= 120
    assert result["budget"]["excerpt_characters"] <= 8000
    assert result["truncated"]
    # A changed file invalidates the traversal route, even when its index has
    # not yet noticed the edit. Its downstream note must not be returned.
    note_path(client, source["id"]).write_text("# RAG\n\n外部未确认修改")
    result = search(client, token_headers, q="RAG")
    assert result["items"] == []


@pytest.mark.posix_storage
def test_alias_routing_graph_hierarchy_and_no_invented_edges(client, token_headers):
    tag = make_tag(client, token_headers, "RAG")
    a = make_note(client, token_headers, [tag["id"]], title="分块", body="按标题划分").json()
    b = make_note(
        client, token_headers, [tag["id"]], title="召回", body=f"参见[分块](./{a['id']}.md)"
    ).json()
    client.patch(f"/api/v1/tags/{tag['id']}", headers=token_headers, json={"name": "检索增强"})
    assert search(client, token_headers, q="RAG")["routing"]["tags"][0]["name"] == "检索增强"
    graph = client.get("/api/v1/memory/graph", headers=token_headers).json()
    assert len(graph["edges"]) == 1
    assert len(graph["regions"]) == 1
    assert len([node for node in graph["nodes"] if node["kind"] == "star"]) == 1
    assert all(node["weight"] == 2 for node in graph["nodes"])
    assert graph["edges"][0]["weight"] == 0.8
    assert {a["id"], b["id"]} == set(graph["regions"][0]["node_ids"])


@pytest.mark.posix_storage
def test_tool_cache_skips_duplicate_database_traversal(client, token_headers, monkeypatch):
    tag = make_tag(client, token_headers)
    make_note(client, token_headers, [tag["id"]])
    knowledge = client.app.state.knowledge
    original, calls = knowledge.search, []

    def counted(**kwargs):
        calls.append(kwargs)
        return original(**kwargs)

    monkeypatch.setattr(knowledge, "search", counted)

    async def run():
        tool = make_memory_tools(knowledge)[0]
        await tool.ainvoke({"q": "RAG"})
        repeated = json.loads(await tool.ainvoke({"q": "RAG"}))
        assert repeated["already_read"]

    asyncio.run(run())
    assert len(calls) == 1


@pytest.mark.parametrize(
    "params", [{"max_hops": 1}, {"max_hops": 4}, {"max_hops": -1}, {"token_budget": 99}]
)
def test_request_cannot_remove_retrieval_limits(client, token_headers, params):
    assert (
        client.get("/api/v1/memory/search", headers=token_headers, params=params).status_code == 422
    )


@pytest.mark.posix_storage
def test_hub_returns_paged_relationships_without_reading_child_bodies(client, token_headers):
    root_tag = make_tag(client, token_headers, "LangChain")
    other = make_tag(client, token_headers, "细节")
    children = [
        make_note(
            client, token_headers, [other["id"]], title=f"局部知识 {i}", body="独立片段"
        ).json()
        for i in range(12)
    ]
    make_note(
        client,
        token_headers,
        [root_tag["id"]],
        title="LangChain",
        body="\n".join(f"[局部知识](./{child['id']}.md)" for child in children),
    )
    result = search(client, token_headers, q="LangChain", limit=20)
    assert result["routing"]["candidates"] == 1
    assert result["truncated"]
    assert len(result["items"]) == 1
    assert len(result["graph"]["edges"]) <= 6
    assert result["graph"]["continuations"]
    assert "独立片段" not in json.dumps(result, ensure_ascii=False)


@pytest.mark.posix_storage
def test_v1_memory_package_upgrades_relationship_indexes(client, token_headers, tmp_path):
    import hashlib
    import io
    import sqlite3
    import zipfile
    from pathlib import Path

    from fastapi.testclient import TestClient

    from app.core.settings import Settings
    from app.main import create_app

    tag = make_tag(client, token_headers, "RAG")
    note = make_note(client, token_headers, [tag["id"]], body="保留旧记忆").json()
    exported = client.get("/api/v1/memory/export", headers=token_headers)
    assert exported.status_code == 200
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        files = {name: archive.read(name) for name in archive.namelist()}
    manifest = json.loads(files["manifest.json"])
    path = tmp_path / "old-memory.sqlite"
    key = ".assistant/memory.sqlite"
    path.write_bytes(files[key])
    with sqlite3.connect(path, autocommit=True) as connection:
        connection.execute("DROP TABLE external_turns")
        connection.execute("DROP INDEX ix_memory_relations_source_active")
        connection.execute("DROP INDEX ix_memory_relations_target_active")
        connection.execute("UPDATE alembic_version SET version_num='0004_second_brain'")
    files[key] = path.read_bytes()
    manifest["database_version"] = "0004_second_brain"
    manifest["files"][key] = {
        "sha256": hashlib.sha256(files[key]).hexdigest(),
        "size": len(files[key]),
    }
    files["manifest.json"] = json.dumps(manifest).encode()
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    response = client.post(
        "/api/v1/memory/import",
        headers={**token_headers, "Content-Type": "application/octet-stream"},
        content=data.getvalue(),
    )
    assert response.status_code == 200, response.text
    restored = Path(response.json()["memory_dir"])
    with TestClient(
        create_app(Settings(restored, tmp_path / "new-config")), base_url="http://127.0.0.1:8000"
    ) as reopened:
        headers = {"X-Local-Token": reopened.get("/api/v1/bootstrap").json()["local_token"]}
        assert (
            reopened.get(f"/api/v1/notes/{note['id']}", headers=headers).json()["body"]
            == "保留旧记忆"
        )
        with reopened.app.state.session_factory() as session:
            indexes = (
                session.connection()
                .exec_driver_sql("PRAGMA index_list('memory_relations')")
                .fetchall()
            )
            assert {"ix_memory_relations_source_active", "ix_memory_relations_target_active"} <= {
                row[1] for row in indexes
            }
