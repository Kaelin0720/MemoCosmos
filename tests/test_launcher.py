"""启动器进程与本机端口检查；不打开用户库或调用模型。"""

import importlib.util
import os
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "yihe_launcher", Path(__file__).resolve().parents[1] / "run.py"
)
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class LauncherTests(unittest.TestCase):
    def test_port_conflict_does_not_take_over_existing_server(self):
        with socket.socket() as existing:
            existing.bind(("127.0.0.1", 0))
            port = existing.getsockname()[1]
            self.assertFalse(launcher.port_available(port))
        self.assertTrue(launcher.port_available(port))

    def test_ready_waits_for_a_real_http_process_and_stop_reaps_it(self):
        with tempfile.TemporaryDirectory() as directory, socket.socket() as reservation:
            Path(directory, "index.html").write_text(
                "temporary preview", encoding="utf-8"
            )
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
            reservation.close()
            process = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "http.server",
                    str(port),
                    "--bind",
                    "127.0.0.1",
                    "--directory",
                    directory,
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=os.name == "posix",
            )
            try:
                launcher.wait_ready(f"http://127.0.0.1:{port}/", process, timeout=20)
                self.assertIsNone(process.poll())
            finally:
                launcher.stop([process])
            self.assertIsNotNone(process.poll())
            if os.name != "nt":
                self.assertTrue(launcher.port_available(port))

    def test_early_service_exit_is_reported_without_waiting_for_timeout(self):
        process = subprocess.Popen(
            [sys.executable, "-c", "raise SystemExit(7)"],
            start_new_session=os.name == "posix",
        )
        process.wait(timeout=5)
        with self.assertRaisesRegex(RuntimeError, "exited during startup"):
            launcher.wait_ready("http://127.0.0.1:1/", process, timeout=5)

    def test_both_started_children_are_reaped(self):
        children = [
            subprocess.Popen(
                [sys.executable, "-c", "import time; time.sleep(30)"],
                start_new_session=os.name == "posix",
            )
            for _ in range(2)
        ]
        launcher.stop(children)
        self.assertTrue(all(child.poll() is not None for child in children))


if __name__ == "__main__":
    unittest.main()
