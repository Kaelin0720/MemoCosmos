"""先检查 Host/Origin，再进入路由；CORS 本身不承担访问控制。"""

import re
import secrets
from typing import Annotated

from fastapi import Header, Request
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import Response

from app.core.errors import ApiError, error_response
from app.core.settings import DEVELOPMENT_ORIGINS

LOOPBACK_HOST = re.compile(r"(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?", re.I)


class LocalBoundaryMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        hosts = request.headers.getlist("host")
        match = LOOPBACK_HOST.fullmatch(hosts[0]) if len(hosts) == 1 else None
        if match is None or (match[2] is not None and not 1 <= int(match[2]) <= 65535):
            return error_response(400, "invalid_host", "仅允许通过本机回环地址访问")

        origins = request.headers.getlist("origin")
        same_origin = f"{request.url.scheme}://{hosts[0].lower()}"
        if len(origins) > 1 or (origins and origins[0] not in (*DEVELOPMENT_ORIGINS, same_origin)):
            return error_response(403, "forbidden_origin", "不允许此网页来源访问本机服务")

        response = await call_next(request)
        # Starlette 的无效 CORS 预检默认返回纯文本，转换为共享错误契约。
        if response.status_code == 400 and request.method == "OPTIONS":
            headers = {
                key: value
                for key, value in response.headers.items()
                if key.lower() not in {"content-type", "content-length"}
            }
            response = error_response(422, "validation_error", "预检方法或请求头不受支持")
            response.headers.update(headers)
        return response


def require_local_token(
    request: Request,
    x_local_token: Annotated[str | None, Header(alias="X-Local-Token")] = None,
) -> None:
    values = request.headers.getlist("x-local-token")
    expected = request.app.state.local_token
    if (
        len(values) != 1
        or x_local_token is None
        or not secrets.compare_digest(x_local_token.encode("utf-8"), expected.encode("ascii"))
    ):
        raise ApiError(401, "invalid_local_token", "本机会话令牌缺失或失效，请重新连接")
