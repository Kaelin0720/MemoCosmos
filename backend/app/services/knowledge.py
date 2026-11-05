"""已确认版本的本地章节索引与可追溯关系；不调用云端。"""

import json
import re
from datetime import datetime
from uuid import uuid4

from sqlalchemy import Text, case, cast, delete, func, or_, select, true, update

from app.core.errors import ApiError
from app.core.time import local_zone
from app.db.models import MemoryJob, MemoryRelation, MemorySetting, Note, NoteSection, NoteVersion

LINK = re.compile(r"(?:\./|yihe://notes/)([a-f0-9-]{36})(?:\.md)?")
DATE = re.compile(r"(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)")


def local_date(timestamp: str) -> str:
    return datetime.fromisoformat(timestamp).astimezone(local_zone()).date().isoformat()


def sections(title: str, body: str, recorded: str):
    heading, content = title, []
    result = []
    for line in body.splitlines():
        match = re.match(r"^#{1,6}\s+(.+)$", line)
        if match:
            if content:
                result.append((heading, "\n".join(content)))
            heading, content = match[1][:400], []
        else:
            content.append(line)
    if content or not result:
        result.append((heading, "\n".join(content)))
    for position, (heading, text) in enumerate(result):
        event = None
        match = DATE.search(heading)
        if match and "记录日期" not in heading:
            try:
                event = datetime.strptime(match[1], "%Y-%m-%d").date().isoformat()
            except ValueError:
                pass
        recorded_match = DATE.search(heading) if "记录日期" in heading else None
        yield position, heading, text, event, recorded_match[1] if recorded_match else recorded


def record_confirmation(session, note, body, tags, origin="manual"):
    if session.get(NoteVersion, (note.id, note.version)) is None:
        session.add(
            NoteVersion(
                note_id=note.id,
                version=note.version,
                title=note.title,
                body=body,
                folder=note.folder,
                source=note.source,
                tags_json=json.dumps(tags, ensure_ascii=False),
                file_hash=note.confirmed_hash,
                created_at=note.updated_at,
                origin=origin,
            )
        )
    session.execute(delete(NoteSection).where(NoteSection.note_id == note.id))
    for position, heading, content, event, recorded in sections(
        note.title, body, local_date(note.created_at)
    ):
        session.add(
            NoteSection(
                note_id=note.id,
                position=position,
                version=note.version,
                heading=heading,
                body=content,
                event_date=event,
                event_end_date=(
                    DATE.findall(heading)[1] if event and len(DATE.findall(heading)) > 1 else event
                ),
                recorded_date=recorded,
            )
        )
    session.execute(
        update(MemoryRelation)
        .where(
            (MemoryRelation.source == note.id)
            | ((MemoryRelation.target == note.id) & (MemoryRelation.kind == "fact"))
        )
        .values(active=False)
    )
    session.execute(
        update(MemoryRelation)
        .where(
            MemoryRelation.target == note.id,
            MemoryRelation.kind == "reference",
            MemoryRelation.active.is_(True),
        )
        .values(target_version=note.version)
    )
    for target_id in set(LINK.findall(body)):
        target = session.get(Note, target_id)
        if target and target.id != note.id and target.sync_status == "synced":
            session.add(
                MemoryRelation(
                    id=str(uuid4()),
                    source=note.id,
                    target=target.id,
                    source_version=note.version,
                    target_version=target.version,
                    relation="引用",
                    kind="reference",
                    evidence=f"已确认笔记版本 {note.version} 中的文档链接",
                    source_message_id=None,
                    active=True,
                    created_at=note.updated_at,
                )
            )
    session.execute(
        update(MemorySetting)
        .where(MemorySetting.id == 1)
        .values(index_revision=MemorySetting.index_revision + 1)
    )


class KnowledgeService:
    def __init__(self, notes):
        self.notes = notes
        self.sessions = notes.sessions

    def pending_changes(self, note_id, title, version):
        # 只选择匹配当前真实笔记的有限建议，不把整个内部计划作为证据返回。
        safe_plan = case(
            (func.json_valid(MemoryJob.plan_json), MemoryJob.plan_json),
            else_='{"notes":[]}',
        )
        proposals = func.json_each(safe_plan, "$.notes").table_valued("value")
        safe_proposal = case((func.json_valid(proposals.c.value), proposals.c.value), else_="{}")

        def field(name):
            return func.json_extract(safe_proposal, "$." + name)

        with self.sessions() as session:
            rows = session.execute(
                select(
                    MemoryJob.id,
                    MemoryJob.question,
                    MemoryJob.error_code,
                    MemoryJob.context_json,
                    field("expected_version"),
                    func.substr(field("replace_text"), 1, 200),
                    func.substr(field("body"), 1, 300),
                )
                .join(proposals, true())
                .where(
                    MemoryJob.status == "needs_confirmation",
                    or_(
                        field("note_id") == note_id,
                        func.unicode_casefold(
                            func.trim(func.coalesce(cast(field("title"), Text), ""))
                        )
                        == title.casefold(),
                    ),
                )
                .order_by(MemoryJob.updated_at.desc(), MemoryJob.id)
                .limit(4)
            ).all()
        changes = []
        for job_id, question, error, context, expected, old, proposed in rows[:3]:
            if expected is None and context:
                try:
                    related = json.loads(context).get("related_notes", [])
                    expected = next(
                        (
                            item.get("version")
                            for item in related
                            if isinstance(item, dict) and item.get("note_id") == note_id
                        ),
                        None,
                    )
                except (ValueError, TypeError, AttributeError):
                    pass
            conflict = error == "note_version_conflict" or (
                expected is not None and expected != version
            )
            suggestion = (f"{old} → {proposed}" if old else str(proposed or ""))[:500]
            changes.append(
                dict(
                    job_id=job_id,
                    status="needs_confirmation",
                    question=(
                        ("笔记版本已变化，请重新复核。" if conflict else "")
                        + (question or "这条变化尚待确认。")
                    )[:300],
                    summary=suggestion,
                    version_conflict=conflict,
                    message="这是未写入笔记的候选变化，不是已确认的当前事实。",
                )
            )
        return dict(
            has_pending_changes=bool(rows),
            pending_changes=changes,
            pending_changes_truncated=len(rows) > 3,
        )

    def ensure_index(self):
        # 旧库首次升级按实际文件确认；危险或冲突文件不作为可用证据。
        with self.sessions() as session:
            ids = list(
                session.scalars(
                    select(Note.id)
                    .outerjoin(
                        NoteSection,
                        (NoteSection.note_id == Note.id) & (NoteSection.version == Note.version),
                    )
                    .where(Note.sync_status == "synced", NoteSection.note_id.is_(None))
                    .limit(100)
                )
            )
        for note_id in ids:
            try:
                self.notes.get(note_id)
            except ApiError:
                continue

    def search(
        self,
        q=None,
        tag_ids=None,
        limit=8,
        date_from=None,
        date_to=None,
        token_budget=2600,
    ):
        from app.services.retrieval import DocumentRetriever

        return DocumentRetriever(self).search(q, tag_ids, limit, date_from, date_to, token_budget)

    def graph(self, q=None, tag_id=None):
        self.ensure_index()
        summaries = self.notes.list(q=q, tag_id=tag_id).items
        valid = {}
        for note in summaries[:200]:
            try:
                valid[note.id] = self.notes.get(note.id)
            except ApiError:
                continue
        from app.services.graph_context import has_knowledge

        nodes = [
            dict(
                id=n.id,
                title=n.title,
                folder=n.folder,
                tags=[t.model_dump() for t in n.tags],
                has_knowledge=has_knowledge(valid[n.id].body),
                version=valid[n.id].version,
            )
            for n in summaries
            if n.sync_status == "synced" and n.id in valid
        ][:200]
        ids = {n["id"] for n in nodes}
        from app.services.graph_layout import enrich_graph
        from app.services.retrieval import confirmed_edges

        with self.sessions() as session:
            current = {
                n.id: n.version for n in session.scalars(select(Note).where(Note.id.in_(ids)))
            }
            edge_rows = list(
                session.scalars(
                    confirmed_edges()
                    .where(MemoryRelation.source.in_(ids), MemoryRelation.target.in_(ids))
                    .order_by(MemoryRelation.id)
                    .limit(501)
                )
            )
            edges = [
                dict(
                    id=e.id,
                    source=e.source,
                    target=e.target,
                    relation=e.relation,
                    kind=e.kind,
                    weight=0.95 if e.kind == "fact" else 0.8,
                    evidence=f"{e.evidence}（来源版本 {e.source_version}，"
                    f"目标版本 {e.target_version}）",
                    source_message_id=e.source_message_id,
                    created_at=e.created_at,
                )
                for e in edge_rows
                if e.source in ids
                and e.target in ids
                and current[e.source] == e.source_version
                and current[e.target] == e.target_version
            ][:500]
        return enrich_graph(nodes, edges, len(summaries) > len(nodes) or len(edge_rows) > 500)
