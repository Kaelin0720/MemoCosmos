from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable

from .config import AgentLabError


ToolHandler = Callable[..., Any]


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]
    handler: ToolHandler

    def specification(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
        }


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        if tool.name in self._tools:
            raise ValueError(f"Duplicate tool: {tool.name}")
        self._tools[tool.name] = tool

    def specifications(self) -> list[dict[str, Any]]:
        return [tool.specification() for tool in self._tools.values()]

    def execute(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if name not in self._tools:
            return {"ok": False, "error": f"未知工具：{name}"}
        if not isinstance(arguments, dict):
            return {"ok": False, "error": "action_input 必须是 JSON 对象。"}

        try:
            result = self._tools[name].handler(**arguments)
            return {"ok": True, "result": result}
        except TypeError as exc:
            return {"ok": False, "error": f"工具参数不正确：{exc}"}
        except AgentLabError as exc:
            return {"ok": False, "error": str(exc)}
        except Exception as exc:  # Tool failures become observations, not crashes.
            return {"ok": False, "error": f"工具执行失败：{type(exc).__name__}: {exc}"}

    @staticmethod
    def render_result(result: dict[str, Any], max_chars: int = 12_000) -> str:
        text = json.dumps(result, ensure_ascii=False, default=str)
        if len(text) > max_chars:
            return text[:max_chars] + "\n...[结果过长，已截断]"
        return text

