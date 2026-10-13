from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response, status
from sqlalchemy.orm import Session

from app.core.errors import ErrorResponse
from app.core.security import require_local_token
from app.db.models import Tag
from app.db.session import get_session
from app.repositories.tags import TagRepository
from app.schemas.tags import TagCreate, TagListResponse, TagResponse, TagUpdate
from app.services.tags import TagService

router = APIRouter(
    prefix="/api/v1/tags",
    tags=["标签池"],
    dependencies=[Depends(require_local_token)],
    responses={
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        422: {"model": ErrorResponse},
    },
)
DatabaseSession = Annotated[Session, Depends(get_session)]


@router.get("", response_model=TagListResponse)
def list_tags(session: DatabaseSession, q: str | None = None) -> TagListResponse:
    tags = TagRepository(session).list(q)
    return TagListResponse(items=[TagResponse.model_validate(tag) for tag in tags], total=len(tags))


@router.post(
    "", response_model=TagResponse, status_code=201, responses={409: {"model": ErrorResponse}}
)
def create_tag(payload: TagCreate, session: DatabaseSession, request: Request) -> Tag:
    return TagService(session, request.app.state.note_service).create(payload)


@router.patch(
    "/{tag_id}",
    response_model=TagResponse,
    responses={404: {"model": ErrorResponse}, 409: {"model": ErrorResponse}},
)
def update_tag(tag_id: str, payload: TagUpdate, session: DatabaseSession, request: Request) -> Tag:
    return TagService(session, request.app.state.note_service).update(tag_id, payload)


@router.delete("/{tag_id}", status_code=204, responses={404: {"model": ErrorResponse}})
def delete_tag(tag_id: str, session: DatabaseSession, request: Request) -> Response:
    TagService(session, request.app.state.note_service).delete(tag_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
