from fastapi.responses import JSONResponse
from pydantic import BaseModel


class ErrorDetail(BaseModel):
    code: str
    message: str
    note_id: str | None = None
    current_version: int | None = None
    operation_id: str | None = None
    sync_status: str | None = None
    retryable: bool | None = None


class ErrorResponse(BaseModel):
    error: ErrorDetail


class ApiError(Exception):
    def __init__(self, status_code: int, code: str, message: str, **details: object):
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details
        super().__init__(message)


def error_response(status_code: int, code: str, message: str, **details: object) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": message, **details}},
    )
