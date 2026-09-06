"""日志脱敏（设计文档 §4 / §17 #11）。

单一职责：对将写入日志的文本做凭证掩码。所有日志落盘路径（Electron 捕获的
子进程输出、Python logging handler）统一经过此层规则。

掩码策略：保留键名与前 4 个字符，其余以 *** 代替，便于排障而不泄露凭证。
"""

from __future__ import annotations

import logging
import re

_PATTERNS = [
    # Cookie / Set-Cookie 头整体
    (re.compile(r"(?i)(cookie\s*:\s*).{4,}"), r"\1***REDACTED***"),
    # Authorization: Bearer xxx
    (re.compile(r"(?i)(authorization\s*[:=]\s*bearer\s+)\S+"), r"\1***REDACTED***"),
    # 键值对形式：token=xxx / "token": "xxx" / sessionid=xxx / SESSDATA=xxx（保留前 4 字符）
    (re.compile(
        r"(?i)(\"?(?:token|access_token|refresh_token|sessionid|sessionid_ss|sid_guard|"
        r"sessdata|api[_-]?key|secret|passw(?:or)?d|vid_token|web_session|bilibili_cookie)\"?\"?\s*[:=]\s*\")"
        r"([A-Za-z0-9_*\-\.]{4})[A-Za-z0-9_*\-\.]+"
    ), r"\1\2***REDACTED***"),
    # URL 查询参数形式的凭证
    (re.compile(r"(?i)([?&](?:token|sessionid|sign|signature|secret|key)=)[A-Za-z0-9_\-\.]{5,}"),
     r"\1***REDACTED***"),
    # 微信读书 scanUrl 携带的 uuid
    (re.compile(r"(?i)(uuid[=/])[A-Za-z0-9\-_]{8,}"), r"\1***REDACTED***"),
]


def redact(text: str) -> str:
    """掩码日志文本中的凭证；保留键名与前 4 字符。"""
    if not text:
        return text
    out = str(text)
    for pattern, repl in _PATTERNS:
        out = pattern.sub(repl, out)
    return out


class RedactFilter(logging.Filter):
    """logging.Filter：对 record 消息做脱敏。

    用法：handler.addFilter(RedactFilter())
    """

    def filter(self, record) -> bool:
        try:
            record.msg = redact(str(record.msg))
            if record.args:
                record.args = tuple(redact(str(a)) for a in record.args)
        except Exception:
            pass  # 脱敏失败不阻塞日志
        return True
