#!/usr/bin/env python3
"""stdio 兜底 MCP 适配器（设计文档 §7.5，连接模式）。

- 协议与传输层与 HTTP 版完全一致（2025-03-26，initialize/tools/resources）；
- 工具注册表直接复用 backend.mcp_server.tools（45 个工具），响应契约统一；
- 连接模式：不负责拉起后端，仅连接运行中的 Flask 服务（CONTENT_COLLECT_WORKBENCH_URL，
  默认 http://127.0.0.1:5200）；后端未启动时工具返回结构化 SERVICE_UNAVAILABLE；
- 令牌从 state/service.json 读取（backend_client 自动附带）。

运行：python mcp_server.py
"""

from __future__ import annotations

import json
import sys

from backend.mcp_server import PROTOCOL_VERSION, SERVER_NAME, __version__
from backend.mcp_server import resources, tools


def _write(message: dict) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _rpc_error(req_id, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


def _handle(msg: dict) -> dict | None:
    method = msg.get("method")
    req_id = msg.get("id")
    if req_id is None:  # notification：stdio 下无需回执
        return None
    if method == "initialize":
        params = msg.get("params") or {}
        client_version = (params.get("protocolVersion") or "").strip()
        result = {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False},
                             "resources": {"subscribe": False, "listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": __version__},
        }
        if client_version and client_version != PROTOCOL_VERSION:
            result["instructions"] = (
                f"协议版本不匹配：客户端声明 {client_version}，服务端实现 {PROTOCOL_VERSION}。"
                f"若遇工具调用异常，请将客户端 MCP 版本升级到 {PROTOCOL_VERSION}。"
            )
        return {"jsonrpc": "2.0", "id": req_id, "result": result}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": req_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": tools.list_tools()}}
    if method == "tools/call":
        params = msg.get("params") or {}
        content, is_error = tools.call_tool(params.get("name"), params.get("arguments") or {})
        return {"jsonrpc": "2.0", "id": req_id, "result": {"content": content, "isError": is_error}}
    if method == "resources/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"resources": resources.list_resources()}}
    if method == "resources/read":
        uri = (msg.get("params") or {}).get("uri", "")
        payload = resources.read_resource(uri)
        if payload is None:
            return _rpc_error(req_id, -32602, f"resource not found: {uri}")
        return {"jsonrpc": "2.0", "id": req_id, "result": {"contents": [payload]}}
    return _rpc_error(req_id, -32601, f"Method not found: {method}")


def main() -> None:
    # stdout 只承载 MCP JSON-RPC；子进程/库的杂散输出重定向到 stderr
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            _write(_rpc_error(None, -32700, "Parse error"))
            continue
        if isinstance(msg, list):  # batch
            for m in msg:
                if isinstance(m, dict):
                    resp = _handle(m)
                    if resp:
                        _write(resp)
            continue
        resp = _handle(msg)
        if resp:
            _write(resp)


if __name__ == "__main__":
    main()
