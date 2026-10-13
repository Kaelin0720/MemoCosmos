"""本地原始会话与运行，不把对话冒充长期知识。"""

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import aclosing, suppress
from threading import RLock
from uuid import UUID, uuid4

from langchain_core.messages import AIMessage, HumanMessage
from langgraph.errors import GraphRecursionError
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from app.agent.main_agent import (
    CONTEXT_MAX_CHARS,
    CONTEXT_MAX_TURNS,
    AgentExecutionError,
    ModelFactory,
    openai_compatible_model,
    stream_main_agent,
)
from app.core.errors import ApiError
from app.core.model_config import ModelConfigSnapshot, ModelConfigStore
from app.core.settings import Settings
from app.db.models import AgentRun, Conversation, Message
from app.schemas.conversations import (
    ConversationList,
    ConversationResponse,
    MessageCreate,
    MessageList,
    MessageResponse,
    RunError,
    RunResponse,
)
from app.services.tags import utc_timestamp

ACTIVE = {"pending", "running"}


def canonical_id(identifier: str, code: str, message: str) -> str:
    try:
        return str(UUID(identifier))
    except ValueError:
        raise ApiError(404, code, message) from None


def run_response(run: AgentRun) -> RunResponse:
    return RunResponse(
        id=run.id,
        conversation_id=run.conversation_id,
        client_message_id=run.client_message_id,
        user_message_id=run.user_message_id,
        assistant_message_id=run.assistant_message_id,
        status=run.status,
        error=RunError(code=run.error_code, message=run.error_message) if run.error_code else None,
        context_truncated=run.context_truncated,
        created_at=run.created_at,
        updated_at=run.updated_at,
    )


def interrupt_stale_runs(sessions: sessionmaker) -> None:
    with sessions.begin() as session:
        timestamp = utc_timestamp()
        for run in session.scalars(select(AgentRun).where(AgentRun.status.in_(ACTIVE))):
            run.status = "interrupted"
            run.updated_at = timestamp
            run.error_code = "run_interrupted"
            run.error_message = "服务重启中断了生成，已保留原文和部分回复"
            message = session.get(Message, run.assistant_message_id)
            if message is not None:
                message.status = "interrupted"
                message.updated_at = timestamp
        for conversation in session.scalars(
            select(Conversation).where(Conversation.active_run_id.is_not(None))
        ):
            conversation.active_run_id = None
            conversation.updated_at = timestamp


def bounded_context(session, run: AgentRun):
    # 多取一个成功轮次，判断确实发生了数量裁剪，不读完整历史。
    previous = list(
        session.scalars(
            select(AgentRun)
            .join(Message, Message.id == AgentRun.user_message_id)
            .where(
                AgentRun.conversation_id == run.conversation_id,
                AgentRun.status == "completed",
            )
            .order_by(Message.seq.desc())
            .limit(CONTEXT_MAX_TURNS + 1)
        )
    )
    truncated = len(previous) > CONTEXT_MAX_TURNS
    pairs = []
    for item in reversed(previous[:CONTEXT_MAX_TURNS]):
        user = session.get(Message, item.user_message_id)
        assistant = session.get(Message, item.assistant_message_id)
        pairs.append((user.content, assistant.content))
    current = session.get(Message, run.user_message_id).content
    size = len(current) + sum(len(user) + len(reply) for user, reply in pairs)
    while pairs and size > min(CONTEXT_MAX_CHARS, 18000):
        user, reply = pairs.pop(0)
        size -= len(user) + len(reply)
        truncated = True
    messages = []
    for user, reply in pairs:
        messages.extend([HumanMessage(content=user), AIMessage(content=reply)])
    messages.append(HumanMessage(content=current))
    return messages, truncated


class RunManager:
    def __init__(
        self,
        sessions: sessionmaker,
        config_store: ModelConfigStore,
        settings: Settings,
        model_factory: ModelFactory | None = None,
        *,
        write_lock=None,
        memory_jobs=None,
        knowledge=None,
    ):
        self.sessions = sessions
        self.memory_jobs = memory_jobs
        self.knowledge = knowledge
        self.config_store = config_store
        self.settings = settings
        self.model_factory = model_factory or openai_compatible_model
        self.lock = asyncio.Lock()
        # 仅串行本机写事务；模型生成与 SSE 等待期间不持有此锁。
        self.write_lock = write_lock or RLock()
        self.tasks: dict[str, asyncio.Task] = {}
        self.subscribers: dict[str, set[asyncio.Queue]] = {}
        self.closing = False

    def create_conversation(self) -> ConversationResponse:
        timestamp = utc_timestamp()
        with self.write_lock, self.sessions.begin() as session:
            item = Conversation(
                id=str(uuid4()),
                title="新的对话",
                created_at=timestamp,
                updated_at=timestamp,
                active_run_id=None,
                last_seq=0,
            )
            session.add(item)
            response = ConversationResponse.model_validate(item)
        return response

    def conversation(self, identifier: str) -> ConversationResponse:
        identifier = canonical_id(identifier, "conversation_not_found", "对话不存在")
        with self.sessions() as session:
            item = session.get(Conversation, identifier)
            if item is None:
                raise ApiError(404, "conversation_not_found", "对话不存在")
            return ConversationResponse.model_validate(item)

    def conversations(self, limit: int, offset: int) -> ConversationList:
        with self.sessions() as session:
            items = session.scalars(
                select(Conversation)
                .order_by(Conversation.updated_at.desc(), Conversation.id)
                .limit(limit)
                .offset(offset)
            )
            return ConversationList(
                items=[ConversationResponse.model_validate(item) for item in items],
                total=session.scalar(select(func.count()).select_from(Conversation)),
            )

    def messages(self, identifier: str, limit: int, before_seq: int | None) -> MessageList:
        identifier = canonical_id(identifier, "conversation_not_found", "对话不存在")
        with self.sessions() as session:
            if session.get(Conversation, identifier) is None:
                raise ApiError(404, "conversation_not_found", "对话不存在")
            statement = select(Message).where(Message.conversation_id == identifier)
            if before_seq is not None:
                statement = statement.where(Message.seq < before_seq)
            items = list(session.scalars(statement.order_by(Message.seq.desc()).limit(limit + 1)))
            return MessageList(
                items=[MessageResponse.model_validate(item) for item in reversed(items[:limit])],
                has_more=len(items) > limit,
            )

    def run(self, identifier: str) -> RunResponse:
        identifier = canonical_id(identifier, "run_not_found", "运行不存在")
        with self.sessions() as session:
            item = session.get(AgentRun, identifier)
            if item is None:
                raise ApiError(404, "run_not_found", "运行不存在")
            return run_response(item)

    def by_client_message(self, conversation_id: str, client_id: str) -> RunResponse:
        conversation_id = canonical_id(conversation_id, "run_not_found", "运行不存在")
        client_id = canonical_id(client_id, "run_not_found", "运行不存在")
        with self.sessions() as session:
            item = session.scalar(
                select(AgentRun).where(
                    AgentRun.conversation_id == conversation_id,
                    AgentRun.client_message_id == client_id,
                )
            )
            if item is None:
                raise ApiError(404, "run_not_found", "该消息尚未被接受")
            return run_response(item)

    async def submit(self, conversation_id: str, payload: MessageCreate) -> RunResponse:
        conversation_id = canonical_id(conversation_id, "conversation_not_found", "对话不存在")
        async with self.lock:
            if self.closing:
                raise ApiError(503, "service_stopping", "服务正在退出，请稍后重试")
            with self.write_lock, self.sessions.begin() as session:
                conversation = session.get(Conversation, conversation_id)
                if conversation is None:
                    raise ApiError(404, "conversation_not_found", "对话不存在")
                existing = session.scalar(
                    select(AgentRun).where(
                        AgentRun.conversation_id == conversation_id,
                        AgentRun.client_message_id == payload.client_message_id,
                    )
                )
                if existing is not None:
                    if session.get(Message, existing.user_message_id).content != payload.content:
                        raise ApiError(409, "idempotency_conflict", "此消息 ID 已用于不同内容")
                    return run_response(existing)
                if conversation.active_run_id is not None:
                    raise ApiError(409, "conversation_busy", "当前对话正在生成，请先等待或停止")
                timestamp = utc_timestamp()
                run = AgentRun(
                    id=str(uuid4()),
                    conversation_id=conversation_id,
                    client_message_id=payload.client_message_id,
                    user_message_id=str(uuid4()),
                    assistant_message_id=str(uuid4()),
                    status="pending",
                    context_truncated=False,
                    created_at=timestamp,
                    updated_at=timestamp,
                )
                session.add(run)
                session.flush()
                for role, message_id, content, status, sequence in (
                    (
                        "user",
                        run.user_message_id,
                        payload.content,
                        "completed",
                        conversation.last_seq + 1,
                    ),
                    (
                        "assistant",
                        run.assistant_message_id,
                        "",
                        "pending",
                        conversation.last_seq + 2,
                    ),
                ):
                    session.add(
                        Message(
                            id=message_id,
                            conversation_id=conversation_id,
                            seq=sequence,
                            role=role,
                            content=content,
                            status=status,
                            run_id=run.id,
                            created_at=timestamp,
                            updated_at=timestamp,
                        )
                    )
                if conversation.last_seq == 0:
                    conversation.title = " ".join(payload.content.strip().split())[:60]
                conversation.last_seq += 2
                conversation.updated_at = timestamp
                conversation.active_run_id = run.id
                response = run_response(run)
            snapshot = self.config_store.snapshot()
            task = asyncio.create_task(self._execute(response.id, snapshot))
            self.tasks[response.id] = task
            task.add_done_callback(lambda done: self._task_done(response.id, done))
            return response

    def _task_done(self, identifier: str, task: asyncio.Task) -> None:
        self.tasks.pop(identifier, None)
        if not task.cancelled():
            # 消费异常，防止 asyncio 把数据库参数或供应商异常写入默认日志。
            task.exception()

    def _publish(self, identifier: str, event: str, data: dict) -> None:
        for queue in list(self.subscribers.get(identifier, ())):
            try:
                queue.put_nowait((event, data))
            except asyncio.QueueFull:
                self.subscribers[identifier].discard(queue)
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait(None)  # 慢客户端重新订阅并替换为完整持久快照。

    def _snapshot(self, identifier: str) -> dict:
        with self.sessions() as session:
            run = session.get(AgentRun, identifier)
            if run is None:
                raise ApiError(404, "run_not_found", "运行不存在")
            message = session.get(Message, run.assistant_message_id)
            return {
                "run": run_response(run).model_dump(mode="json"),
                "message": MessageResponse.model_validate(message).model_dump(mode="json"),
            }

    async def subscribe(self, identifier: str):
        async with self.lock:
            snapshot = self._snapshot(identifier)
            queue = asyncio.Queue(maxsize=256)
            if snapshot["run"]["status"] in ACTIVE:
                self.subscribers.setdefault(identifier, set()).add(queue)
            return snapshot, queue

    async def unsubscribe(self, identifier: str, queue: asyncio.Queue) -> None:
        async with self.lock:
            group = self.subscribers.get(identifier)
            if group is not None:
                group.discard(queue)
                if not group:
                    self.subscribers.pop(identifier, None)

    async def _append(self, identifier: str, delta: str) -> bool:
        async with self.lock:
            with self.write_lock, self.sessions.begin() as session:
                run = session.get(AgentRun, identifier)
                if run.status not in ACTIVE:
                    return False
                message = session.get(Message, run.assistant_message_id)
                remaining = self.settings.output_max_chars - len(message.content)
                accepted = delta[:remaining]
                message.content += accepted
                message.updated_at = utc_timestamp()
                run.updated_at = message.updated_at
                message_id = message.id
            if accepted:
                self._publish(
                    identifier,
                    "message.delta",
                    {
                        "run_id": identifier,
                        "message_id": message_id,
                        "delta": accepted,
                    },
                )
            if len(delta) > remaining:
                raise AgentExecutionError("output_limit", "本轮输出已达到长度上限")
            return True

    async def _finish(self, identifier: str, status: str, error: RunError | None = None):
        async with self.lock:
            with self.write_lock, self.sessions.begin() as session:
                run = session.get(AgentRun, identifier)
                if run.status not in ACTIVE:
                    return
                timestamp = utc_timestamp()
                run.status = status
                run.updated_at = timestamp
                run.error_code = error.code if error else None
                run.error_message = error.message if error else None
                message = session.get(Message, run.assistant_message_id)
                message.status = status
                message.updated_at = timestamp
                conversation = session.get(Conversation, run.conversation_id)
                conversation.active_run_id = None
                conversation.updated_at = timestamp
                if status == "completed" and self.memory_jobs:
                    self.memory_jobs.enqueue(session, run)
            self._publish(identifier, f"run.{status}", self._snapshot(identifier))

    async def _execute(self, identifier: str, snapshot: ModelConfigSnapshot) -> None:
        try:
            async with self.lock:
                with self.write_lock, self.sessions.begin() as session:
                    run = session.get(AgentRun, identifier)
                    if run.status not in ACTIVE:
                        return
                    context, truncated = bounded_context(session, run)
                    source_time = session.get(Message, run.user_message_id).created_at
                    run.context_truncated = truncated
                    run.status = "running"
                    run.updated_at = utc_timestamp()
                    message = session.get(Message, run.assistant_message_id)
                    message.status = "running"
                    message.updated_at = run.updated_at
                self._publish(identifier, "run.snapshot", self._snapshot(identifier))
            if snapshot.config is None:
                raise AgentExecutionError(
                    snapshot.status.reason or "model_not_configured",
                    "云端模型尚未配置或配置不可用，请在设置页检查 URL、API Key 和模型名称",
                )
            produced = False
            async with asyncio.timeout(self.settings.run_timeout_seconds):
                async with aclosing(
                    stream_main_agent(
                        snapshot.config,
                        context,
                        self.sessions,
                        self.settings.agent_max_steps,
                        self.model_factory,
                        self.knowledge,
                        source_time,
                    )
                ) as stream:
                    async for delta in stream:
                        if not await self._append(identifier, delta):
                            return
                        produced = True
            if not produced:
                raise AgentExecutionError("empty_model_response", "模型没有返回可显示的文本")
            await self._finish(identifier, "completed")
        except asyncio.CancelledError:
            status = "interrupted" if self.closing else "cancelled"
            error = (
                RunError(code="run_interrupted", message="服务退出中断了生成")
                if self.closing
                else None
            )
            await self._finish(identifier, status, error)
        except TimeoutError:
            await self._finish(
                identifier,
                "failed",
                RunError(code="model_timeout", message="本轮生成超时，已保留部分回复"),
            )
        except GraphRecursionError:
            await self._finish(
                identifier,
                "failed",
                RunError(code="agent_step_limit", message="本轮智能体步骤已达到上限"),
            )
        except AgentExecutionError as exc:
            await self._finish(identifier, "failed", RunError(code=exc.code, message=exc.message))
        except Exception:
            await self._finish(
                identifier,
                "failed",
                RunError(code="model_error", message="云端模型调用未完成，请检查模型配置或连接"),
            )

    async def cancel(self, identifier: str) -> RunResponse:
        identifier = self.run(identifier).id
        await self._finish(identifier, "cancelled")
        task = self.tasks.get(identifier)
        if task is not None and not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError, TimeoutError):
                await asyncio.wait_for(asyncio.shield(task), timeout=5)
        return self.run(identifier)

    async def close(self) -> None:
        self.closing = True
        tasks = list(self.tasks.values())
        # 尚未开始执行的 Task 被 cancel 后不会进入 _execute 的异常处理。
        # 先持久化终态，再取消实际任务，避免留下 pending 占用会话。
        for identifier in list(self.tasks):
            await self._finish(
                identifier,
                "interrupted",
                RunError(code="run_interrupted", message="服务退出中断了生成"),
            )
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def run_events(manager: RunManager, identifier: str) -> AsyncIterator[str]:
    snapshot, queue = await manager.subscribe(identifier)
    try:
        yield sse("run.snapshot", snapshot)
        if snapshot["run"]["status"] not in ACTIVE:
            yield sse(f"run.{snapshot['run']['status']}", snapshot)
            return
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=15)
            except TimeoutError:
                yield ": heartbeat\n\n"
                continue
            if item is None:
                await manager.unsubscribe(identifier, queue)
                snapshot, queue = await manager.subscribe(identifier)
                yield sse("run.snapshot", snapshot)
                if snapshot["run"]["status"] not in ACTIVE:
                    yield sse(f"run.{snapshot['run']['status']}", snapshot)
                    return
                continue
            event, data = item
            yield sse(event, data)
            if event in {"run.completed", "run.failed", "run.cancelled", "run.interrupted"}:
                return
    finally:
        await manager.unsubscribe(identifier, queue)
