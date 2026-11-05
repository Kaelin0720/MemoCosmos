"""Demo 3: plan, execute each task, then verify and revise one draft."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from typing import Any, Sequence

from agent_lab.config import AgentLabError, load_config
from agent_lab.console import configure_console_encoding
from agent_lab.llm import ChatModel, DeepSeekChat
from agent_lab.parsing import as_bool, parse_json_object, require_string_list, require_text
from agent_lab.trace import Trace


@dataclass(frozen=True)
class PlanTask:
    task_id: str
    title: str
    instruction: str


@dataclass(frozen=True)
class PlannerResult:
    goal: str
    tasks: list[PlanTask]
    task_outputs: list[str]
    initial_draft: str
    passed_initial_review: bool
    review_issues: list[str]
    final_draft: str


def plan(request: str, model: ChatModel, *, max_tasks: int = 5) -> tuple[str, list[PlanTask]]:
    if max_tasks < 1:
        raise AgentLabError("max_tasks 必须大于 0。")
    prompt = f"""你是计划器。把用户请求拆成可以顺序执行的少量步骤。

用户请求：
{request}

只返回 JSON：
{{
  "goal": "一句话说明最终交付物",
  "tasks": [
    {{
      "id": "1",
      "title": "短标题",
      "instruction": "执行者能独立完成的具体动作"
    }}
  ]
}}

最多 {max_tasks} 个步骤。不要为同一信息重复建任务，不要输出 Markdown。"""
    raw = model.complete(
        [
            {"role": "system", "content": "你只输出严格 JSON 计划。"},
            {"role": "user", "content": prompt},
        ],
        json_mode=True,
    )
    data = parse_json_object(raw, "计划器输出")
    goal = require_text(data, "goal", "计划器输出")
    raw_tasks = data.get("tasks")
    if not isinstance(raw_tasks, list) or not raw_tasks:
        raise AgentLabError("计划器输出的 tasks 必须是非空数组。")

    tasks: list[PlanTask] = []
    for index, item in enumerate(raw_tasks[:max_tasks], start=1):
        if not isinstance(item, dict):
            raise AgentLabError("计划器输出的每个 task 必须是 JSON 对象。")
        tasks.append(
            PlanTask(
                task_id=str(item.get("id") or index),
                title=require_text(item, "title", "计划任务"),
                instruction=require_text(item, "instruction", "计划任务"),
            )
        )
    return goal, tasks


def run_planner_executor(
    model: ChatModel,
    request: str,
    *,
    max_tasks: int = 5,
    trace: Trace | None = None,
) -> PlannerResult:
    trace = trace or Trace(enabled=False)
    if not request.strip():
        raise AgentLabError("请求不能为空。")

    trace.emit("planner", "start", "拆解任务")
    goal, tasks = plan(request, model, max_tasks=max_tasks)
    trace.emit("planner", "plan", {"goal": goal, "tasks": [task.title for task in tasks]})

    task_outputs: list[str] = []
    for index, task in enumerate(tasks, start=1):
        trace.emit("executor", f"task_{index}", task.title)
        previous = "\n\n".join(
            f"步骤 {position}：{output}"
            for position, output in enumerate(task_outputs, start=1)
        ) or "（尚无）"
        prompt = f"""你是执行器。只完成当前步骤，不要重复整份最终答案。

总目标：{goal}
用户原始请求：
{request}

之前步骤的结果：
{previous}

当前步骤：{task.title}
执行要求：{task.instruction}

直接输出本步骤的有用内容，语言与用户一致。"""
        output = model.complete(
            [
                {"role": "system", "content": "你是一个严谨、具体的任务执行器。"},
                {"role": "user", "content": prompt},
            ]
        )
        task_outputs.append(output.strip())

    initial_draft = _assemble(goal, tasks, task_outputs)
    trace.emit("verifier", "review", "检查草稿是否完整满足原始请求")
    verify_prompt = f"""你是验收器。检查草稿是否完整、准确地满足用户请求。

用户请求：
{request}

草稿：
{initial_draft}

只返回 JSON：
{{
  "passed": true 或 false,
  "issues": ["具体且可修改的问题"],
  "revision_instruction": "若未通过，给出一次修订指令；若通过则为空字符串"
}}

标准：直接回应请求；没有明显矛盾；未虚构无法验证的关键事实；结构可读。"""
    verify_data = parse_json_object(
        model.complete(
            [
                {"role": "system", "content": "你只输出严格 JSON 验收结果。"},
                {"role": "user", "content": verify_prompt},
            ],
            json_mode=True,
        ),
        "验收器输出",
    )
    passed = as_bool(verify_data.get("passed"))
    issues = require_string_list(verify_data, "issues", "验收器输出")
    revision_instruction = str(verify_data.get("revision_instruction", "") or "").strip()
    trace.emit("verifier", "result", {"passed": passed, "issues": issues})

    final_draft = initial_draft
    if not passed:
        if not revision_instruction:
            revision_instruction = "逐项修复这些问题：" + "；".join(issues)
        trace.emit("executor", "revision", "根据验收意见修订一次")
        final_draft = model.complete(
            [
                {"role": "system", "content": "你是修订者。保留正确内容，只修复指出的问题。"},
                {
                    "role": "user",
                    "content": f"""用户请求：
{request}

原草稿：
{initial_draft}

验收问题：
{json.dumps(issues, ensure_ascii=False)}

修订要求：
{revision_instruction}

输出完整修订稿，不要解释修改过程。""",
                },
            ]
        ).strip()

    trace.emit("planner_executor", "finish", f"{len(tasks)} 个任务，已{'通过' if passed else '修订'}")
    return PlannerResult(
        goal=goal,
        tasks=tasks,
        task_outputs=task_outputs,
        initial_draft=initial_draft,
        passed_initial_review=passed,
        review_issues=issues,
        final_draft=final_draft,
    )


def _assemble(goal: str, tasks: list[PlanTask], outputs: list[str]) -> str:
    sections = [f"# {goal}"]
    for task, output in zip(tasks, outputs):
        sections.append(f"## {task.title}\n\n{output}")
    return "\n\n".join(sections)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Demo 3：规划—执行—验收—修订")
    parser.add_argument("request", help="需要完成的任务")
    parser.add_argument("--max-tasks", type=int, default=5, help="最多拆成几个步骤")
    parser.add_argument("--config", help="配置文件路径，默认是项目根目录 config.json")
    parser.add_argument("--quiet", action="store_true", help="不打印执行轨迹")
    parser.add_argument("--json", action="store_true", help="以 JSON 输出最终结果")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    configure_console_encoding()
    args = build_parser().parse_args(argv)
    try:
        model = DeepSeekChat(load_config(args.config))
        result = run_planner_executor(
            model,
            args.request,
            max_tasks=args.max_tasks,
            trace=Trace(enabled=not args.quiet),
        )
    except AgentLabError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(asdict(result), ensure_ascii=False, indent=2))
    else:
        print(f"\n{result.final_draft}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

