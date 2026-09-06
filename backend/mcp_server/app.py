"""MCP streamable HTTP 传输层（最小合规实现）。

- POST /mcp：接收 JSON-RPC（单条或批），回 application/json；通知回 202；
- GET  /mcp：不提供 server-initiated 流，405（规范允许）；
- 鉴权：Bearer 令牌须与 state/service.json 匹配；Host 仅限本机。
"""

from __future__ import annotations

import json
import os

from flask import Flask, Response, jsonify, request

from . import PROTOCOL_VERSION, SERVER_NAME, __version__
from . import resources, tools


def create_app() -> Flask:
    app = Flask("wechat-mp-tools-mcp")

    def _rpc_error(req_id, code: int, message: str) -> dict:
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}

    def _handle_single(msg: dict) -> dict | None:
        method = msg.get("method")
        req_id = msg.get("id")

        if req_id is None:  # notification
            return None
        if method == "initialize":
            return {"jsonrpc": "2.0", "id": req_id, "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False},
                                 "resources": {"subscribe": False, "listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": __version__},
            }}
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

    def _token_ok() -> bool:
        from backend.core import state_store
        token = state_store.load_service_token()
        if not token:
            return False
        return request.headers.get("Authorization", "") == "Bearer " + token

    @app.post("/mcp")
    def mcp_post():
        if not _token_ok():
            return jsonify({"jsonrpc": "2.0", "id": None,
                            "error": {"code": -32001, "message": "unauthorized: missing or invalid token"}}), 401
        try:
            msgs = request.get_json(force=True)
        except Exception:
            return jsonify(_rpc_error(None, -32700, "Parse error")), 400
        batch = isinstance(msgs, list)
        messages = msgs if batch else [msgs]
        responses = [r for m in messages if isinstance(m, dict) for r in [_handle_single(m)] if r]
        if not responses:
            return Response(status=202)
        if batch and len(responses) > 1:
            return jsonify(responses)
        return jsonify(responses[0])

    @app.get("/mcp")
    def mcp_get():
        return jsonify({"error": "GET stream not supported; use POST"}), 405

    @app.get("/health")
    def health():
        return jsonify({"ok": True, "server": SERVER_NAME, "version": __version__})

    return app


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="wechat-mp-tools MCP server (streamable HTTP)")
    parser.add_argument("--port", type=int, default=3333)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    port_env = os.environ.get("WECHAT_MP_TOOLS_URL")
    print(f"[MCP] backend={port_env or 'http://127.0.0.1:5200'} listening={args.host}:{args.port}")
    app = create_app()
    app.run(host=args.host, port=args.port, threaded=True, debug=False)


if __name__ == "__main__":
    main()
