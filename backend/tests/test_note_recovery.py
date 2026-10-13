import os
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select, update
from test_notes import assert_error, frontmatter, make_note, make_tag, note_path

from app.core.settings import Settings
from app.db.models import NoteWrite, Tag
from app.main import create_app

pytestmark = pytest.mark.posix_storage


def unavailable(*args, **kwargs):
    raise OSError("private-path-and-key-must-never-be-returned")


def write_rows(client):
    with client.app.state.note_service.sessions() as session:
        return list(session.scalars(select(NoteWrite).order_by(NoteWrite.created_at, NoteWrite.id)))


def test_intent_io_failure_exposes_ids_pending_and_one_attempt_then_recovers(
    client, token_headers, monkeypatch
):
    tag = make_tag(client, token_headers)
    service = client.app.state.note_service
    real = service.files.publish
    calls = []

    def fail(*args, **kwargs):
        calls.append(args[1])
        unavailable()

    monkeypatch.setattr(service.files, "publish", fail)
    failed = make_note(client, token_headers, [tag["id"]])
    assert_error(failed, 503, "note_write_failed")
    error = failed.json()["error"]
    assert error["sync_status"] == "pending" and error["retryable"] is True
    assert "private-path-and-key" not in failed.text
    note_id = error["note_id"]
    summary = client.get("/api/v1/notes", headers=token_headers).json()["items"][0]
    assert summary["sync_status"] == "pending" and "body" not in summary
    assert_error(
        client.get(f"/api/v1/notes/{note_id}", headers=token_headers), 409, "note_sync_pending"
    )
    assert calls == [error["operation_id"], error["operation_id"]]
    monkeypatch.setattr(service.files, "publish", real)
    recovered = client.get(f"/api/v1/notes/{note_id}", headers=token_headers)
    assert recovered.status_code == 200 and recovered.json()["version"] == 1
    assert recovered.json()["created_at"] == summary["created_at"]
    assert [row.id for row in write_rows(client)] == [error["operation_id"]]
    assert write_rows(client)[0].status == "completed"


def test_published_file_confirmation_failure_only_confirms_same_bytes(
    client, token_headers, monkeypatch
):
    tag = make_tag(client, token_headers)
    service = client.app.state.note_service
    confirm = service._confirm
    monkeypatch.setattr(service, "_confirm", unavailable)
    result = make_note(client, token_headers, [tag["id"]])
    assert_error(result, 503, "note_write_failed")
    note_id = result.json()["error"]["note_id"]
    path = note_path(client, note_id)
    data, inode = path.read_bytes(), path.stat().st_ino
    monkeypatch.setattr(service, "_confirm", confirm)
    monkeypatch.setattr(os, "link", unavailable)  # 若重写，测试会失败。
    detail = client.get(f"/api/v1/notes/{note_id}", headers=token_headers)
    assert detail.status_code == 200
    assert path.read_bytes() == data and path.stat().st_ino == inode
    assert detail.json()["version"] == frontmatter(data)["version"] == 1


def test_restart_recovers_temp_and_owned_publish_hardlink(client, token_headers, monkeypatch):
    tag = make_tag(client, token_headers)
    unlink = os.unlink

    def fail_owned_temp(path, *args, **kwargs):
        if str(path).endswith(".tmp"):
            unavailable()
        return unlink(path, *args, **kwargs)

    monkeypatch.setattr(os, "unlink", fail_owned_temp)
    result = make_note(client, token_headers, [tag["id"]])
    assert_error(result, 503, "note_write_failed")
    note_id = result.json()["error"]["note_id"]
    path = note_path(client, note_id)
    assert path.stat().st_nlink == 2
    monkeypatch.setattr(os, "unlink", unlink)
    settings = Settings(
        client.app.state.note_service.files.root,
        client.app.state.model_config_store.settings.config_dir,
    )
    # 原客户端空闲；两次生命周期只验证启动恢复，不并发写入同一库。
    with TestClient(create_app(settings), base_url="http://127.0.0.1:8000") as restarted:
        headers = {"X-Local-Token": restarted.get("/api/v1/bootstrap").json()["local_token"]}
        read = restarted.get(f"/api/v1/notes/{note_id}", headers=headers)
        assert read.status_code == 200 and read.json()["version"] == 1
    assert path.stat().st_nlink == 1 and not list(path.parent.glob(".*.tmp"))


def test_unpublished_temp_is_rebuilt_from_same_intent(client, token_headers, monkeypatch):
    tag = make_tag(client, token_headers)
    link = os.link
    monkeypatch.setattr(os, "link", unavailable)
    result = make_note(client, token_headers, [tag["id"]])
    note_id, op_id = result.json()["error"]["note_id"], result.json()["error"]["operation_id"]
    path = note_path(client, note_id)
    assert not path.exists() and (path.parent / ("." + op_id + ".tmp")).is_file()
    monkeypatch.setattr(os, "link", link)
    assert client.get(f"/api/v1/notes/{note_id}", headers=token_headers).status_code == 200
    assert not list(path.parent.glob(".*.tmp")) and len(write_rows(client)) == 1


def test_external_edit_stays_conflict_through_tag_rename_and_delete(client, token_headers):
    tag = make_tag(client, token_headers)
    note = make_note(client, token_headers, [tag["id"]]).json()
    path = note_path(client, note["id"])
    external = path.read_bytes() + "\n外部编辑者的新内容".encode()
    path.write_bytes(external)
    assert_error(
        client.get(f"/api/v1/notes/{note['id']}", headers=token_headers),
        409,
        "external_note_changed",
    )
    assert (
        client.patch(
            f"/api/v1/tags/{tag['id']}", headers=token_headers, json={"name": "新标签"}
        ).status_code
        == 200
    )
    listing = client.get("/api/v1/notes", headers=token_headers).json()["items"][0]
    assert listing["sync_status"] == "conflict" and listing["version"] == 2
    assert listing["tags"] == [{"id": tag["id"], "name": "新标签"}]
    assert client.delete(f"/api/v1/tags/{tag['id']}", headers=token_headers).status_code == 204
    listing = client.get("/api/v1/notes", headers=token_headers).json()["items"][0]
    assert listing["tags"] == [] and listing["version"] == 3
    assert path.read_bytes() == external
    client.app.state.note_service.recover_startup()
    assert (
        path.read_bytes() == external
        and client.get("/api/v1/tags", headers=token_headers).json()["total"] == 0
    )


def test_pending_creation_blocks_tag_change_then_recovers_before_delete(
    client, token_headers, monkeypatch
):
    tag = make_tag(client, token_headers)
    service = client.app.state.note_service
    publish = service.files.publish
    monkeypatch.setattr(service.files, "publish", unavailable)
    result = make_note(client, token_headers, [tag["id"]])
    note_id = result.json()["error"]["note_id"]
    assert_error(
        client.delete(f"/api/v1/tags/{tag['id']}", headers=token_headers), 409, "note_sync_pending"
    )
    assert client.get("/api/v1/tags", headers=token_headers).json()["total"] == 1
    monkeypatch.setattr(service.files, "publish", publish)
    assert client.delete(f"/api/v1/tags/{tag['id']}", headers=token_headers).status_code == 204
    read = client.get(f"/api/v1/notes/{note_id}", headers=token_headers).json()
    assert read["version"] == 2 and read["tags"] == []


def test_failed_metadata_is_superseded_and_does_not_resurrect_deleted_tag(
    client, token_headers, monkeypatch
):
    tag = make_tag(client, token_headers)
    note = make_note(client, token_headers, [tag["id"]]).json()
    path = note_path(client, note["id"])
    original = path.read_bytes()
    service = client.app.state.note_service
    publish = service.files.publish
    monkeypatch.setattr(service.files, "publish", unavailable)
    assert (
        client.patch(
            f"/api/v1/tags/{tag['id']}", headers=token_headers, json={"name": "改名"}
        ).status_code
        == 200
    )
    assert (
        client.get("/api/v1/notes", headers=token_headers).json()["items"][0]["sync_status"]
        == "pending"
    )
    assert client.delete(f"/api/v1/tags/{tag['id']}", headers=token_headers).status_code == 204
    assert path.read_bytes() == original
    rows = write_rows(client)
    assert sorted(row.status for row in rows) == ["completed", "pending", "superseded"]
    monkeypatch.setattr(service.files, "publish", publish)
    service.recover_startup()
    read = client.get(f"/api/v1/notes/{note['id']}", headers=token_headers).json()
    assert read["tags"] == [] and read["version"] == 3 and read["body"] == note["body"]
    assert frontmatter(path.read_bytes())["tags"] == []
    assert client.get("/api/v1/tags", headers=token_headers).json()["total"] == 0


def test_pending_create_external_file_conflict_can_unclassify_without_replay(
    client, token_headers, monkeypatch
):
    tag = make_tag(client, token_headers)
    service = client.app.state.note_service
    publish = service.files.publish
    monkeypatch.setattr(service.files, "publish", unavailable)
    result = make_note(client, token_headers, [tag["id"]])
    note_id = result.json()["error"]["note_id"]
    path = note_path(client, note_id)
    external = b"user-owned external file"
    path.write_bytes(external)
    monkeypatch.setattr(service.files, "publish", publish)
    assert_error(
        client.get(f"/api/v1/notes/{note_id}", headers=token_headers), 409, "external_note_changed"
    )
    assert client.delete(f"/api/v1/tags/{tag['id']}", headers=token_headers).status_code == 204
    service.recover_startup()
    assert path.read_bytes() == external
    assert client.get("/api/v1/notes", headers=token_headers).json()["items"][0]["tags"] == []
    assert write_rows(client)[0].status == "superseded"


def test_missing_confirmed_file_is_not_recreated_by_tag_delete(client, token_headers):
    tag = make_tag(client, token_headers)
    note = make_note(client, token_headers, [tag["id"]]).json()
    path = note_path(client, note["id"])
    path.unlink()
    assert_error(
        client.get(f"/api/v1/notes/{note['id']}", headers=token_headers), 409, "note_file_missing"
    )
    assert client.delete(f"/api/v1/tags/{tag['id']}", headers=token_headers).status_code == 204
    client.app.state.note_service.recover_startup()
    assert not path.exists()


def test_unknown_temp_is_preserved_and_startup_recovery_is_bounded(
    client, token_headers, monkeypatch
):
    tag = make_tag(client, token_headers)
    service = client.app.state.note_service
    publish = service.files.publish
    monkeypatch.setattr(service.files, "publish", unavailable)
    for index in range(3):
        assert make_note(client, token_headers, [tag["id"]], title=str(index)).status_code == 503
    directory = service.files.root / "notes/topics"
    unknown = directory / ("." + str(uuid4()) + ".tmp")
    unknown.write_bytes(b"unknown-user-content")
    monkeypatch.setattr(service.files, "publish", publish)
    service.recover_startup(limit=2)
    listing = client.get("/api/v1/notes", headers=token_headers).json()["items"]
    assert sorted(note["sync_status"] for note in listing) == ["pending", "synced", "synced"]
    assert unknown.read_bytes() == b"unknown-user-content"


def test_temporary_read_io_error_is_pending_and_can_recover_without_new_version(
    client, token_headers, monkeypatch
):
    tag = make_tag(client, token_headers)
    note = make_note(client, token_headers, [tag["id"]]).json()
    service = client.app.state.note_service
    read = service.files.read
    from app.vault.topic_files import FileIssue

    def fail(*args):
        raise FileIssue("note_storage_unavailable", "文档暂不可读", True)

    monkeypatch.setattr(service.files, "read", fail)
    assert_error(
        client.get(f"/api/v1/notes/{note['id']}", headers=token_headers),
        503,
        "note_storage_unavailable",
    )
    assert (
        client.get("/api/v1/notes", headers=token_headers).json()["items"][0]["sync_status"]
        == "pending"
    )
    assert_error(
        client.delete(f"/api/v1/tags/{tag['id']}", headers=token_headers), 409, "note_sync_pending"
    )
    monkeypatch.setattr(service.files, "read", read)
    assert client.get(f"/api/v1/notes/{note['id']}", headers=token_headers).json() == note
    assert len(write_rows(client)) == 1


@pytest.mark.parametrize("change", ["rename", "delete"])
def test_recovery_rejects_stale_tag_snapshot_in_persisted_intent(
    client, token_headers, monkeypatch, change
):
    tag = make_tag(client, token_headers)
    service = client.app.state.note_service
    publish = service.files.publish
    monkeypatch.setattr(service.files, "publish", unavailable)
    result = make_note(client, token_headers, [tag["id"]])
    note_id = result.json()["error"]["note_id"]
    with service.sessions() as session:
        if change == "rename":
            session.execute(update(Tag).where(Tag.id == tag["id"]).values(name="外部数据库改名"))
        else:
            session.execute(delete(Tag).where(Tag.id == tag["id"]))
        session.commit()
    monkeypatch.setattr(service.files, "publish", publish)
    service.recover_startup()
    assert not note_path(client, note_id).exists()
    assert write_rows(client)[0].status == "conflict"
    if change == "delete":
        assert client.get("/api/v1/tags", headers=token_headers).json()["total"] == 0
