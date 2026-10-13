"""Only the browser integration test launches this app; production never imports it."""

import argparse
import os
import sys
from pathlib import Path

import uvicorn

# Reuse the backend's injected test model while exercising its actual Deep Agents,
# API routes, token boundary, run manager, migrations and SQLite persistence.
sys.path.insert(0, str(Path.cwd()))
sys.path.insert(0, str(Path.cwd() / "tests"))
from agent_helpers import ScriptedModel
from app.core.settings import Settings
from app import main as test_main
from app.core import security as test_security
from app.main import create_app
test_main.DEVELOPMENT_ORIGINS += (f"http://127.0.0.1:{os.environ.get('YIHE_TEST_PORT','3307')}",)
test_security.DEVELOPMENT_ORIGINS = test_main.DEVELOPMENT_ORIGINS


def model_factory(config):
    if config.model == "slow-fixture":
        return ScriptedModel(reply="临时联调中的部分回复。" * 80, delay=0.03)
    if config.model == "error-fixture":
        return ScriptedModel(failure=True)
    return ScriptedModel(
        reply="## 临时库联调\n\n中文流式回复已保存为本机原始对话。\n\n"
        "- 用户自行填写 URL、模型名称与密钥\n- 长期知识整理尚未接入\n\n"
        "[## 关联资料](https://example.com/docs)",
        delay=0.002,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--port", required=True, type=int)
    arguments = parser.parse_args()
    root = Path(arguments.root)
    application = create_app(
        Settings(root / "memory", root / "config"), model_factory=model_factory
    )
    uvicorn.run(application, host="127.0.0.1", port=arguments.port, log_level="error", access_log=False)
