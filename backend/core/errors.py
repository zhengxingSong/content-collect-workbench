"""统一结构化错误（设计文档 §7.4）。

Agent 依据错误码行动，不解析自然语言。
"""

from __future__ import annotations


class ErrorCode:
    AUTH_REQUIRED = "AUTH_REQUIRED"
    RATE_LIMITED = "RATE_LIMITED"
    UNSUPPORTED_URL = "UNSUPPORTED_URL"
    ENV_NOT_READY = "ENV_NOT_READY"          # 细分见 detail：FFMPEG_MISSING / PROXY_DOWN ...
    SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE"
    INVALID_INPUT = "INVALID_INPUT"
    QUOTA_EXCEEDED = "QUOTA_EXCEEDED"
    PARTIAL_FAILURE = "PARTIAL_FAILURE"
    INTERNAL = "INTERNAL"
    CANCELLED = "CANCELLED"
    NOT_FOUND = "NOT_FOUND"


class CollectError(Exception):
    """携带错误码的业务异常。MCP/collect API 统一捕获并转结构化响应。"""

    def __init__(self, code: str, message: str, *, retryable: bool = False, detail: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.detail = detail or {}

    def to_dict(self) -> dict:
        return {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
            **({"detail": self.detail} if self.detail else {}),
        }


def envelope(success: bool, summary: str, data: dict | None = None, error: dict | None = None,
             request_id: str | None = None) -> dict:
    """统一业务响应契约：{success, summary, data, error, request_id}。"""
    out = {"success": success, "summary": summary, "data": data or {}, "error": error}
    if request_id:
        out["request_id"] = request_id
    return out


def ok(summary: str, data: dict | None = None) -> dict:
    return envelope(True, summary, data)


def fail(err: CollectError) -> dict:
    return envelope(False, err.message, err.detail or None, err.to_dict())
