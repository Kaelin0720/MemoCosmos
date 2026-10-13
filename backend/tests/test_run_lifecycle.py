import asyncio
import json
from uuid import uuid4

import pytest
from agent_helpers import ScriptedModel
from sqlalchemy import select

from app.agent.main_agent import build_main_agent, make_tag_tool
from app.core.settings import Settings
from app.db.models import AgentRun, Conversation, Message
from app.main import create_app
from app.schemas.agent import AgentConfigUpdate
from app.schemas.conversations import MessageCreate
from app.services.conversations import run_events


def configure_store(application):
    application.state.memory_jobs.set_setting(False)
    application.state.model_config_store.save(
        AgentConfigUpdate(
            base_url="https://example.invalid/v1",
            model="first-model",
            api_key="test-only-secret",
        )
    )


async def wait_run(manager, identifier):
    async with asyncio.timeout(5):
        while manager.run(identifier).status in {"pending", "running"}:
            await asyncio.sleep(0.002)
    return manager.run(identifier)


@pytest.mark.parametrize("action", ["cancel", "shutdown"])
def test_pending_task_is_terminal_even_before_it_starts(tmp_path, action):
    calls = []

    def factory(config):
        calls.append(config.model)
        return ScriptedModel()

    app = create_app(Settings(tmp_path / "memory", tmp_path / "config"), model_factory=factory)

    async def scenario():
        async with app.router.lifespan_context(app):
            configure_store(app)
            manager = app.state.run_manager
            conversation = manager.create_conversation()
            run = await manager.submit(
                conversation.id,
                MessageCreate(
                    client_message_id=str(uuid4()),
                    content="还没开始的原文",
                ),
            )
            assert calls == []
            if action == "cancel":
                await manager.cancel(run.id)
            else:
                await manager.close()
            expected = "cancelled" if action == "cancel" else "interrupted"
            assert manager.run(run.id).status == expected
            assert manager.conversation(conversation.id).active_run_id is None
            assert manager.messages(conversation.id, 10, None).items[0].status == "completed"
            assert calls == []

    asyncio.run(scenario())


def test_config_is_snapshotted_on_acceptance_and_new_run_uses_new_config(tmp_path):
    seen = []

    def factory(config):
        seen.append(config.model)
        return ScriptedModel(delay=0)

    app = create_app(Settings(tmp_path / "memory", tmp_path / "config"), model_factory=factory)

    async def scenario():
        async with app.router.lifespan_context(app):
            configure_store(app)
            manager = app.state.run_manager
            conversation = manager.create_conversation()
            first = await manager.submit(
                conversation.id, MessageCreate(client_message_id=str(uuid4()), content="第一轮")
            )
            app.state.model_config_store.save(
                AgentConfigUpdate(
                    base_url="https://new.invalid/v1",
                    model="second-model",
                )
            )
            assert (await wait_run(manager, first.id)).status == "completed"
            second = await manager.submit(
                conversation.id, MessageCreate(client_message_id=str(uuid4()), content="第二轮")
            )
            assert (await wait_run(manager, second.id)).status == "completed"
            assert seen == ["first-model", "second-model"]

    asyncio.run(scenario())


def test_disconnect_does_not_cancel_and_snapshot_delta_has_no_gap(tmp_path):
    model = ScriptedModel(delay=0.001)
    app = create_app(
        Settings(tmp_path / "memory", tmp_path / "config"), model_factory=lambda config: model
    )

    async def scenario():
        async with app.router.lifespan_context(app):
            configure_store(app)
            manager = app.state.run_manager
            conversation = manager.create_conversation()
            run = await manager.submit(
                conversation.id, MessageCreate(client_message_id=str(uuid4()), content="中文流")
            )
            stream = run_events(manager, run.id)
            first = await anext(stream)
            assert first.startswith("event: run.snapshot")
            await stream.aclose()
            assert manager.run(run.id).status in {"pending", "running"}
            restored = run_events(manager, run.id)
            content = ""
            terminal = None
            async for block in restored:
                lines = block.splitlines()
                event = lines[0][7:]
                data = json.loads(lines[1][6:])
                if event == "run.snapshot":
                    content = data["message"]["content"]
                elif event == "message.delta":
                    content += data["delta"]
                elif event == "run.completed":
                    terminal = data
            assert terminal is not None
            assert content == terminal["message"]["content"] == model.reply
            assert not manager.subscribers

    asyncio.run(scenario())


def test_slow_subscriber_resynchronizes_instead_of_dropping_text(tmp_path):
    model = ScriptedModel(delay=0, reply="中文" * 400)
    app = create_app(
        Settings(tmp_path / "memory", tmp_path / "config"), model_factory=lambda config: model
    )

    async def scenario():
        async with app.router.lifespan_context(app):
            configure_store(app)
            manager = app.state.run_manager
            conversation = manager.create_conversation()
            run = await manager.submit(
                conversation.id, MessageCreate(client_message_id=str(uuid4()), content="慢客户端")
            )
            stream = run_events(manager, run.id)
            await anext(stream)
            assert (await wait_run(manager, run.id)).status == "completed"
            blocks = [block async for block in stream]
            assert blocks[-2].startswith("event: run.snapshot")
            assert blocks[-1].startswith("event: run.completed")
            assert json.loads(blocks[-1].splitlines()[1][6:])["message"]["content"] == model.reply
            assert not manager.subscribers

    asyncio.run(scenario())


def test_actual_tool_table_has_no_files_execution_or_delegation(tmp_path):
    app = create_app(Settings(tmp_path / "memory", tmp_path / "config"))

    async def scenario():
        async with app.router.lifespan_context(app):
            agent = build_main_agent(ScriptedModel(), app.state.session_factory)
            assert set(agent.nodes["tools"].bound.tools_by_name) == {
                "list_tags",
                "search_memory",
                "read_note",
            }
            assert agent.checkpointer is None
            tool = make_tag_tool(app.state.session_factory)
            for limit in (0, 21, True):
                with pytest.raises(ValueError):
                    await tool.ainvoke({"limit": limit})

    asyncio.run(scenario())


def test_restart_interrupts_seeded_active_run_without_regenerating(tmp_path):
    settings = Settings(tmp_path / "memory", tmp_path / "config")
    app = create_app(settings)
    saved = {}

    async def seed():
        async with app.router.lifespan_context(app):
            manager = app.state.run_manager
            conversation = manager.create_conversation()
            run = await manager.submit(
                conversation.id, MessageCreate(client_message_id=str(uuid4()), content="中断原文")
            )
            await manager.cancel(run.id)
            # 临时库模拟断电留下的已提交 running 状态，生产数据不参与。
            with manager.sessions.begin() as session:
                stored = session.get(AgentRun, run.id)
                stored.status = "running"
                assistant = session.get(Message, stored.assistant_message_id)
                assistant.content = "已持久化的部分回复"
                assistant.status = "running"
                session.get(Conversation, conversation.id).active_run_id = run.id
            saved["run"] = run.id
            saved["conversation"] = conversation.id

    asyncio.run(seed())
    calls = []
    restarted = create_app(settings, model_factory=lambda config: calls.append(config))

    async def inspect():
        async with restarted.router.lifespan_context(restarted):
            manager = restarted.state.run_manager
            assert manager.run(saved["run"]).status == "interrupted"
            assert manager.conversation(saved["conversation"]).active_run_id is None
            items = manager.messages(saved["conversation"], 10, None).items
            assert items[0].content == "中断原文" and items[0].status == "completed"
            assert items[1].content == "已持久化的部分回复" and items[1].status == "interrupted"
            assert calls == []
            with manager.sessions() as session:
                assert len(list(session.scalars(select(AgentRun)))) == 1

    asyncio.run(inspect())
