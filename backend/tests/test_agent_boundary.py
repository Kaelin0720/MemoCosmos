import pytest
from agent_helpers import ScriptedModel, auth, configure, finished, submit
from fastapi.testclient import TestClient
from test_tags import assert_error

from app.core.settings import Settings
from app.main import create_app


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("GET", "/api/v1/agent/status", None),
        (
            "PUT",
            "/api/v1/agent/config",
            {"base_url": "https://example.invalid/v1", "model": "test", "api_key": "key"},
        ),
        ("POST", "/api/v1/conversations", {}),
        ("GET", "/api/v1/conversations", None),
        ("GET", "/api/v1/conversations/missing", None),
        ("GET", "/api/v1/conversations/missing/messages", None),
        (
            "POST",
            "/api/v1/conversations/missing/messages",
            {"client_message_id": "00000000-0000-0000-0000-000000000001", "content": "test"},
        ),
        ("GET", "/api/v1/conversations/missing/runs/by-client-message/missing", None),
        ("GET", "/api/v1/runs/missing", None),
        ("GET", "/api/v1/runs/missing/events", None),
        ("POST", "/api/v1/runs/missing/cancel", {}),
    ],
)
def test_every_agent_endpoint_preserves_local_boundary(client, token_headers, method, path, body):
    assert_error(client.request(method, path, json=body), 401, "invalid_local_token")
    assert_error(
        client.request(
            method, path, json=body, headers={**token_headers, "Origin": "https://evil.example"}
        ),
        403,
        "forbidden_origin",
    )
    assert_error(
        client.request(method, path, json=body, headers={**token_headers, "Host": "evil.example"}),
        400,
        "invalid_host",
    )


def test_settings_put_has_real_cors_preflight(client):
    response = client.options(
        "/api/v1/agent/config",
        headers={
            "Origin": "http://127.0.0.1:3000",
            "Access-Control-Request-Method": "PUT",
            "Access-Control-Request-Headers": "Content-Type, X-Local-Token",
        },
    )
    assert response.status_code == 200
    assert "PUT" in response.headers["access-control-allow-methods"]
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:3000"


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/conversations?limit=0",
        "/api/v1/conversations?limit=101",
        "/api/v1/conversations?offset=-1",
        "/api/v1/conversations/missing/messages?limit=201",
        "/api/v1/conversations/missing/messages?before_seq=0",
    ],
)
def test_pagination_is_bounded(client, token_headers, path):
    assert_error(client.get(path, headers=token_headers), 422, "validation_error")


def test_unknown_runs_are_json_errors_before_sse_headers(client, token_headers):
    response = client.get("/api/v1/runs/missing/events", headers=token_headers)
    assert_error(response, 404, "run_not_found")
    assert response.headers["content-type"].startswith("application/json")


@pytest.mark.parametrize("name", ["task", "read_file", "execute"])
def test_hallucinated_host_tools_are_refused(tmp_path, name):
    model = ScriptedModel(forbidden_tool=name)
    settings = Settings(tmp_path / "memory", tmp_path / "config")
    with TestClient(
        create_app(settings, model_factory=lambda config: model), base_url="http://127.0.0.1:8000"
    ) as client:
        headers = auth(client)
        configure(client, headers)
        conversation = client.post("/api/v1/conversations", headers=headers, json={}).json()["id"]
        run = submit(client, headers, conversation)
        final = finished(client, headers, run["id"])
        assert final["status"] == "failed"
        assert all(
            set(names) == {"list_tags", "search_memory", "read_note"}
            for names in model._bound_names
        )
        items = client.get(
            f"/api/v1/conversations/{conversation}/messages", headers=headers
        ).json()["items"]
        assert items[1]["content"] == ""
