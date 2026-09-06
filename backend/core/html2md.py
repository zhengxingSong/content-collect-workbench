"""极简 HTML→Markdown 转换器（产物归一化用，设计文档 §10）。

只覆盖公众号/笔记正文的常见结构：标题、段落、加粗/斜体、链接、图片、
有序/无序列表、引用、代码块。语义安全的空白归一化，不做激进变换。
"""

from __future__ import annotations

import re
from html import escape, unescape
from html.parser import HTMLParser


class _MdParser(HTMLParser):
    BLOCK_TAGS = {"p", "div", "section", "h1", "h2", "h3", "h4", "h5", "h6",
                  "ul", "ol", "li", "blockquote", "pre", "table", "tr", "br", "hr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._out: list[str] = []
        self._buf: list[str] = []
        self._link_href: str | None = None
        self._ignore_depth = 0          # script/style
        self._list_stack: list[str] = []  # 'ul' | 'ol'
        self._ol_counter = 0
        self._in_pre = False
        self._pre_buf: list[str] = []

    # ── 工具 ─────────────────────────────────────────────
    def _flush(self, prefix: str = "", suffix: str = "") -> None:
        text = "".join(self._buf).strip()
        self._buf = []
        if text:
            self._out.append(prefix + text + suffix)

    def _block(self, text: str) -> None:
        if text.strip():
            self._out.append(text.strip())

    # ── 事件 ─────────────────────────────────────────────
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in {"script", "style"}:
            self._ignore_depth += 1
            return
        if self._ignore_depth:
            return
        if tag == "pre":
            self._flush()
            self._in_pre = True
            self._pre_buf = []
            return
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self._flush()
            self._h = "#" * int(tag[1])
        elif tag in {"ul", "ol"}:
            self._flush()
            self._list_stack.append(tag)
            self._ol_counter = 0
        elif tag == "li":
            self._flush()
        elif tag == "blockquote":
            self._flush()
        elif tag == "br":
            self._buf.append("\n\n")
        elif tag == "hr":
            self._flush()
            self._block("---")
        elif tag == "img":
            src = (a.get("src") or a.get("data-src") or "").strip()
            if src:
                self._block(f"![image]({src})")
        elif tag == "a":
            self._link_href = (a.get("href") or "").strip()
            self._link_mark = len(self._buf)
        elif tag in {"strong", "b"}:
            self._buf.append("**")
        elif tag in {"em", "i"}:
            self._buf.append("*")
        elif tag == "code":
            self._buf.append("`")

    def handle_endtag(self, tag):
        if tag in {"script", "style"}:
            self._ignore_depth = max(0, self._ignore_depth - 1)
            return
        if self._ignore_depth:
            return
        if tag == "pre":
            self._in_pre = False
            code = "".join(self._pre_buf).strip("\n")
            self._block(f"```\n{code}\n```")
            return
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self._flush(prefix=f"{getattr(self, '_h', '##')} ")
        elif tag in {"ul", "ol"}:
            if self._list_stack:
                self._list_stack.pop()
        elif tag == "li":
            if self._list_stack and self._list_stack[-1] == "ol":
                self._ol_counter += 1
                self._flush(prefix=f"{self._ol_counter}. ")
            else:
                self._flush(prefix="- ")
        elif tag == "blockquote":
            self._flush(prefix="> ")
        elif tag in {"p", "div", "section", "table", "tr"}:
            self._flush()
        elif tag in {"strong", "b"}:
            self._buf.append("**")
        elif tag in {"em", "i"}:
            self._buf.append("*")
        elif tag == "code":
            self._buf.append("`")
        elif tag == "a":
            href = self._link_href
            self._link_href = None
            mark = getattr(self, "_link_mark", 0)
            text = "".join(self._buf[mark:]).strip()
            del self._buf[mark:]
            if href and text:
                self._buf.append(f"[{text}]({href})")
            elif text:
                self._buf.append(text)

    def handle_data(self, data):
        if self._ignore_depth:
            return
        if self._in_pre:
            self._pre_buf.append(data)
        else:
            self._buf.append(re.sub(r"\s+", " ", data))

    def result(self) -> str:
        self._flush()
        text = "\n\n".join(line.strip() for line in self._out if line.strip())
        return text


def html_to_markdown(html: str) -> str:
    if not html:
        return ""
    parser = _MdParser()
    try:
        parser.feed(unescape(html) if _has_entities(html) else html)
        parser.close()
    except Exception:
        # 转换失败降级：剥标签保留纯文本
        return re.sub(r"<[^>]+>", " ", html).strip()
    return parser.result()


def _has_entities(html: str) -> bool:
    return bool(re.search(r"&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);", html))
