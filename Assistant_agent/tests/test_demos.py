from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agent_lab.config import AgentLabError
from agent_lab.demos.multi_agent import run_review_board
from agent_lab.demos.planner_executor import run_planner_executor
from agent_lab.demos.react import NoteStore, run_react
from agent_lab.demos.state_machine import (
    apply_human_decision,
    load_state,
    submit_case,
    transition,
)
from agent_lab.demos.workflow import run_workflow
from tests.fakes import ScriptedModel


class WorkflowTests(unittest.TestCase):
    def test_technical_urgent_ticket_gets_two_hour_sla(self) -> None:
        model = ScriptedModel(
            [
                json.dumps(
                    {
                        "summary": "客户无法登录。",
                        "category": "technical",
                        "urgency": 4,
                        "signals": ["今天还登录失败"],
                    },
                    ensure_ascii=False,
                ),
                "已记录登录问题，并转入技术支持处理。",
            ]
        )
        result = run_workflow(model, "今天登录失败，无法工作")
        self.assertEqual(result.queue, "技术支持")
        self.assertEqual(result.sla_hours, 2)
        self.assertEqual(result.priority, "P1")


class ReactTests(unittest.TestCase):
    def test_react_reads_note_and_finishes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            notes = Path(directory)
            (notes / "policy.md").write_text("验收需要单元测试。", encoding="utf-8")
            model = ScriptedModel(
                [
                    json.dumps(
                        {"thought": "列出笔记", "action": "list_notes", "action_input": {}},
                        ensure_ascii=False,
                    ),
                    json.dumps(
                        {
                            "thought": "读取相关笔记",
                            "action": "read_note",
                            "action_input": {"path": "policy.md"},
                        },
                        ensure_ascii=False,
                    ),
                    json.dumps(
                        {
                            "thought": "已找到",
                            "action": "finish",
                            "action_input": {"answer": "需要单元测试。"},
                        },
                        ensure_ascii=False,
                    ),
                ]
            )
            result = run_react(model, "验收要求？", notes_dir=notes)
            self.assertEqual(result.answer, "需要单元测试。")
            self.assertEqual(len(result.steps), 2)

    def test_note_store_rejects_path_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = NoteStore(Path(directory) / "notes")
            with self.assertRaises(AgentLabError):
                store.read_note("../secret.md")


class PlannerTests(unittest.TestCase):
    def test_planner_executor_accepts_passed_draft(self) -> None:
        model = ScriptedModel(
            [
                json.dumps(
                    {
                        "goal": "形成周会流程",
                        "tasks": [
                            {
                                "id": "1",
                                "title": "设计议程",
                                "instruction": "列出三个议程项",
                            }
                        ],
                    },
                    ensure_ascii=False,
                ),
                "1. 回顾\n2. 分享\n3. 行动项",
                json.dumps(
                    {"passed": True, "issues": [], "revision_instruction": ""},
                    ensure_ascii=False,
                ),
            ]
        )
        result = run_planner_executor(model, "设计一个周会流程")
        self.assertTrue(result.passed_initial_review)
        self.assertIn("设计议程", result.final_draft)
        self.assertEqual(len(model.calls), 3)


class MultiAgentTests(unittest.TestCase):
    def test_roles_have_separate_handoffs(self) -> None:
        model = ScriptedModel(
            [
                "收益明确，但成本未确认。",
                "缺少失败后的退出条件。",
                json.dumps(
                    {
                        "recommendation": "有条件做",
                        "rationale": "先小规模验证。",
                        "conditions": ["设定退出条件"],
                        "next_steps": ["执行一周试点"],
                        "confidence": 0.7,
                    },
                    ensure_ascii=False,
                ),
            ]
        )
        result = run_review_board(model, "上线一个新工具")
        self.assertEqual(result.recommendation, "有条件做")
        self.assertAlmostEqual(result.confidence, 0.7)
        self.assertIn("分析师意见", model.calls[1][1]["content"])


class StateMachineTests(unittest.TestCase):
    def test_medium_risk_waits_for_human_then_approves(self) -> None:
        model = ScriptedModel(
            [
                json.dumps(
                    {
                        "risk_level": "medium",
                        "violations": [],
                        "rationale": "信息不足",
                        "evidence": [],
                    },
                    ensure_ascii=False,
                )
            ]
        )
        with tempfile.TemporaryDirectory() as directory:
            state_file = Path(directory) / "state.json"
            submitted = submit_case(model, "测试内容", state_file=state_file)
            self.assertEqual(submitted["status"], "pending_review")
            approved = apply_human_decision(
                "approve", note="人工确认", state_file=state_file
            )
            self.assertEqual(approved["status"], "approved")
            self.assertEqual(load_state(state_file)["status"], "approved")

    def test_illegal_transition_is_rejected(self) -> None:
        with self.assertRaises(AgentLabError):
            transition("approved", "approve")


if __name__ == "__main__":
    unittest.main()

