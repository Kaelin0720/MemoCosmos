"""仅用于临时进程故障注入；生产入口不导入本模块。"""

import os
import signal

from app.main import create_app
from app.services.notes import NoteService
from app.vault.topic_files import TopicFiles

phase = os.environ["YIHE_TEST_CRASH_PHASE"]


def crash():
    os.kill(os.getpid(), signal.SIGKILL)


if phase == "intent":

    def crashing_publish(self, *args, **kwargs):
        crash()

    TopicFiles.publish = crashing_publish
elif phase == "temp":

    def crashing_link(*args, **kwargs):
        crash()

    os.link = crashing_link
elif phase == "hardlink":
    original_unlink = os.unlink

    def crashing_unlink(path, *args, **kwargs):
        if str(path).endswith(".tmp"):
            crash()
        return original_unlink(path, *args, **kwargs)

    os.unlink = crashing_unlink
elif phase == "published":

    def crashing_confirm(self, *args, **kwargs):
        crash()

    NoteService._confirm = crashing_confirm
else:
    raise ValueError("未知测试阶段")

app = create_app()
