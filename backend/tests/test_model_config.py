import os
import stat

import pytest
from agent_helpers import auth, configure
from fastapi.testclient import TestClient
from test_tags import assert_error

from app.core.errors import ApiError
from app.core.model_config import ModelConfigStore
from app.core.settings import SOURCE_ROOT, Settings
from app.main import create_app
from app.schemas.agent import AgentConfigUpdate


def test_missing_configuration_does_not_stop_tags(client, token_headers, monkeypatch):
    for name in ("CHAT_MODEL_BASE_URL", "CHAT_MODEL_NAME", "CHAT_MODEL_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    status = client.get("/api/v1/agent/status", headers=token_headers).json()
    assert status == {
        "configured": False,
        "provider": "openai_compatible",
        "model": None,
        "base_url": None,
        "has_api_key": False,
        "source": "none",
        "reason": "model_not_configured",
        "tools": ["list_tags", "search_memory", "read_note"],
        "context_max_chars": 32000,
        "context_max_turns": 12,
    }
    assert (
        client.post("/api/v1/tags", headers=token_headers, json={"name": "仍可保存"}).status_code
        == 201
    )


def test_configuration_is_private_persistent_and_never_returned(tmp_path, monkeypatch):
    monkeypatch.setenv("CHAT_MODEL_BASE_URL", "https://env.invalid/v1")
    monkeypatch.setenv("CHAT_MODEL_NAME", "environment-model")
    monkeypatch.setenv("CHAT_MODEL_API_KEY", "environment-test-key")
    settings = Settings(tmp_path / "memory", tmp_path / "config")
    with TestClient(create_app(settings), base_url="http://127.0.0.1:8000") as client:
        headers = auth(client)
        assert client.get("/api/v1/agent/status", headers=headers).json()["source"] == "env"
        status = configure(client, headers)
        assert status["source"] == "file"
        assert status["configured"] and status["has_api_key"]
        assert "test-only-secret" not in str(status)
        updated = client.put(
            "/api/v1/agent/config",
            headers=headers,
            json={
                "base_url": "https://changed.invalid/v1/",
                "model": "changed-model",
            },
        )
        assert updated.status_code == 200
        assert updated.json()["base_url"] == "https://changed.invalid/v1"
        assert "api_key" not in updated.json()
    path = settings.model_config_path()
    if os.name == "posix":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    assert not path.is_relative_to(settings.memory_dir)
    assert ("test-only-secret" in path.read_text()) == (os.name == "posix")
    if os.name == "nt":
        assert "windows-dpapi-current-user-v1" in path.read_text()
    assert not list(path.parent.glob(".model-*"))
    with TestClient(create_app(settings), base_url="http://127.0.0.1:8000") as restarted:
        status = restarted.get("/api/v1/agent/status", headers=auth(restarted)).json()
        assert status["source"] == "file" and status["model"] == "changed-model"
        assert "test-only-secret" not in str(status)


@pytest.mark.parametrize(
    "patch",
    [
        {"api_key": ""},
        {"api_key": None},
        {"api_key": 123},
        {"api_key": "key\ninside"},
        {"api_key": "x" * 4097},
        {"model": " "},
        {"model": "a\nb"},
        {"extra": True},
        {"base_url": "https://user:password@host/v1"},
        {"base_url": "https://host/v1?key=test-only-secret"},
        {"base_url": "https://host/v1#secret"},
        {"base_url": "file:///tmp/key"},
        {"base_url": "https://host:99999/v1"},
        {"base_url": "https://host/ with space"},
    ],
)
def test_invalid_config_never_echoes_key_or_changes_saved_file(client, token_headers, patch):
    configure(client, token_headers)
    old = client.app.state.model_config_store.settings.model_config_path().read_bytes()
    response = client.put(
        "/api/v1/agent/config",
        headers=token_headers,
        json={
            "base_url": "https://example.invalid/v1",
            "model": "test",
            "api_key": "test-only-secret",
            **patch,
        },
    )
    assert_error(response, 422, "validation_error")
    assert "test-only-secret" not in response.text
    assert client.app.state.model_config_store.settings.model_config_path().read_bytes() == old


def test_first_save_requires_key(client, token_headers, monkeypatch):
    monkeypatch.delenv("CHAT_MODEL_API_KEY", raising=False)
    assert_error(
        client.put(
            "/api/v1/agent/config",
            headers=token_headers,
            json={
                "base_url": "https://example.invalid/v1",
                "model": "test",
            },
        ),
        422,
        "validation_error",
    )


@pytest.mark.parametrize("kind", ["source", "memory", "relative", "symlink"])
def test_configuration_path_cannot_leak_to_source_or_memory(tmp_path, kind):
    memory = tmp_path / "memory"
    path = {
        "source": SOURCE_ROOT / "config",
        "memory": memory / "config",
        "relative": "relative-config",
        "symlink": tmp_path / "link",
    }[kind]
    if kind == "symlink":
        try:
            path.symlink_to(tmp_path / "outside", target_is_directory=True)
        except OSError:
            pytest.skip("This OS user cannot create a directory symlink")
    settings = Settings(memory, path if isinstance(path, str) else path)
    if isinstance(path, str):
        from pathlib import Path

        settings = Settings(memory, Path(path))
    with pytest.raises(ValueError):
        settings.model_config_path()


def test_unsafe_or_corrupt_file_does_not_fall_back_to_env(tmp_path, monkeypatch):
    settings = Settings(tmp_path / "memory", tmp_path / "config")
    store = ModelConfigStore(settings)
    store.save(AgentConfigUpdate(base_url="https://file.invalid/v1", model="file", api_key="key"))
    monkeypatch.setenv("CHAT_MODEL_BASE_URL", "https://env.invalid/v1")
    monkeypatch.setenv("CHAT_MODEL_NAME", "env")
    monkeypatch.setenv("CHAT_MODEL_API_KEY", "env-test-key")
    settings.model_config_path().write_text("invalid JSON")
    assert not store.snapshot().status.configured
    assert store.snapshot().status.source == "file"
    settings.model_config_path().write_text("{}")
    os.chmod(settings.model_config_path(), 0o644)
    assert store.snapshot().status.reason == "model_config_invalid"


def test_failed_atomic_replace_keeps_previous_config_and_removes_temp(
    client, token_headers, monkeypatch
):
    configure(client, token_headers)
    path = client.app.state.model_config_store.settings.model_config_path()
    original = path.read_bytes()

    def fail_replace(*args, **kwargs):
        raise OSError("untrusted-error test-only-secret")

    monkeypatch.setattr(os, "replace", fail_replace)
    response = client.put(
        "/api/v1/agent/config",
        headers=token_headers,
        json={
            "base_url": "https://changed.invalid/v1",
            "model": "changed-model",
        },
    )
    assert_error(response, 503, "config_write_failed")
    assert "untrusted-error" not in response.text and "test-only-secret" not in response.text
    assert path.read_bytes() == original
    assert not list(path.parent.glob(".model-*"))


@pytest.mark.skipif(
    os.name != "posix", reason="POSIX permission enforcement; Windows uses DACL/DPAPI"
)
@pytest.mark.parametrize("target", ["directory", "file"])
def test_filesystem_that_ignores_private_permissions_never_receives_key(
    tmp_path, monkeypatch, target
):
    from types import SimpleNamespace

    settings = Settings(tmp_path / "memory", tmp_path / "config")
    if target == "directory":
        settings.config_dir.mkdir(mode=0o755)
        monkeypatch.setattr(os, "chmod", lambda *args: None)
    else:
        actual = os.fstat

        def unsafe(descriptor):
            info = actual(descriptor)
            return SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_nlink=info.st_nlink)

        monkeypatch.setattr(os, "fstat", unsafe)
    with pytest.raises(ApiError) as caught:
        ModelConfigStore(settings).save(
            AgentConfigUpdate(
                base_url="https://temporary.invalid/v1",
                model="temporary",
                api_key="permission-test-secret",
            )
        )
    assert getattr(caught.value, "code", None) == "config_write_failed"
    assert not settings.model_config_path().exists()
    assert not list(settings.config_dir.glob(".model-*"))
