"""状态持久化规范（设计文档 §3）。

三类数据分离：
- 内容产物   -> output/          （由 backend/library.py 管理，原子提交协议）
- 运行状态   -> state/           （JSON/JSONL，后端单点写入，原子替换）
- 敏感凭证   -> state/credentials/ （加密文件；v1 先收敛目录并限权限，Fernet 加密在 M3 落地）

通用规则：所有 JSON 先写 *.tmp 再 os.replace()；state/ 只由后端进程写入。
"""

from __future__ import annotations

import json
import os
import secrets
import threading
import time
from pathlib import Path

from backend.config import SCRIPT_DIR

STATE_DIR = Path(os.environ.get("WMT_STATE_DIR") or (SCRIPT_DIR / "state"))
TASKS_DIR = STATE_DIR / "tasks"
CREDENTIALS_DIR = STATE_DIR / "credentials"
SERVICE_FILE = STATE_DIR / "service.json"
DEDUP_INDEX_FILE = STATE_DIR / "dedup_index.json"

_json_lock = threading.Lock()


def ensure_dirs() -> None:
    for d in (STATE_DIR, TASKS_DIR, CREDENTIALS_DIR):
        d.mkdir(parents=True, exist_ok=True)


def _restrict_perms(path: Path) -> None:
    """尽力将文件权限限制为当前用户（POSIX 生效；Windows 由 ACL 兜底）。"""
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _write_json_atomic(path: Path, payload: str, private: bool) -> None:
    """核心原子写：先写 .tmp 并 fsync，替换前备份旧文件，再 os.replace。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with _json_lock:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        # 单代备份：替换前把现有有效文件备份为 .bak，供损坏时回滚
        if path.exists():
            try:
                with open(path, "rb") as f:
                    head = f.read(1)
                if head:  # 仅备份非空旧文件
                    import shutil
                    shutil.copyfile(path, path.with_suffix(path.suffix + ".bak"))
            except OSError:
                pass
        os.replace(tmp, path)
    if private:
        _restrict_perms(path)


def atomic_write_json(path: Path, data, *, private: bool = False) -> None:
    """原子写 JSON：临时文件 + 单代 .bak 备份 + os.replace，避免半写损坏。"""
    payload = json.dumps(data, ensure_ascii=False, indent=2)
    _write_json_atomic(path, payload, private)


def read_json(path: Path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return default


def append_jsonl(path: Path, record: dict) -> None:
    """追加一行 JSON 记录（任务状态机采用追加式全量记录，读方取每 task_id 最后一条）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
    with _json_lock:
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
            f.flush()
            os.fsync(f.fileno())


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # 半写行：跳过，不视为致命
    return out


def validate_state_dir() -> None:
    """启动时校验 state/：清理残留 .tmp、校验 JSON 可解析、损坏则回滚 .bak 或标记。

    返回受影响文件列表（供日志），不抛异常——尽可能自愈，绝不阻塞启动。
    """
    import shutil as _shutil
    affected: list[str] = []
    for path in STATE_DIR.rglob("*.json"):
        if path.name.endswith(".json.bak") or path.name.endswith(".json.tmp"):
            continue
        try:
            json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            bak = path.with_suffix(path.suffix + ".bak")
            if bak.exists():
                try:
                    _shutil.copyfile(bak, path)
                    affected.append(f"rollback:{path.name}")
                except OSError:
                    affected.append(f"rollback-fail:{path.name}")
            else:
                affected.append(f"corrupt-no-bak:{path.name}")
    # 清理残留 .tmp（上次进程异常退出遗留）
    for tmp in STATE_DIR.rglob("*.tmp"):
        try:
            tmp.unlink()
            affected.append(f"cleanup:{tmp.name}")
        except OSError:
            pass
    return affected
    return out


def ensure_service_token(backend_port: int) -> dict:
    """生成本地服务令牌（设计文档 §4）。MCP/新 API 校验用；文件限当前用户可读。

    已存在则复用（MCP 独立进程与后端共享同一令牌）。
    """
    ensure_dirs()
    info = read_json(SERVICE_FILE)
    if not info or not info.get("token"):
        info = {
            "token": secrets.token_hex(32),
            "backend_port": backend_port,
            "pid": os.getpid(),
            "started_at": time.time(),
        }
        atomic_write_json(SERVICE_FILE, info, private=True)
    else:
        info["backend_port"] = backend_port
        info["pid"] = os.getpid()
        info["last_seen"] = time.time()
        atomic_write_json(SERVICE_FILE, info, private=True)
    return info


def load_service_token() -> str | None:
    info = read_json(SERVICE_FILE)
    return (info or {}).get("token")
