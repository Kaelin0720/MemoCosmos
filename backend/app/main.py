"""MemoCosmos本地 API：标签池与真实主智能体；运行 uvicorn app.main:app。"""

import logging
import secrets
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker
from starlette.exceptions import HTTPException

from app.agent.main_agent import ModelFactory, disable_sdk_logging
from app.api.v1.agent import router as agent_router
from app.api.v1.conversations import router as conversation_router
from app.api.v1.memory import router as memory_router
from app.api.v1.notes import router as note_router
from app.api.v1.tags import router as tag_router
from app.core.errors import ApiError, error_response
from app.core.model_config import ModelConfigStore
from app.core.security import LocalBoundaryMiddleware
from app.core.settings import DEVELOPMENT_ORIGINS, Settings
from app.db.session import build_engine, run_migrations
from app.services.conversations import RunManager, interrupt_stale_runs
from app.services.knowledge import KnowledgeService
from app.services.memory_archive import MemoryArchive
from app.services.memory_jobs import MemoryJobs
from app.services.notes import NoteService

logger = logging.getLogger("uvicorn.error")


def create_app(
    settings: Settings | None = None,
    *,
    model_factory: ModelFactory | None = None,
    memory_planner=None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        selected = settings or Settings.from_env()
        selected.validate_limits()
        database_path = selected.database_path()
        engine = build_engine(database_path)
        manager = None
        memory_jobs = None
        try:
            run_migrations(engine)
            application.state.session_factory = sessionmaker(engine, expire_on_commit=False)
            application.state.note_service = NoteService(
                selected, application.state.session_factory
            )
            application.state.note_service.recover_startup()
            interrupt_stale_runs(application.state.session_factory)
            application.state.model_config_store = ModelConfigStore(selected)
            application.state.knowledge = KnowledgeService(application.state.note_service)
            memory_jobs = MemoryJobs(
                application.state.note_service,
                application.state.knowledge,
                application.state.model_config_store,
                model_factory,
                memory_planner,
            )
            application.state.memory_jobs = memory_jobs
            application.state.memory_archive = MemoryArchive(
                selected, application.state.note_service, application.state.model_config_store
            )
            manager = RunManager(
                application.state.session_factory,
                application.state.model_config_store,
                selected,
                model_factory,
                write_lock=application.state.note_service.write_lock,
                memory_jobs=memory_jobs,
                knowledge=application.state.knowledge,
            )
            application.state.run_manager = manager
            application.state.local_token = secrets.token_urlsafe(32)
            application.state.database_path = database_path
            disable_sdk_logging()
            logger.info("MemoCosmos本地记忆库已打开")
            memory_jobs.start()
            yield
        finally:
            if manager is not None:
                await manager.close()
            if memory_jobs is not None:
                await memory_jobs.close()
            engine.dispose()

    application = FastAPI(title="MemoCosmos · 第二大脑", version="1.0.0", lifespan=lifespan)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=list(DEVELOPMENT_ORIGINS),
        allow_origin_regex=r"https?://(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?",
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Content-Type", "X-Local-Token"],
        max_age=600,
    )
    # 后添加的中间件在外层：预检和 Bootstrap 也要经过访问边界校验。
    application.add_middleware(LocalBoundaryMiddleware)

    @application.exception_handler(ApiError)
    async def handle_api_error(_request: Request, exc: ApiError) -> JSONResponse:
        return error_response(exc.status_code, exc.code, exc.message, **exc.details)

    @application.exception_handler(RequestValidationError)
    async def handle_validation_error(
        _request: Request, _exc: RequestValidationError
    ) -> JSONResponse:
        return error_response(422, "validation_error", "输入格式不正确，请检查字段与长度")

    @application.exception_handler(HTTPException)
    async def handle_http_error(_request: Request, exc: HTTPException) -> JSONResponse:
        message = "请求地址不存在" if exc.status_code == 404 else "请求方法或格式不受支持"
        response = error_response(exc.status_code, "http_error", message)
        if exc.headers:
            response.headers.update(exc.headers)
        return response

    @application.exception_handler(OperationalError)
    async def handle_database_error(_request: Request, _exc: OperationalError) -> JSONResponse:
        logger.error("本地数据库暂不可用")
        return error_response(503, "database_unavailable", "本地数据库暂不可用，请稍后重试")

    @application.exception_handler(Exception)
    async def handle_internal_error(_request: Request, _exc: Exception) -> JSONResponse:
        logger.error("本地服务发生未预期错误")
        return error_response(500, "internal_error", "本地服务暂时无法完成请求")

    @application.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @application.get("/api/v1/bootstrap")
    def bootstrap(request: Request) -> JSONResponse:
        # 令牌只驻留在本次运行的内存中，不放进日志、数据库或缓存。
        return JSONResponse(
            content={"local_token": request.app.state.local_token},
            headers={"Cache-Control": "no-store"},
        )

    application.include_router(tag_router)
    application.include_router(agent_router)
    application.include_router(conversation_router)
    application.include_router(note_router)
    application.include_router(memory_router)
    return application


app = create_app()
