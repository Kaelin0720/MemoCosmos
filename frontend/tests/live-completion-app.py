"""Explicit test-only models and planner; real API, jobs, SQLite and Markdown."""
import argparse
import os
import sys
from pathlib import Path

import uvicorn

sys.path.insert(0, str(Path.cwd()))
sys.path.insert(0, str(Path.cwd() / "tests"))
from agent_helpers import ScriptedModel
from app.core.settings import Settings
from app import main as test_main
from app.core import security as test_security
from app.main import create_app
test_main.DEVELOPMENT_ORIGINS += (f"http://127.0.0.1:{os.environ.get('YIHE_TEST_PORT','3307')}",)
test_security.DEVELOPMENT_ORIGINS = test_main.DEVELOPMENT_ORIGINS

attempts = {}


async def planner(config, context):
    user = context["user"]
    attempts[user] = attempts.get(user, 0) + 1
    if "故障" in user and attempts[user] == 1:
        raise RuntimeError("explicit test planning failure")
    if "确认" in user:
        return {
            "decision": "apply" if context["clarification"] else "confirm",
            "reason": "测试澄清后保留概念，不生成个人完成事实",
            "question": "请确认这是概念记录还是个人经历？",
            "notes": [{"title": "澄清记录", "body": "这是概念资料。", "tags": ["缓存"]}],
        }
    if "故障" in user:
        return {"decision": "skip", "reason": "显式重试已成功判断，没有新增资料"}
    return {
        "decision": "apply",
        "reason": "临时联调：保存关联概念",
        "notes": [
            {"title": "Redis 缓存", "body": "## 使用记录\n\nRedis 缓存用于重复查询。", "folder": "知识/数据库", "tags": ["缓存"]},
            {"title": "查询缓存", "body": "## 实验思路\n\n在项目中检查缓存失效与数据库读取。", "folder": "项目/缓存", "tags": ["缓存"]},
        ],
        "relations": [{"source_index": 0, "target_index": 1, "relation": "应用", "evidence": "Redis 缓存用于查询缓存"}],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--memory-dir")
    args = parser.parse_args()
    root = Path(args.root)
    app = create_app(
        Settings(Path(args.memory_dir) if args.memory_dir else root / "memory", root / "config"),
        model_factory=lambda _: ScriptedModel(reply="## 临时联调回复\n\n原始对话已保存，知识整理随后独立完成。", delay=0.002),
        memory_planner=planner,
    )
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="error", access_log=False)
