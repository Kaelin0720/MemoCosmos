"""静态页面与固定本机 API 转发；生产页面无需跨端口预检。"""

import argparse
import http.client
import json
import re
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

MAX_BODY = 100 * 1024 * 1024


class PreviewHandler(SimpleHTTPRequestHandler):
    backend_port = 8000

    def _error(self, status, code, message):
        body = json.dumps(
            {"error": {"code": code, "message": message}}, ensure_ascii=False
        ).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        self.close_connection = True

    def _route(self):
        hosts = self.headers.get_all("Host", [])
        if len(hosts) != 1 or not re.fullmatch(
            rf"(?:127\.0\.0\.1|localhost):{self.server.server_port}",
            hosts[0],
            re.IGNORECASE,
        ):
            self._error(400, "invalid_host", "仅允许通过本机回环地址访问")
            return
        if not self.path.startswith("/") or self.path.startswith("//"):
            self._error(400, "invalid_path", "请求地址不受支持")
            return
        path = urlsplit(self.path).path
        if path == "/health" or path.startswith("/api/v1/"):
            self._proxy()
        elif self.command == "GET":
            super().do_GET()
        elif self.command == "HEAD":
            super().do_HEAD()
        else:
            self._error(405, "http_error", "请求方法不受支持")

    def _proxy(self):
        if self.headers.get("Transfer-Encoding"):
            self._error(400, "validation_error", "不支持分块上传")
            return
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) > 1 or (lengths and not lengths[0].isdigit()):
            self._error(400, "validation_error", "请求长度不合法")
            return
        length = int(lengths[0]) if lengths else 0
        if length > MAX_BODY:
            self._error(413, "memory_package_too_large", "上传文件超过100 MiB")
            return
        headers = {}
        for name in ("Content-Type", "X-Local-Token", "Origin", "Accept"):
            values = self.headers.get_all(name, [])
            if len(values) > 1:
                self._error(400, "validation_error", "请求头重复")
                return
            if values:
                headers[name] = values[0]
        body = self.rfile.read(length) if length else None
        upstream = http.client.HTTPConnection(
            "127.0.0.1", self.backend_port, timeout=150
        )
        started = False
        try:
            upstream.request(self.command, self.path, body=body, headers=headers)
            response = upstream.getresponse()
            self.send_response(response.status)
            for name in (
                "Content-Type",
                "Content-Length",
                "Content-Disposition",
                "Cache-Control",
            ):
                value = response.getheader(name)
                if value is not None:
                    self.send_header(name, value)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            started = True
            if self.command != "HEAD":
                while data := response.read1(65536):
                    self.wfile.write(data)
                    self.wfile.flush()
        except (OSError, http.client.HTTPException):
            if not started:
                self._error(
                    502, "backend_unavailable", "本机后端暂不可用，请重新检查连接"
                )
        finally:
            upstream.close()
            self.close_connection = True

    do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = _route


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    args = parser.parse_args()
    with ThreadingHTTPServer(
        ("127.0.0.1", 3000), partial(PreviewHandler, directory=args.directory)
    ) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
