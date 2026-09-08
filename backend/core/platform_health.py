"""平台通路健康统计（P1-4）：从真实任务终态聚合，不主动探测平台。

数据：state/platform_health.json，每平台保留最近 HEALTH_WINDOW 条结果。
错误分类：user_input（用户输错/不支持）、auth（认证问题）、platform（频控/
风控/上游故障）、internal（未归类）。小样本返回 sample=insufficient，
UI/Agent 不应据此宣称平台故障。
"""

from __future__ import annotations

import threading
import time

from backend.core import state_store

HEALTH_WINDOW = 200          # 每平台滑动窗口
MIN_SAMPLE = 10              # 小于该样本量视为 insufficient

_health_lock = threading.Lock()

_error_class = {
    "INVALID_INPUT": "user_input",
    "UNSUPPORTED_URL": "user_input",
    "NOT_FOUND": "user_input",
    "AUTH_REQUIRED": "auth",
    "RATE_LIMITED": "platform",
    "SERVICE_UNAVAILABLE": "platform",
    "ENV_NOT_READY": "platform",
    "QUOTA_EXCEEDED": "platform",
    "PARTIAL_FAILURE": "platform",
    "INTERNAL": "internal",
    "CANCELLED": "internal",
}


def _classify(error: dict | None) -> str:
    if not error:
        return "internal"
    return _error_class.get(error.get("code") or "", "internal")


def _health_file():
    """动态求值：跟随 state_store.STATE_DIR（测试 monkeypatch 隔离依赖此行为）。"""
    return state_store.STATE_DIR / "platform_health.json"


def _load() -> dict:
    return state_store.read_json(_health_file(), {}) or {}


def record_task(platform: str, item_status: str, error: dict | None) -> None:
    """记录一条任务条目结果（从 TaskManager 聚合钩子调用）。"""
    with _health_lock:
        data = _load()
        rows = data.setdefault(platform, [])
        rows.append({"t": time.time(), "status": item_status,
                     "err": _classify(error) if item_status == "failed" else None})
        del rows[:-HEALTH_WINDOW]
        state_store.atomic_write_json(_health_file(), data, private=True)


def get_platform_health(platform: str) -> dict:
    data = _load().get(platform, [])
    total = len(data)
    succeeded = sum(1 for r in data if r["status"] == "succeeded")
    failed = sum(1 for r in data if r["status"] == "failed")
    skipped = sum(1 for r in data if r["status"] == "skipped")
    error_types: dict[str, int] = {}
    for r in data:
        if r.get("err"):
            error_types[r["err"]] = error_types.get(r["err"], 0) + 1
    return {
        "platform": platform,
        "total": total, "succeeded": succeeded, "failed": failed, "skipped": skipped,
        "success_rate": round(succeeded / total, 3) if total else 0.0,
        "error_types": error_types,
        "sample": "sufficient" if total >= MIN_SAMPLE else "insufficient",
        "window": HEALTH_WINDOW,
    }


def get_all_health() -> dict:
    return {p: get_platform_health(p) for p in _load()}
