from datetime import datetime
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class NoteCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    title: str = Field(min_length=1, max_length=200)
    body: str = Field(max_length=200000)
    tag_ids: list[str] = Field(min_length=1, max_length=64)
    source: str = Field(default="", max_length=2000)
    folder: str = Field(default="", max_length=240)

    @field_validator("title", mode="before")
    @classmethod
    def trim_title(cls, value):
        return value.strip() if isinstance(value, str) else value

    @field_validator("title")
    @classmethod
    def one_line(cls, value: str) -> str:
        if len(value.splitlines()) != 1:
            raise ValueError("标题必须是单行")
        return value

    @field_validator("title", "body", "source", "folder")
    @classmethod
    def utf8_text(cls, value: str) -> str:
        if "\0" in value:
            raise ValueError("文本不能包含 NUL")
        value.encode("utf-8")
        return value

    @field_validator("folder")
    @classmethod
    def safe_folder(cls, value: str) -> str:
        return validate_folder(value)


def validate_folder(value: str) -> str:
    if not value:
        return value
    parts = value.split("/")
    if (
        len(parts) > 8
        or len(value) > 240
        or "\\" in value
        or any(ord(char) < 32 or ord(char) == 127 for char in value)
        or any(not part or part in (".", "..") or len(part) > 80 for part in parts)
    ):
        raise ValueError("目录必须是最多八层的逻辑相对路径")
    value.encode("utf-8")
    return value


class NoteUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expected_version: int = Field(gt=0)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    body: str | None = Field(default=None, max_length=200000)
    tag_ids: list[str] | None = Field(default=None, max_length=64)
    source: str | None = Field(default=None, max_length=2000)
    folder: str | None = Field(default=None, max_length=240)

    @field_validator("title", "body", "tag_ids", "source", "folder", mode="before")
    @classmethod
    def provided(cls, value):
        if value is None:
            raise ValueError("显式 null 不合法")
        return value

    @model_validator(mode="after")
    def validate_changes(self) -> Self:
        changes = self.model_fields_set - {"expected_version"}
        if not changes:
            raise ValueError("至少一个变更字段")
        if self.title is not None:
            self.title = self.title.strip()
            if not self.title or len(self.title.splitlines()) != 1:
                raise ValueError("标题必须是单行")
        for value in (self.title, self.body, self.source, self.folder):
            if value is not None:
                NoteCreate.utf8_text(value)
        if self.folder is not None:
            validate_folder(self.folder)
        return self


class ExternalImport(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expected_version: int = Field(gt=0)
    file_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


class NoteDelete(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expected_version: int = Field(gt=0)


class NoteTagView(BaseModel):
    id: str
    name: str


class NoteSyncError(BaseModel):
    code: str
    message: str
    retryable: bool


class NoteSummary(BaseModel):
    id: str
    title: str
    tags: list[NoteTagView]
    source: str
    created_at: datetime
    updated_at: datetime
    version: int
    sync_status: Literal["synced", "pending", "conflict"]
    sync_error: NoteSyncError | None
    folder: str = ""


class NoteDetail(NoteSummary):
    body: str


class NoteList(BaseModel):
    items: list[NoteSummary]
    total: int
