from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

RunStatus = Literal["pending", "running", "completed", "cancelled", "failed", "interrupted"]


class EmptyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class MessageCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    client_message_id: str
    content: str = Field(min_length=1, max_length=20000)

    @field_validator("client_message_id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        return str(UUID(value))

    @field_validator("content")
    @classmethod
    def validate_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("消息不能为空")
        value.encode("utf-8")
        return value


class ConversationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    created_at: datetime
    updated_at: datetime
    active_run_id: str | None


class ConversationList(BaseModel):
    items: list[ConversationResponse]
    total: int


class MessageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    conversation_id: str
    seq: int
    role: Literal["user", "assistant"]
    content: str
    status: RunStatus
    run_id: str
    created_at: datetime
    updated_at: datetime


class MessageList(BaseModel):
    items: list[MessageResponse]
    has_more: bool


class RunError(BaseModel):
    code: str
    message: str


class RunResponse(BaseModel):
    id: str
    conversation_id: str
    client_message_id: str
    user_message_id: str
    assistant_message_id: str
    status: RunStatus
    error: RunError | None
    context_truncated: bool
    created_at: datetime
    updated_at: datetime
