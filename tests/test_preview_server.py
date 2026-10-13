"""真实 HTTP 验证同源代理、二进制载荷、流式响应与本机访问边界。"""

import http.client
import tempfile
import threading
import unittest
from contextlib import closing
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from preview_server import PreviewHandler


class ProxyTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.release = threading.Event()
        calls, release = self.calls, self.release

        class Backend(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def reply(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                calls.append((self.command, self.path, dict(self.headers), body))
                if self.path == "/api/v1/events":
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    self.wfile.write(b"data: first\n\n")
                    self.wfile.flush()
                    release.wait(3)
                    self.wfile.write(b"data: last\n\n")
                else:
                    result = body or b'{"items":[],"total":0}'
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(len(result)))
                    self.end_headers()
                    self.wfile.write(result)

            do_GET = do_POST = do_PATCH = reply

        self.backend = ThreadingHTTPServer(("127.0.0.1", 0), Backend)
        self.directory = tempfile.TemporaryDirectory()
        Path(self.directory.name, "index.html").write_text("preview", encoding="utf-8")

        class QuietPreview(PreviewHandler):
            def log_message(self, *_args):
                pass

        QuietPreview.backend_port = self.backend.server_port
        self.preview = ThreadingHTTPServer(
            ("127.0.0.1", 0), partial(QuietPreview, directory=self.directory.name)
        )
        self.threads = [
            threading.Thread(target=server.serve_forever, daemon=True)
            for server in (self.backend, self.preview)
        ]
        for thread in self.threads:
            thread.start()

    def tearDown(self):
        self.release.set()
        for server in (self.preview, self.backend):
            server.shutdown()
            server.server_close()
        for thread in self.threads:
            thread.join(timeout=3)
        self.directory.cleanup()

    def connect(self):
        return closing(
            http.client.HTTPConnection("127.0.0.1", self.preview.server_port, timeout=2)
        )

    def test_static_and_api_forward_binary_body_and_access_headers(self):
        with self.connect() as connection:
            connection.request("GET", "/")
            self.assertEqual(connection.getresponse().read(), b"preview")
        payload = b"PK\x03\x04\x00\xff\x00temporary-package"
        origin = f"http://127.0.0.1:{self.preview.server_port}"
        with self.connect() as connection:
            connection.request(
                "POST",
                "/api/v1/memory/import",
                payload,
                {
                    "Origin": origin,
                    "X-Local-Token": "test-only",
                    "Content-Type": "application/octet-stream",
                },
            )
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), payload)
        method, path, headers, body = self.calls[0]
        self.assertEqual(
            (method, path, body), ("POST", "/api/v1/memory/import", payload)
        )
        self.assertEqual(headers["Origin"], origin)
        self.assertEqual(headers["X-Local-Token"], "test-only")

    def test_stream_first_event_arrives_before_backend_finishes(self):
        with self.connect() as connection:
            connection.request("GET", "/api/v1/events")
            response = connection.getresponse()
            self.assertEqual(response.getheader("Content-Type"), "text/event-stream")
            self.assertEqual(response.readline(), b"data: first\n")
            self.assertFalse(self.release.is_set())
            self.release.set()
            self.assertIn(b"data: last", response.read())

    def test_wrong_host_and_oversize_body_never_reach_backend(self):
        with self.connect() as connection:
            connection.request(
                "GET", "/api/v1/notes", headers={"Host": "malicious.example"}
            )
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            response.read()
        with self.connect() as connection:
            connection.request(
                "POST",
                "/api/v1/memory/import",
                headers={"Content-Length": str(100 * 1024 * 1024 + 1)},
            )
            response = connection.getresponse()
            self.assertEqual(response.status, 413)
            response.read()
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
