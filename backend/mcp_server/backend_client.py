"""后端 HTTP 客户端（薄代理的唯一出口）。"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

from backend.core import state_store

DEFAULT_BACKEND = os.environ.get("WECHAT_MP_TOOLS_URL", "http://127.0.0.1:5200").rstrip("/")


class BackendUnavailable(Exception):
    pass


class BackendError(Exception):
    def __init__(self, payload: dict, status: int):
        super().__init__(str(payload))
        self.payload = payload
        self.status = status


def call(path: str, method: str = "GET", payload: dict | None = None, timeout: int = 60) -> dict:
    """调用后端 API；返回 JSON。后端不可用抛 BackendUnavailable。"""
    base = os.environ.get("WECHAT_MP_TOOLS_URL", DEFAULT_BACKEND).rstrip("/")
    url = base + path
    body = None
    headers = {"Accept": "application/json"}
    token = state_store.load_service_token()
    if token:
        headers["Authorization"] = "Bearer " + token
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        try:
            return json.loads(detail)
        except json.JSONDecodeError:
            raise BackendError({"success": False, "summary": f"HTTP {e.code}",
                                "data": {}, "error": {"code": "INTERNAL",
                                                      "message": detail[:500], "retryable": False}},
                               e.code)
    except (urllib.error.URLError, OSError) as e:
        raise BackendUnavailable(f"{base}: {e}")
