import json
import os
from uuid import uuid4

import pytest
from sqlalchemy import update
from test_note_recovery import unavailable
from test_notes import assert_error, frontmatter, make_note, make_tag, note_path

from app.db.models import Tag
from app.vault.topic_files import MAX_FILE_BYTES

pytestmark = pytest.mark.posix_storage


@pytest.mark.parametrize("kind", ["symlink", "hardlink", "fifo", "directory", "utf8", "oversize"])
def test_unsafe_known_files_are_conflicts_and_never_rewritten(
    client, token_headers, tmp_path, kind
):
    tag = make_tag(client, token_headers)
    note = make_note(client, token_headers, [tag["id"]]).json()
    path = note_path(client, note["id"])
    outside = tmp_path / "outside.md"
    outside.write_bytes(path.read_bytes())
    path.unlink()
    if kind == "symlink":
        path.symlink_to(outside)
    elif kind == "hardlink":
        os.link(outside, path)
    elif kind == "fifo":
        os.mkfifo(path)
    elif kind == "directory":
        path.mkdir()
    elif kind == "utf8":
        path.write_bytes(b"\xffinvalid")
    else:
        path.write_bytes(b"x" * (MAX_FILE_BYTES + 1))
    before = outside.read_bytes()
    response = client.get(f"/api/v1/notes/{note['id']}", headers=token_headers)
    assert_error(response, 409, "note_file_invalid")
    assert str(path) not in response.text and str(outside) not in response.text
    assert (
        client.patch(
            f"/api/v1/tags/{tag['id']}", headers=token_headers, json={"name": "重命名"}
        ).status_code
        == 200
    )
    assert outside.read_bytes() == before
    listing = client.get("/api/v1/notes", headers=token_headers).json()["items"][0]
    assert listing["sync_status"] == "conflict" and listing["tags"][0]["name"] == "重命名"


@pytest.mark.parametrize("level", ["notes", "topics", "root"])
def test_symlink_directory_is_rejected_before_registering_note(
    client, token_headers, tmp_path, level
):
    tag = make_tag(client, token_headers)
    files = client.app.state.note_service.files
    outside = tmp_path / "outside"
    outside.mkdir()
    marker = outside / "marker"
    marker.write_text("外部文件不动")
    if level == "notes":
        (files.root / "notes").symlink_to(outside, target_is_directory=True)
    elif level == "topics":
        (files.root / "notes").mkdir()
        (files.root / "notes/topics").symlink_to(outside, target_is_directory=True)
    else:
        link = tmp_path / "linked-memory"
        link.symlink_to(outside, target_is_directory=True)
        files.root = link
    assert_error(make_note(client, token_headers, [tag["id"]]), 503, "note_storage_unavailable")
    assert client.get("/api/v1/notes", headers=token_headers).json()["total"] == 0
    assert list(outside.iterdir()) == [marker] and marker.read_text() == "外部文件不动"


def test_existing_unregistered_target_is_not_overwritten_or_registered(
    client, token_headers, monkeypatch
):
    tag = make_tag(client, token_headers)
    chosen = uuid4()
    service = client.app.state.note_service
    service.files.prepare()
    path = note_path(client, str(chosen))
    path.write_text("外部已有文档")
    monkeypatch.setattr("app.services.notes.uuid4", lambda: chosen)
    assert_error(make_note(client, token_headers, [tag["id"]]), 503, "note_storage_unavailable")
    assert path.read_text() == "外部已有文档"
    assert client.get("/api/v1/notes", headers=token_headers).json()["total"] == 0


def test_no_clobber_if_external_target_appears_during_publication(
    client, token_headers, monkeypatch
):
    tag = make_tag(client, token_headers)
    link = os.link

    def racing_link(src, dst, **kwargs):
        handle = os.open(
            dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=kwargs["dst_dir_fd"]
        )
        with os.fdopen(handle, "wb") as stream:
            stream.write(b"external-racing-file")
        return link(src, dst, **kwargs)

    monkeypatch.setattr(os, "link", racing_link)
    result = make_note(client, token_headers, [tag["id"]])
    assert_error(result, 503, "note_write_failed")
    error = result.json()["error"]
    assert error["sync_status"] == "conflict" and error["retryable"] is False
    assert note_path(client, error["note_id"]).read_bytes() == b"external-racing-file"
    assert_error(
        client.get(f"/api/v1/notes/{error['note_id']}", headers=token_headers),
        409,
        "external_note_changed",
    )


def test_symlink_owned_temp_is_preserved_and_cannot_escape(
    client, token_headers, tmp_path, monkeypatch
):
    tag = make_tag(client, token_headers)
    service = client.app.state.note_service
    publish = service.files.publish
    monkeypatch.setattr(service.files, "publish", unavailable)
    result = make_note(client, token_headers, [tag["id"]])
    error = result.json()["error"]
    outside = tmp_path / "outside-temp"
    outside.write_bytes(b"private-unchanged")
    temporary = note_path(client, error["note_id"]).parent / ("." + error["operation_id"] + ".tmp")
    temporary.symlink_to(outside)
    monkeypatch.setattr(service.files, "publish", publish)
    assert_error(
        client.get(f"/api/v1/notes/{error['note_id']}", headers=token_headers),
        409,
        "note_file_missing",
    )
    # 恢复已记录 file_invalid；详情再检查确认目标缺失，两者都保留现场。
    assert temporary.is_symlink() and outside.read_bytes() == b"private-unchanged"
    assert not note_path(client, error["note_id"]).exists()


def test_readable_chinese_metadata_escape_controls_and_preserve_body(client, token_headers):
    tag = make_tag(client, token_headers, '中文"标签\n分行\u0085\u2028')
    body = "  \n\n### 原始正文\r\n\t尾部  \n\n"
    source = '中文出处"\n第二行\u2029'
    result = make_note(client, token_headers, [tag["id"]], body=body, source=source)
    assert result.status_code == 201
    note = result.json()
    data = note_path(client, note["id"]).read_bytes()
    assert "中文".encode() in data and b"\\u4e2d" not in data
    assert frontmatter(data)["source"] == source and frontmatter(data)["tags"] == [tag["name"]]
    assert note["body"] == body and data.endswith(body.encode())
    assert (
        client.patch(
            f"/api/v1/tags/{tag['id']}", headers=token_headers, json={"name": "新的中文标签"}
        ).status_code
        == 200
    )
    assert client.get(f"/api/v1/notes/{note['id']}", headers=token_headers).json()["body"] == body
    assert note_path(client, note["id"]).read_bytes().endswith(body.encode())


def test_legacy_invalid_tag_text_is_rejected_before_note_intent(client, token_headers):
    tag = make_tag(client, token_headers)
    with client.app.state.note_service.sessions() as session:
        session.execute(update(Tag).where(Tag.id == tag["id"]).values(name=b"\xff"))
        session.commit()
    assert_error(make_note(client, token_headers, [tag["id"]]), 422, "invalid_tag_ids")
    assert client.get("/api/v1/notes", headers=token_headers).json()["total"] == 0


@pytest.mark.parametrize("value", ["\ud800", "NUL\0"])
def test_tag_input_bad_encoding_is_validation_error_not_partial_write(client, token_headers, value):
    response = client.post(
        "/api/v1/tags",
        headers={**token_headers, "Content-Type": "application/json"},
        content=json.dumps({"name": value}),
    )
    assert_error(response, 422, "validation_error")
    assert client.get("/api/v1/tags", headers=token_headers).json()["total"] == 0
