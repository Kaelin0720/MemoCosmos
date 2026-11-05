"""Demo 1: a deterministic customer-support triage workflow.

The model performs two bounded tasks: structured extraction and reply drafting.
Routing and SLA selection are ordinary Python rules, which makes the business
process reproducible and easy to test.
"""

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
class Triage:
    summary: str
    category: str
    urgency: int
    signals: list[str]


@dataclass(frozen=True)
class WorkflowResult:
    triage: Triage
    queue: str
    priority: str
    sla_hours: int
    reply: str


ROUTING = {
    "billing": ("财务支持", 24),
    "technical": ("技术支持", 8),
    "account": ("账户支持", 12),
    "other": ("人工分诊", 24),
}


def run_workflow(
    model: ChatModel,
    ticket: str,
    *,
    trace: Trace | None = None,
) -> WorkflowResult:
    trace = trace or Trace(enabled=False)
    if not ticket.strip():
        raise AgentLabError("工单内容不能为空。")

    trace.emit("workflow", "stage", "01_structured_extraction")
    extraction_prompt = f"""你是客服工单分诊器。只做信息提取，不回答客户问题。

工单：
{ticket}

只返回一个 JSON 对象，字段必须如下：
{{
  "summary": "不超过80字的事实摘要",
  "category": "billing 或 technical 或 account 或 other",
  "urgency": 1到4的整数，4表示最紧急,
  "signals": ["支持判断的原文短句"]
}}
不要输出 Markdown，不要编造工单中没有的事实。"""
    raw_triage = model.complete(
        [
            {"role": "system", "content": "你输出严格 JSON。"},
            {"role": "user", "content": extraction_prompt},
        ],
        json_mode=True,
    )
    triage_data = parse_json_object(raw_triage, "工单分诊结果")
    triage = _normalise_triage(triage_data)
    route = _route(triage)
    priority = f"P{5 - triage.urgency}"
    trace.emit(
        "workflow",
        "route",
        {
            "category": triage.category,
            "priority": priority,
            "queue": route[0],
            "sla_hours": route[1],
        },
    )

    trace.emit("workflow", "stage", "02_reply_drafting")
    reply_prompt = f"""你是一名专业客服。根据已经确定的工单事实和路由结果，写一条中文回复。

工单原文：
{ticket}

事实摘要：{triage.summary}
处理队列：{route[0]}
优先级：{priority}
目标响应时限：{route[1]} 小时

要求：
1. 先复述问题，再说明下一步处理；
2. 不承诺未确认的退款、赔偿或完成时间；
3. 不暴露内部优先级代码；
4. 不超过180字，不要标题。"""
    reply = model.complete(
        [
            {"role": "system", "content": "你只输出给客户看的中文回复。"},
            {"role": "user", "content": reply_prompt},
        ]
    )
    trace.emit("workflow", "finish", "工单已分诊并生成回复")
    return WorkflowResult(
        triage=triage,
        queue=route[0],
        priority=priority,
        sla_hours=route[1],
        reply=reply.strip(),
    )


def _normalise_triage(data: dict[str, object]) -> Triage:
    summary = require_text(data, "summary", "工单分诊结果")
    category = str(data.get("category", "")).strip().lower()
    aliases = {
        "支付": "billing",
        "账单": "billing",
        "技术": "technical",
        "故障": "technical",
        "账户": "account",
    }
    category = aliases.get(category, category)
    if category not in ROUTING:
        raise AgentLabError(f"工单分诊结果包含不支持的 category：{category!r}")

    try:
        urgency = int(data.get("urgency", 0))
    except (TypeError, ValueError) as exc:
        raise AgentLabError("工单分诊结果中的 urgency 必须是整数。") from exc
    if urgency not in {1, 2, 3, 4}:
        raise AgentLabError("工单分诊结果中的 urgency 必须在 1 到 4 之间。")

    return Triage(
        summary=summary,
        category=category,
        urgency=urgency,
        signals=require_string_list(data, "signals", "工单分诊结果"),
    )


def _route(triage: Triage) -> tuple[str, int]:
    queue, hours = ROUTING[triage.category]
    if triage.category == "technical" and triage.urgency >= 3:
        hours = 2
    return queue, hours


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Demo 1：固定工作流的客服工单分诊")
    parser.add_argument("ticket", help="工单内容")
    parser.add_argument("--config", help="配置文件路径，默认是项目根目录 config.json")
    parser.add_argument("--quiet", action="store_true", help="不打印执行轨迹")
    parser.add_argument("--json", action="store_true", help="以 JSON 输出最终结果")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    configure_console_encoding()
    args = build_parser().parse_args(argv)
    try:
        model = DeepSeekChat(load_config(args.config))
        result = run_workflow(model, args.ticket, trace=Trace(enabled=not args.quiet))
    except AgentLabError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(asdict(result), ensure_ascii=False, indent=2))
    else:
        print(f"\n队列：{result.queue}")
        print(f"优先级：{result.priority}")
        print(f"响应时限：{result.sla_hours} 小时")
        print(f"\n客户回复：\n{result.reply}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

