from fastapi import APIRouter, Depends, Query, Request, Response

from app.core.errors import ApiError, ErrorResponse
from app.core.security import require_local_token
from app.schemas.notes import (
    ExternalImport,
    NoteCreate,
    NoteDelete,
    NoteDetail,
    NoteList,
    NoteUpdate,
    validate_folder,
)

router = APIRouter(
    prefix="/api/v1/notes",
    tags=["主题笔记"],
    dependencies=[Depends(require_local_token)],
    responses={409: {"model": ErrorResponse}, 503: {"model": ErrorResponse}},
)


@router.post("", status_code=201, response_model=NoteDetail)
def create_note(payload: NoteCreate, request: Request):
    return request.app.state.note_service.create(payload)


@router.get("", response_model=NoteList)
def list_notes(
    request: Request,
    q: str | None = Query(None, max_length=200),
    tag_id: str | None = None,
    folder: str | None = None,
):
    if set(request.query_params) - {"q", "tag_id", "folder"}:
        raise ApiError(422, "validation_error", "不支持的笔记筛选参数")
    try:
        if folder is not None:
            validate_folder(folder)
        if tag_id:
            from uuid import UUID

            tag_id = str(UUID(tag_id))
    except ValueError:
        raise ApiError(422, "validation_error", "目录或标签筛选格式不正确") from None
    return request.app.state.note_service.list(q=q, tag_id=tag_id, folder=folder)


@router.get("/{note_id}", response_model=NoteDetail)
def get_note(note_id: str, request: Request):
    return request.app.state.note_service.get(note_id)


@router.patch("/{note_id}", response_model=NoteDetail)
def update_note(note_id: str, payload: NoteUpdate, request: Request):
    return request.app.state.note_service.update(note_id, payload)


@router.delete("/{note_id}", status_code=204)
def delete_note(note_id: str, payload: NoteDelete, request: Request):
    request.app.state.note_service.delete(note_id, payload.expected_version)
    return Response(status_code=204)


@router.get("/{note_id}/versions")
def versions(note_id: str, request: Request):
    return request.app.state.note_service.versions(note_id)


@router.get("/{note_id}/external")
def external(note_id: str, request: Request):
    return request.app.state.note_service.external(note_id)


@router.post("/{note_id}/import-external", response_model=NoteDetail)
def import_external(note_id: str, payload: ExternalImport, request: Request):
    return request.app.state.note_service.import_external(note_id, payload)
