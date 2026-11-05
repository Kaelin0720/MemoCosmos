"""Durable, idempotent ingestion of completed turns from other agent hosts."""

import json
from datetime import UTC, datetime
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy import select

from app.core.errors import ApiError
from app.db.models import AgentRun, Conversation, ExternalTurn, MemoryJob, Message
from app.services.tags import utc_timestamp
from app.vault.topic_files import digest


def identity(*parts):
    return str(uuid5(NAMESPACE_URL, "memocosmos:external:" + json.dumps(parts)))


class ExternalMemory:
    def __init__(self, jobs):
        self.jobs, self.notes = jobs, jobs.notes

    def ingest(self, payload):
        identifier = identity(payload.source, payload.session_id, payload.turn_id)
        fingerprint = digest(payload.model_dump_json().encode("utf-8"))
        with self.notes.lock, self.notes._writing() as session:
            previous = session.get(ExternalTurn, identifier)
            if previous:
                if previous.content_hash != fingerprint:
                    raise ApiError(
                        409, "capture_conflict", "同一来源轮次已保存不同内容，请使用新的轮次标识"
                    )
                job_id = session.scalar(
                    select(MemoryJob.id).where(MemoryJob.run_id == previous.run_id)
                )
                return dict(capture_id=identifier, job_id=job_id, duplicate=True, status="accepted")
            if not self.jobs.should_capture(session, payload.user):
                return dict(capture_id=None, job_id=None, duplicate=False, status="disabled")
            timestamp = utc_timestamp()
            source_time = (
                datetime.fromisoformat(payload.occurred_at)
                .astimezone(UTC)
                .isoformat(timespec="microseconds")
                if payload.occurred_at
                else timestamp
            )
            config = self.jobs.config_store.snapshot().config
            user, assistant = (
                self.jobs._safe(payload.user, config),
                self.jobs._safe(payload.assistant, config),
            )
            conversation_id = identity(payload.source, payload.session_id)
            conversation = session.get(Conversation, conversation_id)
            if conversation is None:
                conversation = Conversation(
                    id=conversation_id,
                    title=f"{payload.source} · {user[:70]}",
                    created_at=timestamp,
                    updated_at=timestamp,
                    last_seq=0,
                )
                session.add(conversation)
                session.flush()
            run_id = identity(identifier, "run")
            user_id, assistant_id = identity(identifier, "user"), identity(identifier, "assistant")
            run = AgentRun(
                id=run_id,
                conversation_id=conversation_id,
                client_message_id=identifier,
                user_message_id=user_id,
                assistant_message_id=assistant_id,
                status="completed",
                context_truncated=payload.truncated,
                created_at=timestamp,
                updated_at=timestamp,
            )
            session.add(run)
            session.flush()
            for offset, role, message_id, content in (
                (1, "user", user_id, user),
                (2, "assistant", assistant_id, assistant),
            ):
                session.add(
                    Message(
                        id=message_id,
                        conversation_id=conversation_id,
                        seq=conversation.last_seq + offset,
                        role=role,
                        content=content,
                        status="completed",
                        run_id=run_id,
                        created_at=source_time,
                        updated_at=timestamp,
                    )
                )
            conversation.last_seq += 2
            conversation.updated_at = timestamp
            session.add(
                ExternalTurn(
                    id=identifier,
                    source=payload.source,
                    session_id=payload.session_id,
                    turn_id=payload.turn_id,
                    run_id=run_id,
                    content_hash=fingerprint,
                    truncated=payload.truncated,
                    captured_at=timestamp,
                )
            )
            session.flush()
            job_id = self.jobs.enqueue(session, run)
            session.commit()
        self.jobs._notify()
        return dict(capture_id=identifier, job_id=job_id, duplicate=False, status="accepted")
