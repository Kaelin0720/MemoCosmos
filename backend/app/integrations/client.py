"""Loopback-only bridge. Credentials never enter plugin manifests or stdout."""

import json
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class BridgeError(Exception):
    def __init__(self, code, message, *, retryable=True):
        self.code, self.message, self.retryable = code, message, retryable
        super().__init__(message)


def local_url(value):
    parsed = urlsplit(value)
    if (
        any(char.isspace() for char in value)
        or parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
        or parsed.port is None
        or parsed.port == 0
    ):
        raise ValueError("MemoCosmos URL must be an explicit HTTP loopback address and port")
    return value.rstrip("/")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class LocalClient:
    def __init__(self, base_url="http://127.0.0.1:8000", *, timeout=5):
        self.base_url, self.timeout = local_url(base_url), timeout
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def _request(self, path, data=None, token=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["X-Local-Token"] = token
        request = Request(
            self.base_url + path,
            data=json.dumps(data).encode() if data is not None else None,
            headers=headers,
        )
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                body = response.read(1024 * 1024 + 1)
                if len(body) > 1024 * 1024:
                    raise BridgeError("invalid_response", "Local response exceeded the size limit")
                return json.loads(body)
        except HTTPError as exc:
            raise BridgeError(
                "local_request_rejected",
                f"MemoCosmos rejected this request (HTTP {exc.code})",
                retryable=exc.code >= 500 or exc.code in {401, 429},
            ) from None
        except (URLError, TimeoutError, OSError, ValueError):
            raise BridgeError(
                "service_unavailable", "Start the local MemoCosmos service, then retry"
            ) from None

    def call(self, path, data=None):
        bootstrap = self._request("/api/v1/bootstrap")
        token = bootstrap.get("local_token")
        if not isinstance(token, str) or not token:
            raise BridgeError("invalid_response", "Local service did not provide a session token")
        return self._request(path, data, token)
