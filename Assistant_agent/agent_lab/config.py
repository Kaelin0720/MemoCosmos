from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config.json"


class AgentLabError(RuntimeError):
    """An expected, user-facing error."""


@dataclass(frozen=True)
class DeepSeekConfig:
    api_key: str
    base_url: str = "https://api.deepseek.com"
    model: str = "deepseek-chat"
    temperature: float = 0.2
    timeout_seconds: int = 60

    @classmethod
    def from_mapping(cls, data: dict[str, Any]) -> "DeepSeekConfig":
        api_key = str(data.get("api_key", "") or "").strip()
        environment_key = os.getenv("DEEPSEEK_API_KEY", "").strip()
        if environment_key:
            api_key = environment_key

        try:
            temperature = float(data.get("temperature", 0.2))
            timeout_seconds = int(data.get("timeout_seconds", 60))
        except (TypeError, ValueError) as exc:
            raise AgentLabError("config.json 中的 temperature 或 timeout_seconds 格式不正确。") from exc

        if not 0 <= temperature <= 2:
            raise AgentLabError("config.json 中的 temperature 必须在 0 到 2 之间。")
        if timeout_seconds <= 0:
            raise AgentLabError("config.json 中的 timeout_seconds 必须大于 0。")

        base_url = str(data.get("base_url", "https://api.deepseek.com") or "").rstrip("/")
        if not base_url.startswith(("https://", "http://")):
            raise AgentLabError("config.json 中的 base_url 必须以 https:// 或 http:// 开头。")

        model = str(data.get("model", "deepseek-chat") or "").strip()
        if not model:
            raise AgentLabError("config.json 中的 model 不能为空。")

        return cls(
            api_key=api_key,
            base_url=base_url,
            model=model,
            temperature=temperature,
            timeout_seconds=timeout_seconds,
        )

    def require_api_key(self) -> str:
        if not self.api_key:
            raise AgentLabError(
                "DeepSeek API Key 尚未配置。请编辑项目根目录的 config.json，"
                "填写 api_key；也可以设置 DEEPSEEK_API_KEY 环境变量。"
            )
        return self.api_key


def load_config(path: str | Path | None = None) -> DeepSeekConfig:
    config_path = Path(path) if path else DEFAULT_CONFIG_PATH
    if not config_path.exists():
        raise AgentLabError(f"找不到配置文件：{config_path}")

    try:
        data = json.loads(config_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise AgentLabError(
            f"配置文件不是合法 JSON：{config_path}（第 {exc.lineno} 行，第 {exc.colno} 列）"
        ) from exc
    except OSError as exc:
        raise AgentLabError(f"无法读取配置文件：{config_path}") from exc

    if not isinstance(data, dict):
        raise AgentLabError("config.json 的顶层内容必须是 JSON 对象。")
    return DeepSeekConfig.from_mapping(data)

