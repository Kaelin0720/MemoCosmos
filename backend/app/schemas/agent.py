from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator


class AgentConfigUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    base_url: str = Field(min_length=1, max_length=2000)
    model: str = Field(min_length=1, max_length=200)
    api_key: SecretStr | None = Field(default=None, max_length=4096)

    @field_validator("base_url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        parts = urlsplit(value)
        if (
            parts.scheme not in {"http", "https"}
            or not parts.hostname
            or parts.username is not None
            or parts.password is not None
            or "?" in value
            or "#" in value
            or any(character.isspace() or ord(character) < 32 for character in value)
        ):
            raise ValueError("需要不含凭据、查询参数和片段的 HTTP API 基址")
        if parts.port is not None and not 1 <= parts.port <= 65535:
            raise ValueError("API 端口不合法")
        return value

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: str) -> str:
        value = value.strip()
        if not value or any(ord(character) < 32 for character in value):
            raise ValueError("模型名称不能为空或包含控制字符")
        value.encode("utf-8")
        return value

    @field_validator("api_key", mode="before")
    @classmethod
    def validate_key(cls, value: object) -> object:
        if not isinstance(value, str) or not value.strip() or len(value) > 4096:
            raise ValueError("密钥不能为空")
        value = value.strip()
        if any(ord(character) < 32 or ord(character) == 127 for character in value):
            raise ValueError("密钥不能包含控制字符")
        value.encode("utf-8")
        return value


class AgentStatus(BaseModel):
    configured: bool
    provider: str = "openai_compatible"
    model: str | None = None
    base_url: str | None = None
    has_api_key: bool = False
    source: Literal["file", "env", "none"] = "none"
    reason: str | None = "model_not_configured"
    tools: list[str] = Field(default_factory=lambda: ["list_tags", "search_memory", "read_note"])
    context_max_chars: int = 32000
    context_max_turns: int = 12
