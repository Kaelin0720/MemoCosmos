"""本机时区；TZ 可显式配置，macOS/Linux 通常从 /etc/localtime 解析。"""

import os
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def local_zone():
    configured = os.environ.get("TZ") or os.environ.get("YIHE_TIMEZONE")
    path = str(Path("/etc/localtime").resolve())
    inferred = path.split("/zoneinfo/", 1)[-1] if "/zoneinfo/" in path else None
    for name in (configured, inferred):
        if name:
            try:
                return ZoneInfo(name)
            except ZoneInfoNotFoundError:
                continue
    return datetime.now().astimezone().tzinfo
