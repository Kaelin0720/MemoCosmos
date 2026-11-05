"""Capture documented Codex events into a private, durable local outbox."""

import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

from app.integrations.client import BridgeError, LocalClient

MAX_INPUT = 2 * 1024 * 1024


class CaptureQueue:
    def __init__(self, directory):
        if os.name != "posix" or not hasattr(os, "O_NOFOLLOW"):
            raise ValueError("Capture requires POSIX private-file storage; use WSL2 on Windows")
        directory = Path(directory)
        if directory.is_symlink():
            raise ValueError("Capture directory cannot be a symbolic link")
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = directory / "capture.sqlite"
        if self.path.is_symlink():
            raise ValueError("Capture database cannot be a symbolic link")
        descriptor = os.open(self.path, os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        os.close(descriptor)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute(
                "CREATE TABLE IF NOT EXISTS prompts (session TEXT, turn TEXT, prompt TEXT, "
                "occurred_at TEXT, truncated INTEGER, PRIMARY KEY(session, turn))"
            )
            db.execute(
                "CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, payload TEXT, "
                "status TEXT NOT NULL, error TEXT)"
            )
            # Prompt buffers support revised completions, but are not a vault.
            cutoff = (datetime.now(UTC) - timedelta(days=7)).isoformat()
            db.execute("DELETE FROM prompts WHERE occurred_at < ?", (cutoff,))

    def connect(self):
        return sqlite3.connect(self.path, timeout=3)

    def receive(self, event):
        if not isinstance(event, dict):
            raise ValueError("Capture event must be an object")
        name, session, turn = (
            event.get("hook_event_name"),
            event.get("session_id"),
            event.get("turn_id"),
        )
        if name == "SessionStart":
            return
        if not all(isinstance(value, str) and 0 < len(value) <= 200 for value in (session, turn)):
            raise ValueError("Codex event must include session_id and turn_id")
        with self.connect() as db:
            if name == "UserPromptSubmit":
                prompt = event.get("prompt")
                if isinstance(prompt, str) and prompt.strip():
                    db.execute(
                        "INSERT OR IGNORE INTO prompts VALUES (?,?,?,?,?)",
                        (
                            session,
                            turn,
                            prompt[:20000],
                            datetime.now(UTC).isoformat(),
                            len(prompt) > 20000,
                        ),
                    )
            elif name == "Interrupt":
                db.execute("DELETE FROM prompts WHERE session=? AND turn=?", (session, turn))
            elif name == "Stop":
                assistant = event.get("last_assistant_message")
                prompt = db.execute(
                    "SELECT prompt,occurred_at,truncated FROM prompts WHERE session=? AND turn=?",
                    (session, turn),
                ).fetchone()
                if prompt is None or not isinstance(assistant, str) or not assistant.strip():
                    return
                # Replayed Stop events share an identity. A revised completion
                # has a new identity while retaining its original turn prefix.
                revision = hashlib.sha256(assistant.encode()).hexdigest()[:24]
                source_turn = f"{turn[:170]}:{revision}"
                payload = dict(
                    source="codex",
                    session_id=session,
                    turn_id=source_turn,
                    user=prompt[0],
                    assistant=assistant[:20000],
                    occurred_at=prompt[1],
                    truncated=bool(prompt[2] or len(assistant) > 20000),
                )
                key = hashlib.sha256(json.dumps([session, source_turn]).encode()).hexdigest()
                db.execute(
                    "INSERT OR IGNORE INTO outbox VALUES (?,?,'pending',NULL)",
                    (key, json.dumps(payload, ensure_ascii=False)),
                )
            else:
                raise ValueError("Unsupported capture event")

    def flush(self, client, limit=20):
        delivered = 0
        with self.connect() as db:
            pending = db.execute(
                "SELECT id,payload FROM outbox WHERE status='pending' ORDER BY rowid LIMIT ?",
                (limit,),
            ).fetchall()
        for identifier, raw in pending:
            try:
                result = client.call("/api/v1/integrations/turns", json.loads(raw))
                if result.get("status") not in {"accepted", "disabled"}:
                    raise BridgeError("invalid_response", "Capture was not acknowledged")
            except BridgeError as exc:
                with self.connect() as db:
                    db.execute(
                        "UPDATE outbox SET status=?,error=? WHERE id=?",
                        ("pending" if exc.retryable else "blocked", exc.code, identifier),
                    )
                if exc.retryable:
                    break
            else:
                with self.connect() as db:
                    # Keep only the receipt after acknowledgement, not another
                    # long-term copy of the conversation text.
                    db.execute(
                        "UPDATE outbox SET payload=NULL,status='delivered',error=NULL WHERE id=?",
                        (identifier,),
                    )
                delivered += 1
        return dict(sent=delivered, **self.status())

    def status(self):
        with self.connect() as db:
            counts = dict(
                db.execute("SELECT status,count(*) FROM outbox GROUP BY status").fetchall()
            )
        return {status: counts.get(status, 0) for status in ("pending", "delivered", "blocked")}


def spawn_flush(directory, url):
    env = dict(os.environ)
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[2])
    subprocess.Popen(
        [
            sys.executable,
            "-m",
            "app.integrations.codex_hook",
            "flush",
            "--data-dir",
            str(directory),
            "--url",
            url,
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        env=env,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["hook", "flush", "status"])
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    args = parser.parse_args()
    try:
        client = LocalClient(args.url, timeout=2)
        queue = CaptureQueue(args.data_dir)
        if args.action == "hook":
            raw = sys.stdin.read(MAX_INPUT + 1)
            if len(raw) > MAX_INPUT:
                raise ValueError("Capture event exceeded its input limit")
            event = json.loads(raw)
            queue.receive(event)
            spawn_flush(args.data_dir, args.url)
            print("{}")
        elif args.action == "flush":
            print(json.dumps(queue.flush(client)))
        else:
            print(json.dumps(queue.status()))
    except (ValueError, OSError, sqlite3.Error, BridgeError):
        if args.action == "hook":
            print(
                json.dumps(
                    dict(systemMessage="MemoCosmos 未完成本轮采集，请检查本地插件配置和待发送队列")
                )
            )
        else:
            print(
                "MemoCosmos capture queue is unavailable; check the local configuration",
                file=sys.stderr,
            )
            raise SystemExit(1) from None


if __name__ == "__main__":
    main()
