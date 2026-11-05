"""Interactive, framework-free universal assistant built from the demos."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

from agent_lab.config import PROJECT_ROOT, AgentLabError, load_config
from agent_lab.console import configure_console_encoding
from agent_lab.demos.multi_agent import run_review_board
from agent_lab.demos.planner_executor import run_planner_executor
from agent_lab.demos.react import DEFAULT_NOTES_DIR, run_react
from agent_lab.demos.state_machine import (
    DEFAULT_STATE_FILE,
    apply_human_decision,
    load_state,
    submit_case,
)
from agent_lab.demos.workflow import run_workflow
from agent_lab.llm import ChatModel, DeepSeekChat
from agent_lab.parsing import parse_json_object
from agent_lab.trace import Trace


DEFAULT_SESSION_FILE = PROJECT_ROOT / "data" / "runtime" / "assistant_session.json"
INTENT_LABELS = {
    "chat": "通用对话",
    "notes": "本地资料问答",
    "support": "工单处理",
    "plan": "规划执行",
    "review": "多角色评审",
    "approval": "内容审批",
}
VALID_INTENTS = set(INTENT_LABELS)


@dataclass(frozen=True)
class AssistantResponse:
    text: str
    intent: str
    route_reason: str = ""


class ConversationMemory:
    def __init__(
        self,
        path: Path | None = DEFAULT_SESSION_FILE,
        *,
        max_messages: int = 24,
    ) -> None:
        self.path = path
        self.max_messages = max_messages
        self.messages: list[dict[str, str]] = []

    def load(self) -> None:
        self.messages = []
        if self.path is None or not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise AgentLabError(f"会话记录无法读取：{self.path}") from exc
        if not isinstance(data, list):
            raise AgentLabError(f"会话记录格式不正确：{self.path}")

        messages: list[dict[str, str]] = []
        for item in data:
            if (
                isinstance(item, dict)
                and item.get("role") in {"user", "assistant"}
                and isinstance(item.get("content"), str)
            ):
                messages.append(
                    {"role": str(item["role"]), "content": str(item["content"])}
                )
        self.messages = messages[-self.max_messages :]

    def add(self, user_message: str, assistant_message: str) -> None:
        self.messages.extend(
            [
                {"role": "user", "content": user_message},
                {"role": "assistant", "content": assistant_message},
            ]
        )
        self.messages = self.messages[-self.max_messages :]
        self.save()

    def clear(self) -> None:
        self.messages = []
        self.save()

    def save(self) -> None:
        if self.path is None:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix(self.path.suffix + ".tmp")
            temporary.write_text(
                json.dumps(self.messages, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            temporary.replace(self.path)
        except OSError as exc:
            raise AgentLabError(f"无法保存会话记录：{self.path}") from exc

    def context(self, max_messages: int = 8, max_chars_per_message: int = 700) -> str:
        if not self.messages:
            return "（无）"
        rows = []
        for message in self.messages[-max_messages:]:
            role = "用户" if message["role"] == "user" else "助手"
            content = message["content"].strip()
            if len(content) > max_chars_per_message:
                content = content[:max_chars_per_message] + "..."
            rows.append(f"{role}：{content}")
        return "\n".join(rows)


class UniversalAssistant:
    def __init__(
        self,
        model: ChatModel | None = None,
        *,
        config_path: str | Path | None = None,
        notes_dir: Path = DEFAULT_NOTES_DIR,
        state_file: Path = DEFAULT_STATE_FILE,
        session_file: Path | None = DEFAULT_SESSION_FILE,
        mode: str = "auto",
        trace_enabled: bool = False,
    ) -> None:
        if mode != "auto" and mode not in VALID_INTENTS:
            raise AgentLabError(f"不支持的助手模式：{mode}")
        self.model = model
        self.config_path = Path(config_path) if config_path else None
        self.notes_dir = notes_dir
        self.state_file = state_file
        self.mode = mode
        self.trace_enabled = trace_enabled
        self.memory = ConversationMemory(session_file)
        self.memory_error = ""
        try:
            self.memory.load()
        except AgentLabError as exc:
            self.memory_error = str(exc)

    @property
    def memory_path_display(self) -> str:
        return str(self.memory.path) if self.memory.path else "未启用"

    def reload_model(self) -> ChatModel:
        model = DeepSeekChat(load_config(self.config_path))
        self.model = model
        return model

    def handle(self, message: str) -> AssistantResponse:
        message = message.strip()
        if not message:
            raise AgentLabError("请输入内容。")

        model = self._get_model()
        if self.mode == "auto":
            intent, route_reason = classify_intent(model, message, self.memory.context())
        else:
            intent, route_reason = self.mode, f"已强制使用{INTENT_LABELS[self.mode]}模式"

        trace = Trace(enabled=self.trace_enabled)
        if intent == "chat":
            text = self._chat(model, message)
        elif intent == "notes":
            result = run_react(
                model,
                self._contextual_request(message),
                notes_dir=self.notes_dir,
                trace=trace,
            )
            text = result.answer
        elif intent == "support":
            result = run_workflow(
                model,
                self._contextual_request(message),
                trace=trace,
            )
            text = _format_support(result)
        elif intent == "plan":
            result = run_planner_executor(
                model,
                self._contextual_request(message),
                max_tasks=4,
                trace=trace,
            )
            text = result.final_draft
        elif intent == "review":
            result = run_review_board(
                model,
                self._contextual_request(message),
                trace=trace,
            )
            text = _format_review(result)
        elif intent == "approval":
            result = submit_case(
                model,
                self._contextual_request(message),
                state_file=self.state_file,
                trace=trace,
            )
            text = _format_approval(result)
        else:
            raise AgentLabError(f"无法处理未知意图：{intent}")

        self.memory.add(message, text)
        return AssistantResponse(text=text, intent=intent, route_reason=route_reason)

    def _get_model(self) -> ChatModel:
        if self.model is None:
            self.reload_model()
        if self.model is None:
            raise AgentLabError("模型尚未初始化。")
        return self.model

    def _chat(self, model: ChatModel, message: str) -> str:
        system = """你是一个中文优先的万能助手。你擅长解释概念、写作、编程、分析和日常规划。

要求：
- 先直接解决问题，再补充必要说明；
- 复杂任务使用清晰的小节或步骤，简单问题保持简洁；
- 不假装调用过工具，不编造文件、网页或运行结果；
- 信息不足且会影响结论时，明确说明假设；
- 不泄露 API Key 或其他敏感配置。"""
        messages = [{"role": "system", "content": system}]
        messages.extend(self.memory.messages[-12:])
        messages.append({"role": "user", "content": message})
        return model.complete(messages).strip()

    def _contextual_request(self, message: str) -> str:
        if not self.memory.messages:
            return message
        return f"""近期对话（仅用于理解指代和补充上下文）：
{self.memory.context(max_messages=6, max_chars_per_message=500)}

当前请求：
{message}"""


def classify_intent(
    model: ChatModel,
    message: str,
    recent_context: str = "（无）",
) -> tuple[str, str]:
    router_prompt = f"""你是助手路由器。选择最适合处理当前请求的一种模式。

模式：
- chat：普通问答、解释、聊天、写短文本、编程问题，直接回答即可。
- notes：询问本项目的文件、笔记、README、配置、架构或验收要求，需要查本地资料。
- support：处理客服工单、客户投诉、退款、扣款、登录故障或服务问题，需要分级和回复。
- plan：要求完成复杂方案、报告、计划、长文、应用或需要拆解执行的任务。
- review：要求评估提案、方案、决策、风险或比较是否值得做。
- approval：要求检查一段准备发布的文案或内容是否合规、是否可发布。

近期对话：
{recent_context}

当前请求：
{message}

只返回 JSON：
{{"intent": "chat/notes/support/plan/review/approval 之一", "reason": "不超过30字"}}

优先选择最轻量的模式。普通问题不要选 plan；只有用户明确要评审时才选 review；
涉及“审核文案/能否发布/合规检查”时选 approval。"""
    try:
        raw = model.complete(
            [
                {"role": "system", "content": "你只输出严格 JSON 路由结果。"},
                {"role": "user", "content": router_prompt},
            ],
            temperature=0,
            json_mode=True,
        )
        data = parse_json_object(raw, "助手路由结果")
        intent = str(data.get("intent", "")).strip().lower()
        reason = str(data.get("reason", "")).strip()
        if intent in VALID_INTENTS:
            return intent, reason or "模型自动路由"
    except AgentLabError:
        pass
    return heuristic_intent(message), "模型路由不可用，已使用关键词兜底"


def heuristic_intent(message: str) -> str:
    text = message.lower()
    support_words = ("工单", "退款", "扣款", "投诉", "客服", "无法登录", "登录失败")
    approval_words = ("合规", "违规", "敏感词", "能否发布", "可以发布", "审核文案", "内容审核")
    review_words = ("评审", "评估", "是否值得", "决策", "风险分析", "方案比较")
    notes_words = ("readme", "这个项目", "项目里", "本地笔记", "验收要求", "配置文件", "demo")
    plan_words = ("帮我写", "设计一个", "制定", "详细方案", "完整报告", "开发一个", "实现一个")

    if any(word in text for word in support_words):
        return "support"
    if any(word in text for word in approval_words):
        return "approval"
    if any(word in text for word in review_words):
        return "review"
    if any(word in text for word in notes_words):
        return "notes"
    if any(word in text for word in plan_words):
        return "plan"
    return "chat"


def _format_support(result: Any) -> str:
    return f"""已识别问题：{result.triage.summary}
分类：{result.triage.category}
优先级：{result.priority}
处理队列：{result.queue}
目标响应时限：{result.sla_hours} 小时

建议回复：
{result.reply}"""


def _format_review(result: Any) -> str:
    conditions = "\n".join(f"- {item}" for item in result.conditions) or "- 无"
    next_steps = "\n".join(f"- {item}" for item in result.next_steps) or "- 无"
    return f"""结论：{result.recommendation}
置信度：{result.confidence:.0%}
理由：{result.rationale}

前置条件：
{conditions}

下一步：
{next_steps}"""


def _format_approval(state: dict[str, Any]) -> str:
    assessment = state["assessment"]
    evidence = "\n".join(f"- {item}" for item in assessment.get("evidence", [])) or "- 无"
    status = state["status"]
    text = f"""审批单：{state['case_id']}
状态：{status}
风险等级：{assessment['risk_level']}
原因：{state['reason']}
判断依据：{assessment['rationale']}

关键原文：
{evidence}"""
    if status == "pending_review":
        text += "\n\n该内容需要人工决定，可输入 /approval approve 或 /approval reject。"
    return text


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="交互式 DeepSeek 万能助手")
    parser.add_argument("prompt", nargs="?", help="只处理一条消息；省略后进入交互模式")
    parser.add_argument("--config", help="配置文件路径，默认是项目根目录 config.json")
    parser.add_argument("--notes-dir", default=str(DEFAULT_NOTES_DIR), help="本地笔记目录")
    parser.add_argument("--state-file", default=str(DEFAULT_STATE_FILE), help="审批状态文件")
    parser.add_argument(
        "--session-file",
        default=str(DEFAULT_SESSION_FILE),
        help="会话记忆文件",
    )
    parser.add_argument("--no-history", action="store_true", help="不保存会话记忆")
    parser.add_argument("--trace", action="store_true", help="显示子 Agent 执行轨迹")
    parser.add_argument(
        "--mode",
        default="auto",
        choices=["auto", *sorted(VALID_INTENTS)],
        help="自动路由或强制一种模式",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    configure_console_encoding()
    args = build_parser().parse_args(argv)
    assistant = UniversalAssistant(
        config_path=args.config,
        notes_dir=Path(args.notes_dir),
        state_file=Path(args.state_file),
        session_file=None if args.no_history else Path(args.session_file),
        mode=args.mode,
        trace_enabled=args.trace,
    )
    if assistant.memory_error:
        print(f"警告：{assistant.memory_error}，本次将使用空会话。", file=sys.stderr)

    if args.prompt:
        return _run_once(assistant, args.prompt)
    return run_repl(assistant)


def _run_once(assistant: UniversalAssistant, message: str) -> int:
    try:
        response = assistant.handle(message)
    except AgentLabError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2
    print(f"[模式：{INTENT_LABELS[response.intent]}]")
    print(response.text)
    return 0


def run_repl(assistant: UniversalAssistant) -> int:
    print("DeepSeek 万能助手")
    print("输入 /help 查看命令，输入 /quit 退出。\n")
    print(f"当前模式：{_mode_label(assistant.mode)}")
    if assistant.memory_path_display:
        print(f"会话记忆：{assistant.memory_path_display}")
    try:
        assistant.reload_model()
    except AgentLabError as exc:
        print(f"提示：{exc}")
        print("编辑配置后可以在对话中输入 /reload。\n")
    else:
        print("DeepSeek 已连接。\n")

    while True:
        try:
            message = input("你 > ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n再见。")
            return 0
        if not message:
            continue
        if message == "/paste":
            message = _read_multiline()
            if not message:
                continue
        elif message.startswith("/"):
            should_continue = _handle_command(assistant, message)
            if not should_continue:
                return 0
            continue

        try:
            print("处理中...")
            response = assistant.handle(message)
        except AgentLabError as exc:
            print(f"错误：{exc}\n")
            continue
        except KeyboardInterrupt:
            print("\n已取消本次请求。\n")
            continue

        print(f"\n助手 [{INTENT_LABELS[response.intent]}] >")
        print(response.text)
        if assistant.trace_enabled and response.route_reason:
            print(f"\n路由：{response.route_reason}")
        print()


def _handle_command(assistant: UniversalAssistant, command: str) -> bool:
    name, _, argument = command.partition(" ")
    argument = argument.strip()
    if name in {"/quit", "/exit"}:
        print("再见。")
        return False
    if name == "/help":
        _print_help()
    elif name == "/mode":
        if not argument:
            print(f"当前模式：{_mode_label(assistant.mode)}\n")
        elif argument in {"auto", *VALID_INTENTS}:
            assistant.mode = argument
            print(f"已切换到：{_mode_label(argument)}\n")
        else:
            print("模式必须是 auto、chat、notes、support、plan、review 或 approval。\n")
    elif name == "/trace":
        if argument in {"on", "off"}:
            assistant.trace_enabled = argument == "on"
        print(f"执行轨迹：{'开启' if assistant.trace_enabled else '关闭'}\n")
    elif name == "/history":
        if not assistant.memory.messages:
            print("暂无会话记录。\n")
        else:
            for index, item in enumerate(assistant.memory.messages, start=1):
                role = "你" if item["role"] == "user" else "助手"
                print(f"{index:02d} {role}：{item['content']}")
            print()
    elif name == "/clear":
        assistant.memory.clear()
        print("会话记忆已清空。\n")
    elif name == "/reload":
        try:
            assistant.reload_model()
            print("配置已重新加载。\n")
        except AgentLabError as exc:
            print(f"重新加载失败：{exc}\n")
    elif name in {"/approval", "/status"}:
        _handle_approval_command(assistant, argument if name == "/approval" else "status")
    else:
        print(f"未知命令：{name}。输入 /help 查看可用命令。\n")
    return True


def _handle_approval_command(assistant: UniversalAssistant, argument: str) -> None:
    subcommand, _, note = argument.partition(" ")
    subcommand = subcommand.strip() or "status"
    try:
        if subcommand == "status":
            state = load_state(assistant.state_file)
            if state is None:
                print("当前没有审批单。\n")
            else:
                print(_format_approval(state) + "\n")
        elif subcommand in {"approve", "reject"}:
            state = apply_human_decision(
                subcommand,
                note=note.strip(),
                state_file=assistant.state_file,
            )
            print(_format_approval(state) + "\n")
        elif subcommand == "reset":
            if assistant.state_file.exists():
                assistant.state_file.unlink()
                print("审批状态已删除。\n")
            else:
                print("当前没有审批单。\n")
        else:
            print("用法：/approval status | approve [备注] | reject [备注] | reset\n")
    except AgentLabError as exc:
        print(f"错误：{exc}\n")


def _read_multiline() -> str:
    print("进入多行输入，输入 /end 结束：")
    lines = []
    while True:
        try:
            line = input("... ")
        except (EOFError, KeyboardInterrupt):
            break
        if line.strip() == "/end":
            break
        lines.append(line)
    return "\n".join(lines).strip()


def _print_help() -> None:
    print(
        """可用命令：
  /help                    显示帮助
  /mode [模式]             查看或切换 auto/chat/notes/support/plan/review/approval
  /trace [on|off]          查看或切换子 Agent 执行轨迹
  /paste                   输入多行内容，使用 /end 结束
  /history                 显示已保存的会话
  /clear                   清空会话记忆
  /reload                  重新读取 config.json
  /approval status         查看当前审批单
  /approval approve [备注] 人工通过待审核内容
  /approval reject [备注]  人工拒绝待审核内容
  /approval reset          删除当前审批状态
  /quit                    退出

直接输入自然语言即可。auto 模式会根据请求自动选择最合适的处理流程。
"""
    )


def _mode_label(mode: str) -> str:
    return "自动路由" if mode == "auto" else INTENT_LABELS.get(mode, mode)

