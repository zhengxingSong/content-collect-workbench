"""统一任务模型（设计文档 §8）。

状态机：
    queued -> running -> succeeded | partially_succeeded | failed
                     -> cancel_requested -> cancelled
    running -> waiting_auth -> queued        （认证闸门，§9）
    重启后：running/queued/cancel_requested -> interrupted（有 cursor 者标记 resumable）

持久化：state/tasks/<YYYYMMDD>.jsonl 追加式全量记录（读方取每 task_id 最后一条）。
幂等：idempotency_key 未传时按 (platform, kind, 参数规范化) 生成；同键活跃任务直接复用。
取消：协作式 —— runner 通过 ctx.check_cancel() 响应，不保证瞬时停止。
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
import uuid
from pathlib import Path

from backend.core import state_store
from backend.core.errors import ErrorCode, CollectError

QUEUED = "queued"
RUNNING = "running"
WAITING_AUTH = "waiting_auth"
CANCEL_REQUESTED = "cancel_requested"
SUCCEEDED = "succeeded"
PARTIAL = "partially_succeeded"
FAILED = "failed"
CANCELLED = "cancelled"
INTERRUPTED = "interrupted"

TERMINAL = {SUCCEEDED, PARTIAL, FAILED, CANCELLED, INTERRUPTED}
ACTIVE = {QUEUED, RUNNING, WAITING_AUTH, CANCEL_REQUESTED}

SUGGESTED_POLL_INTERVAL = 2.0


def _canonical(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class TaskCancelled(Exception):
    pass


class TaskContext:
    """runner 与任务模型的交互接口。"""

    def __init__(self, manager: "TaskManager", record: dict):
        self._manager = manager
        self._record = record

    @property
    def task_id(self) -> str:
        return self._record["task_id"]

    @property
    def params(self) -> dict:
        return self._record.get("params", {})

    def report(self, total: int | None = None, done: int | None = None,
               failed: int | None = None, skipped: int | None = None) -> None:
        p = self._record.setdefault("progress", {"total": 0, "done": 0, "failed": 0, "skipped": 0})
        for k in ("total", "done", "failed", "skipped"):
            v = locals()[k]
            if v is not None:
                p[k] = v
        self._manager._touch(self._record)

    def item(self, key: str, status: str, message: str = "", entry_id: str | None = None) -> None:
        """分条目结果（§8.2 批量允许部分成功）。status: succeeded|failed|skipped"""
        self._record["items"].append(
            {"key": key, "status": status, "message": message,
             **({"entry_id": entry_id} if entry_id else {})}
        )
        if entry_id and status == "succeeded":
            self._record["entry_ids"].append(entry_id)
        p = self._record["progress"]
        p["done"] = sum(1 for i in self._record["items"] if i["status"] == "succeeded")
        p["failed"] = sum(1 for i in self._record["items"] if i["status"] == "failed")
        p["skipped"] = sum(1 for i in self._record["items"] if i["status"] == "skipped")
        self._manager._touch(self._record)

    def entry(self, entry_id: str) -> None:
        if entry_id not in self._record["entry_ids"]:
            self._record["entry_ids"].append(entry_id)
            self._manager._touch(self._record)

    def set_cursor(self, cursor: str) -> None:
        self._record["cursor"] = cursor
        self._manager._touch(self._record)

    def waiting_auth(self, auth_request_id: str) -> None:
        self._manager._set_status(self._record, WAITING_AUTH,
                                  detail={"auth_request_id": auth_request_id})

    def check_cancel(self) -> None:
        if self._record["cancel_requested"]:
            raise TaskCancelled()


class TaskManager:
    def __init__(self):
        self._lock = threading.Lock()
        self._tasks: dict[str, dict] = {}
        self._by_key: dict[str, str] = {}
        self._loaded = False

    # ── 持久化 ────────────────────────────────────────────
    def _persist(self, record: dict) -> None:
        day = time.strftime("%Y%m%d", time.localtime(record["created_at"]))
        path = state_store.TASKS_DIR / f"{day}.jsonl"
        state_store.append_jsonl(path, record)

    def recover(self) -> list[str]:
        """启动时恢复：JSONL 重放 + 未完任务标 interrupted（§8.4）。返回中断任务 id。"""
        with self._lock:
            self._tasks.clear()
            self._by_key.clear()
            last: dict[str, dict] = {}
            for f in sorted(state_store.TASKS_DIR.glob("*.jsonl")):
                for rec in state_store.read_jsonl(f):
                    last[rec["task_id"]] = rec
            interrupted = []
            for rec in last.values():
                if rec["status"] in ACTIVE:
                    rec["status"] = INTERRUPTED
                    rec["updated_at"] = time.time()
                    rec["interrupt_reason"] = "service_restarted"
                    rec["resumable"] = bool(rec.get("cursor"))
                    self._persist(rec)
                    interrupted.append(rec["task_id"])
                self._tasks[rec["task_id"]] = rec
                if rec["status"] in ACTIVE and rec.get("idempotency_key"):
                    self._by_key[rec["idempotency_key"]] = rec["task_id"]
            self._loaded = True
            return interrupted

    # ── 创建与执行 ────────────────────────────────────────
    def create(self, platform: str, kind: str, params: dict, runner,
               idempotency_key: str | None = None) -> tuple[dict, bool]:
        """返回 (record, created)。created=False 表示命中幂等键复用既有任务。"""
        key = idempotency_key or hashlib.sha256(
            _canonical({"platform": platform, "kind": kind, "params": params}).encode("utf-8")
        ).hexdigest()[:16]

        with self._lock:
            existing_id = self._by_key.get(key)
            if existing_id:
                existing = self._tasks.get(existing_id)
                if existing and existing["status"] in ACTIVE:
                    return existing, False
            now = time.time()
            record = {
                "task_id": f"t_{uuid.uuid4().hex[:12]}",
                "idempotency_key": key,
                "platform": platform,
                "kind": kind,
                "params": params,
                "status": QUEUED,
                "created_at": now,
                "started_at": None,
                "updated_at": now,
                "progress": {"total": 0, "done": 0, "failed": 0, "skipped": 0},
                "items": [],
                "entry_ids": [],
                "error": None,
                "cursor": None,
                "cancel_requested": False,
                "resumable": False,
                "suggested_poll_interval": SUGGESTED_POLL_INTERVAL,
            }
            self._tasks[record["task_id"]] = record
            self._by_key[key] = record["task_id"]
            self._persist(record)

        thread = threading.Thread(
            target=self._run, args=(record, runner), name=f"task-{record['task_id']}", daemon=True
        )
        thread.start()
        return record, True

    def _run(self, record: dict, runner) -> None:
        ctx = TaskContext(self, record)
        self._set_status(record, RUNNING)
        try:
            runner(ctx)
        except TaskCancelled:
            self._set_status(record, CANCELLED)
        except CollectError as e:
            record["error"] = e.to_dict()
            self._set_status(record, FAILED)
        except Exception as e:  # runner 内部未归类异常
            record["error"] = {"code": ErrorCode.INTERNAL, "message": str(e), "retryable": False}
            self._set_status(record, FAILED)
        else:
            self._aggregate(record)

    def _aggregate(self, record: dict) -> None:
        """将分条目结果聚合为任务终态（§8.2）。

        规则（诚实反映"是否存在未成功的失败"）：
        - 有失败 且 有成功        -> partially_succeeded
        - 有失败 且 无成功        -> failed（即使有跳过项，也没有新产物成功）
        - 无失败 且 有成功        -> succeeded
        - 无失败 且 全为跳过(已存在)-> succeeded + 注明"全部已存在/跳过"
        - 无任何条目（total==0）  -> failed（无产出）
        """
        items = record.get("items", [])
        n_ok = sum(1 for i in items if i["status"] == "succeeded")
        n_failed = sum(1 for i in items if i["status"] == "failed")
        n_skipped = sum(1 for i in items if i["status"] == "skipped")
        progress = record.setdefault("progress", {"total": 0, "done": 0, "failed": 0, "skipped": 0})

        if not items and progress.get("total", 0) == 0:
            record["error"] = {"code": ErrorCode.INTERNAL,
                               "message": "任务未产出任何条目", "retryable": True}
            self._set_status(record, FAILED)
        elif n_failed and n_ok:
            self._set_status(record, PARTIAL)
        elif n_failed and not n_ok:
            # 全部失败（或 失败+跳过）：无新产物成功，按失败处理，注明跳过项
            detail = {"skipped_existing": n_skipped} if n_skipped else None
            self._set_status(record, FAILED, detail=detail)
        elif n_skipped and not n_ok:
            # 全部是"已存在完整产物"而跳过：不视为失败，注明
            self._set_status(record, SUCCEEDED,
                             detail={"all_skipped_existing": True, "skipped": n_skipped})
        else:
            self._set_status(record, SUCCEEDED)

    # ── 状态流转（内部） ──────────────────────────────────
    def _set_status(self, record: dict, status: str, detail: dict | None = None) -> None:
        with self._lock:
            record["status"] = status
            record["updated_at"] = time.time()
            if status == RUNNING and not record["started_at"]:
                record["started_at"] = record["updated_at"]
            if detail:
                record["detail"] = {**(record.get("detail") or {}), **detail}
            self._persist(record)

    def _touch(self, record: dict) -> None:
        record["updated_at"] = time.time()
        self._persist(record)

    # ── 查询与操作 ────────────────────────────────────────
    def get(self, task_id: str) -> dict | None:
        with self._lock:
            return self._tasks.get(task_id)

    def list_tasks(self, platform: str | None = None, status: str | None = None) -> list[dict]:
        with self._lock:
            out = [t for t in self._tasks.values()
                   if (not platform or t["platform"] == platform)
                   and (not status or t["status"] == status)]
        return sorted(out, key=lambda t: t["created_at"], reverse=True)

    def request_cancel(self, task_id: str) -> dict | None:
        with self._lock:
            rec = self._tasks.get(task_id)
            if not rec:
                return None
            if rec["status"] in {QUEUED, RUNNING, WAITING_AUTH}:
                rec["status"] = CANCEL_REQUESTED
                rec["cancel_requested"] = True
                rec["updated_at"] = time.time()
                self._persist(rec)
            return rec


task_manager = TaskManager()
