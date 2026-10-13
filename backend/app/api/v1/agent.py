from fastapi import APIRouter, Depends, Request

from app.core.errors import ErrorResponse
from app.core.security import require_local_token
from app.schemas.agent import AgentConfigUpdate, AgentStatus

router = APIRouter(
    prefix="/api/v1/agent",
    tags=["主智能体配置"],
    dependencies=[Depends(require_local_token)],
    responses={401: {"model": ErrorResponse}, 403: {"model": ErrorResponse}},
)


@router.get("/status", response_model=AgentStatus)
async def agent_status(request: Request):
    return request.app.state.model_config_store.snapshot().status


@router.put("/config", response_model=AgentStatus, responses={422: {"model": ErrorResponse}})
async def configure_agent(payload: AgentConfigUpdate, request: Request):
    return request.app.state.model_config_store.save(payload)
