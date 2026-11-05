from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agent_lab.assistant import (
    UniversalAssistant,
    classify_intent,
    heuristic_intent,
)
from agent_lab.config import AgentLabError
from tests.fakes import ScriptedModel


class UniversalAssistantTests(unittest.TestCase):
    def test_forced_chat_uses_conversation_memory(self) -> None:
        model = ScriptedModel(["你好，我是助手。", "我记得你刚才向我问好。"])
        assistant = UniversalAssistant(model=model, session_file=None, mode="chat")

        first = assistant.handle("你好")
        second = assistant.handle("你记得我刚才说了什么吗？")

        self.assertEqual(first.intent, "chat")
        self.assertIn("刚才向我问好", second.text)
        second_messages = model.calls[1]
        self.assertTrue(
            any(
                message["role"] == "assistant" and "我是助手" in message["content"]
                for message in second_messages
            )
        )

    def test_auto_route_support_uses_workflow_pipeline(self) -> None:
        model = ScriptedModel(
            [
                json.dumps(
                    {"intent": "support", "reason": "客户登录故障"},
                    ensure_ascii=False,
                ),
                json.dumps(
                    {
                        "summary": "客户无法登录。",
                        "category": "technical",
                        "urgency": 4,
                        "signals": ["无法登录"],
                    },
                    ensure_ascii=False,
                ),
                "已转交技术支持。",
            ]
        )
        assistant = UniversalAssistant(model=model, session_file=None, mode="auto")

        response = assistant.handle("我无法登录，请尽快处理")

        self.assertEqual(response.intent, "support")
        self.assertIn("技术支持", response.text)
        self.assertEqual(len(model.calls), 3)

    def test_router_failure_falls_back_to_keywords(self) -> None:
        model = ScriptedModel(["不是 JSON"])
        intent, reason = classify_intent(model, "请帮我处理退款工单")
        self.assertEqual(intent, "support")
        self.assertIn("兜底", reason)

    def test_heuristic_prefers_specific_capabilities(self) -> None:
        self.assertEqual(heuristic_intent("检查这段文案是否合规，能否发布"), "approval")
        self.assertEqual(heuristic_intent("评估一下这个方案是否值得做"), "review")
        self.assertEqual(heuristic_intent("你好，解释一下什么是 RAG"), "chat")

    def test_session_is_persisted_and_reloaded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            session_file = Path(directory) / "session.json"
            first = UniversalAssistant(
                model=ScriptedModel(["已记住。"]),
                session_file=session_file,
                mode="chat",
            )
            first.handle("记住这个偏好：回答尽量简洁")

            second = UniversalAssistant(
                model=ScriptedModel(["好的。"]),
                session_file=session_file,
                mode="chat",
            )
            self.assertEqual(len(second.memory.messages), 2)
            self.assertIn("尽量简洁", second.memory.messages[0]["content"])

    def test_invalid_forced_mode_is_rejected(self) -> None:
        with self.assertRaises(AgentLabError):
            UniversalAssistant(model=ScriptedModel([]), session_file=None, mode="unknown")


if __name__ == "__main__":
    unittest.main()

