from datetime import datetime
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator, model_validator

TagName = Annotated[str, Field(min_length=1, max_length=80)]
TagDescription = Annotated[str, Field(max_length=1000)]


def valid_text(value: str) -> str:
    if "\0" in value:
        raise ValueError("标签文本不能包含 NUL")
    value.encode("utf-8")
    return value


class TagCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    name: TagName
    description: TagDescription = ""

    @field_validator("name", mode="before")
    @classmethod
    def trim_name(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("name", "description")
    @classmethod
    def utf8_text(cls, value: str) -> str:
        return valid_text(value)


class TagUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    name: TagName | None = None
    description: TagDescription | None = None

    @field_validator("name", "description", mode="before")
    @classmethod
    def check_provided_value(cls, value: object, info: ValidationInfo) -> object:
        # 未提供字段使用默认 None；显式 null 不是合法的字段修改。
        if value is None:
            raise ValueError("字段不能为 null")
        if info.field_name == "name" and isinstance(value, str):
            return value.strip()
        return value

    @field_validator("name", "description")
    @classmethod
    def utf8_text(cls, value: str) -> str:
        return valid_text(value)

    @model_validator(mode="after")
    def require_changes(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("至少提供 name 或 description")
        return self


class TagResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    description: str
    created_by: Literal["user", "ai"]
    created_at: datetime
    updated_at: datetime


class TagListResponse(BaseModel):
    items: list[TagResponse]
    total: int
