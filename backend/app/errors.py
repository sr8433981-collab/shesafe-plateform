"""Centralised error handling.

Every failure in the app leaves through an :class:`AppError`. The handler turns
it into a single, stable JSON envelope::

    {"ok": false, "error": {"code": "...", "message": "..."}, "request_id": "..."}

``message`` is always safe to show an end user: internal exceptions are logged
with their detail and returned as a generic 500 with the request id.
"""

from __future__ import annotations

from typing import Any

from flask import Flask, g, jsonify
from werkzeug.exceptions import HTTPException


class AppError(Exception):
    """Base class for expected, user-facing failures."""

    status_code = 400
    code = "bad_request"
    message = "Request could not be processed."

    def __init__(self, message: str | None = None, *, code: str | None = None, status_code: int | None = None, **extra: Any):
        super().__init__(message or self.code)
        # Class-level `message` provides the default copy for each error type.
        self.message = message or self.message or "Request could not be processed."
        if code:
            self.code = code
        if status_code:
            self.status_code = status_code
        self.extra = extra

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"code": self.code, "message": self.message}
        payload.update(self.extra)
        return payload


class ValidationError(AppError):
    status_code = 422
    code = "validation_failed"

    def __init__(self, message: str = "Please check the highlighted fields.", **fields: Any):
        super().__init__(message)
        self.fields = fields

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "fields": self.fields}


class AuthenticationError(AppError):
    status_code = 401
    code = "authentication_required"
    message = "Please sign in to continue."


class AuthorizationError(AppError):
    status_code = 403
    code = "not_authorised"
    message = "You do not have access to this resource."


class NotFoundError(AppError):
    status_code = 404
    code = "not_found"
    message = "The requested resource was not found."


class ConflictError(AppError):
    status_code = 409
    code = "conflict"
    message = "That action conflicts with the current state."


class RateLimitError(AppError):
    status_code = 429
    code = "rate_limited"
    message = "Too many requests. Please slow down and try again shortly."

    def __init__(self, retry_after: int = 60):
        super().__init__()
        self.retry_after = retry_after

    def to_dict(self) -> dict[str, Any]:
        return {**super().to_dict(), "retryAfter": self.retry_after}


class ServiceUnavailableError(AppError):
    status_code = 503
    code = "service_unavailable"
    message = "This capability is temporarily unavailable."


def error_response(error: AppError):
    response = jsonify(
        {
            "ok": False,
            "error": error.to_dict(),
            "request_id": getattr(g, "request_id", None),
        }
    )
    response.status_code = error.status_code
    if isinstance(error, RateLimitError):
        response.headers["Retry-After"] = str(error.retry_after)
    return response


def register_error_handlers(app: Flask) -> None:
    from .logging_utils import log_event

    @app.errorhandler(AppError)
    def _handle_app_error(exc: AppError):
        if exc.status_code >= 500:
            log_event("http.error", action=exc.code, status=exc.status_code)
        return error_response(exc)

    @app.errorhandler(HTTPException)
    def _handle_http_error(exc: HTTPException):
        mapped = {
            400: "bad_request",
            401: "authentication_required",
            403: "not_authorised",
            404: "not_found",
            405: "method_not_allowed",
            413: "payload_too_large",
            429: "rate_limited",
        }.get(exc.code or 500, "http_error")
        message = {
            404: "The requested resource was not found.",
            405: "That method is not allowed for this endpoint.",
            413: "The request body is too large.",
            429: "Too many requests. Please slow down.",
        }.get(exc.code or 500, exc.description or "Request failed.")
        error = AppError(message, code=mapped, status_code=exc.code or 500)
        return error_response(error)

    @app.errorhandler(Exception)
    def _handle_unexpected(exc: Exception):
        log_event(
            "http.unhandled_exception",
            level=40,
            request_id=getattr(g, "request_id", None),
            error_type=type(exc).__name__,
            error=str(exc)[:400],
        )
        response = jsonify(
            {
                "ok": False,
                "error": {
                    "code": "internal_error",
                    # Never leak internals. The request id lets an operator correlate.
                    "message": "Something went wrong on our side. Please try again.",
                },
                "request_id": getattr(g, "request_id", None),
            }
        )
        response.status_code = 500
        return response