import asyncio
from uuid import UUID

from fastapi import APIRouter, Depends, Request

from app.core.security import require_local_token
from app.schemas.integrations import CaptureTurn, RecallRequest

router = APIRouter(
    prefix="/api/v1/integrations", tags=["智能体插件"], dependencies=[Depends(require_local_token)]
)


@router.post("/turns")
async def ingest_turn(payload: CaptureTurn, request: Request):
    return await asyncio.to_thread(request.app.state.external_memory.ingest, payload)


@router.post("/recall")
async def recall(payload: RecallRequest, request: Request):
    return await request.app.state.recall_sessions.call(payload)


@router.get("/jobs/{identifier}")
async def job(identifier: UUID, request: Request):
    return await asyncio.to_thread(request.app.state.memory_jobs.view, str(identifier))
