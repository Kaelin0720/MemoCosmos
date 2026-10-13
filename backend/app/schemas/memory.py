"""后台规划的严格边界和公开设置请求。"""

from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.notes import validate_folder


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class MemorySettings(StrictModel):
    auto_memory: bool


class JobResolve(StrictModel):
    action: Literal["confirm", "dismiss"]
    clarification: str = Field(default="", max_length=4000)


class EmptyRequest(StrictModel):
    pass


class PlannedNote(StrictModel):
    note_id: str | None = None
    expected_version: int | None = Field(default=None, gt=0)
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=12000)
    folder: str = Field(default="", max_length=240)
    source: str = Field(default="", max_length=2000)
    tags: list[str] = Field(default_factory=list, max_length=8)
    kind: Literal["knowledge", "experience", "generated"] = "knowledge"
    subject: Literal["self", "other", "general"] = "general"
    state: Literal["fact", "planned", "negated", "uncertain"] = "fact"
    evidence: str = Field(default="", max_length=1000)
    occurred_on: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    period_start: str | None = None
    period_end: str | None = None
    mode: Literal["append", "correct"] = "append"
    replace_text: str = Field(default="", max_length=12000)

    @field_validator("occurred_on", "period_start", "period_end")
    @classmethod
    def event_date(cls, value):
        if value is not None:
            date.fromisoformat(value)
        return value

    @field_validator("folder")
    @classmethod
    def folder_path(cls, value):
        return validate_folder(value)

    @field_validator("title", "body", "source", "evidence")
    @classmethod
    def utf8(cls, value):
        value.encode("utf-8")
        if "\0" in value:
            raise ValueError("invalid text")
        return value

    @field_validator("tags")
    @classmethod
    def tag_names(cls, values):
        if any(not v.strip() or len(v) > 80 or "\0" in v for v in values):
            raise ValueError("invalid tags")
        return [v.strip() for v in values]


class PlannedRelation(StrictModel):
    source_index: int = Field(ge=0, le=7)
    target_index: int = Field(ge=0, le=7)
    relation: str = Field(min_length=1, max_length=80)
    evidence: str = Field(min_length=1, max_length=1000)


class MemoryPlan(StrictModel):
    decision: Literal["apply", "skip", "confirm"]
    reason: str = Field(min_length=1, max_length=2000)
    question: str = Field(default="", max_length=1000)
    notes: list[PlannedNote] = Field(default_factory=list, max_length=8)
    relations: list[PlannedRelation] = Field(default_factory=list, max_length=30)
