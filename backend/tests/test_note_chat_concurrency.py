import time
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from uuid import uuid4

import pytest
from agent_helpers import ScriptedModel, configure
from fastapi.testclient import TestClient
from test_notes import make_note, make_tag

from app.core.settings import Settings
from app.main import create_app

pytestmark = pytest.mark.posix_storage


def test_streaming_chat_keeps_all_deltas_while_note_intent_holds_writer(tmp_path, monkeypatch):
    model = ScriptedModel(reply="字" * 100, delay=0.005)
    settings = Settings(tmp_path / "memory", tmp_path / "config")
    with TestClient(
        create_app(settings, model_factory=lambda _: model), base_url="http://127.0.0.1:8000"
    ) as client:
        headers = {"X-Local-Token": client.get("/api/v1/bootstrap").json()["local_token"]}
        configure(client, headers)
        tag = make_tag(client, headers)
        conversation = client.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
        run = client.post(
            f"/api/v1/conversations/{conversation}/messages",
            headers=headers,
            json={"client_message_id": str(uuid4()), "content": "普通聊天"},
        ).json()
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if (
                client.get(f"/api/v1/runs/{run['id']}", headers=headers).json()["status"]
                == "running"
            ):
                break
            time.sleep(0.01)
        else:
            raise AssertionError("测试聊天未开始")
        service = client.app.state.note_service
        original = service._intent
        entered, release = Event(), Event()

        def paused(*args, **kwargs):
            entered.set()
            assert release.wait(timeout=3)
            return original(*args, **kwargs)

        monkeypatch.setattr(service, "_intent", paused)
        with ThreadPoolExecutor(max_workers=1) as pool:
            save = pool.submit(make_note, client, headers, [tag["id"]])
            assert entered.wait(timeout=3)
            time.sleep(0.1)
            release.set()
            assert save.result(timeout=5).status_code == 201
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            state = client.get(f"/api/v1/runs/{run['id']}", headers=headers).json()
            if state["status"] not in ("pending", "running"):
                break
            time.sleep(0.01)
        assert state["status"] == "completed", state
        messages = client.get(
            f"/api/v1/conversations/{conversation}/messages", headers=headers
        ).json()["items"]
        assert messages[0]["content"] == "普通聊天" and messages[1]["content"] == "字" * 100


@pytest.mark.parametrize("phase", ["publish", "catalog", "confirm_read"])
def test_chat_commits_more_text_before_blocked_note_io_is_released(tmp_path, monkeypatch, phase):
    reply = "字" * 200
    model = ScriptedModel(reply=reply, delay=0.005)
    with TestClient(
        create_app(
            Settings(tmp_path / "memory", tmp_path / "config"), model_factory=lambda _: model
        ),
        base_url="http://127.0.0.1:8000",
    ) as client:
        headers = {"X-Local-Token": client.get("/api/v1/bootstrap").json()["local_token"]}
        configure(client, headers)
        tag = make_tag(client, headers)
        if phase == "catalog":
            assert make_note(client, headers, [tag["id"]], title="目录里的笔记").status_code == 201
        conversation = client.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
        run = client.post(
            f"/api/v1/conversations/{conversation}/messages",
            headers=headers,
            json={"client_message_id": str(uuid4()), "content": "普通聊天"},
        ).json()
        messages_url = f"/api/v1/conversations/{conversation}/messages"

        def assistant_text():
            response = client.get(messages_url, headers=headers)
            assert response.status_code == 200
            return response.json()["items"][-1]["content"]

        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            baseline = assistant_text()
            if baseline:
                break
            time.sleep(0.01)
        else:
            raise AssertionError("聊天没有首个持久增量")
        assert len(baseline) < len(reply)
        service = client.app.state.note_service
        entered, release = Event(), Event()

        def paused(callback, *args, **kwargs):
            if not release.is_set():
                entered.set()
                assert release.wait(timeout=4)
            return callback(*args, **kwargs)

        if phase == "catalog":
            from app.services import notes

            original = notes.tags_for
            monkeypatch.setattr(notes, "tags_for", lambda *args: paused(original, *args))

            def note_request():
                return client.get("/api/v1/notes", headers=headers)

            expected = 200
        else:
            method = "publish" if phase == "publish" else "read"
            original = getattr(service.files, method)
            monkeypatch.setattr(service.files, method, lambda *args: paused(original, *args))

            def note_request():
                return make_note(client, headers, [tag["id"]])

            expected = 201

        def progress():
            at_start = assistant_text()  # 已确认笔记 I/O 被阻塞之后，再取聊天基线。
            assert len(at_start) < len(reply)
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                time.sleep(0.01)
                current = assistant_text()
                if len(current) > len(at_start):
                    return at_start, current
            raise AssertionError("笔记纯 I/O 阻塞期间聊天未提交增量")

        with ThreadPoolExecutor(max_workers=2) as pool:
            note = pool.submit(note_request)
            try:
                assert entered.wait(timeout=3)
                probe = pool.submit(progress)
                before, after = probe.result(timeout=2)
                assert len(after) > len(before) >= len(baseline)
                assert not note.done() and not release.is_set()
            finally:
                release.set()
            assert note.result(timeout=5).status_code == expected
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            state = client.get(f"/api/v1/runs/{run['id']}", headers=headers).json()
            if state["status"] not in ("pending", "running"):
                break
            time.sleep(0.01)
        assert state["status"] == "completed"
        assert assistant_text() == reply
