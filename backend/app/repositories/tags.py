from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.db.models import Tag


class TagRepository:
    def __init__(self, session: Session):
        self.session = session

    def get(self, tag_id: str) -> Tag | None:
        return self.session.get(Tag, tag_id)

    def by_normalized_name(self, name: str) -> Tag | None:
        return self.session.scalar(select(Tag).where(Tag.normalized_name == name))

    def list(self, query: str | None) -> list[Tag]:
        statement = select(Tag)
        if query and (normalized_query := query.strip().casefold()):
            # instr 是字面子串匹配，% 与 _ 不会被当成 SQL 通配符。
            statement = statement.where(
                or_(
                    func.instr(Tag.normalized_name, normalized_query) > 0,
                    func.instr(func.unicode_casefold(Tag.description), normalized_query) > 0,
                )
            )
        statement = statement.order_by(Tag.created_at.desc(), Tag.id)
        return list(self.session.scalars(statement))
