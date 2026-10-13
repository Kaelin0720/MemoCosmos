"""Start MemoCosmos locally from a terminal or PyCharm."""

from __future__ import annotations

import argparse
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
API_URL = "http://127.0.0.1:8000"
APP_URL = "http://127.0.0.1:3000"
VERSION = "1.0.0"


def port_available(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        # 与 HTTP/ASGI 服务一致：允许复用刚退出连接的 TIME_WAIT 地址，
        # 仍拒绝已经在监听的服务，避免正常重启被误判为端口占用。
        option = socket.SO_EXCLUSIVEADDRUSE if os.name == "nt" else socket.SO_REUSEADDR
        listener.setsockopt(socket.SOL_SOCKET, option, 1)
        try:
            listener.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def wait_ready(url: str, process: subprocess.Popen, timeout: float = 30) -> None:
    # 本机请求绕开系统代理；只在已确认未被占用的端口等待本次子进程。
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(
                "A service exited during startup. Check the error output above."
            )
        try:
            with opener.open(url, timeout=1) as response:
                if response.status == 200:
                    return
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(0.15)
    raise RuntimeError("A service did not start in time. Check the error output above.")


def stop(processes: list[subprocess.Popen]) -> None:
    for process in reversed(processes):
        if process.poll() is not None:
            continue
        try:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGTERM)
            else:
                process.terminate()
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 10
    for process in reversed(processes):
        try:
            process.wait(timeout=max(0.1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            if os.name == "posix":
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            else:
                process.kill()
            process.wait(timeout=5)


def commands(dev: bool) -> tuple[list[str], list[str]]:
    executable = ROOT / "backend" / ".venv"
    executable /= "Scripts/python.exe" if os.name == "nt" else "bin/python"
    if not executable.is_file():
        raise RuntimeError(
            "Backend is not installed. Run: uv sync --project backend --locked"
        )
    backend = [
        str(executable),
        "-m",
        "uvicorn",
        "app.main:app",
        "--host",
        "127.0.0.1",
        "--port",
        "8000",
    ]
    if dev:
        pnpm = shutil.which("pnpm")
        if not pnpm:
            raise RuntimeError("pnpm is not installed. Install Node.js and pnpm first.")
        frontend = [pnpm, "dev"]
    else:
        exported = ROOT / "frontend" / "out"
        if not (exported / "index.html").is_file():
            raise RuntimeError(
                "Frontend is not built. Run pnpm build in frontend, or use --dev."
            )
        sources = list((ROOT / "frontend" / "src").rglob("*"))
        sources += [
            ROOT / "frontend" / "package.json",
            ROOT / "frontend" / "next.config.ts",
        ]
        if any(
            path.is_file()
            and path.stat().st_mtime > (exported / "index.html").stat().st_mtime
            for path in sources
        ):
            raise RuntimeError(
                "Frontend sources are newer than the build. Run pnpm build in frontend."
            )
        frontend = [
            str(executable),
            str(ROOT / "preview_server.py"),
            "--directory",
            str(exported),
        ]
    return backend, frontend


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Start MemoCosmos locally. Works in PyCharm too."
    )
    parser.add_argument("--version", action="version", version=f"MemoCosmos {VERSION}")
    parser.add_argument(
        "--dev", action="store_true", help="Use the frontend development server"
    )
    parser.add_argument(
        "--no-browser", action="store_true", help="Do not open the browser"
    )
    parser.add_argument(
        "--memory-dir",
        type=Path,
        help="Use an absolute path to a memory vault outside this project",
    )
    args = parser.parse_args()
    processes: list[subprocess.Popen] = []
    try:
        if os.name == "nt":
            raise RuntimeError(
                "Native Windows vault storage is not supported in 1.0. "
                "Run MemoCosmos inside WSL2 Ubuntu. See README.md."
            )
        backend, frontend = commands(args.dev)
        for port in (8000, 3000):
            if not port_available(port):
                raise RuntimeError(
                    f"Port {port} is already in use. Stop the existing service first."
                )
        environment = os.environ.copy()
        if args.memory_dir is not None:
            selected = args.memory_dir.expanduser()
            if not selected.is_absolute():
                raise RuntimeError(
                    "--memory-dir must be an absolute path outside this project."
                )
            environment["YIHE_MEMORY_DIR"] = str(selected)
        for command, directory, ready in (
            (backend, ROOT / "backend", API_URL + "/health"),
            (frontend, ROOT / "frontend", APP_URL + "/"),
        ):
            process = subprocess.Popen(
                command,
                cwd=directory,
                env=environment,
                start_new_session=os.name == "posix",
            )
            processes.append(process)
            wait_ready(ready, process, 60 if args.dev else 30)
        print(f"\nMemoCosmos {VERSION}: {APP_URL}/", flush=True)
        print(
            "Configure your cloud model in Settings. Press Ctrl+C to stop both services.",
            flush=True,
        )
        if not args.no_browser:
            webbrowser.open(APP_URL + "/")
        while all(process.poll() is None for process in processes):
            time.sleep(0.3)
        raise RuntimeError("A service has exited. Stopping the remaining service.")
    except KeyboardInterrupt:
        print("\nStopping MemoCosmos.", flush=True)
        return 0
    except (RuntimeError, OSError) as error:
        print(f"Startup failed: {error}", file=sys.stderr, flush=True)
        return 1
    finally:
        stop(processes)


def request_shutdown(_signum: int, _frame: object) -> None:
    raise KeyboardInterrupt


if __name__ == "__main__":
    # 接收到终端/IDE 的终止请求时，也清理本次启动的子进程。
    signal.signal(signal.SIGTERM, request_shutdown)
    raise SystemExit(main())
