"""启动前环境检查：只检查本机可验证条件，不主动请求平台。"""
from __future__ import annotations

import os
import shutil
import socket
from pathlib import Path


def _port_check(port: int, label: str, *, expect_running: bool = False) -> dict:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.settimeout(0.2)
        occupied = sock.connect_ex(("127.0.0.1", int(port))) == 0
    except OSError:
        occupied = False
    finally:
        sock.close()
    if expect_running and occupied:
        return {"ok": True, "message": f"{label} 服务正在监听端口 {port}", "retryable": False}
    if expect_running and not occupied:
        return {"ok": False, "message": f"{label} 未在监听端口 {port}（服务可能未启动）", "retryable": True}
    return {"ok": not occupied, "message": f"{label} 端口 {port} 可用" if not occupied else f"{label} 端口 {port} 已被占用，请更换端口或停止占用进程", "retryable": occupied}


def _write_check(path: Path) -> dict:
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / ".environment-check.tmp"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return {"ok": True, "message": f"目录可写：{path}", "retryable": False}
    except OSError as e:
        return {"ok": False, "message": f"目录不可写：{path}（{e}）", "retryable": True}


def check_environment(backend_port: int = 5200, mcp_port: int = 3333, root: str | Path | None = None, *, expect_running: bool = False) -> dict:
    root_path = Path(root or Path.cwd())
    checks = {
        "backend_port": _port_check(backend_port, "Backend", expect_running=expect_running),
    }
    if expect_running:
        # 运行中模式：MCP 可能在另一容器（backend 容器内 127.0.0.1 查不到它），
        # 端口探测无意义——交给 /api/status 的 MCP_HEALTH 探针，这里不阻塞。
        checks["mcp_port"] = {"ok": True, "message": "MCP 状态由服务探针提供（见状态卡）", "retryable": False}
    else:
        checks["mcp_port"] = _port_check(mcp_port, "MCP")
    checks.update({
        "data_writable": _write_check(root_path / "data"),
        "state_writable": _write_check(root_path / "state"),
        "output_writable": _write_check(root_path / "output"),
    })
    ffmpeg = shutil.which("ffmpeg")
    checks["ffmpeg"] = {"ok": bool(ffmpeg), "message": "FFmpeg 可用" if ffmpeg else "未找到 FFmpeg（视频转码功能不可用，公众号采集不受影响）", "retryable": False}
    try:
        usage = shutil.disk_usage(root_path)
        free_gb = usage.free / (1024 ** 3)
        checks["disk"] = {"ok": free_gb >= 1, "message": f"可用空间 {free_gb:.1f} GB" if free_gb >= 1 else "可用空间低于 1 GB，请清理磁盘", "retryable": free_gb < 1}
    except OSError as e:
        checks["disk"] = {"ok": False, "message": f"无法检查磁盘空间：{e}", "retryable": True}
    blocking = [k for k, v in checks.items() if not v["ok"] and k not in {"ffmpeg"}]
    status = "blocked" if blocking else ("degraded" if not checks["ffmpeg"]["ok"] else "ready")
    return {"status": status, "checks": checks, "blocking_checks": blocking}
