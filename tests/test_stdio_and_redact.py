"""stdio 兜底适配器 + 日志脱敏测试（§7.5 / §17 #11）。"""

from __future__ import annotations

import json
import logging
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# ── 日志脱敏（log_redact） ────────────────────────────────

def test_redact_cookie_header():
    from backend.core.log_redact import redact
    out = redact("request sent Cookie: SESSDATA=abc123def456; bili_jct=zzz; OTHER=1")
    assert "abc123def456" not in out
    assert "Cookie:" in out and "REDACTED" in out


def test_redact_bearer_token():
    from backend.core.log_redact import redact
    out = redact("Authorization: Bearer deadbeef1234567890")
    assert "deadbeef1234567890" not in out
    assert "Bearer ***REDACTED***" in out


def test_redact_kv_pairs():
    from backend.core.log_redact import redact
    out = redact('{"token": "abcdef123456", "sessionid": "xyz78901234"}')
    assert "abcdef123456" not in out and "xyz78901234" not in out
    assert '"token": "abcd***REDACTED***"' in out  # 保留前 4 字符便于排障


def test_redact_url_query_and_uuid():
    from backend.core.log_redact import redact
    out = redact("GET /api?token=abcdef12345&foo=1 status=200")
    assert "abcdef12345" not in out
    out2 = redact("scan login uuid=AbCdEf123456789 pending")
    assert "AbCdEf123456789" not in out2


def test_redact_keeps_normal_content():
    from backend.core.log_redact import redact
    line = "2026-09-05 GET /api/library/entries 200 文章标题正常记录"
    assert redact(line) == line


def test_redact_logging_filter():
    from backend.core.log_redact import RedactFilter
    logger = logging.getLogger("redact-test")
    logger.setLevel(logging.INFO)
    records = []
    handler = logging.Handler()
    handler.emit = lambda record: records.append(record.getMessage())
    handler.addFilter(RedactFilter())
    logger.handlers = [handler]
    logger.propagate = False
    logger.info("Cookie: SECRETVALUE123456")
    assert "SECRETVALUE123456" not in records[0]


# ── stdio 兜底适配器（§7.5，子进程真实管道验证） ──────────

def _run_stdio(requests: list[dict]) -> list[dict]:
    import os
    stdin = "\n".join(json.dumps(r, ensure_ascii=False) for r in requests)
    env = os.environ | {"PYTHONIOENCODING": "utf-8"}
    proc = subprocess.run(
        [str(PROJECT_ROOT / "venv312" / "Scripts" / "python.exe"),
         str(PROJECT_ROOT / "mcp_server.py")],
        input=stdin, capture_output=True, text=True, encoding="utf-8", timeout=60,
        cwd=str(PROJECT_ROOT), env=env,
    )
    assert proc.returncode == 0, proc.stderr[-500:]
    return [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]


def test_stdio_initialize_and_tools_list():
    msgs = _run_stdio([
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    ])
    init = msgs[0]["result"]
    assert init["protocolVersion"] == "2025-03-26"
    assert init["serverInfo"]["name"] == "wechat-mp-tools"
    tools = msgs[1]["result"]["tools"]
    names = {t["name"] for t in tools}
    # 与 HTTP 版注册表完全一致（49 工具：含环境检查）
    assert {"mp_collect", "douyin_download_single", "bili_detect_url", "xhs_parse",
            "channels_fetch_video_profile", "transcode_start", "mp_start_auth",
            "mp_search_biz", "mp_hot_articles", "collect_task_retry_failed", "environment_check"} <= names
    assert len(tools) == 49


def test_stdio_unknown_method_and_notification():
    msgs = _run_stdio([
        {"jsonrpc": "2.0", "method": "notifications/initialized"},   # 无 id：无回执
        {"jsonrpc": "2.0", "id": 9, "method": "bogus/method"},
    ])
    assert len(msgs) == 1
    assert msgs[0]["error"]["code"] == -32601


def test_stdio_resources_list():
    msgs = _run_stdio([{"jsonrpc": "2.0", "id": 3, "method": "resources/list"}])
    uris = {r["uri"] for r in msgs[0]["result"]["resources"]}
    assert "mp-tools://status" in uris and "mp-tools://capabilities" in uris


def test_stdio_protocol_mismatch_is_actionable():
    msgs = _run_stdio([{"jsonrpc": "2.0", "id": 1, "method": "initialize",
                        "params": {"protocolVersion": "2024-11-05"}}])
    result = msgs[0]["result"]
    assert result["protocolVersion"] == "2025-03-26"
    assert "协议版本不匹配" in result.get("instructions", "")


def test_stdio_environment_check_tool_registered():
    msgs = _run_stdio([{"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                        "params": {"name": "environment_check", "arguments": {}}}])
    assert msgs[0]["result"]["isError"] is False
    payload = json.loads(msgs[0]["result"]["content"][0]["text"])
    assert payload["data"]["status"] in {"ready", "degraded", "blocked"}
