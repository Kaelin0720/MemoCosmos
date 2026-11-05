from __future__ import annotations

from collections.abc import Iterable

from agent_lab.llm import ChatModel, Message


class ScriptedModel(ChatModel):
    def __init__(self, responses: Iterable[str]) -> None:
        self.responses = list(responses)
        self.calls: list[list[Message]] = []

    def complete(
        self,
        messages: list[Message],
        *,
        temperature: float | None = None,
        json_mode: bool = False,
    ) -> str:
        self.calls.append(messages)
        if not self.responses:
            raise AssertionError("ScriptedModel 没有剩余响应。")
        return self.responses.pop(0)

