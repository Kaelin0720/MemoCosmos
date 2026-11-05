from __future__ import annotations

import json
import urllib.error
import urllib.request
from abc import ABC, abstractmethod
from typing import Any

from .config import AgentLabError, DeepSeekConfig


Message = dict[str, str]


class ChatModel(ABC):
    """The only model capability the demos depend on."""

    @abstractmethod
    def complete(
        self,
        messages: list[Message],
        *,
        temperature: float | None = None,
        json_mode: bool = False,
    ) -> str:
        raise NotImplementedError


class DeepSeekChat(ChatModel):
    """A tiny DeepSeek client built on Python's standard library."""

    def __init__(self, config: DeepSeekConfig) -> None:
        config.require_api_key()
        self.config = config

    def complete(
        self,
        messages: list[Message],
        *,
        temperature: float | None = None,
        json_mode: bool = False,
    ) -> str:
        api_key = self.config.require_api_key()
        payload: dict[str, Any] = {
            "model": self.config.model,
            "messages": messages,
            "temperature": self.config.temperature if temperature is None else temperature,
            "stream": False,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}

        request = urllib.request.Request(
            f"{self.config.base_url}/chat/completions",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=self.config.timeout_seconds) as response:
                body = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:800]
            raise AgentLabError(
                f"DeepSeek 请求失败：HTTP {exc.code}。响应：{_safe_error_detail(detail, api_key)}"
            ) from exc
        except urllib.error.URLError as exc:
            raise AgentLabError(f"无法连接 DeepSeek：{exc.reason}") from exc
        except TimeoutError as exc:
            raise AgentLabError("DeepSeek 请求超时，请检查网络或调大 timeout_seconds。") from exc

        try:
            data = json.loads(body)
            content = data["choices"][0]["message"]["content"]
        except (json.JSONDecodeError, KeyError, IndexError, TypeError) as exc:
            raise AgentLabError("DeepSeek 返回了无法识别的响应结构。") from exc

        if not isinstance(content, str) or not content.strip():
            raise AgentLabError("DeepSeek 返回了空内容。")
        return content.strip()


def _safe_error_detail(detail: str, api_key: str) -> str:
    return detail.replace(api_key, "[REDACTED]") if api_key else detail

