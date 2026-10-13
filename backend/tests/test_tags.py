from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from uuid import UUID

import pytest


def assert_error(response, status, code):
    assert response.status_code == status
    body = response.json()
    assert set(body) == {"error"}
    assert set(body["error"]) == {"code", "message"}
    assert body["error"]["code"] == code
    assert isinstance(body["error"]["message"], str)


def test_crud_search_and_stable_dates(client, token_headers):
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/api/v1/tags", headers=token_headers).json() == {"items": [], "total": 0}

    response = client.post(
        "/api/v1/tags",
        headers=token_headers,
        json={"name": "  RAG  ", "description": "检索增强生成"},
    )
    assert response.status_code == 201
    created = response.json()
    assert set(created) == {"id", "name", "description", "created_by", "created_at", "updated_at"}
    assert str(UUID(created["id"])) == created["id"]
    assert created["name"] == "RAG"
    assert created["created_by"] == "user"
    assert datetime.fromisoformat(created["created_at"]).utcoffset() == UTC.utcoffset(None)
    assert created["created_at"] == created["updated_at"]
    for query in ["rag", "检索", "  RAG  "]:
        found = client.get("/api/v1/tags", headers=token_headers, params={"q": query}).json()
        assert found == {"items": [created], "total": 1}
    assert (
        client.get("/api/v1/tags", headers=token_headers, params={"q": "不存在"}).json()["total"]
        == 0
    )

    response = client.patch(
        f"/api/v1/tags/{created['id']}",
        headers=token_headers,
        json={"name": "  RAG 检索  ", "description": "更新说明"},
    )
    assert response.status_code == 200
    updated = response.json()
    assert updated["id"] == created["id"]
    assert updated["created_at"] == created["created_at"]
    assert updated["name"] == "RAG 检索"
    assert updated["description"] == "更新说明"
    assert datetime.fromisoformat(updated["updated_at"]) >= datetime.fromisoformat(
        created["created_at"]
    )

    response = client.patch(
        f"/api/v1/tags/{created['id']}", headers=token_headers, json={"description": ""}
    )
    assert response.status_code == 200
    assert response.json()["description"] == ""
    assert response.json()["name"] == "RAG 检索"
    deleted = client.delete(f"/api/v1/tags/{created['id']}", headers=token_headers)
    assert deleted.status_code == 204
    assert deleted.content == b""
    assert client.get("/api/v1/tags", headers=token_headers).json()["total"] == 0
    assert_error(
        client.delete(f"/api/v1/tags/{created['id']}", headers=token_headers), 404, "tag_not_found"
    )


def test_duplicate_create_and_update_are_atomic(client, token_headers):
    first = client.post("/api/v1/tags", headers=token_headers, json={"name": "RAG"}).json()
    second = client.post("/api/v1/tags", headers=token_headers, json={"name": "SQLite"}).json()
    assert first["description"] == ""
    duplicate = client.post("/api/v1/tags", headers=token_headers, json={"name": " rag "})
    assert_error(duplicate, 409, "duplicate_tag")
    duplicate = client.patch(
        f"/api/v1/tags/{second['id']}",
        headers=token_headers,
        json={"name": "rAg", "description": "不能留下部分修改"},
    )
    assert_error(duplicate, 409, "duplicate_tag")
    current = client.get("/api/v1/tags", headers=token_headers, params={"q": "SQLite"}).json()
    assert current == {"items": [second], "total": 1}
    same_name = client.patch(
        f"/api/v1/tags/{first['id']}", headers=token_headers, json={"name": "rag"}
    )
    assert same_name.status_code == 200
    assert same_name.json()["id"] == first["id"]


def test_unicode_casefold_and_literal_search(client, token_headers):
    created = client.post(
        "/api/v1/tags",
        headers=token_headers,
        json={"name": "Straße", "description": "ÄPFEL 100% _"},
    ).json()
    duplicate = client.post("/api/v1/tags", headers=token_headers, json={"name": "STRASSE"})
    assert_error(duplicate, 409, "duplicate_tag")
    for query in ["strasse", "äpfel", "%", "_"]:
        found = client.get("/api/v1/tags", headers=token_headers, params={"q": query}).json()
        assert found == {"items": [created], "total": 1}
    assert (
        client.get("/api/v1/tags", headers=token_headers, params={"q": "%' OR 1=1 --"}).json()[
            "total"
        ]
        == 0
    )


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"name": ""},
        {"name": " \t\n "},
        {"name": "知" * 81},
        {"name": 123},
        {"name": None},
        {"name": "有效", "description": "x" * 1001},
        {"name": "有效", "description": None},
        {"name": "有效", "description": False},
        {"name": "有效", "created_by": "ai"},
        {"name": "有效", "id": "client-id"},
    ],
)
def test_create_validation_rejects_bad_input_without_writes(client, token_headers, payload):
    assert_error(
        client.post("/api/v1/tags", headers=token_headers, json=payload), 422, "validation_error"
    )
    assert client.get("/api/v1/tags", headers=token_headers).json()["total"] == 0


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"name": " "},
        {"name": None},
        {"description": None},
        {"description": "x" * 1001},
        {"created_by": "ai"},
        {"unexpected": "value"},
    ],
)
def test_update_validation_does_not_change_tag(client, token_headers, payload):
    created = client.post("/api/v1/tags", headers=token_headers, json={"name": "原名"}).json()
    response = client.patch(f"/api/v1/tags/{created['id']}", headers=token_headers, json=payload)
    assert_error(response, 422, "validation_error")
    assert client.get("/api/v1/tags", headers=token_headers).json() == {
        "items": [created],
        "total": 1,
    }


def test_boundary_lengths_missing_ids_and_malformed_json(client, token_headers):
    created = client.post(
        "/api/v1/tags",
        headers=token_headers,
        json={"name": " " + "知" * 80 + " ", "description": "x" * 1000},
    )
    assert created.status_code == 201
    missing = client.patch(
        "/api/v1/tags/not-a-real-id", headers=token_headers, json={"name": "新名"}
    )
    assert_error(missing, 404, "tag_not_found")
    invalid_json = client.post(
        "/api/v1/tags", headers={**token_headers, "Content-Type": "application/json"}, content="{"
    )
    assert_error(invalid_json, 422, "validation_error")


def test_concurrent_duplicate_requests_only_create_one_tag(client, token_headers):
    def create(name):
        return client.post("/api/v1/tags", headers=token_headers, json={"name": name})

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(create, ["并发TAG", "并发tag"]))
    assert sorted(response.status_code for response in responses) == [201, 409]
    assert client.get("/api/v1/tags", headers=token_headers).json()["total"] == 1
