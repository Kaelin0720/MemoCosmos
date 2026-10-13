import tomllib
from pathlib import Path

from app.core.settings import (
    Settings,
    default_config_dir,
    default_memory_dir,
)
from app.main import create_app


def test_release_metadata_and_official_locked_registry():
    root = Path(__file__).resolve().parents[1]
    project = tomllib.loads((root / "pyproject.toml").read_text())
    lock = tomllib.loads((root / "uv.lock").read_text())
    assert project["project"]["name"] == "memocosmos-backend"
    assert project["project"]["version"] == "1.0.0"
    assert project["project"]["license"] == "MIT"
    assert create_app().version == "1.0.0"
    assert create_app().title.startswith("MemoCosmos")
    assert all(
        index["url"] == "https://pypi.org/simple" for index in project["tool"]["uv"]["index"]
    )
    assert all(
        package["source"]["registry"] == "https://pypi.org/simple"
        for package in lock["package"]
        if "registry" in package["source"]
    )


def test_brand_rename_preserves_legacy_default_paths_and_environment(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "settings"))
    for platform, memory, config in (
        (
            "darwin",
            tmp_path / "home/Library/Application Support/Yihe/memory",
            tmp_path / "home/Library/Application Support/Yihe/config",
        ),
        ("win32", tmp_path / "local/Yihe/memory", tmp_path / "local/Yihe/config"),
        ("linux", tmp_path / "data/yihe/memory", tmp_path / "settings/yihe/config"),
    ):
        monkeypatch.setattr("app.core.settings.sys.platform", platform)
        assert default_memory_dir() == memory
        assert default_config_dir() == config
    monkeypatch.setenv("YIHE_MEMORY_DIR", str(tmp_path / "explicit-memory"))
    monkeypatch.setenv("YIHE_CONFIG_DIR", str(tmp_path / "explicit-config"))
    selected = Settings.from_env()
    assert selected.memory_dir == tmp_path / "explicit-memory"
    assert selected.config_dir == tmp_path / "explicit-config"
