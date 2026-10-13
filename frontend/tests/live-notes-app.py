"""Browser-test launcher: production API with an explicitly isolated temporary vault."""
import argparse
import os
import sys
from pathlib import Path

import uvicorn

sys.path.insert(0, str(Path.cwd()))
from app.core.settings import Settings
from app import main as test_main
from app.core import security as test_security
from app.main import create_app
test_main.DEVELOPMENT_ORIGINS += (f"http://127.0.0.1:{os.environ.get('YIHE_TEST_PORT','3307')}",)
test_security.DEVELOPMENT_ORIGINS = test_main.DEVELOPMENT_ORIGINS

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--port", required=True, type=int)
    arguments = parser.parse_args()
    root = Path(arguments.root)
    application = create_app(Settings(root / "memory", root / "config"))
    uvicorn.run(application, host="127.0.0.1", port=arguments.port, log_level="error", access_log=False)
