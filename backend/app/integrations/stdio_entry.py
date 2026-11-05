"""Absolute-file entry point for MCP hosts that launch from arbitrary folders."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.integrations.mcp_server import main  # noqa: E402

if __name__ == "__main__":
    main()
