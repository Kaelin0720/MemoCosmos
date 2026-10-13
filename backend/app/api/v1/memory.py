from datetime import date
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response

from app.core.errors import ApiError
from app.core.security import require_local_token
from app.schemas.memory import EmptyRequest, JobResolve, MemorySettings
from app.services.memory_archive import MAX_ARCHIVE

router = APIRouter(
    prefix="/api/v1/memory", tags=["第二大脑"], dependencies=[Depends(require_local_token)]
)


@router.get("/settings")
def settings(request: Request):
    return request.app.state.memory_jobs.setting()


@router.put("/settings")
def save_settings(payload: MemorySettings, request: Request):
    return request.app.state.memory_jobs.set_setting(payload.auto_memory)


@router.get("/search")
def search(
    request: Request,
    q: str | None = Query(None, max_length=200),
    tag_ids: str | None = None,
    limit: int = Query(8, ge=1, le=20),
    date_from: str | None = None,
    date_to: str | None = None,
):
    try:
        tags = [str(UUID(v)) for v in tag_ids.split(",")] if tag_ids else []
        if len(tags) > 64:
            raise ValueError("too many tags")
        if date_from:
            date.fromisoformat(date_from)
        if date_to:
            date.fromisoformat(date_to)
        if date_from and date_to and date_from > date_to:
            raise ValueError("invalid date range")
    except ValueError:
        raise ApiError(422, "validation_error", "标签或日期范围格式不正确") from None
    return request.app.state.knowledge.search(q, tags, limit, date_from, date_to)


@router.get("/graph")
def graph(request: Request, q: str | None = Query(None, max_length=200), tag_id: str | None = None):
    if tag_id:
        try:
            tag_id = str(UUID(tag_id))
        except ValueError:
            raise ApiError(422, "validation_error", "标签格式不正确") from None
    return request.app.state.knowledge.graph(q, tag_id)


@router.get("/jobs")
def jobs(
    request: Request, conversation_id: str | None = None, limit: int = Query(20, ge=1, le=100)
):
    if conversation_id:
        try:
            conversation_id = str(UUID(conversation_id))
        except ValueError:
            raise ApiError(422, "validation_error", "会话格式不正确") from None
    return request.app.state.memory_jobs.list(conversation_id, limit)


@router.post("/jobs/{identifier}/retry")
def retry(identifier: str, payload: EmptyRequest, request: Request):
    return request.app.state.memory_jobs.retry(identifier)


@router.post("/jobs/{identifier}/resolve")
def resolve(identifier: str, payload: JobResolve, request: Request):
    return request.app.state.memory_jobs.resolve(identifier, payload)


@router.get("/export")
def export(request: Request):
    data = request.app.state.memory_archive.export()
    return Response(
        data,
        media_type="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="yihe-memory.zip"',
            "Cache-Control": "no-store",
        },
    )


@router.post("/import")
async def restore(request: Request):
    if request.headers.get("content-type", "").split(";")[0] != "application/octet-stream":
        raise ApiError(415, "memory_import_type", "请以 application/octet-stream 上传记忆包")
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > MAX_ARCHIVE:
            raise ApiError(413, "memory_import_large", "记忆包最大100MiB")
        data.extend(chunk)
    import asyncio

    return await asyncio.to_thread(request.app.state.memory_archive.restore, bytes(data))
