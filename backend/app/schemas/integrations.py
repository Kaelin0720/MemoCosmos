from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import Field, field_validator

from app.schemas.memory import StrictModel


class CaptureTurn(StrictModel):
    source: str = Field(min_length=1, max_length=64, pattern=r"^[a-z][a-z0-9._-]*$")
    session_id: str = Field(min_length=1, max_length=200)
    turn_id: str = Field(min_length=1, max_length=200)
    user: str = Field(min_length=1, max_length=20000)
    assistant: str = Field(min_length=1, max_length=20000)
    occurred_at: str | None = None
    truncated: bool = False

    @field_validator("session_id", "turn_id", "user", "assistant")
    @classmethod
    def valid_text(cls, value):
        value.encode("utf-8")
        if not value.strip() or "\0" in value:
            raise ValueError("invalid text")
        return value

    @field_validator("occurred_at")
    @classmethod
    def valid_timestamp(cls, value):
        if value is not None:
            parsed = datetime.fromisoformat(value)
            if parsed.tzinfo is None:
                raise ValueError("source timestamp needs a timezone")
        return value


class RecallRequest(StrictModel):
    tool: Literal["search_memory", "read_note", "explore_memory_graph", "list_tags"]
    arguments: dict = Field(default_factory=dict)
    retrieval_id: str | None = None

    @field_validator("retrieval_id")
    @classmethod
    def valid_id(cls, value):
        return str(UUID(value)) if value is not None else None
