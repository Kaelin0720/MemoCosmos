from datetime import UTC, datetime
from typing import TYPE_CHECKING
from uuid import uuid4

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import ApiError
from app.db.models import Tag, TagAlias
from app.repositories.tags import TagRepository
from app.schemas.tags import TagCreate, TagUpdate

if TYPE_CHECKING:
    from app.services.notes import NoteService


def utc_timestamp() -> str:
    return datetime.now(UTC).isoformat(timespec="microseconds")


class TagService:
    def __init__(self, session: Session, notes: "NoteService | None" = None):
        self.session = session
        self.repository = TagRepository(session)
        self.notes = notes

    def _commit(self, normalized_name: str) -> None:
        try:
            self.session.commit()
        except IntegrityError:
            self.session.rollback()
            if self.repository.by_normalized_name(normalized_name) is not None:
                raise ApiError(409, "duplicate_tag", "标签名称已存在") from None
            raise

    def create(self, payload: TagCreate) -> Tag:
        if self.notes is not None:
            with self.notes.write_lock:
                return self._create(payload)
        return self._create(payload)

    def _create(self, payload: TagCreate) -> Tag:
        timestamp = utc_timestamp()
        tag = Tag(
            id=str(uuid4()),
            name=payload.name,
            normalized_name=payload.name.casefold(),
            description=payload.description,
            created_by="user",
            created_at=timestamp,
            updated_at=timestamp,
        )
        if self.notes is not None:
            alias = self.session.get(TagAlias, tag.normalized_name)
            if alias is not None:
                self.session.delete(alias)
        self.session.add(tag)
        self._commit(tag.normalized_name)
        return tag

    def update(self, tag_id: str, payload: TagUpdate) -> Tag:
        if self.notes is not None:
            return self.notes.update_tag(tag_id, payload)
        tag = self.repository.get(tag_id)
        if tag is None:
            raise ApiError(404, "tag_not_found", "标签不存在")
        if payload.name is not None:
            tag.name = payload.name
            tag.normalized_name = payload.name.casefold()
        if payload.description is not None:
            tag.description = payload.description
        tag.updated_at = utc_timestamp()
        self._commit(tag.normalized_name)
        return tag

    def delete(self, tag_id: str) -> None:
        if self.notes is not None:
            self.notes.delete_tag(tag_id)
            return
        tag = self.repository.get(tag_id)
        if tag is None:
            raise ApiError(404, "tag_not_found", "标签不存在")
        self.session.delete(tag)
        self.session.commit()
