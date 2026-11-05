from __future__ import annotations

import json
import re
from typing import Any

from .config import AgentLabError


_FENCED_JSON = re.compile(r"^```(?:json)?\s*(.*?)\s*```$", re.IGNORECASE | re.DOTALL)


def parse_json_object(text: str, context: str = "模型输出") -> dict[str, Any]:
    """Parse a JSON object and tolerate a Markdown code fence around it."""
    candidate = text.strip()
    fenced = _FENCED_JSON.match(candidate)
    if fenced:
        candidate = fenced.group(1).strip()

    try:
        value = json.loads(candidate)
    except json.JSONDecodeError:
        value = _first_json_object(candidate)
    if not isinstance(value, dict):
        raise AgentLabError(f"{context}必须是 JSON 对象，实际收到：{text[:200]}")
    return value


def _first_json_object(text: str) -> dict[str, Any]:
    decoder = json.JSONDecoder()
    for match in re.finditer(r"\{", text):
        try:
            value, _ = decoder.raw_decode(text[match.start() :])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise AgentLabError(f"无法从模型输出中解析 JSON：{text[:300]}")


def require_text(data: dict[str, Any], field: str, context: str = "模型输出") -> str:
    value = data.get(field)
    if not isinstance(value, str) or not value.strip():
        raise AgentLabError(f"{context}缺少非空字段 {field!r}。")
    return value.strip()


def require_string_list(data: dict[str, Any], field: str, context: str = "模型输出") -> list[str]:
    value = data.get(field, [])
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise AgentLabError(f"{context}的字段 {field!r} 必须是字符串数组。")
    return [item.strip() for item in value if item.strip()]


def as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "yes", "1", "是", "通过"}
    return bool(value)

