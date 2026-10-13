"""记忆库和私密模型配置的边界；不自动加载 .env。"""

import os
import sys
from dataclasses import dataclass
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[3]
DEVELOPMENT_ORIGINS = ("http://127.0.0.1:3000", "http://localhost:3000")


def default_memory_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Yihe" / "memory"
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
        return base / "Yihe" / "memory"
    base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / "yihe" / "memory"


def default_config_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Yihe" / "config"
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
        return base / "Yihe" / "config"
    base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return base / "yihe" / "config"


@dataclass(frozen=True)
class Settings:
    memory_dir: Path
    config_dir: Path | None = None
    run_timeout_seconds: float = 120
    agent_max_steps: int = 12
    output_max_chars: int = 20000

    @classmethod
    def from_env(cls) -> "Settings":
        value = os.environ.get("YIHE_MEMORY_DIR")
        config = os.environ.get("YIHE_CONFIG_DIR")
        return cls(
            Path(value).expanduser() if value else default_memory_dir(),
            Path(config).expanduser() if config else default_config_dir(),
            run_timeout_seconds=float(os.environ.get("RUN_TIMEOUT_SECONDS", "120")),
            agent_max_steps=int(os.environ.get("AGENT_MAX_STEPS", "12")),
        )

    def validate_limits(self) -> None:
        if not 0 < self.run_timeout_seconds <= 600:
            raise ValueError("RUN_TIMEOUT_SECONDS 必须在 0 到 600 秒之间")
        if not 1 <= self.agent_max_steps <= 50 or not 1 <= self.output_max_chars <= 20000:
            raise ValueError("智能体步骤或输出上限不合法")

    def model_config_path(self) -> Path:
        selected = self.config_dir or default_config_dir()
        if not selected.is_absolute() or selected.is_symlink() or selected.is_junction():
            raise ValueError("配置目录必须是绝对路径且不能是符号链接")
        directory = selected.resolve()
        memory = self.memory_dir.resolve()
        for protected in (SOURCE_ROOT, memory):
            if directory.is_relative_to(protected) or protected.is_relative_to(directory):
                raise ValueError("配置目录必须与源码和记忆库分开")
        path = directory / "model.json"
        if path.is_symlink() or path.is_junction() or not path.resolve().is_relative_to(directory):
            raise ValueError("配置文件不能通过链接越出配置目录")
        return path

    def database_path(self) -> Path:
        if not self.memory_dir.is_absolute():
            raise ValueError("YIHE_MEMORY_DIR 必须是源码目录之外的绝对路径")
        memory_dir = self.memory_dir.resolve()
        database_path = (memory_dir / ".assistant" / "memory.sqlite").resolve()
        if memory_dir.is_relative_to(SOURCE_ROOT) or database_path.is_relative_to(SOURCE_ROOT):
            raise ValueError("记忆库和数据库必须位于源码目录之外")
        # 防止 .assistant 的符号链接把数据库写出当前记忆库。
        if not database_path.is_relative_to(memory_dir):
            raise ValueError("数据库路径必须位于所选记忆库内")
        return database_path
