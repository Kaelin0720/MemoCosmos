"""独立的本机私密配置；密钥不进入数据库，也不返回到状态接口。"""

import json
import os
import stat
import tempfile
import threading
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import unquote

from pydantic import ValidationError

from app.core import windows_private_config
from app.core.errors import ApiError
from app.core.settings import Settings
from app.schemas.agent import AgentConfigUpdate, AgentStatus

MAX_CONFIG_BYTES = 65536  # 包含 DPAPI 密文的 base64 包装；原生解密另有32KiB上限。


@dataclass(frozen=True)
class ModelConfig:
    base_url: str
    model: str
    api_key: str = field(repr=False)


@dataclass(frozen=True)
class ModelConfigSnapshot:
    status: AgentStatus
    config: ModelConfig | None = field(default=None, repr=False)


class ModelConfigStore:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.lock = threading.RLock()

    def _read_file(self, path: Path) -> dict:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        descriptor = (
            windows_private_config.open_read(path)
            if windows_private_config.is_windows()
            else os.open(path, flags)
        )
        with os.fdopen(descriptor, "rb") as file:
            info = os.fstat(file.fileno())
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_nlink != 1
                or info.st_size > MAX_CONFIG_BYTES
                or (os.name == "posix" and info.st_mode & 0o077)
            ):
                raise ValueError("私密配置文件的类型或权限不合法")
            data = json.loads(file.read(MAX_CONFIG_BYTES + 1).decode("utf-8"))
            if windows_private_config.is_windows() or (
                isinstance(data, dict) and "protection" in data
            ):
                return windows_private_config.open_config(data)
            return data

    def snapshot(self) -> ModelConfigSnapshot:
        with self.lock:
            source = "none"
            try:
                path = self.settings.model_config_path()
                if path.exists():
                    source = "file"
                    data = self._read_file(path)
                    provider = data.pop("provider", "openai_compatible")
                else:
                    data = {
                        "base_url": os.environ.get("CHAT_MODEL_BASE_URL", ""),
                        "model": os.environ.get("CHAT_MODEL_NAME", ""),
                        "api_key": os.environ.get("CHAT_MODEL_API_KEY", ""),
                    }
                    provider = os.environ.get("CHAT_MODEL_PROVIDER", "openai_compatible")
                    source = "env" if any(data.values()) else "none"
                if provider not in {"openai_compatible", "openai"}:
                    return ModelConfigSnapshot(
                        AgentStatus(source=source, configured=False, reason="unsupported_provider")
                    )
                if not all(data.get(key) for key in ("base_url", "model", "api_key")):
                    return ModelConfigSnapshot(AgentStatus(source=source, configured=False))
                parsed = AgentConfigUpdate.model_validate(data)
                config = ModelConfig(
                    parsed.base_url, parsed.model, parsed.api_key.get_secret_value()
                )
                if config.api_key in unquote(config.base_url) or config.api_key in config.model:
                    raise ValueError("公开配置字段不能包含密钥")
                return ModelConfigSnapshot(
                    AgentStatus(
                        configured=True,
                        provider=provider,
                        model=config.model,
                        base_url=config.base_url,
                        has_api_key=True,
                        source=source,
                        reason=None,
                    ),
                    config,
                )
            except (OSError, ValueError, TypeError, AttributeError, ValidationError):
                return ModelConfigSnapshot(
                    AgentStatus(configured=False, source=source, reason="model_config_invalid")
                )

    def save(self, payload: AgentConfigUpdate) -> AgentStatus:
        with self.lock:
            previous = self.snapshot()
            key = (
                payload.api_key.get_secret_value()
                if payload.api_key is not None
                else previous.config.api_key
                if previous.config
                else None
            )
            if not key:
                raise ApiError(422, "validation_error", "首次配置需要填写 API Key")
            if key in unquote(payload.base_url) or key in payload.model:
                raise ApiError(422, "validation_error", "URL 和模型名称不能包含 API Key")
            temporary = None
            try:
                path = self.settings.model_config_path()
                windows = windows_private_config.is_windows()
                if os.name != "posix" and not windows:
                    raise ValueError("当前私密配置写入尚未支持此系统的权限机制")
                path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                if windows:
                    windows_private_config.restrict_private(path.parent)
                else:
                    os.chmod(path.parent, 0o700)
                    if path.parent.stat().st_mode & 0o077:
                        raise ValueError("配置目录未能获得私有权限")
                # 再次检查，防止目录准备过程中出现链接目标。
                path = self.settings.model_config_path()
                descriptor, temporary = tempfile.mkstemp(prefix=".model-", dir=path.parent)
                with os.fdopen(descriptor, "w", encoding="utf-8") as file:
                    if windows:
                        windows_private_config.restrict_private(Path(temporary))
                    else:
                        os.fchmod(file.fileno(), 0o600)
                        info = os.fstat(file.fileno())
                        if (
                            not stat.S_ISREG(info.st_mode)
                            or info.st_nlink != 1
                            or info.st_mode & 0o077
                        ):
                            raise ValueError("配置文件未能获得私有权限")
                    data = {
                        "provider": "openai_compatible",
                        "base_url": payload.base_url,
                        "model": payload.model,
                        "api_key": key,
                    }
                    if windows:
                        data = windows_private_config.seal_config(data)
                    json.dump(
                        data,
                        file,
                        ensure_ascii=False,
                    )
                    file.flush()
                    os.fsync(file.fileno())
                os.replace(temporary, path)
                temporary = None
                if not windows:
                    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
                    try:
                        os.fsync(directory)
                    finally:
                        os.close(directory)
            except (OSError, ValueError):
                raise ApiError(503, "config_write_failed", "私密配置暂时无法安全保存") from None
            finally:
                if temporary is not None:
                    try:
                        os.unlink(temporary)
                    except OSError:
                        pass
            return self.snapshot().status
