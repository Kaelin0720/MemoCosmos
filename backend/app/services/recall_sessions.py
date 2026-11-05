"""Bound external tool calls to short-lived, explicit retrieval sessions."""

import asyncio
import json
import time
from uuid import uuid4

from pydantic import ValidationError

from app.agent.main_agent import TagQuery, make_tag_tool
from app.agent.memory_tools import GraphQuery, ReadQuery, SearchQuery, make_memory_tools
from app.core.errors import ApiError

SCHEMAS = {
    "search_memory": SearchQuery,
    "read_note": ReadQuery,
    "explore_memory_graph": GraphQuery,
    "list_tags": TagQuery,
}


class RecallSessions:
    def __init__(self, knowledge, *, ttl=900, capacity=128):
        self.knowledge, self.ttl, self.capacity = knowledge, ttl, capacity
        self.sessions = {}
        self.lock = asyncio.Lock()

    async def call(self, payload):
        try:
            arguments = SCHEMAS[payload.tool].model_validate(payload.arguments).model_dump()
        except ValidationError:
            raise ApiError(422, "validation_error", "记忆工具参数格式不正确") from None
        async with self.lock:
            now = time.monotonic()
            self.sessions = {key: value for key, value in self.sessions.items() if value[0] > now}
            identifier = payload.retrieval_id
            if identifier is not None and identifier not in self.sessions:
                raise ApiError(
                    404, "retrieval_expired", "本轮检索已过期，请开始新的检索并说明证据范围"
                )
            if identifier is None:
                if len(self.sessions) >= self.capacity:
                    raise ApiError(429, "retrieval_capacity", "检索会话过多，请稍后重试")
                identifier = str(uuid4())
                tools = [*make_memory_tools(self.knowledge), make_tag_tool(self.knowledge.sessions)]
                self.sessions[identifier] = (now + self.ttl, {tool.name: tool for tool in tools})
            tools = self.sessions[identifier][1]
        result = json.loads(await tools[payload.tool].ainvoke(arguments))
        return dict(retrieval_id=identifier, **result)
