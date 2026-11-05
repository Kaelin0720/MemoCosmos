"""Locate documents and expose direct relationships for model-led retrieval.

Only short, selected sections leave the machine through the model tools. A link
is a retrieval route, never evidence that two statements are equivalent.
"""

import math
import re
from collections import Counter

from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import aliased

from app.core.errors import ApiError
from app.db.models import MemoryRelation, Note, NoteSection, NoteTag, Tag, TagAlias
from app.services.notes import tags_for

MAX_SEEDS = 6
MAX_CHARS = 8000


def query_terms(query):
    text = (query or "").strip().casefold()
    text = re.sub(
        r"帮我|请问|找一下|找下|最近|刚学的|相关知识|相关的|相关|知识|怎么做|是什么|"
        r"我想了解|告诉我|关于|一下|的|\b(?:please|find|about|what|how|the|is|are)\b",
        " ",
        text,
    )
    terms = set(re.findall(r"[a-z0-9_]+|[\u4e00-\u9fff]+", text))
    for term in list(terms):
        if re.fullmatch(r"[\u4e00-\u9fff]{3,}", term):
            terms.update(term[i : i + 2] for i in range(len(term) - 1))
    return sorted(terms, key=lambda term: (-len(term), term))[:32]


def token_cost(text):
    # Provider tokenizers differ. This is a conservative local estimate, not
    # billing usage; the separate hard character ceiling always applies.
    ascii_count = sum(ord(char) < 128 for char in text)
    return len(text) - ascii_count + math.ceil(ascii_count / 3)


def clip_tokens(text, budget):
    low, high = 0, min(len(text), 900)
    while low < high:
        mid = (low + high + 1) // 2
        if token_cost(text[:mid]) <= budget:
            low = mid
        else:
            high = mid - 1
    return text[:low]


def confirmed_edges():
    source, target = aliased(Note), aliased(Note)
    return (
        select(MemoryRelation)
        .join(source, source.id == MemoryRelation.source)
        .join(target, target.id == MemoryRelation.target)
        .where(
            MemoryRelation.active.is_(True),
            source.sync_status == "synced",
            target.sync_status == "synced",
            MemoryRelation.source_version == source.version,
            MemoryRelation.target_version == target.version,
        )
    )


class DocumentRetriever:
    def __init__(self, knowledge):
        self.knowledge = knowledge
        self.notes = knowledge.notes

    def route_tags(self, session, query, terms):
        if not terms:
            return []
        candidates = [func.instr(Tag.normalized_name, term) > 0 for term in terms]
        candidates += [func.instr(func.unicode_casefold(Tag.description), t) > 0 for t in terms]
        tags = list(session.scalars(select(Tag).where(or_(*candidates)).limit(32)))
        aliases = list(
            session.scalars(
                select(TagAlias)
                .where(
                    TagAlias.deleted.is_(False),
                    TagAlias.tag_id.is_not(None),
                    or_(*(func.instr(TagAlias.normalized_name, term) > 0 for term in terms)),
                )
                .limit(32)
            )
        )
        ids = {tag.id for tag in tags}
        for alias in aliases:
            if alias.tag_id not in ids and (tag := session.get(Tag, alias.tag_id)):
                tags.append(tag)
                ids.add(tag.id)
        query = (query or "").casefold()
        alias_names = {a.tag_id: a.normalized_name for a in aliases}
        scored = []
        for tag in tags:
            name = tag.normalized_name
            exact = name in query or alias_names.get(tag.id, "\0") in query
            name_hits = sum(term in name for term in terms)
            score = (
                10 * exact
                + 3 * name_hits
                + sum(term in tag.description.casefold() for term in terms)
            )
            scored.append((score, tag))
        scored.sort(key=lambda pair: (-pair[0], pair[1].id))
        # A named domain wins over weaker description matches.
        floor = 10 if any(score >= 10 for score, _ in scored) else 2
        return [dict(id=tag.id, name=tag.name) for score, tag in scored if score >= floor][:4]

    def search(
        self,
        q=None,
        tag_ids=None,
        limit=8,
        date_from=None,
        date_to=None,
        token_budget=2600,
    ):
        self.knowledge.ensure_index()
        terms, explicit = query_terms(q), list(dict.fromkeys(tag_ids or []))
        token_budget = max(100, min(6000, token_budget))
        with self.notes.sessions() as session:
            routed = (
                self.route_tags(session, q, terms)
                if not explicit
                else [
                    dict(id=tag.id, name=tag.name)
                    for identifier in explicit
                    if (tag := session.get(Tag, identifier))
                ]
            )
            score, matches = 1, []
            for term in terms:
                title = func.instr(Note.normalized_title, term) > 0
                heading = func.instr(func.unicode_casefold(NoteSection.heading), term) > 0
                body = func.instr(func.unicode_casefold(NoteSection.body), term) > 0
                matches += [title, heading, body]
                score += case((title, 12), else_=0) + case((heading, 6), else_=0)
                score += case((body, 2), else_=0)

            def scope(statement):
                for identifier in explicit:
                    statement = statement.where(
                        Note.id.in_(select(NoteTag.note_id).where(NoteTag.tag_id == identifier))
                    )
                day = func.coalesce(NoteSection.event_date, NoteSection.recorded_date)
                end = func.coalesce(NoteSection.event_end_date, day)
                if date_from:
                    statement = statement.where(end >= date_from)
                if date_to:
                    statement = statement.where(day <= date_to)
                return statement

            base = scope(
                select(Note, NoteSection)
                .join(NoteSection, NoteSection.note_id == Note.id)
                .where(Note.sync_status == "synced", NoteSection.version == Note.version)
            )
            seeds = base
            if not explicit and routed:
                seeds = seeds.where(
                    Note.id.in_(
                        select(NoteTag.note_id).where(
                            NoteTag.tag_id.in_([tag["id"] for tag in routed])
                        )
                    )
                )
            if terms:
                matched = seeds.where(or_(*matches))
                # If the label matched but passages use different vocabulary,
                # seed within that domain instead of scanning unrelated bodies.
                seeds = (
                    matched
                    if session.scalar(select(matched.exists()))
                    else (seeds if routed else matched)
                )
            grouped = (
                seeds.with_only_columns(Note.id, func.max(score).label("relevance"))
                .group_by(Note.id)
                .order_by(func.max(score).desc(), Note.id)
            )
            seed_rows = list(session.execute(grouped.limit(MAX_SEEDS)))
            matched_notes = session.scalar(select(func.count()).select_from(grouped.subquery()))
            activations = {}
            highest = max((row.relevance for row in seed_rows), default=1)
            for row in seed_rows:
                activations[row.id] = dict(
                    activation=0.75 + 0.25 * row.relevance / highest,
                    hop=0,
                    path=[dict(note_id=row.id, relation=None)],
                    matched_by="tag" if routed and row.relevance == 1 else "keyword",
                )
            clipped = matched_notes > MAX_SEEDS

            rows = (
                list(
                    session.execute(
                        base.where(Note.id.in_(activations))
                        .order_by(score.desc(), Note.id, NoteSection.position)
                        .limit(MAX_SEEDS * 8)
                    )
                )
                if activations
                else []
            )
            total_notes = session.scalar(
                select(func.count()).select_from(Note).where(Note.sync_status == "synced")
            )
            indexed = session.scalar(
                select(func.count(func.distinct(NoteSection.note_id)))
                .join(Note, Note.id == NoteSection.note_id)
                .where(Note.sync_status == "synced", NoteSection.version == Note.version)
            )
            candidates = []
            for note, section in rows:
                activation = activations[note.id]
                relevance = sum(
                    12 * (term in note.normalized_title)
                    + 6 * (term in section.heading.casefold())
                    + 2 * (term in section.body.casefold())
                    for term in terms
                )
                candidates.append(
                    (activation["activation"] + min(relevance, 40) / 160, note, section, activation)
                )
            candidates.sort(key=lambda item: (-item[0], item[1].id, item[2].position))
            result, per_note, valid, remaining_chars = [], Counter(), {}, MAX_CHARS
            remaining_tokens, pending = token_budget, {}
            for rank, note, section, activation in candidates:
                if len(result) >= limit or remaining_tokens < 40:
                    clipped = True
                    break
                if per_note[note.id] >= 2:
                    continue
                for step in activation["path"]:
                    identifier = step["note_id"]
                    if identifier not in valid:
                        try:
                            current = self.notes.get(identifier)
                            indexed_note = session.get(Note, identifier)
                            valid[identifier] = current.version == indexed_note.version
                        except ApiError:
                            valid[identifier] = False
                if not all(valid[step["note_id"]] for step in activation["path"]):
                    continue
                content = section.body
                at = next(
                    (content.casefold().find(term) for term in terms if term in content.casefold()),
                    0,
                )
                start = max(0, at - 100)
                excerpt = clip_tokens(
                    content[start : start + min(900, remaining_chars)], remaining_tokens
                )
                if note.id not in pending:
                    pending[note.id] = self.knowledge.pending_changes(
                        note.id, note.title, note.version
                    )
                result.append(
                    dict(
                        note_id=note.id,
                        title=note.title,
                        folder=note.folder,
                        tags=tags_for(session, note.id),
                        version=note.version,
                        heading=section.heading,
                        excerpt=excerpt,
                        score=round(rank * 100, 2),
                        date=section.event_date or section.recorded_date,
                        date_to=section.event_end_date or section.recorded_date,
                        date_basis="发生日期"
                        if section.event_date
                        else "记录日期（未说明发生日期）",
                        hop=activation["hop"],
                        matched_by=activation["matched_by"],
                        activation=round(activation["activation"], 4),
                        path=[
                            dict(**step, title=session.get(Note, step["note_id"]).title)
                            for step in activation["path"]
                        ],
                        **pending[note.id],
                    )
                )
                remaining_chars -= len(excerpt)
                remaining_tokens -= token_cost(excerpt)
                per_note[note.id] += 1
                clipped |= len(excerpt) < len(content)
            from app.services.graph_context import graph_context

            graph = (
                graph_context(
                    self.knowledge,
                    list(dict.fromkeys(item["note_id"] for item in result)),
                    token_budget=1600,
                    tag_ids=explicit,
                )
                if result
                else dict(nodes=[], edges=[], truncated=False)
            )
            # Building the adjacency may observe a newer version than the
            # selected excerpts. Do not expose mixed-version evidence.
            changed = set(graph.get("unavailable_note_ids", []))
            for identifier, version in {(item["note_id"], item["version"]) for item in result}:
                try:
                    if self.notes.get(identifier).version != version:
                        changed.add(identifier)
                except ApiError:
                    changed.add(identifier)
            if changed:
                clipped = True
                result = [item for item in result if item["note_id"] not in changed]
                graph["root_ids"] = [i for i in graph.get("root_ids", []) if i not in changed]
                graph["edges"] = [
                    e
                    for e in graph["edges"]
                    if e["source"] not in changed and e["target"] not in changed
                ]
                retained = set(graph["root_ids"])
                retained.update(n for e in graph["edges"] for n in (e["source"], e["target"]))
                graph["nodes"] = [n for n in graph["nodes"] if n["id"] in retained]
                graph["continuations"] = [
                    c for c in graph.get("continuations", []) if c["note_id"] not in changed
                ]
                graph["truncated"] = True
            return dict(
                items=result,
                graph=graph,
                total=max(len(result), len(candidates)),
                truncated=bool(
                    clipped
                    or len(candidates) > len(result)
                    or indexed < total_notes
                    or graph["truncated"]
                ),
                pending_changes_detected=bool(
                    any(item["has_pending_changes"] for item in result)
                    or graph.get("pending_changes_detected")
                ),
                routing=dict(
                    strategy="documents_then_model_directed_relations",
                    tags=routed,
                    explicit_tags=bool(explicit),
                    candidates=len(activations),
                    expansion="model_decides",
                ),
                budget=dict(
                    limit_tokens=token_budget,
                    used_tokens=token_budget - remaining_tokens,
                    unit="estimated_tokens",
                    excerpt_characters=MAX_CHARS - remaining_chars,
                ),
                coverage=dict(
                    indexed_notes=indexed,
                    total_notes=total_notes,
                    unindexed_notes=total_notes - indexed,
                    matched_sections=len(candidates),
                    date_basis="明确发生日期或标注的记录日期",
                ),
            )
