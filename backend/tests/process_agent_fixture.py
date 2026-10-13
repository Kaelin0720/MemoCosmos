"""仅供真实进程测试使用的依赖注入入口；生产启动使用 app.main:app。"""

from agent_helpers import ScriptedModel

from app.core.settings import Settings
from app.main import create_app

app = create_app(
    Settings.from_env(),
    model_factory=lambda config: ScriptedModel(delay=0.025, reply="测试进程的持续中文回复。" * 100),
)
