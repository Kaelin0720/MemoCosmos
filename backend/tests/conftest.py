import os

import pytest
from fastapi.testclient import TestClient

from app.core.settings import Settings
from app.main import create_app


@pytest.fixture(autouse=True)
def isolated_cloud_environment(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "app.core.settings.default_config_dir", lambda: tmp_path / "isolated-default-config"
    )
    # 测试只能使用临时保存配置或本用例显式设置的环境，禁止继承真实云端账号。
    for name in (
        "CHAT_MODEL_PROVIDER",
        "CHAT_MODEL_BASE_URL",
        "CHAT_MODEL_NAME",
        "CHAT_MODEL_API_KEY",
    ):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def client(tmp_path):
    with TestClient(
        create_app(Settings(tmp_path / "memory", tmp_path / "config")),
        base_url="http://127.0.0.1:8000",
    ) as api:
        yield api


@pytest.fixture
def token_headers(client):
    token = client.get("/api/v1/bootstrap").json()["local_token"]
    return {"X-Local-Token": token}


def pytest_collection_modifyitems(items):
    if os.name == "posix" and hasattr(os, "O_NOFOLLOW"):
        return
    skip = pytest.mark.skip(reason="Requires secure POSIX note storage; native Windows uses WSL2")
    for item in items:
        if item.get_closest_marker("posix_storage"):
            item.add_marker(skip)
