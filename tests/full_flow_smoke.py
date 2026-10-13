"""真实本机 HTTP + ChatOpenAI 协议联调；全部数据与凭据为临时测试内容。

运行：backend/.venv/bin/python tests/full_flow_smoke.py
不注入生产回复或更改默认服务，模拟云端只在本次测试期间监听随机端口。
"""

from __future__ import annotations

import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
KEY = "yihe-protocol-test-only-key"
TITLE = "RAG 切片策略"
PROJECT = "项目 A 联网需求"
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def plan(context):
    user = context["user"]
    if "查询" in user:
        return {
            "decision": "skip",
            "reason": "只有查询，没有新增知识。",
            "notes": [],
            "relations": [],
        }
    related = context.get("related_notes", [])
    if "不需要联网" in user:
        target = next(note for note in related if note["title"] == PROJECT)
        return {
            "decision": "confirm",
            "reason": "项目的联网要求有相反变化，需要确认适用范围。",
            "question": "是否确认将项目 A 的当前结论改成不需要联网搜索？",
            "notes": [
                {
                    "title": PROJECT,
                    "note_id": target["note_id"],
                    "expected_version": target["version"],
                    "body": "项目 A 不需要联网搜索。",
                    "replace_text": "项目 A 需要联网搜索。",
                    "mode": "correct",
                    "tags": ["项目"],
                    "evidence": "不需要联网搜索",
                }
            ],
            "relations": [],
        }
    if "适量重叠" in user:
        target = next(note for note in related if note["title"] == TITLE)
        return {
            "decision": "apply",
            "reason": "补充已有主题，保留人工正文。",
            "notes": [
                {
                    "title": TITLE,
                    "note_id": target["note_id"],
                    "expected_version": target["version"],
                    "body": "相邻片段可以增加适量重叠。",
                    "tags": ["RAG"],
                    "evidence": "适量重叠",
                }
            ],
            "relations": [],
        }
    today = context["current_date"][:10]
    return {
        "decision": "apply",
        "reason": "保存知识及用户明确提及的学习经历。",
        "notes": [
            {
                "title": TITLE,
                "folder": "概念/RAG",
                "body": "按标题切片可以保留章节上下文。",
                "tags": ["RAG"],
                "evidence": "按标题切片可以保留章节上下文",
            },
            {
                "title": "学习 RAG 切片",
                "folder": "经历/学习",
                "body": "用户今天学习了 RAG 按标题切片。",
                "tags": ["RAG"],
                "kind": "experience",
                "subject": "self",
                "occurred_on": today,
                "evidence": "我今天学习了 RAG",
            },
        ],
        "relations": [
            {
                "source_index": 1,
                "target_index": 0,
                "relation": "学习",
                "evidence": "我今天学习了 RAG",
            }
        ],
    }


class Provider(BaseHTTPRequestHandler):
    calls = 0
    protocol_version = "HTTP/1.1"

    def log_message(self, _format, *args):
        pass

    def do_POST(self):
        assert self.path == "/v1/chat/completions"
        assert self.headers.get("Authorization") == f"Bearer {KEY}"
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        assert body["model"] == "user-configured-protocol-test"
        Provider.calls += 1
        messages = body["messages"]
        last = messages[-1]
        result, tools = "原始聊天已保存，知识整理会独立显示处理结果。", None
        if "后台记忆整理器" in messages[0]["content"]:
            result = json.dumps(plan(json.loads(last["content"])), ensure_ascii=False)
        elif last["role"] == "tool":
            data = json.loads(last["content"])
            if data.get("items") and "note_id" in data["items"][0]:
                note = next(note for note in data["items"] if note["title"] == TITLE)
                result = (
                    f"已找到 [{note['title']}](yihe://notes/{note['note_id']})：{note['excerpt']}"
                )
            else:
                tags = data.get("items", [])
                tools = {
                    "name": "search_memory",
                    "arguments": json.dumps(
                        {"q": "切片", "tag_ids": [tag["id"] for tag in tags[:1]], "limit": 8},
                        ensure_ascii=False,
                    ),
                }
        elif "查询" in str(last.get("content", "")):
            tools = {"name": "list_tags", "arguments": '{"query":"RAG","limit":10}'}
        if not body.get("stream"):
            payload = json.dumps(
                {
                    "id": "protocol-test",
                    "object": "chat.completion",
                    "created": 1,
                    "model": body["model"],
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": result},
                            "finish_reason": "stop",
                        }
                    ],
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
        else:
            frames = []

            def frame(delta, finish=None):
                frames.append(
                    "data: "
                    + json.dumps(
                        {
                            "id": "protocol-test",
                            "object": "chat.completion.chunk",
                            "created": 1,
                            "model": body["model"],
                            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
                        },
                        ensure_ascii=False,
                    )
                    + "\n\n"
                )

            if tools:
                frame(
                    {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": f"call_{uuid4().hex}",
                                "type": "function",
                                "function": tools,
                            }
                        ]
                    }
                )
            else:
                for offset in range(0, len(result), 64):
                    frame({"content": result[offset : offset + 64]})
            frame({}, "tool_calls" if tools else "stop")
            frames.append("data: [DONE]\n\n")
            payload = "".join(frames).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        self.wfile.flush()


def random_port():
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        return reservation.getsockname()[1]


class Client:
    def __init__(self, base):
        self.base, self.token = base, None

    def request(self, path, method="GET", data=None, binary=False):
        headers = {"X-Local-Token": self.token} if self.token else {}
        if data is not None:
            headers["Content-Type"] = "application/octet-stream" if binary else "application/json"
            data = data if binary else json.dumps(data, ensure_ascii=False).encode()
        url = self.base + urllib.parse.quote(path, safe="/?=&%,")
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        with opener.open(request, timeout=10) as response:
            content = response.read()
            if response.headers.get_content_type() == "application/zip":
                return content
            return json.loads(content) if content else None

    def wait(self, fetch, complete, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = fetch()
            if complete(result):
                return result
            time.sleep(0.1)
        raise AssertionError("Temporary HTTP flow did not reach the expected persistent state.")

    def chat(self, conversation, content):
        run = self.request(
            f"/api/v1/conversations/{conversation}/messages",
            "POST",
            {"client_message_id": str(uuid4()), "content": content},
        )
        result = self.wait(
            lambda: self.request(f"/api/v1/runs/{run['id']}"),
            lambda value: value["status"] not in ("pending", "running"),
        )
        assert result["status"] == "completed", result.get("error")
        return run["id"]

    def job(self, run, expected="completed"):
        result = self.wait(
            lambda: next(
                (
                    job
                    for job in self.request("/api/v1/memory/jobs")["items"]
                    if job["run_id"] == run
                ),
                None,
            ),
            lambda value: value is not None and value["status"] not in ("pending", "running"),
        )
        assert result["status"] == expected, {k: result[k] for k in ("status", "reason", "error")}
        return result


def start(vault, config, port, log):
    environment = os.environ.copy()
    for name in tuple(environment):
        if name.startswith("CHAT_MODEL_"):
            environment.pop(name)
    environment.update(YIHE_MEMORY_DIR=str(vault), YIHE_CONFIG_DIR=str(config))
    command = [
        sys.executable,
        "-m",
        "uvicorn",
        "app.main:app",
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
    ]
    if environment.get("YIHE_SMOKE_DIAGNOSTICS") == "1":
        diagnostic = """
import sys, traceback, uvicorn
from app.services.memory_jobs import MemoryJobs
for name in ('_context','_guard','_apply'):
    original = getattr(MemoryJobs,name)
    def wrapped(*args,_method=original,**kwargs):
        try: return _method(*args,**kwargs)
        except Exception:
            traceback.print_exc()
            raise
    setattr(MemoryJobs,name,wrapped)
original_plan = MemoryJobs._plan
async def wrapped_plan(*args,**kwargs):
    try: return await original_plan(*args,**kwargs)
    except Exception:
        traceback.print_exc()
        raise
MemoryJobs._plan = wrapped_plan
uvicorn.run('app.main:app',host='127.0.0.1',port=int(sys.argv[1]))
"""
        command = [sys.executable, "-c", diagnostic, str(port)]
    process = subprocess.Popen(
        command,
        cwd=ROOT / "backend",
        env=environment,
        stdout=log,
        stderr=log,
    )
    client = Client(f"http://127.0.0.1:{port}")
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            client.token = client.request("/api/v1/bootstrap")["local_token"]
            return process, client
        except (urllib.error.URLError, TimeoutError):
            if process.poll() is not None:
                break
            time.sleep(0.1)
    process.terminate()
    process.wait(timeout=10)
    raise AssertionError("Temporary backend failed to start.")


def main():
    provider = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    process = None
    try:
        with tempfile.TemporaryDirectory(prefix="yihe-full-http-") as directory:
            base = Path(directory).resolve()
            vault, config = base / "memory", base / "config"
            port = random_port()
            with (base / "backend.log").open("wb") as log:
                process, client = start(vault, config, port, log)
                client.request(
                    "/api/v1/agent/config",
                    "PUT",
                    {
                        "base_url": f"http://127.0.0.1:{provider.server_port}/v1",
                        "model": "user-configured-protocol-test",
                        "api_key": KEY,
                    },
                )
                conversation = client.request("/api/v1/conversations", "POST", {})["id"]
                run = client.chat(
                    conversation, "我今天学习了 RAG：按标题切片可以保留章节上下文。请整理到知识库。"
                )
                try:
                    client.job(run)
                except AssertionError:
                    if os.environ.get("YIHE_SMOKE_DIAGNOSTICS") == "1":
                        log.flush()
                        print((base / "backend.log").read_text()[-4000:])
                    raise
                notes = client.request("/api/v1/notes")["items"]
                assert len(notes) == 2
                note = next(note for note in notes if note["title"] == TITLE)
                note = client.request(f"/api/v1/notes/{note['id']}")
                tag = next(tag for tag in note["tags"] if tag["name"] == "RAG")["id"]
                assert client.request("/api/v1/memory/graph")["edges"]
                marker = "保留这个人工句子：切片时要保留标题。"
                note = client.request(
                    f"/api/v1/notes/{note['id']}",
                    "PATCH",
                    {
                        "expected_version": note["version"],
                        "body": note["body"] + "\n\n" + marker,
                        "folder": note["folder"],
                        "tag_ids": [t["id"] for t in note["tags"]],
                    },
                )
                run = client.chat(conversation, "补充 RAG 切片策略：相邻片段可以增加适量重叠。")
                client.job(run)
                current = client.request(f"/api/v1/notes/{note['id']}")
                assert marker in current["body"] and "适量重叠" in current["body"]
                assert len(client.request("/api/v1/notes")["items"]) == 2
                assert client.request(f"/api/v1/memory/search?q=切片&tag_ids={tag}")["items"]
                run = client.chat(conversation, "查询我的 RAG 切片策略知识。")
                client.job(run, "skipped")
                messages = client.request(f"/api/v1/conversations/{conversation}/messages")["items"]
                reply = next(
                    message["content"]
                    for message in messages
                    if message.get("run_id") == run and message["role"] == "assistant"
                )
                assert f"yihe://notes/{note['id']}" in reply
                project_tag = client.request(
                    "/api/v1/tags", "POST", {"name": "项目", "description": "临时联调"}
                )["id"]
                project = client.request(
                    "/api/v1/notes",
                    "POST",
                    {
                        "title": PROJECT,
                        "body": "项目 A 需要联网搜索。\n\n保留项目的人工说明。",
                        "tag_ids": [project_tag],
                        "folder": "项目",
                    },
                )
                run = client.chat(
                    conversation, "项目 A 现在不需要联网搜索。之前的适用范围还没说清楚。"
                )
                job = client.job(run, "needs_confirmation")
                client.request(
                    f"/api/v1/memory/jobs/{job['id']}/resolve", "POST", {"action": "confirm"}
                )
                client.job(run)
                current = client.request(f"/api/v1/notes/{project['id']}")
                assert "项目 A 不需要联网搜索。" in current["body"]
                assert "项目 A 需要联网搜索。" not in current["body"]
                assert "保留项目的人工说明。" in current["body"]
                before = client.request("/api/v1/notes")["items"]
                archive = client.request("/api/v1/memory/export")
                with zipfile.ZipFile(io.BytesIO(archive)) as packed:
                    assert all(KEY.encode() not in packed.read(name) for name in packed.namelist())
                restored = client.request("/api/v1/memory/import", "POST", archive, binary=True)
                restored_path = Path(restored["memory_dir"])
                assert restored_path.is_relative_to(base) and restored_path != vault
                assert restored["requires_restart"] is True
                calls = Provider.calls
                process.terminate()
                process.wait(timeout=10)
                process, client = start(restored_path, config, port, log)
                after = client.request("/api/v1/notes")["items"]
                assert {note["id"] for note in before} == {note["id"] for note in after}
                assert client.request(f"/api/v1/notes/{project['id']}")["body"] == current["body"]
                assert client.request("/api/v1/memory/graph")["nodes"]
                assert Provider.calls == calls, "Restore replayed a model request."
                print(
                    "Full real HTTP flow OK: configured protocol, automatic notes, tags, "
                    "evidence graph, manual edits, retrieval/tools/citations, confirmation, "
                    "ZIP restore, no key export or model replay."
                )
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
        provider.shutdown()
        provider.server_close()


if __name__ == "__main__":
    main()
