"""Unified entry point for the interactive assistant and individual demos."""

from __future__ import annotations

import sys

from agent_lab import assistant
from agent_lab.console import configure_console_encoding
from agent_lab.demos import multi_agent, planner_executor, react, state_machine, workflow


DEMOS = {
    "workflow": (workflow, "固定工作流：客服工单分诊"),
    "react": (react, "ReAct：本地资料工具问答"),
    "planner-executor": (planner_executor, "规划执行：任务拆解、验收、修订"),
    "multi-agent": (multi_agent, "多角色协作：分析与决策评审"),
    "state-machine": (state_machine, "状态机：可恢复的内容审批"),
}


def main() -> int:
    configure_console_encoding()
    if len(sys.argv) < 2:
        return assistant.main([])
    if sys.argv[1] in {"-h", "--help", "list"}:
        print("用法：\n")
        print("  python -m agent_lab                    启动交互式万能助手")
        print("  python -m agent_lab ask \"你的问题\"      单轮调用万能助手")
        print("  python -m agent_lab assistant [参数]     配置交互助手")
        print("  python -m agent_lab <demo> [参数]        单独运行 Demo\n")
        print("可用 Demo：")
        for name, (_, description) in DEMOS.items():
            print(f"  {name:<18} {description}")
        print("\n查看交互助手参数：python -m agent_lab assistant --help")
        return 0

    name = sys.argv[1]
    if name in {"assistant", "ask"}:
        if name == "ask" and len(sys.argv) < 3:
            print("用法：python -m agent_lab ask \"你的问题\"", file=sys.stderr)
            return 2
        return assistant.main(sys.argv[2:])
    if name not in DEMOS:
        print(f"未知 Demo：{name}", file=sys.stderr)
        print("直接运行 python -m agent_lab 可启动万能助手。", file=sys.stderr)
        return 2

    module, _ = DEMOS[name]
    return module.main(sys.argv[2:])


if __name__ == "__main__":
    raise SystemExit(main())

