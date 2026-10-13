import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from threading import Event
from uuid import UUID, uuid4

import pytest


def make_tag(client, headers, name="学习"):
    response = client.post("/api/v1/tags", headers=headers, json={"name": name})
    assert response.status_code == 201
    return response.json()


def make_note(client, headers, tags, **values):
    payload = {"title": "RAG 学习", "body": "\n## 切片\n\n中文😀  \r\n", "tag_ids": tags}
    payload.update(values)
    return client.post(
        "/api/v1/notes",
        headers={**headers, "Content-Type": "application/json"},
        content=json.dumps(payload),
    )


def note_path(client, note_id):
    return Path(client.app.state.note_service.files.root) / "notes/topics" / (note_id + ".md")


def frontmatter(data):
    text = data.decode("utf-8")
    return {
        key: json.loads(value)
        for key, value in (line.split(": ", 1) for line in text.split("---\n", 2)[1].splitlines())
    }


@pytest.mark.posix_storage
def test_create_actual_markdown_list_and_read_without_body_in_summary(client, token_headers):
    first = make_tag(client, token_headers, '知"识: []')
    second = make_tag(client, token_headers, "项目")
    response = make_note(client, token_headers, [second["id"], first["id"]], title="  RAG  ")
    assert response.status_code == 201, response.text
    note = response.json()
    assert str(UUID(note["id"])) == note["id"]
    assert note["title"] == "RAG" and note["version"] == 1
    assert note["sync_status"] == "synced" and note["sync_error"] is None
    assert note["source"] == "" and note["created_at"] == note["updated_at"]
    assert datetime.fromisoformat(note["created_at"]).utcoffset() == UTC.utcoffset(None)
    path = note_path(client, note["id"])
    data = path.read_bytes()
    metadata = frontmatter(data)
    assert metadata["id"] == note["id"]
    assert metadata["tag_ids"] == [tag["id"] for tag in note["tags"]]
    assert metadata["tags"] == [tag["name"] for tag in note["tags"]]
    assert "source" not in metadata
    assert data.endswith(note["body"].encode("utf-8"))
    assert b"\n# RAG\n\n" in data
    assert path.stat().st_mode & 0o777 == 0o600
    listing = client.get("/api/v1/notes", headers=token_headers).json()
    assert listing == {"items": [{k: v for k, v in note.items() if k != "body"}], "total": 1}
    assert client.get(f"/api/v1/notes/{note['id'].upper()}", headers=token_headers).json() == note


@pytest.mark.posix_storage
def test_source_is_stored_as_text_without_fetching_and_body_can_be_empty(client, token_headers):
    tag = make_tag(client, token_headers)
    source = '用户资料：https://example.invalid/\n"手记"'
    response = make_note(client, token_headers, [tag["id"]], source=source, body="")
    assert response.status_code == 201
    note = response.json()
    assert note["body"] == "" and note["source"] == source
    assert frontmatter(note_path(client, note["id"]).read_bytes())["source"] == source


@pytest.mark.posix_storage
def test_title_casefold_collision_returns_original_id_and_never_overwrites(client, token_headers):
    tag = make_tag(client, token_headers)
    first = make_note(client, token_headers, [tag["id"]], title="Straße").json()
    before = note_path(client, first["id"]).read_bytes()
    duplicate = make_note(client, token_headers, [tag["id"]], title="  STRASSE ", body="新稿")
    assert_error(duplicate, 409, "note_title_exists")
    assert duplicate.json()["error"]["note_id"] == first["id"]
    assert note_path(client, first["id"]).read_bytes() == before
    assert client.get("/api/v1/notes", headers=token_headers).json()["total"] == 1


@pytest.mark.posix_storage
def test_concurrent_same_title_has_one_file_and_one_directory_entry(client, token_headers):
    tag = make_tag(client, token_headers)
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(
            pool.map(
                lambda body: make_note(client, token_headers, [tag["id"]], body=body), ["一", "二"]
            )
        )
    assert sorted(r.status_code for r in responses) == [201, 409]
    note = next(r for r in responses if r.status_code == 201).json()
    assert (
        next(r for r in responses if r.status_code == 409).json()["error"]["note_id"] == note["id"]
    )
    assert list(note_path(client, note["id"]).parent.glob("*.md")) == [
        note_path(client, note["id"])
    ]


@pytest.mark.posix_storage
def test_rename_description_delete_last_tag_keep_body_and_advance_only_real_metadata(
    client, token_headers
):
    tag = make_tag(client, token_headers)
    note = make_note(client, token_headers, [tag["id"]]).json()
    path = note_path(client, note["id"])
    original = path.read_bytes()
    assert (
        client.patch(
            f"/api/v1/tags/{tag['id']}", headers=token_headers, json={"description": "只改说明"}
        ).status_code
        == 200
    )
    assert path.read_bytes() == original
    assert (
        client.patch(
            f"/api/v1/tags/{tag['id']}", headers=token_headers, json={"name": "学习"}
        ).status_code
        == 200
    )
    assert path.read_bytes() == original
    assert (
        client.patch(
            f"/api/v1/tags/{tag['id']}", headers=token_headers, json={"name": "学习记录"}
        ).status_code
        == 200
    )
    renamed = client.get(f"/api/v1/notes/{note['id']}", headers=token_headers).json()
    assert renamed["body"] == note["body"] and renamed["created_at"] == note["created_at"]
    assert renamed["version"] == 2 and renamed["tags"] == [{"id": tag["id"], "name": "学习记录"}]
    assert frontmatter(path.read_bytes())["tags"] == ["学习记录"]
    assert client.delete(f"/api/v1/tags/{tag['id']}", headers=token_headers).status_code == 204
    unclassified = client.get(f"/api/v1/notes/{note['id']}", headers=token_headers).json()
    assert unclassified["tags"] == [] and unclassified["version"] == 3
    assert unclassified["body"] == note["body"] and unclassified["id"] == note["id"]
    assert frontmatter(path.read_bytes())["tag_ids"] == []
    assert client.get("/api/v1/tags", headers=token_headers).json()["total"] == 0


@pytest.mark.posix_storage
def test_duplicate_tag_rename_leaves_note_version_file_and_associations(client, token_headers):
    tag = make_tag(client, token_headers)
    make_tag(client, token_headers, "另一标签")
    note = make_note(client, token_headers, [tag["id"]]).json()
    original = note_path(client, note["id"]).read_bytes()
    result = client.patch(
        f"/api/v1/tags/{tag['id']}",
        headers=token_headers,
        json={"name": "另一标签", "description": "不留下修改"},
    )
    assert_error(result, 409, "duplicate_tag")
    assert note_path(client, note["id"]).read_bytes() == original
    assert client.get(f"/api/v1/notes/{note['id']}", headers=token_headers).json() == note


@pytest.mark.parametrize(
    "changes",
    [
        {"title": ""},
        {"title": "  "},
        {"title": "多\n行"},
        {"title": "字" * 201},
        {"title": None},
        {"body": None},
        {"body": 12},
        {"body": "字" * 200001},
        {"body": "NUL\0"},
        {"body": "\ud800"},
        {"source": None},
        {"source": "x" * 2001},
        {"source": False},
        {"tag_ids": []},
        {"tag_ids": [None]},
        {"tag_ids": "not-list"},
        {"tag_ids": [str(uuid4())] * 65},
        {"unexpected": True},
    ],
)
def test_invalid_input_does_not_register_intent(client, token_headers, changes):
    tag = make_tag(client, token_headers)
    result = make_note(client, token_headers, [tag["id"]], **changes)
    assert_error(result, 422, "validation_error")
    assert client.get("/api/v1/notes", headers=token_headers).json()["total"] == 0


def test_invalid_or_duplicate_tag_ids_do_not_create_files(client, token_headers):
    tag = make_tag(client, token_headers)
    for ids in ([tag["id"], tag["id"].upper()], [str(uuid4())], ["../../etc/passwd"]):
        assert_error(make_note(client, token_headers, ids), 422, "invalid_tag_ids")
    assert client.get("/api/v1/notes", headers=token_headers).json()["total"] == 0


def test_only_authorized_batch_endpoints_and_origin_token_boundaries(client, token_headers):
    assert_error(client.get("/api/v1/notes"), 401, "invalid_local_token")
    assert_error(client.post("/api/v1/notes", json={}), 401, "invalid_local_token")
    assert_error(client.get(f"/api/v1/notes/{uuid4()}"), 401, "invalid_local_token")
    assert_error(
        client.get("/api/v1/notes", headers={**token_headers, "Origin": "https://evil.invalid"}),
        403,
        "forbidden_origin",
    )
    for params in ({"path": "/etc/passwd"}, {"folder": "../outside"}, {"tag_id": "invalid"}):
        assert_error(
            client.get("/api/v1/notes", headers=token_headers, params=params),
            422,
            "validation_error",
        )
    assert_error(
        client.get(f"/api/v1/notes/{uuid4()}", headers=token_headers), 404, "note_not_found"
    )
    assert_error(
        client.get("/api/v1/notes/not-an-id", headers=token_headers), 404, "note_not_found"
    )
    assert (
        client.patch(f"/api/v1/notes/{uuid4()}", headers=token_headers, json={}).status_code == 422
    )


@pytest.mark.posix_storage
def test_largest_utf8_body_and_64_tags_fit_budget_without_truncation(client, token_headers):
    tags = [make_tag(client, token_headers, str(index) + "😀" * 75)["id"] for index in range(64)]
    body = "😀" * 200000
    response = make_note(client, token_headers, tags, body=body, source="😀" * 2000)
    assert response.status_code == 201
    note = response.json()
    assert note_path(client, note["id"]).stat().st_size < 1024 * 1024
    assert client.get(f"/api/v1/notes/{note['id']}", headers=token_headers).json()["body"] == body


@pytest.mark.posix_storage
def test_note_intent_holds_write_lock_before_validation_while_chat_writes(
    client, token_headers, monkeypatch
):
    tag = make_tag(client, token_headers)
    service = client.app.state.note_service
    real_intent = service._intent
    entered, release, writer_started = Event(), Event(), Event()

    def paused_intent(*args, **kwargs):
        entered.set()
        assert release.wait(timeout=3)
        return real_intent(*args, **kwargs)

    monkeypatch.setattr(service, "_intent", paused_intent)

    def chat_write():
        writer_started.set()
        return client.post("/api/v1/conversations", headers=token_headers, json={})

    with ThreadPoolExecutor(max_workers=2) as pool:
        creation = pool.submit(make_note, client, token_headers, [tag["id"]])
        assert entered.wait(timeout=3)
        chat = pool.submit(chat_write)
        assert writer_started.wait(timeout=3)
        try:
            time.sleep(0.05)
            assert not chat.done(), "聊天写入不能在笔记校验与意图登记之间推进快照"
        finally:
            release.set()
        assert creation.result(timeout=5).status_code == 201
        assert chat.result(timeout=5).status_code == 201


def assert_error(response, status, code):
    assert response.status_code == status, response.text
    assert set(response.json()) == {"error"}
    assert response.json()["error"]["code"] == code
    assert isinstance(response.json()["error"]["message"], str)
