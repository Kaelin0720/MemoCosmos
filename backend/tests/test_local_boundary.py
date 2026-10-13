import pytest
from test_tags import assert_error


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("GET", "/api/v1/tags", None),
        ("POST", "/api/v1/tags", {"name": "不能创建"}),
        ("PATCH", "/api/v1/tags/missing", {"name": "不能修改"}),
        ("DELETE", "/api/v1/tags/missing", None),
    ],
)
def test_all_tag_operations_require_token(client, method, path, body):
    assert_error(client.request(method, path, json=body), 401, "invalid_local_token")
    assert_error(
        client.request(method, path, json=body, headers={"X-Local-Token": "wrong"}),
        401,
        "invalid_local_token",
    )


@pytest.mark.parametrize("path", ["/health", "/api/v1/bootstrap", "/api/v1/tags"])
@pytest.mark.parametrize("origin", ["https://evil.example", "http://localhost:3001", "null"])
def test_origin_boundary_also_protects_bootstrap(client, token_headers, path, origin):
    response = client.get(path, headers={**token_headers, "Origin": origin})
    assert_error(response, 403, "forbidden_origin")
    assert "access-control-allow-origin" not in response.headers


@pytest.mark.parametrize(
    "host",
    [
        "evil.example:8000",
        "localhost.evil.example",
        "127.0.0.1.evil.example",
        "evil@localhost",
        "localhost:0",
        "localhost:65536",
        "localhost:not-a-port",
    ],
)
def test_host_boundary_rejects_rebinding_hosts(client, host):
    assert_error(client.get("/api/v1/bootstrap", headers={"Host": host}), 400, "invalid_host")


@pytest.mark.parametrize(
    "origin", ["http://127.0.0.1:3000", "http://localhost:3000", "http://127.0.0.1:8000"]
)
def test_allowed_origins_receive_cors_and_token_errors(client, origin):
    bootstrap = client.get("/api/v1/bootstrap", headers={"Origin": origin})
    assert bootstrap.status_code == 200
    assert bootstrap.headers["cache-control"] == "no-store"
    assert bootstrap.headers["access-control-allow-origin"] == origin
    unauthorized = client.get("/api/v1/tags", headers={"Origin": origin})
    assert_error(unauthorized, 401, "invalid_local_token")
    assert unauthorized.headers["access-control-allow-origin"] == origin


def test_preflight_checks_boundary_and_accepts_tag_headers(client):
    headers = {
        "Origin": "http://127.0.0.1:3000",
        "Access-Control-Request-Method": "PATCH",
        "Access-Control-Request-Headers": "Content-Type, X-Local-Token",
    }
    response = client.options("/api/v1/tags/example", headers=headers)
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == headers["Origin"]
    assert "x-local-token" in response.headers["access-control-allow-headers"].lower()
    assert_error(
        client.options("/api/v1/tags", headers={**headers, "Origin": "https://evil.example"}),
        403,
        "forbidden_origin",
    )
    invalid_preflight = client.options(
        "/api/v1/tags", headers={**headers, "Access-Control-Request-Method": "TRACE"}
    )
    assert_error(invalid_preflight, 422, "validation_error")


def test_duplicate_host_origin_and_token_headers_are_rejected(client, token_headers):
    assert_error(
        client.get("/health", headers=[("Host", "localhost"), ("Host", "evil.example")]),
        400,
        "invalid_host",
    )
    assert_error(
        client.get(
            "/api/v1/bootstrap",
            headers=[("Origin", "http://localhost:3000"), ("Origin", "https://evil.example")],
        ),
        403,
        "forbidden_origin",
    )
    token = token_headers["X-Local-Token"]
    response = client.get(
        "/api/v1/tags", headers=[("X-Local-Token", token), ("X-Local-Token", token)]
    )
    assert_error(response, 401, "invalid_local_token")


def test_http_errors_use_common_envelope(client):
    assert_error(client.get("/unknown"), 404, "http_error")
    assert_error(client.post("/health"), 405, "http_error")
