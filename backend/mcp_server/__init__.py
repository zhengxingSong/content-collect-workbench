"""MCP HTTP 服务（设计文档 §7）。

手写 MCP streamable HTTP 最小合规实现（POST /mcp 收 JSON-RPC、回 application/json），
不引入 fastmcp 依赖链（venv 的 typing-extensions 锁与 mitmproxy 冲突）。
本进程为薄代理：不写业务，全部转发到 Flask 后端。
"""

__version__ = "1.0.0"
PROTOCOL_VERSION = "2025-03-26"
SERVER_NAME = "wechat-mp-tools"
