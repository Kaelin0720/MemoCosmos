from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse

from app.core.errors import ErrorResponse
from app.core.security import require_local_token
from app.schemas.conversations import (
    ConversationList,
    ConversationResponse,
    EmptyRequest,
    MessageCreate,
    MessageList,
    RunResponse,
)
from app.services.conversations import run_events

router = APIRouter(
    prefix="/api/v1",
    tags=["原始会话与运行"],
    dependencies=[Depends(require_local_token)],
    responses={
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        409: {"model": ErrorResponse},
        422: {"model": ErrorResponse},
    },
)


@router.post("/conversations", response_model=ConversationResponse, status_code=201)
async def create_conversation(_payload: EmptyRequest, request: Request):
    return request.app.state.run_manager.create_conversation()


@router.get("/conversations", response_model=ConversationList)
async def list_conversations(
    request: Request,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    return request.app.state.run_manager.conversations(limit, offset)


@router.get("/conversations/{conversation_id}", response_model=ConversationResponse)
async def get_conversation(conversation_id: str, request: Request):
    return request.app.state.run_manager.conversation(conversation_id)


@router.get("/conversations/{conversation_id}/messages", response_model=MessageList)
async def get_messages(
    conversation_id: str,
    request: Request,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    before_seq: Annotated[int | None, Query(ge=1)] = None,
):
    return request.app.state.run_manager.messages(conversation_id, limit, before_seq)


@router.post(
    "/conversations/{conversation_id}/messages", response_model=RunResponse, status_code=202
)
async def send_message(conversation_id: str, payload: MessageCreate, request: Request):
    return await request.app.state.run_manager.submit(conversation_id, payload)


@router.get(
    "/conversations/{conversation_id}/runs/by-client-message/{client_message_id}",
    response_model=RunResponse,
)
async def run_by_client_message(conversation_id: str, client_message_id: str, request: Request):
    return request.app.state.run_manager.by_client_message(conversation_id, client_message_id)


@router.get("/runs/{run_id}", response_model=RunResponse)
async def get_run(run_id: str, request: Request):
    return request.app.state.run_manager.run(run_id)


@router.post("/runs/{run_id}/cancel", response_model=RunResponse)
async def cancel_run(run_id: str, _payload: EmptyRequest, request: Request):
    return await request.app.state.run_manager.cancel(run_id)


@router.get("/runs/{run_id}/events")
async def stream_events(run_id: str, request: Request):
    manager = request.app.state.run_manager
    run_id = manager.run(run_id).id
    return StreamingResponse(
        run_events(manager, run_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
