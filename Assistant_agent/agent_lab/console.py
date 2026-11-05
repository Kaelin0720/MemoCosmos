from __future__ import annotations

import sys


def configure_console_encoding() -> None:
    """Keep Chinese CLI output consistent when stdout is captured or piped."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8")
            except (OSError, ValueError):
                pass

