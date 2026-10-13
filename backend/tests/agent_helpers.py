"""测试依赖注入；生产入口不会导入这个模型。"""

import asyncio
import json
import time
from uuid import uuid4

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langsmith import get_tracing_context
from pydantic import PrivateAttr


class ScriptedModel(BaseChatModel):
    model_name: str = "yihe-test"
    reply: str = "这是测试模型的流式回复。\n\n第二段中文。"
    delay: float = 0.001
    failure: bool = False
    repeat_tools: bool = False
    forbidden_tool: str | None = None
    fail_after_chunks: int | None = None
    _inputs: list = PrivateAttr(default_factory=list)
    _bound_names: list = PrivateAttr(default_factory=list)
    _trace_flags: list = PrivateAttr(default_factory=list)
    _closed: int = PrivateAttr(default=0)
    _tool_results: list = PrivateAttr(default_factory=list)

    @property
    def _llm_type(self):
        return "yihe-test"

    def bind_tools(self, tools, **kwargs):
        self._bound_names.append([item.name for item in tools])
        return self

    def _response(self, messages):
        self._inputs.append(messages)
        self._trace_flags.append(get_tracing_context().get("enabled"))
        if self.failure:
            raise RuntimeError("provider-error https://secret.invalid test-only-secret")
        if self.forbidden_tool and not isinstance(messages[-1], ToolMessage):
            return AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": self.forbidden_tool,
                        "args": {"file_path": "/etc/passwd"},
                        "id": "forbidden-call",
                        "type": "tool_call",
                    }
                ],
            )
        if self.repeat_tools or (
            "查标签" in str(messages[-1].content) and messages[-1].type == "human"
        ):
            return AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "list_tags",
                        "args": {"query": "RAG", "limit": 20},
                        "id": f"tag-call-{len(self._inputs)}",
                        "type": "tool_call",
                    }
                ],
            )
        if isinstance(messages[-1], ToolMessage):
            result = json.loads(messages[-1].content)
            self._tool_results.append(result)
            names = "、".join(item["name"] for item in result["items"])
            return AIMessage(content=f"查到标签：{names}。")
        return AIMessage(content=self.reply)

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        return ChatResult(generations=[ChatGeneration(message=self._response(messages))])

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        try:
            response = self._response(messages)
            if response.tool_calls:
                await asyncio.sleep(self.delay)
                yield ChatGenerationChunk(
                    message=AIMessageChunk(
                        content="",
                        tool_call_chunks=[
                            {
                                "name": call["name"],
                                "args": json.dumps(call["args"], ensure_ascii=False),
                                "id": call["id"],
                                "index": index,
                            }
                            for index, call in enumerate(response.tool_calls)
                        ],
                    )
                )
            else:
                for position in range(0, len(response.content), 2):
                    if (
                        self.fail_after_chunks is not None
                        and position // 2 >= self.fail_after_chunks
                    ):
                        raise RuntimeError("provider-error test-only-secret")
                    await asyncio.sleep(self.delay)
                    yield ChatGenerationChunk(
                        message=AIMessageChunk(content=response.content[position : position + 2])
                    )
        finally:
            self._closed += 1


def auth(client):
    return {"X-Local-Token": client.get("/api/v1/bootstrap").json()["local_token"]}


def configure(client, headers, model="test-model"):
    response = client.put(
        "/api/v1/agent/config",
        headers=headers,
        json={
            "base_url": "https://example.invalid/v1",
            "model": model,
            "api_key": "test-only-secret",
        },
    )
    assert response.status_code == 200, response.text
    client.put("/api/v1/memory/settings", headers=headers, json={"auto_memory": False})
    return response.json()


def submit(client, headers, conversation_id, content="你好", client_message_id=None):
    response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        headers=headers,
        json={
            "client_message_id": client_message_id or str(uuid4()),
            "content": content,
        },
    )
    assert response.status_code == 202, response.text
    return response.json()


def finished(client, headers, run_id, seconds=5):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        run = client.get(f"/api/v1/runs/{run_id}", headers=headers).json()
        if run["status"] not in {"pending", "running"}:
            return run
        time.sleep(0.005)
    raise AssertionError("test run did not finish")


def decode_events(response):
    result = []
    for block in response.text.split("\n\n"):
        lines = block.splitlines()
        event = next((line[7:] for line in lines if line.startswith("event: ")), None)
        data = "\n".join(line[6:] for line in lines if line.startswith("data: "))
        if event:
            result.append((event, json.loads(data)))
    return result
