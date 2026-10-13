import io
import json
import shutil
import time
import zipfile
from pathlib import Path
from uuid import uuid4

import pytest
from agent_helpers import ScriptedModel, auth, configure, finished, submit
from fastapi.testclient import TestClient
from sqlalchemy import select
from test_notes import make_note, make_tag, note_path

from app.core.settings import Settings
from app.db.models import Note, NoteDeletion, NoteVersion, NoteWrite
from app.main import create_app
from app.vault.topic_files import FileIssue


@pytest.mark.posix_storage
def test_edit_filters_versions_conflict_and_manual_classification(client, token_headers):
    tag = make_tag(client, token_headers)
    original = make_note(client, token_headers, [tag["id"]], folder="学习/数据库").json()
    identifier = original["id"]
    edited = client.patch(
        f"/api/v1/notes/{identifier}",
        headers=token_headers,
        json={
            "expected_version": 1,
            "body": "人工正文",
            "tag_ids": [tag["id"]],
            "folder": "学习/数据库",
        },
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["version"] == 2
    with client.app.state.session_factory() as session:
        assert session.get(Note, identifier).manual_classification is False
    same = client.patch(
        f"/api/v1/notes/{identifier}",
        headers=token_headers,
        json={"expected_version": 2, "body": "人工正文"},
    )
    assert same.json()["version"] == 2
    conflict = client.patch(
        f"/api/v1/notes/{identifier}",
        headers=token_headers,
        json={"expected_version": 1, "body": "旧稿"},
    )
    assert conflict.status_code == 409
    assert note_path(client, identifier).read_text().endswith("人工正文")
    assert (
        client.get(
            "/api/v1/notes",
            headers=token_headers,
            params={"q": "RAG", "folder": "学习/数据库", "tag_id": tag["id"]},
        ).json()["total"]
        == 1
    )
    assert (
        client.get("/api/v1/notes", headers=token_headers, params={"folder": ""}).json()["total"]
        == 0
    )
    versions = client.get(f"/api/v1/notes/{identifier}/versions", headers=token_headers).json()
    assert [v["version"] for v in versions["items"]] == [2, 1]
    removed = client.patch(
        f"/api/v1/notes/{identifier}",
        headers=token_headers,
        json={"expected_version": 2, "tag_ids": []},
    )
    assert removed.json()["tags"] == []
    with client.app.state.session_factory() as session:
        assert session.get(Note, identifier).manual_classification is True


@pytest.mark.parametrize(
    "folder", ["../逃逸", "/绝对", "一//二", "a\\b", "a/./b", "x\n", "/".join(["a"] * 9)]
)
def test_logical_folder_is_strict(client, token_headers, folder):
    tag = make_tag(client, token_headers)
    assert make_note(client, token_headers, [tag["id"]], folder=folder).status_code == 422


@pytest.mark.posix_storage
def test_external_import_hash_and_version_guard(client, token_headers):
    tag = make_tag(client, token_headers)
    note = make_note(client, token_headers, [tag["id"]], folder="知识").json()
    path = note_path(client, note["id"])
    path.write_text("# 外部标题\n\n外部改动\n")
    assert client.get(f"/api/v1/notes/{note['id']}", headers=token_headers).status_code == 409
    external = client.get(f"/api/v1/notes/{note['id']}/external", headers=token_headers).json()
    assert external["body"] == "外部改动\n"
    path.write_text("# 外部标题\n\n再次改动\n")
    assert (
        client.post(
            f"/api/v1/notes/{note['id']}/import-external",
            headers=token_headers,
            json={"expected_version": 1, "file_hash": external["file_hash"]},
        ).status_code
        == 409
    )
    external = client.get(f"/api/v1/notes/{note['id']}/external", headers=token_headers).json()
    result = client.post(
        f"/api/v1/notes/{note['id']}/import-external",
        headers=token_headers,
        json={"expected_version": 1, "file_hash": external["file_hash"]},
    )
    assert result.status_code == 200, result.text
    assert result.json()["folder"] == "知识" and result.json()["version"] == 2
    assert result.json()["title"] == "外部标题"


@pytest.mark.posix_storage
def test_delete_fence_recovers_and_removes_all_body_snapshots(client, token_headers, monkeypatch):
    tag = make_tag(client, token_headers)
    note = make_note(client, token_headers, [tag["id"]], body="需彻底删除的正文").json()
    service = client.app.state.note_service
    real_remove = service.files.remove

    def failed(*args):
        raise FileIssue("note_storage_unavailable", "暂时失败", True)

    monkeypatch.setattr(service.files, "remove", failed)
    response = client.request(
        "DELETE", f"/api/v1/notes/{note['id']}", headers=token_headers, json={"expected_version": 1}
    )
    assert response.status_code == 503
    assert client.get(f"/api/v1/notes/{note['id']}", headers=token_headers).status_code == 404
    monkeypatch.setattr(service.files, "remove", real_remove)
    service.recover_startup()
    assert not note_path(client, note["id"]).exists()
    with service.sessions() as session:
        assert session.get(Note, note["id"]) is None
        assert session.scalar(select(NoteVersion).where(NoteVersion.note_id == note["id"])) is None
        assert session.scalar(select(NoteWrite).where(NoteWrite.note_id == note["id"])) is None
        assert session.get(NoteDeletion, note["id"]).status == "completed"
    assert (
        client.request(
            "DELETE",
            f"/api/v1/notes/{note['id']}",
            headers=token_headers,
            json={"expected_version": 1},
        ).status_code
        == 204
    )


@pytest.mark.posix_storage
def test_chinese_date_sections_reference_survives_target_edit_and_external_conflict(
    client, token_headers
):
    tag = make_tag(client, token_headers)
    target = make_note(client, token_headers, [tag["id"]], title="Redis", body="缓存方法").json()
    source = make_note(
        client,
        token_headers,
        [tag["id"]],
        title="工作记录",
        body=f"## 2026-10-01\n\n完成缓存项目，使用[Redis](./{target['id']}.md)\n\n"
        "## 记录日期 2026-10-08（未说明发生日期）\n\n新的缓存思路",
    ).json()
    search = client.get(
        "/api/v1/memory/search",
        headers=token_headers,
        params={"q": "缓存", "date_from": "2026-10-01", "date_to": "2026-10-02"},
    ).json()
    assert search["items"][0]["note_id"] == source["id"]
    assert search["items"][0]["date_basis"] == "发生日期"
    assert sum(len(i["excerpt"]) for i in search["items"]) <= 8000
    graph = client.get("/api/v1/memory/graph", headers=token_headers).json()
    assert len(graph["edges"]) == 1
    client.patch(
        f"/api/v1/notes/{target['id']}",
        headers=token_headers,
        json={"expected_version": 1, "body": "新的说明"},
    )
    assert len(client.get("/api/v1/memory/graph", headers=token_headers).json()["edges"]) == 1
    note_path(client, source["id"]).write_text("# 改动\n\n外部改了")
    search = client.get(
        "/api/v1/memory/search", headers=token_headers, params={"q": "完成缓存项目"}
    ).json()
    assert not any(i["note_id"] == source["id"] for i in search["items"])


def wait_job(client, headers):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        jobs = client.get("/api/v1/memory/jobs", headers=headers).json()["items"]
        if jobs and jobs[0]["status"] not in ("pending", "running"):
            return jobs[0]
        time.sleep(0.01)
    raise AssertionError(jobs)


@pytest.mark.posix_storage
def test_auto_memory_real_files_dedup_new_tags_secrets_links_and_restore(tmp_path):
    calls = []

    async def planner(config, context):
        calls.append(context)
        return {
            "decision": "apply",
            "reason": "保存 test-only-secret 关联知识",
            "notes": [
                {"title": "RAG", "body": "检索增强生成方法 test-only-secret", "tags": ["人工智能"]},
                {"title": "切片", "body": "按语义分割资料", "tags": ["人工智能"]},
            ],
            "relations": [
                {
                    "source_index": 0,
                    "target_index": 1,
                    "relation": "使用",
                    "evidence": "RAG 使用切片",
                }
            ],
        }

    settings = Settings(tmp_path / "memory", tmp_path / "config")
    restored = None
    with TestClient(
        create_app(
            settings, model_factory=lambda _: ScriptedModel(delay=0), memory_planner=planner
        ),
        base_url="http://127.0.0.1:8000",
    ) as client:
        headers = auth(client)
        assert client.get("/api/v1/memory/settings", headers=headers).json() == {
            "auto_memory": True
        }
        configure(client, headers)
        client.put("/api/v1/memory/settings", headers=headers, json={"auto_memory": True})
        conversation = client.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
        client_id = str(uuid4())
        run = submit(client, headers, conversation, "RAG 使用切片", client_id)
        assert finished(client, headers, run["id"])["status"] == "completed"
        job = wait_job(client, headers)
        assert job["status"] == "completed", job
        assert len(job["notes"]) == 2 and len(calls) == 1
        assert "test-only-secret" not in json.dumps(job)
        notes = client.get("/api/v1/notes", headers=headers).json()["items"]
        rag = next(n for n in notes if n["title"] == "RAG")
        assert "./" in client.get(f"/api/v1/notes/{rag['id']}", headers=headers).json()["body"]
        assert len(client.get("/api/v1/memory/graph", headers=headers).json()["edges"]) >= 1
        assert submit(client, headers, conversation, "RAG 使用切片", client_id)["id"] == run["id"]
        assert (
            client.post(f"/api/v1/memory/jobs/{job['id']}/retry", headers=headers, json={}).json()[
                "status"
            ]
            == "completed"
        )
        exported = client.get("/api/v1/memory/export", headers=headers)
        assert exported.status_code == 200, (
            exported.text[:100] if exported.status_code != 200 else ""
        )
        with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
            assert not any("config" in name for name in archive.namelist())
            for name in archive.namelist():
                assert b"test-only-secret" not in archive.read(name)
        imported = client.post(
            "/api/v1/memory/import",
            headers={**headers, "Content-Type": "application/octet-stream"},
            content=exported.content,
        )
        assert imported.status_code == 200, imported.text
        restored = Path(imported.json()["memory_dir"])
    try:
        with TestClient(
            create_app(Settings(restored, tmp_path / "new-config")),
            base_url="http://127.0.0.1:8000",
        ) as client:
            headers = auth(client)
            actual = client.get("/api/v1/notes", headers=headers).json()["items"]
            assert {n["id"] for n in actual} == {n["id"] for n in notes}
            assert (
                client.get("/api/v1/memory/jobs", headers=headers).json()["items"][0]["status"]
                == "completed"
            )
            assert len(client.get("/api/v1/memory/graph", headers=headers).json()["edges"]) >= 1
    finally:
        if restored:
            shutil.rmtree(restored)


@pytest.mark.parametrize(
    "name", ["../escape", "/absolute", "notes/topics/not-an-id.md", "config/model.json"]
)
def test_import_rejects_uncontrolled_entries(client, token_headers, name):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        archive.writestr(name, "bad")
    response = client.post(
        "/api/v1/memory/import",
        headers={**token_headers, "Content-Type": "application/octet-stream"},
        content=data.getvalue(),
    )
    assert response.status_code == 422


def test_planning_failure_and_explicit_do_not_save(tmp_path):
    calls = []

    async def planner(config, context):
        calls.append(context)
        raise RuntimeError("provider test-only-secret")

    with TestClient(
        create_app(
            Settings(tmp_path / "memory", tmp_path / "config"),
            model_factory=lambda _: ScriptedModel(delay=0),
            memory_planner=planner,
        ),
        base_url="http://127.0.0.1:8000",
    ) as client:
        headers = auth(client)
        configure(client, headers)
        client.put("/api/v1/memory/settings", headers=headers, json={"auto_memory": True})
        conversation = client.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
        run = submit(client, headers, conversation, "今天学了 RAG，不要记住")
        finished(client, headers, run["id"])
        assert wait_job(client, headers)["status"] == "skipped"
        assert not calls
        run = submit(client, headers, conversation, "今天学了 RAG")
        finished(client, headers, run["id"])
        failed = wait_job(client, headers)
        assert failed["status"] == "failed" and "test-only-secret" not in json.dumps(failed)
        assert client.get("/api/v1/notes", headers=headers).json()["total"] == 0


@pytest.mark.posix_storage
def test_correction_replaces_unique_text_preserves_manual_body_and_history(tmp_path):
    async def planner(config, context):
        related = next(n for n in context["related_notes"] if n["title"] == "Redis")
        return {
            "decision": "apply",
            "reason": "明确更正",
            "notes": [
                {
                    "title": "Redis",
                    "note_id": related["note_id"],
                    "expected_version": related["version"],
                    "body": "Redis 支持多种数据结构",
                    "tags": ["学习"],
                    "mode": "correct",
                    "replace_text": "Redis 只支持字符串",
                }
            ],
        }

    with TestClient(
        create_app(
            Settings(tmp_path / "memory", tmp_path / "config"),
            model_factory=lambda _: ScriptedModel(delay=0),
            memory_planner=planner,
        ),
        base_url="http://127.0.0.1:8000",
    ) as client:
        headers = auth(client)
        tag = make_tag(client, headers)
        note = make_note(
            client,
            headers,
            [tag["id"]],
            title="Redis",
            body="## 结论\n\nRedis 只支持字符串\n\n## 人工说明\n\n不要改掉这段个人备注",
        ).json()
        configure(client, headers)
        client.put("/api/v1/memory/settings", headers=headers, json={"auto_memory": True})
        conversation = client.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
        run = submit(client, headers, conversation, "更正 Redis 结论：它支持多种数据结构")
        finished(client, headers, run["id"])
        job = wait_job(client, headers)
        assert job["status"] == "completed", job
        current = client.get(f"/api/v1/notes/{note['id']}", headers=headers).json()
        assert "Redis 只支持字符串" not in current["body"]
        assert "Redis 支持多种数据结构" in current["body"]
        assert "不要改掉这段个人备注" in current["body"]
        versions = client.get(f"/api/v1/notes/{note['id']}/versions", headers=headers).json()
        assert "Redis 只支持字符串" in versions["items"][-1]["body"]
        results = client.get(
            "/api/v1/memory/search", headers=headers, params={"q": "只支持字符串"}
        ).json()
        assert all("Redis 只支持字符串" not in row["excerpt"] for row in results["items"])


def test_tag_alias_and_deleted_classification_are_not_recreated(client, token_headers):
    from app.db.models import Tag, TagAlias

    service = client.app.state.memory_jobs
    tag = make_tag(client, token_headers, "旧分类")
    response = client.patch(
        f"/api/v1/tags/{tag['id']}", headers=token_headers, json={"name": "新分类"}
    )
    assert response.status_code == 200
    assert service._tags(["旧分类"]) == [tag["id"]]
    assert client.get("/api/v1/tags", headers=token_headers).json()["total"] == 1
    assert client.delete(f"/api/v1/tags/{tag['id']}", headers=token_headers).status_code == 204
    assert service._tags(["旧分类", "新分类"]) == []
    with service.sessions() as session:
        assert session.get(TagAlias, "旧分类").deleted is True
        assert session.get(TagAlias, "新分类").deleted is True
        assert session.scalar(select(Tag)) is None
    manual = make_tag(client, token_headers, "旧分类")
    assert service._tags(["旧分类"]) == [manual["id"]]


@pytest.mark.parametrize(
    "evidence", ["我准备学习 Redis", "我没有完成 Redis 项目", "朋友完成了 Redis 项目"]
)
def test_planned_negated_other_experience_needs_confirmation(tmp_path, evidence):
    async def planner(config, context):
        return {
            "decision": "apply",
            "reason": "候选经历",
            "notes": [
                {
                    "title": "Redis 项目",
                    "body": "用户已完成 Redis 项目",
                    "kind": "experience",
                    "subject": "self",
                    "state": "fact",
                    "evidence": evidence,
                }
            ],
        }

    with TestClient(
        create_app(
            Settings(tmp_path / "memory", tmp_path / "config"),
            model_factory=lambda _: ScriptedModel(delay=0),
            memory_planner=planner,
        ),
        base_url="http://127.0.0.1:8000",
    ) as client:
        headers = auth(client)
        configure(client, headers)
        client.put("/api/v1/memory/settings", headers=headers, json={"auto_memory": True})
        conversation = client.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
        run = submit(client, headers, conversation, evidence)
        finished(client, headers, run["id"])
        job = wait_job(client, headers)
        assert job["status"] == "needs_confirmation", job
        assert job["question"] and job["notes"] == []
        assert client.get("/api/v1/notes", headers=headers).json()["total"] == 0
        assert (
            client.post(
                f"/api/v1/memory/jobs/{job['id']}/resolve",
                headers=headers,
                json={"action": "dismiss"},
            ).json()["status"]
            == "skipped"
        )


def test_interrupted_planning_not_automatically_replayed(tmp_path):
    import asyncio

    calls = []

    async def planner(config, context):
        calls.append(context)
        await asyncio.sleep(30)

    settings = Settings(tmp_path / "memory", tmp_path / "config")
    with TestClient(
        create_app(
            settings, model_factory=lambda _: ScriptedModel(delay=0), memory_planner=planner
        ),
        base_url="http://127.0.0.1:8000",
    ) as client:
        headers = auth(client)
        configure(client, headers)
        client.put("/api/v1/memory/settings", headers=headers, json={"auto_memory": True})
        conversation = client.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
        run = submit(client, headers, conversation, "需要整理的知识")
        finished(client, headers, run["id"])
        deadline = time.monotonic() + 5
        while not calls and time.monotonic() < deadline:
            time.sleep(0.01)
        assert len(calls) == 1
    with TestClient(
        create_app(
            settings, model_factory=lambda _: ScriptedModel(delay=0), memory_planner=planner
        ),
        base_url="http://127.0.0.1:8000",
    ) as client:
        headers = auth(client)
        job = client.get("/api/v1/memory/jobs", headers=headers).json()["items"][0]
        assert job["status"] == "interrupted"
        time.sleep(0.05)
        assert len(calls) == 1


@pytest.mark.posix_storage
def test_explicit_remember_runs_while_automatic_memory_disabled(tmp_path):
    async def planner(config, context):
        return {
            "decision": "apply",
            "reason": "明确记住",
            "notes": [{"title": "RAG", "body": "检索增强生成"}],
        }

    with TestClient(
        create_app(
            Settings(tmp_path / "memory", tmp_path / "config"),
            model_factory=lambda _: ScriptedModel(delay=0),
            memory_planner=planner,
        ),
        base_url="http://127.0.0.1:8000",
    ) as client:
        headers = auth(client)
        configure(client, headers)  # 会把自动整理关闭，显式意图仍走校验。
        conversation = client.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
        run = submit(client, headers, conversation, "请记住 RAG 是检索增强生成")
        finished(client, headers, run["id"])
        assert wait_job(client, headers)["status"] == "completed"
        assert client.get("/api/v1/memory/settings", headers=headers).json()["auto_memory"] is False


@pytest.mark.posix_storage
def test_memory_tools_budget_cache_and_latest_version(client, token_headers):
    import asyncio

    from app.agent.memory_tools import make_memory_tools

    tag = make_tag(client, token_headers)
    note = make_note(client, token_headers, [tag["id"]], body="知识内容 " * 4000).json()
    tools = {tool.name: tool for tool in make_memory_tools(client.app.state.knowledge, 12000)}

    async def scenario():
        first = await tools["read_note"].ainvoke({"note_id": note["id"]})
        second = await tools["read_note"].ainvoke({"note_id": note["id"]})
        assert json.loads(second)["already_read"]
        changed = client.patch(
            f"/api/v1/notes/{note['id']}",
            headers=token_headers,
            json={"expected_version": 1, "body": "新的知识内容"},
        )
        assert changed.status_code == 200
        latest = json.loads(await tools["read_note"].ainvoke({"note_id": note["id"]}))
        assert latest["version"] == 2 and latest["body"] == "新的知识内容"
        total = len(first) + len(second) + len(json.dumps(latest, ensure_ascii=False))
        for _ in range(15):
            response = await tools["search_memory"].ainvoke({"q": str(uuid4())})
            # 用尽后只返回边界信息，不继续读库。
            total += len(response)
        assert total < 14000

    asyncio.run(scenario())


@pytest.mark.posix_storage
def test_saved_step_retry_reuses_file_without_duplicate_or_model_replanning(tmp_path):
    from app.db.models import MemoryJobItem

    calls = []

    async def planner(config, context):
        calls.append(context)
        return {
            "decision": "apply",
            "reason": "记录知识",
            "notes": [{"title": "事务恢复", "body": "已经确认的正文"}],
        }

    with TestClient(
        create_app(
            Settings(tmp_path / "memory", tmp_path / "config"),
            model_factory=lambda _: ScriptedModel(delay=0),
            memory_planner=planner,
        ),
        base_url="http://127.0.0.1:8000",
    ) as client:
        headers = auth(client)
        configure(client, headers)
        client.put("/api/v1/memory/settings", headers=headers, json={"auto_memory": True})
        service = client.app.state.memory_jobs
        create = service.notes.create
        interrupted = [False]

        def saved_then_failure(*args, **kwargs):
            result = create(*args, **kwargs)
            if not interrupted[0]:
                interrupted[0] = True
                raise RuntimeError("在确认文件后、进度登记前中断")
            return result

        service.notes.create = saved_then_failure
        conversation = client.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
        run = submit(client, headers, conversation, "事务恢复的新知识")
        finished(client, headers, run["id"])
        job = wait_job(client, headers)
        assert job["status"] == "failed"
        initial = client.get("/api/v1/notes", headers=headers).json()["items"][0]
        with service.sessions() as session:
            assert session.get(MemoryJobItem, (job["id"], 0)) is None
        service.notes.create = create
        client.post(f"/api/v1/memory/jobs/{job['id']}/retry", headers=headers, json={})
        recovered = wait_job(client, headers)
        assert recovered["status"] == "completed", recovered
        actual = client.get("/api/v1/notes", headers=headers).json()["items"]
        assert len(actual) == 1 and actual[0]["id"] == initial["id"] and actual[0]["version"] == 1
        assert len(calls) == 1


@pytest.mark.posix_storage
def test_confirmation_rejects_current_version_change_and_clarification_replans(tmp_path):
    calls = []

    async def planner(config, context):
        calls.append(context)
        known = next(n for n in context["related_notes"] if n["title"] == "Redis")
        return {
            "decision": "confirm" if not context["clarification"] else "apply",
            "reason": "相关变化",
            "question": "是否补充此观点？",
            "notes": [
                {
                    "title": "Redis",
                    "note_id": known["note_id"],
                    "expected_version": known["version"],
                    "body": "新的补充知识",
                }
            ],
        }

    with TestClient(
        create_app(
            Settings(tmp_path / "memory", tmp_path / "config"),
            model_factory=lambda _: ScriptedModel(delay=0),
            memory_planner=planner,
        ),
        base_url="http://127.0.0.1:8000",
    ) as client:
        headers = auth(client)
        tag = make_tag(client, headers)
        note = make_note(client, headers, [tag["id"]], title="Redis", body="人工正文").json()
        configure(client, headers)
        client.put("/api/v1/memory/settings", headers=headers, json={"auto_memory": True})
        conversation = client.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
        run = submit(client, headers, conversation, "Redis 的补充知识")
        finished(client, headers, run["id"])
        job = wait_job(client, headers)
        assert job["status"] == "needs_confirmation"
        client.patch(
            f"/api/v1/notes/{note['id']}",
            headers=headers,
            json={"expected_version": 1, "body": "人工修订必须保留"},
        )
        pending = client.get("/api/v1/memory/search", headers=headers, params={"q": "Redis"}).json()
        assert pending["items"][0]["pending_changes"][0]["version_conflict"] is True
        assert "重新复核" in pending["items"][0]["pending_changes"][0]["question"]
        response = client.post(
            f"/api/v1/memory/jobs/{job['id']}/resolve", headers=headers, json={"action": "confirm"}
        )
        assert response.status_code == 409
        client.post(
            f"/api/v1/memory/jobs/{job['id']}/resolve",
            headers=headers,
            json={"action": "confirm", "clarification": "请基于最新人工正文增加 Redis 的补充知识"},
        )
        complete = wait_job(client, headers)
        assert complete["status"] == "completed", complete
        body = client.get(f"/api/v1/notes/{note['id']}", headers=headers).json()["body"]
        assert "人工修订必须保留" in body and "新的补充知识" in body
        assert len(calls) == 2


@pytest.mark.posix_storage
def test_deleted_note_cannot_be_resurrected_by_saved_old_plan(tmp_path):
    calls = []

    async def planner(config, context):
        calls.append(context)
        return {
            "decision": "apply",
            "reason": "旧整理计划",
            "notes": [{"title": "不恢复知识", "body": "不应该重现的内容"}],
        }

    with TestClient(
        create_app(
            Settings(tmp_path / "memory", tmp_path / "config"),
            model_factory=lambda _: ScriptedModel(delay=0),
            memory_planner=planner,
        ),
        base_url="http://127.0.0.1:8000",
    ) as client:
        headers = auth(client)
        configure(client, headers)
        client.put("/api/v1/memory/settings", headers=headers, json={"auto_memory": True})
        service = client.app.state.memory_jobs
        create = service.notes.create

        def fail_after_file(*args, **kwargs):
            create(*args, **kwargs)
            raise RuntimeError("已持久化，进度尚未登记")

        service.notes.create = fail_after_file
        conversation = client.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
        run = submit(client, headers, conversation, "不恢复知识")
        finished(client, headers, run["id"])
        job = wait_job(client, headers)
        assert job["status"] == "failed"
        note = client.get("/api/v1/notes", headers=headers).json()["items"][0]
        assert (
            client.request(
                "DELETE",
                f"/api/v1/notes/{note['id']}",
                headers=headers,
                json={"expected_version": note["version"]},
            ).status_code
            == 204
        )
        service.notes.create = create
        response = client.post(f"/api/v1/memory/jobs/{job['id']}/retry", headers=headers, json={})
        assert response.json()["status"] == "skipped"
        assert client.get("/api/v1/notes", headers=headers).json()["total"] == 0
        assert len(calls) == 1


@pytest.mark.posix_storage
def test_index_rebuilds_missing_section_without_full_vault_file_scan(
    client, token_headers, monkeypatch
):
    from sqlalchemy import delete

    from app.db.models import NoteSection

    tag = make_tag(client, token_headers)
    first = make_note(client, token_headers, [tag["id"]], title="索引A", body="缓存知识").json()
    second = make_note(client, token_headers, [tag["id"]], title="索引B", body="不相关文字").json()
    service = client.app.state.note_service
    with service._writing() as session:
        session.execute(delete(NoteSection).where(NoteSection.note_id == first["id"]))
        session.commit()
    read = service.files.read
    inspected = []

    def tracked(identifier):
        inspected.append(identifier)
        return read(identifier)

    monkeypatch.setattr(service.files, "read", tracked)
    result = client.get(
        "/api/v1/memory/search", headers=token_headers, params={"q": "缓存知识"}
    ).json()
    assert result["items"][0]["note_id"] == first["id"]
    assert second["id"] not in inspected


@pytest.mark.posix_storage
def test_archive_rejects_hash_tampering_symlink_and_external_conflict(client, token_headers):
    import stat

    tag = make_tag(client, token_headers)
    note = make_note(client, token_headers, [tag["id"]]).json()
    exported = client.get("/api/v1/memory/export", headers=token_headers)
    assert exported.status_code == 200
    output = io.BytesIO()
    with (
        zipfile.ZipFile(io.BytesIO(exported.content)) as archive,
        zipfile.ZipFile(output, "w") as tampered,
    ):
        for name in archive.namelist():
            tampered.writestr(
                name, archive.read(name) + (b"\nchanged" if name.endswith(".md") else b"")
            )
    assert (
        client.post(
            "/api/v1/memory/import",
            headers={**token_headers, "Content-Type": "application/octet-stream"},
            content=output.getvalue(),
        ).status_code
        == 422
    )
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        entry = zipfile.ZipInfo("manifest.json")
        entry.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(entry, "/private/path")
    assert (
        client.post(
            "/api/v1/memory/import",
            headers={**token_headers, "Content-Type": "application/octet-stream"},
            content=output.getvalue(),
        ).status_code
        == 422
    )
    note_path(client, note["id"]).write_text("# 外部\n\n改了")
    assert client.get("/api/v1/memory/export", headers=token_headers).status_code == 409


@pytest.mark.posix_storage
def test_last_week_is_indexed_as_range_without_inventing_day(tmp_path, monkeypatch):
    from datetime import datetime, timedelta

    from app.core.time import local_zone

    contexts = []
    monkeypatch.setenv("TZ", "UTC")

    async def planner(config, context):
        contexts.append(context)
        return {
            "decision": "apply",
            "reason": "明确已完成的经历",
            "notes": [
                {
                    "title": "Redis 项目经历",
                    "body": "完成 Redis 项目",
                    "kind": "experience",
                    "subject": "self",
                    "state": "fact",
                    "evidence": "上周我完成了 Redis 项目",
                }
            ],
        }

    with TestClient(
        create_app(
            Settings(tmp_path / "memory", tmp_path / "config"),
            model_factory=lambda _: ScriptedModel(delay=0),
            memory_planner=planner,
        ),
        base_url="http://127.0.0.1:8000",
    ) as client:
        headers = auth(client)
        configure(client, headers)
        client.put("/api/v1/memory/settings", headers=headers, json={"auto_memory": True})
        conversation = client.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
        run = submit(client, headers, conversation, "上周我完成了 Redis 项目")
        finished(client, headers, run["id"])
        assert wait_job(client, headers)["status"] == "completed"
        recorded = (
            datetime.fromisoformat(contexts[0]["source_message_time"])
            .astimezone(local_zone())
            .date()
        )
        start = recorded - timedelta(days=recorded.weekday() + 7)
        end = start + timedelta(days=6)
        result = client.get(
            "/api/v1/memory/search",
            headers=headers,
            params={
                "q": "Redis",
                "date_from": (start + timedelta(days=3)).isoformat(),
                "date_to": (start + timedelta(days=3)).isoformat(),
            },
        ).json()
        assert result["items"][0]["date"] == start.isoformat()
        assert result["items"][0]["date_to"] == end.isoformat()
        assert "发生日期范围" in result["items"][0]["heading"]
        assert contexts[0]["timezone"] == "UTC"


def test_invalid_calendar_date_rejected_and_planner_budget_includes_schema(client, token_headers):
    from agent_helpers import finished, submit

    from app.db.models import MemoryJob, Message
    from app.schemas.memory import MemoryPlan
    from app.services.memory_jobs import PLANNING_PROMPT

    with pytest.raises(ValueError):
        MemoryPlan.model_validate(
            {
                "decision": "apply",
                "reason": "无效日期",
                "notes": [{"title": "日期", "body": "事件", "occurred_on": "2026-99-99"}],
            }
        )
    # 无配置失败的聊天也可用于只读测试规划上下文，绝不调用供应商。
    conversation = client.post("/api/v1/conversations", headers=token_headers, json={}).json()["id"]
    run = submit(client, token_headers, conversation, "知识 " * 6500)
    finished(client, token_headers, run["id"])
    with client.app.state.session_factory() as session:
        user = session.get(Message, run["user_message_id"])
        job = MemoryJob(
            id=str(uuid4()),
            conversation_id=conversation,
            run_id=run["id"],
            user_message_id=user.id,
            clarification="澄清 " * 1000,
        )
        context = client.app.state.memory_jobs._context(job)
    size = (
        len(json.dumps(context, ensure_ascii=False))
        + len(PLANNING_PROMPT)
        + len(json.dumps(MemoryPlan.model_json_schema(), ensure_ascii=False))
    )
    assert size <= 18000


@pytest.mark.posix_storage
def test_background_file_publish_does_not_block_chat_and_close_waits_owned_worker(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    async def planner(config, context):
        return {
            "decision": "apply",
            "reason": "保存",
            "notes": [{"title": "后台保存", "body": "需要fsync"}],
        }

    app = create_app(
        Settings(tmp_path / "memory", tmp_path / "config"),
        model_factory=lambda _: ScriptedModel(delay=0.001),
        memory_planner=planner,
    )
    entered, release = Event(), Event()
    with TestClient(app, base_url="http://127.0.0.1:8000") as client:
        headers = auth(client)
        configure(client, headers)
        client.put("/api/v1/memory/settings", headers=headers, json={"auto_memory": True})
        service = app.state.note_service
        publish = service.files.publish

        def delayed(*args, **kwargs):
            entered.set()
            assert release.wait(timeout=5)
            return publish(*args, **kwargs)

        service.files.publish = delayed
        first = client.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
        run = submit(client, headers, first, "保存知识")
        finished(client, headers, run["id"])
        assert entered.wait(timeout=5)
        # 文件发布暂停期间另一会话仍可实际输出并完成。
        second = client.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
        follow = submit(client, headers, second, "同时聊天")
        assert finished(client, headers, follow["id"])["status"] == "completed"
        with ThreadPoolExecutor(max_workers=1) as pool:
            shutdown = pool.submit(lambda: client.portal.call(app.state.memory_jobs.close))
            time.sleep(0.03)
            assert not shutdown.done()
            release.set()
            shutdown.result(timeout=5)
        assert client.get("/api/v1/notes", headers=headers).json()["total"] == 1
        assert service.files.read(
            client.get("/api/v1/notes", headers=headers).json()["items"][0]["id"]
        )


@pytest.mark.posix_storage
def test_equal_experience_on_two_dates_is_retained_and_retry_does_not_repeat(tmp_path):
    calls = []

    async def planner(config, context):
        calls.append(context)
        existing = next(
            (note for note in context["related_notes"] if note["title"] == "每日记录"), None
        )
        note = {
            "title": "每日记录",
            "body": "我完成了每日记录",
            "kind": "experience",
            "subject": "self",
            "state": "fact",
            "evidence": context["user"],
            "occurred_on": context["user"][:10],
        }
        if existing:
            note.update(note_id=existing["note_id"], expected_version=existing["version"])
        return {"decision": "apply", "reason": "实际经历", "notes": [note]}

    with TestClient(
        create_app(
            Settings(tmp_path / "memory", tmp_path / "config"),
            model_factory=lambda _: ScriptedModel(delay=0),
            memory_planner=planner,
        ),
        base_url="http://127.0.0.1:8000",
    ) as client:
        headers = auth(client)
        configure(client, headers)
        client.put("/api/v1/memory/settings", headers=headers, json={"auto_memory": True})
        conversation = client.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
        for day in ("2026-10-01", "2026-10-02"):
            run = submit(client, headers, conversation, day + " 我完成了每日记录")
            finished(client, headers, run["id"])
            job = wait_job(client, headers)
            assert job["status"] == "completed", job
        note = client.get("/api/v1/notes", headers=headers).json()["items"][0]
        body = client.get(f"/api/v1/notes/{note['id']}", headers=headers).json()["body"]
        assert "## 2026-10-01" in body and "## 2026-10-02" in body
        assert body.count("我完成了每日记录") == 2
        assert (
            client.post(f"/api/v1/memory/jobs/{job['id']}/retry", headers=headers, json={}).json()[
                "status"
            ]
            == "completed"
        )
        assert client.get(f"/api/v1/notes/{note['id']}", headers=headers).json()["body"] == body
        assert len(calls) == 2


@pytest.mark.posix_storage
def test_repeated_knowledge_plan_skips_without_fake_update_or_unused_new_tag(tmp_path):
    async def planner(config, context):
        existing = next(
            (note for note in context["related_notes"] if note["title"] == "Redis"), None
        )
        note = {"title": "Redis", "body": "Redis 是数据结构服务", "tags": ["不应生成的新标签"]}
        if existing:
            note.update(note_id=existing["note_id"], expected_version=existing["version"])
        return {"decision": "apply", "reason": "判断有内容", "notes": [note]}

    with TestClient(
        create_app(
            Settings(tmp_path / "memory", tmp_path / "config"),
            model_factory=lambda _: ScriptedModel(delay=0),
            memory_planner=planner,
        ),
        base_url="http://127.0.0.1:8000",
    ) as client:
        headers = auth(client)
        tag = make_tag(client, headers)
        note = make_note(
            client, headers, [tag["id"]], title="Redis", body="Redis 是数据结构服务"
        ).json()
        configure(client, headers)
        client.put("/api/v1/memory/settings", headers=headers, json={"auto_memory": True})
        conversation = client.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
        run = submit(client, headers, conversation, "Redis 是数据结构服务")
        finished(client, headers, run["id"])
        job = wait_job(client, headers)
        assert job["status"] == "skipped" and job["notes"] == [], job
        assert client.get(f"/api/v1/notes/{note['id']}", headers=headers).json()["version"] == 1
        assert client.get("/api/v1/tags", headers=headers).json()["total"] == 1


@pytest.mark.posix_storage
@pytest.mark.parametrize("action", ["dismiss", "confirm"])
def test_new_conversation_reads_pending_change_as_candidate_and_resolution_clears_cache(
    tmp_path, action
):
    import asyncio

    from langchain_core.messages import AIMessage, ToolMessage

    from app.agent.memory_tools import make_memory_tools

    class QueryModel(ScriptedModel):
        def _response(self, messages):
            last = messages[-1]
            if last.type == "human" and "查询项目 A" in last.content:
                self._inputs.append(messages)
                return AIMessage(
                    content="",
                    tool_calls=[
                        dict(
                            name="search_memory",
                            args={"q": "项目 A"},
                            id=str(uuid4()),
                            type="tool_call",
                        )
                    ],
                )
            if isinstance(last, ToolMessage) and last.name == "search_memory":
                self._inputs.append(messages)
                result = json.loads(last.content)
                self._tool_results.append(result)
                return AIMessage(
                    content="",
                    tool_calls=[
                        dict(
                            name="read_note",
                            args={"note_id": result["items"][0]["note_id"]},
                            id=str(uuid4()),
                            type="tool_call",
                        )
                    ],
                )
            if isinstance(last, ToolMessage) and last.name == "read_note":
                self._inputs.append(messages)
                result = json.loads(last.content)
                self._tool_results.append(result)
                return AIMessage(
                    content=("存在待确认变化：" + result["pending_changes"][0]["question"])
                    if result["has_pending_changes"]
                    else "当前已确认记录：" + result["body"]
                )
            return super()._response(messages)

    model = QueryModel(delay=0)

    async def planner(config, context):
        if "查询项目 A" in context["user"]:
            return {"decision": "skip", "reason": "只查询已有知识"}
        known = next(n for n in context["related_notes"] if n["title"] == "项目 A")
        proposal = {
            "title": "项目 A",
            "body": "项目 A 不需要联网搜索。",
            "mode": "correct",
            "replace_text": "项目 A 需要联网搜索。",
        }
        if action == "confirm":
            proposal.update(note_id=known["note_id"], expected_version=known["version"])
        return {
            "decision": "confirm",
            "reason": "同一要求出现相反变化",
            "question": "是调整了需求，还是只在某种情况不需要联网？",
            "notes": [proposal],
        }

    with TestClient(
        create_app(
            Settings(tmp_path / "memory", tmp_path / "config"),
            model_factory=lambda _: model,
            memory_planner=planner,
        ),
        base_url="http://127.0.0.1:8000",
    ) as client:
        headers = auth(client)
        tag = make_tag(client, headers)
        note = make_note(
            client, headers, [tag["id"]], title="项目 A", body="项目 A 需要联网搜索。"
        ).json()
        unrelated = make_note(client, headers, [tag["id"]], title="项目 B", body="无关记录").json()
        tools = {tool.name: tool for tool in make_memory_tools(client.app.state.knowledge)}

        async def read_with_cache():
            return json.loads(await tools["read_note"].ainvoke({"note_id": note["id"]}))

        assert not asyncio.run(read_with_cache())["has_pending_changes"]
        configure(client, headers)
        client.put("/api/v1/memory/settings", headers=headers, json={"auto_memory": True})
        source = client.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
        run = submit(client, headers, source, "项目 A 不需要联网搜索，但适用范围还需要确认。")
        finished(client, headers, run["id"])
        pending = wait_job(client, headers)
        assert pending["status"] == "needs_confirmation"
        refreshed = asyncio.run(read_with_cache())
        assert refreshed["has_pending_changes"] and refreshed["body"] == "项目 A 需要联网搜索。"
        assert refreshed["pending_changes"][0]["job_id"] == pending["id"]
        assert "不需要联网搜索" in refreshed["pending_changes"][0]["summary"]
        assert len(refreshed["pending_changes"][0]["summary"]) <= 500
        assert not client.app.state.knowledge.pending_changes(unrelated["id"], "项目 B", 1)[
            "has_pending_changes"
        ]
        tiny = {tool.name: tool for tool in make_memory_tools(client.app.state.knowledge, 100)}
        minimal = asyncio.run(tiny["read_note"].ainvoke({"note_id": note["id"]}))
        assert len(minimal) <= 100 and json.loads(minimal)["has_pending_changes"]
        fresh = client.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
        run = submit(client, headers, fresh, "查询项目 A 当前的联网要求")
        assert finished(client, headers, run["id"])["status"] == "completed"
        messages = client.get(f"/api/v1/conversations/{fresh}/messages", headers=headers).json()[
            "items"
        ]
        assert "存在待确认变化" in messages[-1]["content"]
        searched = next(result for result in model._tool_results if "items" in result)
        assert searched["pending_changes_detected"]
        assert searched["items"][0]["has_pending_changes"]
        assert "不需要联网搜索" not in searched["items"][0]["excerpt"]
        assert any(
            "旧结论只称此前确认记录" in str(message.content)
            for message in model._inputs[-1]
            if message.type == "system"
        )
        response = client.post(
            f"/api/v1/memory/jobs/{pending['id']}/resolve", headers=headers, json={"action": action}
        )
        assert response.status_code == 200
        deadline = time.monotonic() + 5
        while action == "confirm" and time.monotonic() < deadline:
            job = next(
                job
                for job in client.get("/api/v1/memory/jobs", headers=headers).json()["items"]
                if job["id"] == pending["id"]
            )
            if job["status"] == "completed":
                break
            time.sleep(0.01)
        cleared = asyncio.run(read_with_cache())
        assert not cleared["has_pending_changes"] and cleared["pending_changes"] == []
        assert cleared["body"] == (
            "项目 A 不需要联网搜索。" if action == "confirm" else "项目 A 需要联网搜索。"
        )


@pytest.mark.posix_storage
@pytest.mark.parametrize(
    "message,expected_status",
    [
        ("Please remember this: Yesterday I completed the Redis migration.", "completed"),
        ("Please remember this: Yesterday I planned the Redis migration.", "needs_confirmation"),
        ("Please don't save this: Yesterday I completed the Redis migration.", "skipped"),
    ],
)
def test_english_memory_intents_dates_and_experience_guard(tmp_path, message, expected_status):
    from datetime import datetime, timedelta

    from app.core.time import local_zone

    calls = []

    async def planner(config, context):
        calls.append(context)
        occurred = datetime.fromisoformat(context["source_message_time"]).astimezone(
            local_zone()
        ).date() - timedelta(days=1)
        return {
            "decision": "apply",
            "reason": "Keep the migration event",
            "notes": [
                {
                    "title": "Redis migration",
                    "body": "Completed the Redis migration.",
                    "kind": "experience",
                    "subject": "self",
                    "state": "fact",
                    "evidence": context["user"],
                    "occurred_on": occurred.isoformat(),
                }
            ],
        }

    with TestClient(
        create_app(
            Settings(tmp_path / "memory", tmp_path / "config"),
            model_factory=lambda _: ScriptedModel(delay=0),
            memory_planner=planner,
        ),
        base_url="http://127.0.0.1:8000",
    ) as client:
        headers = auth(client)
        configure(client, headers)
        conversation = client.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
        # 显式英文 remember 在自动开关关闭时也进入同一校验链。
        if expected_status == "skipped":
            client.put("/api/v1/memory/settings", headers=headers, json={"auto_memory": True})
        run = submit(client, headers, conversation, message)
        finished(client, headers, run["id"])
        job = wait_job(client, headers)
        assert job["status"] == expected_status, job
        if expected_status == "completed":
            assert client.get("/api/v1/notes", headers=headers).json()["total"] == 1
        else:
            assert client.get("/api/v1/notes", headers=headers).json()["total"] == 0
        assert bool(calls) == (expected_status != "skipped")


@pytest.mark.posix_storage
def test_archive_blocks_current_model_key_in_note_history_and_removes_deleted_page_residue(
    client, token_headers
):
    configure(client, token_headers)
    tag = make_tag(client, token_headers)
    note = make_note(
        client, token_headers, [tag["id"]], title="Sensitive fixture", body="test-only-secret"
    ).json()
    exported = client.get("/api/v1/memory/export", headers=token_headers)
    assert (
        exported.status_code == 409 and exported.json()["error"]["code"] == "memory_export_secret"
    )
    assert "test-only-secret" not in exported.text
    updated = client.patch(
        f"/api/v1/notes/{note['id']}",
        headers=token_headers,
        json={"expected_version": 1, "body": "Secret removed from current text"},
    ).json()
    # 旧已确认版本仍然包含敏感文本，所以不能仅扫描当前Markdown就放行。
    assert client.get("/api/v1/memory/export", headers=token_headers).status_code == 409
    assert (
        client.request(
            "DELETE",
            f"/api/v1/notes/{note['id']}",
            headers=token_headers,
            json={"expected_version": updated["version"]},
        ).status_code
        == 204
    )
    exported = client.get("/api/v1/memory/export", headers=token_headers)
    assert exported.status_code == 200
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        assert all(b"test-only-secret" not in archive.read(name) for name in archive.namelist())
