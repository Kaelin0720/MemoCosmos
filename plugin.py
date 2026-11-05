"""Generate the local MemoCosmos plugin after installing backend dependencies."""

import os
import sys
from pathlib import Path

root = Path(__file__).resolve().parent
python = (
    root / "backend/.venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
)
if not python.exists():
    raise SystemExit("Install the backend first: uv sync --project backend --locked")
environment = dict(os.environ, PYTHONPATH=str(root / "backend"))
os.execve(
    python,
    [str(python), "-m", "app.integrations.setup_plugin", *sys.argv[1:]],
    environment,
)
