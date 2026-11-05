"""Demo 2: a hand-written ReAct loop over a safe local note store."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Sequence

from agent_lab.config import PROJECT_ROOT, AgentLabError, load_config
from agent_lab.console import configure_console_encoding
from agent_lab.llm import ChatModel, DeepSeekChat
from agent_lab.parsing import parse_json_object
from agent_lab.tools import Tool, ToolRegistry
from agent_lab.trace import Trace


DEFAULT_NOTES_DIR = PROJECT_ROOT / "data" / "notes"


@dataclass(frozen=True)
class ReactStep:
    action: str
    action_input: dict[str, Any]
    observation: dict[str, Any]


@dataclass(frozen=True)
class ReactResult:
    answer: str
    steps: list[ReactStep]


class NoteStore:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def list_notes(self) -> list[str]:
        if not self.root.exists():
            return []
        notes = []
        for path in self.root.rglob("*.md"):
            resolved = path.resolve()
            if resolved.is_file() and _is_inside(resolved, self.root):
                notes.append(path.relative_to(self.root).as_posix())
        return sorted(notes)

    def read_note(self, path: str, max_chars: int = 10_000) -> str:
        if not isinstance(path, str) or not path.strip():
            raise AgentLabError("path 必须是非空字符串。")
        candidate = (self.root / path).resolve()
        if not _is_inside(candidate, self.root):
            raise AgentLabError("拒绝读取笔记目录之外的文件。")
        if candidate.suffix.lower() != ".md":
            raise AgentLabError("只允许读取 Markdown 笔记。")
        if not candidate.is_file():
            available = ", ".join(self.list_notes()) or "（无）"
            raise AgentLabError(f"笔记不存在：{path}。可用笔记：{available}")
        content = candidate.read_text(encoding="utf-8")
        if len(content) > max_chars:
            return content[:max_chars] + "\n...[笔记过长，已截断]"
        return content


def run_react(
    model: ChatModel,
    question: str,
    *,
    notes_dir: Path = DEFAULT_NOTES_DIR,
    max_steps: int = 6,
    trace: Trace | None = None,
) -> ReactResult:
    trace = trace or Trace(enabled=False)
    if not question.strip():
        raise AgentLabError("问题不能为空。")
    if max_steps < 1:
        raise AgentLabError("max_steps 必须大于 0。")

    registry = _build_registry(NoteStore(notes_dir))
    tool_specs = json.dumps(registry.specifications(), ensure_ascii=False, indent=2)
    system = f"""你是一个本地资料问答 Agent。你只能通过工具获取资料，不能假装已经看过未读取的文件。

可用工具：
{tool_specs}

每一步只输出一个 JSON 对象，格式二选一：
1. 调用工具：
{{"thought": "简短说明下一步做什么", "action": "工具名", "action_input": {{}}}}
2. 回答：
{{"thought": "信息已经足够", "action": "finish", "action_input": {{"answer": "最终中文回答"}}}}

规则：
- 先确定需要哪些资料，再调用工具；
- 如果问题涉及项目约定，优先查看相关笔记；
- 工具报错时根据观察信息调整，不要重复同样的错误；
- 回答只能依据问题、工具观察和通用常识，并明确区分事实与推测。"""
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": f"用户问题：{question}"},
    ]
    steps: list[ReactStep] = []

    for step_number in range(1, max_steps + 1):
        raw = model.complete(messages, json_mode=True)
        plan = parse_json_object(raw, f"第 {step_number} 步 Agent 输出")
        action = str(plan.get("action", "")).strip()
        action_input = plan.get("action_input", {})
        thought = str(plan.get("thought", "")).strip()
        if not isinstance(action_input, dict):
            action_input = {}

        trace.emit("react", f"step_{step_number}", {"thought": thought, "action": action})
        if action == "finish":
            answer = action_input.get("answer")
            if not isinstance(answer, str) or not answer.strip():
                raise AgentLabError("Agent 调用 finish 时缺少非空 answer。")
            trace.emit("react", "finish", f"共执行 {len(steps)} 次工具调用")
            return ReactResult(answer=answer.strip(), steps=steps)

        observation = registry.execute(action, action_input)
        trace.emit("react", "observation", observation)
        steps.append(ReactStep(action=action, action_input=action_input, observation=observation))
        messages.extend(
            [
                {"role": "assistant", "content": raw},
                {
                    "role": "user",
                    "content": "工具观察：\n" + ToolRegistry.render_result(observation),
                },
            ]
        )

    raise AgentLabError(f"Agent 在 {max_steps} 步内没有完成。最后动作：{steps[-1].action}")


def _build_registry(store: NoteStore) -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(
        Tool(
            name="list_notes",
            description="列出所有可用笔记的相对路径。",
            parameters={"type": "object", "properties": {}, "additionalProperties": False},
            handler=store.list_notes,
        )
    )
    registry.register(
        Tool(
            name="read_note",
            description="读取一篇 Markdown 笔记的全文。",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string", "description": "list_notes 返回的相对路径"}},
                "required": ["path"],
                "additionalProperties": False,
            },
            handler=store.read_note,
        )
    )
    return registry


def _is_inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Demo 2：手写 ReAct 工具调用循环")
    parser.add_argument("question", help="要查询的问题")
    parser.add_argument("--notes-dir", default=str(DEFAULT_NOTES_DIR), help="Markdown 笔记目录")
    parser.add_argument("--max-steps", type=int, default=6, help="最大工具调用轮数")
    parser.add_argument("--config", help="配置文件路径，默认是项目根目录 config.json")
    parser.add_argument("--quiet", action="store_true", help="不打印执行轨迹")
    parser.add_argument("--json", action="store_true", help="以 JSON 输出最终结果")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    configure_console_encoding()
    args = build_parser().parse_args(argv)
    try:
        model = DeepSeekChat(load_config(args.config))
        result = run_react(
            model,
            args.question,
            notes_dir=Path(args.notes_dir),
            max_steps=args.max_steps,
            trace=Trace(enabled=not args.quiet),
        )
    except AgentLabError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(asdict(result), ensure_ascii=False, indent=2))
    else:
        print(f"\n回答：\n{result.answer}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

