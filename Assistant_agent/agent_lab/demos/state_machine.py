"""Demo 5: a persistent content-approval state machine with human review."""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Sequence

from agent_lab.config import PROJECT_ROOT, AgentLabError, load_config
from agent_lab.console import configure_console_encoding
from agent_lab.llm import ChatModel, DeepSeekChat
from agent_lab.parsing import parse_json_object, require_string_list, require_text
from agent_lab.trace import Trace


DEFAULT_STATE_FILE = PROJECT_ROOT / "data" / "runtime" / "approval_state.json"
TERMINAL_STATES = {"approved", "rejected"}


def assess_content(model: ChatModel, content: str) -> dict[str, Any]:
    if not content.strip():
        raise AgentLabError("待审批内容不能为空。")
    prompt = f"""你是内容合规初审器。只评估风险，不替人工做最终裁决。

待审内容：
{content}

只返回 JSON：
{{
  "risk_level": "low 或 medium 或 high",
  "violations": ["发现的明确问题；没有则为空数组"],
  "rationale": "不超过120字的判断依据",
  "evidence": ["内容中的关键原文短句"]
}}

high 表示存在明确违规或重大法律/安全风险；medium 表示信息不足或存在歧义；
low 表示未发现明显问题。不要编造规则。"""
    data = parse_json_object(
        model.complete(
            [
                {"role": "system", "content": "你只输出严格 JSON 合规初审结果。"},
                {"role": "user", "content": prompt},
            ],
            json_mode=True,
        ),
        "合规初审输出",
    )
    risk_level = str(data.get("risk_level", "")).strip().lower()
    if risk_level not in {"low", "medium", "high"}:
        raise AgentLabError("合规初审输出中的 risk_level 必须是 low、medium 或 high。")
    return {
        "risk_level": risk_level,
        "violations": require_string_list(data, "violations", "合规初审输出"),
        "rationale": require_text(data, "rationale", "合规初审输出"),
        "evidence": require_string_list(data, "evidence", "合规初审输出"),
    }


def decide_initial_state(assessment: dict[str, Any]) -> tuple[str, str]:
    risk_level = assessment.get("risk_level")
    violations = assessment.get("violations", [])
    if risk_level == "high" or violations:
        return "rejected", "初审发现高风险或明确问题，自动拒绝。"
    if risk_level == "medium":
        return "pending_review", "初审为中等风险，等待人工审核。"
    return "approved", "初审未发现明显风险，自动通过。"


def transition(status: str, event: str, note: str = "") -> tuple[str, str]:
    transitions = {
        ("pending_review", "approve"): ("approved", "人工审核通过。"),
        ("pending_review", "reject"): ("rejected", "人工审核拒绝。"),
    }
    if (status, event) not in transitions:
        raise AgentLabError(f"非法状态转换：{status} --{event}--> ?")
    next_status, default_reason = transitions[(status, event)]
    return next_status, note.strip() or default_reason


def submit_case(
    model: ChatModel,
    content: str,
    *,
    state_file: Path = DEFAULT_STATE_FILE,
    trace: Trace | None = None,
) -> dict[str, Any]:
    trace = trace or Trace(enabled=False)
    trace.emit("state_machine", "evaluating", "调用合规初审节点")
    assessment = assess_content(model, content)
    status, reason = decide_initial_state(assessment)
    now = _now()
    state = {
        "case_id": uuid.uuid4().hex[:8],
        "status": status,
        "content": content.strip(),
        "assessment": assessment,
        "reason": reason,
        "created_at": now,
        "updated_at": now,
        "history": [
            {"at": now, "event": "submitted", "detail": "创建审批单"},
            {"at": now, "event": "agent_reviewed", "detail": reason},
        ],
    }
    _write_state(state_file, state)
    trace.emit("state_machine", "transition", {"to": status, "reason": reason})
    return state


def apply_human_decision(
    event: str,
    *,
    note: str = "",
    state_file: Path = DEFAULT_STATE_FILE,
) -> dict[str, Any]:
    state = load_state(state_file)
    if state is None:
        raise AgentLabError("当前没有审批单，请先执行 submit。")
    next_status, reason = transition(str(state["status"]), event, note)
    now = _now()
    state["status"] = next_status
    state["reason"] = reason
    state["updated_at"] = now
    state["history"].append({"at": now, "event": event, "detail": reason})
    _write_state(state_file, state)
    return state


def load_state(path: Path = DEFAULT_STATE_FILE) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise AgentLabError(f"状态文件损坏或无法读取：{path}") from exc
    if not isinstance(state, dict) or "status" not in state:
        raise AgentLabError(f"状态文件结构不正确：{path}")
    return state


def _write_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Demo 5：可恢复的内容审批状态机")
    parser.add_argument("--state-file", default=str(DEFAULT_STATE_FILE), help="状态文件路径")
    parser.add_argument("--config", help="配置文件路径，默认是项目根目录 config.json")
    parser.add_argument("--quiet", action="store_true", help="submit 时不打印执行轨迹")
    parser.add_argument("--json", action="store_true", help="以 JSON 输出最终结果")
    subparsers = parser.add_subparsers(dest="command", required=True)

    submit = subparsers.add_parser("submit", help="提交新内容并执行初审")
    submit.add_argument("content", help="待审批内容")

    subparsers.add_parser("status", help="查看当前状态")

    approve = subparsers.add_parser("approve", help="人工通过待审核内容")
    approve.add_argument("--note", default="", help="审核备注")

    reject = subparsers.add_parser("reject", help="人工拒绝待审核内容")
    reject.add_argument("--note", default="", help="审核备注")

    subparsers.add_parser("reset", help="删除当前演示状态")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    configure_console_encoding()
    args = build_parser().parse_args(argv)
    state_file = Path(args.state_file)
    try:
        if args.command == "submit":
            model = DeepSeekChat(load_config(args.config))
            state = submit_case(
                model,
                args.content,
                state_file=state_file,
                trace=Trace(enabled=not args.quiet),
            )
        elif args.command == "status":
            state = load_state(state_file)
            if state is None:
                print("当前没有审批单。")
                return 0
        elif args.command == "approve":
            state = apply_human_decision("approve", note=args.note, state_file=state_file)
        elif args.command == "reject":
            state = apply_human_decision("reject", note=args.note, state_file=state_file)
        elif args.command == "reset":
            if state_file.exists():
                state_file.unlink()
                print(f"已删除状态文件：{state_file}")
            else:
                print("没有可删除的状态文件。")
            return 0
        else:
            raise AgentLabError(f"未知命令：{args.command}")
    except AgentLabError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(state, ensure_ascii=False, indent=2))
    else:
        print(f"审批单：{state['case_id']}")
        print(f"状态：{state['status']}")
        print(f"风险：{state['assessment']['risk_level']}")
        print(f"原因：{state['reason']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

