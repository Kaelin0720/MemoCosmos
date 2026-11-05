"""Demo 4: an analyst, critic, and decision maker with isolated context."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from typing import Sequence

from agent_lab.config import AgentLabError, load_config
from agent_lab.console import configure_console_encoding
from agent_lab.llm import ChatModel, DeepSeekChat
from agent_lab.parsing import parse_json_object, require_string_list, require_text
from agent_lab.trace import Trace


@dataclass(frozen=True)
class DecisionMemo:
    analysis: str
    critique: str
    recommendation: str
    rationale: str
    conditions: list[str]
    next_steps: list[str]
    confidence: float


def run_review_board(
    model: ChatModel,
    proposal: str,
    *,
    trace: Trace | None = None,
) -> DecisionMemo:
    trace = trace or Trace(enabled=False)
    if not proposal.strip():
        raise AgentLabError("待评审提案不能为空。")

    trace.emit("analyst", "start", "分析目标、收益、成本和风险")
    analysis = model.complete(
        [
            {
                "role": "system",
                "content": "你是方案分析师。关注事实、目标、约束、收益、成本和风险，不替最终决策者下结论。",
            },
            {
                "role": "user",
                "content": f"""分析下面的提案。明确区分提案中的事实、合理推断和未知信息。

提案：
{proposal}

用紧凑的中文要点输出，不超过350字。""",
            },
        ]
    ).strip()

    trace.emit("critic", "start", "只接收提案和分析，寻找漏洞")
    critique = model.complete(
        [
            {
                "role": "system",
                "content": "你是反方评审。目标是找出会导致失败的关键漏洞，而不是复述分析。",
            },
            {
                "role": "user",
                "content": f"""提案：
{proposal}

分析师意见：
{analysis}

指出最关键的缺失假设、风险和反例。用中文，不超过300字。""",
            },
        ]
    ).strip()

    trace.emit("decision_maker", "start", "综合分析和批评后决策")
    decision_prompt = f"""你是最终决策者。阅读提案、分析和批评，给出可执行结论。

提案：
{proposal}

分析师意见：
{analysis}

反方评审：
{critique}

只返回 JSON：
{{
  "recommendation": "建议做 / 有条件做 / 不做，并写一句结论",
  "rationale": "决策依据，不超过180字",
  "conditions": ["必须满足的条件"],
  "next_steps": ["下一步可执行动作"],
  "confidence": 0.0到1.0之间的数字
}}

不确定性必须写进条件，不能假装知道。"""
    decision_data = parse_json_object(
        model.complete(
            [
                {"role": "system", "content": "你只输出严格 JSON 决策备忘录。"},
                {"role": "user", "content": decision_prompt},
            ],
            json_mode=True,
        ),
        "决策者输出",
    )
    confidence = _normalise_confidence(decision_data.get("confidence"))
    result = DecisionMemo(
        analysis=analysis,
        critique=critique,
        recommendation=require_text(decision_data, "recommendation", "决策者输出"),
        rationale=require_text(decision_data, "rationale", "决策者输出"),
        conditions=require_string_list(decision_data, "conditions", "决策者输出"),
        next_steps=require_string_list(decision_data, "next_steps", "决策者输出"),
        confidence=confidence,
    )
    trace.emit(
        "decision_maker",
        "finish",
        {"recommendation": result.recommendation, "confidence": result.confidence},
    )
    return result


def _normalise_confidence(value: object) -> float:
    try:
        confidence = float(value)
    except (TypeError, ValueError) as exc:
        raise AgentLabError("决策者输出中的 confidence 必须是数字。") from exc
    if not 0 <= confidence <= 1:
        raise AgentLabError("决策者输出中的 confidence 必须在 0 到 1 之间。")
    return confidence


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Demo 4：分析师—批评者—决策者角色协作")
    parser.add_argument("proposal", help="待评审的提案")
    parser.add_argument("--show-work", action="store_true", help="同时显示分析与批评全文")
    parser.add_argument("--config", help="配置文件路径，默认是项目根目录 config.json")
    parser.add_argument("--quiet", action="store_true", help="不打印执行轨迹")
    parser.add_argument("--json", action="store_true", help="以 JSON 输出最终结果")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    configure_console_encoding()
    args = build_parser().parse_args(argv)
    try:
        model = DeepSeekChat(load_config(args.config))
        result = run_review_board(model, args.proposal, trace=Trace(enabled=not args.quiet))
    except AgentLabError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(asdict(result), ensure_ascii=False, indent=2))
        return 0

    if args.show_work:
        print(f"\n分析：\n{result.analysis}")
        print(f"\n批评：\n{result.critique}")
    print(f"\n建议：{result.recommendation}")
    print(f"理由：{result.rationale}")
    print(f"置信度：{result.confidence:.0%}")
    print("条件：")
    for condition in result.conditions or ["（无）"]:
        print(f"- {condition}")
    print("下一步：")
    for step in result.next_steps or ["（无）"]:
        print(f"- {step}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

