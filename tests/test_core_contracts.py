"""M0-M4 契约层测试：state_store / urlnorm / task_manager / html2md / library /
security / MCP 协议 / AuthRequest。

运行：venv312/Scripts/python.exe -m pytest tests/test_core_contracts.py -v
"""

from __future__ import annotations

import base64
import json
import time
import threading

import pytest


# ── fixtures：隔离 state/ 与 output/ ─────────────────────

@pytest.fixture()
def state_dir(tmp_path, monkeypatch):
    from backend.core import state_store
    sd = tmp_path / "state"
    monkeypatch.setattr(state_store, "STATE_DIR", sd)
    monkeypatch.setattr(state_store, "TASKS_DIR", sd / "tasks")
    monkeypatch.setattr(state_store, "CREDENTIALS_DIR", sd / "credentials")
    monkeypatch.setattr(state_store, "SERVICE_FILE", sd / "service.json")
    monkeypatch.setattr(state_store, "DEDUP_INDEX_FILE", sd / "dedup_index.json")
    state_store.ensure_dirs()
    return sd


@pytest.fixture()
def library_dir(tmp_path, monkeypatch):
    from backend import library
    ld = tmp_path / "output"
    monkeypatch.setattr(library, "LIBRARY_DIR", ld)
    return ld


# ── state_store ──────────────────────────────────────────

def test_atomic_write_and_read(state_dir):
    from backend.core import state_store
    p = state_dir / "x.json"
    state_store.atomic_write_json(p, {"a": 1, "b": "文"})
    assert state_store.read_json(p) == {"a": 1, "b": "文"}
    # 无 tmp 残留
    assert not (state_dir / "x.json.tmp").exists()


def test_service_token_roundtrip(state_dir):
    from backend.core import state_store
    info = state_store.ensure_service_token(5200)
    assert info["token"] and info["backend_port"] == 5200
    # 复用不换令牌
    again = state_store.ensure_service_token(5200)
    assert again["token"] == info["token"]
    assert state_store.load_service_token() == info["token"]


# ── urlnorm（§11） ───────────────────────────────────────

def test_urlnorm_strips_tracking_params():
    from backend.core.urlnorm import normalize_url
    url = "https://mp.weixin.qq.com/s/abcDEF123?chksm=zzz&scene=42&from=timeline"
    assert normalize_url(url) == "https://mp.weixin.qq.com/s/abcDEF123"


def test_urlnorm_keeps_platform_identity_params():
    from backend.core.urlnorm import normalize_url
    url = "https://www.bilibili.com/video/BV1xx411c7mD?p=3&spm_id_from=333"
    assert "p=3" in normalize_url(url)
    assert "spm_id_from" not in normalize_url(url)


def test_platform_item_id_extraction():
    from backend.core.urlnorm import platform_item_id
    assert platform_item_id("https://mp.weixin.qq.com/s/abcDEF123") == "mp:abcDEF123"
    assert platform_item_id("https://www.bilibili.com/video/BV1xx411c7mD") == "bili:BV1xx411c7mD"
    assert platform_item_id("https://www.douyin.com/video/7301234567890123456") == "dy:7301234567890123456"
    assert platform_item_id("https://example.com/page") is None


def test_identity_key_prefers_pid_over_url():
    from backend.core.urlnorm import identity_key
    a = identity_key("https://mp.weixin.qq.com/s/abc?chksm=x")
    b = identity_key("https://mp.weixin.qq.com/s/abc?scene=y")
    assert a == b  # 同一内容不同跟踪参数 → 同一身份


def test_nchash_whitespace_normalization():
    from backend.core.urlnorm import nchash
    assert nchash("你好  世界\n\nfoo") == nchash("你好 世界 foo")


# ── task_manager（§8） ───────────────────────────────────

def test_task_success_lifecycle(state_dir):
    from backend.core.task_manager import TaskManager, SUCCEEDED

    def runner(ctx):
        ctx.report(total=2)
        ctx.item("a", "succeeded", entry_id="e1")
        ctx.item("b", "succeeded", entry_id="e2")

    tm = TaskManager()
    rec, created = tm.create("mp", "collect", {"urls": ["u1"]}, runner)
    assert created
    for _ in range(100):
        rec = tm.get(rec["task_id"])
        if rec["status"] in ("succeeded", "failed"):
            break
        time.sleep(0.05)
    assert rec["status"] == SUCCEEDED
    assert rec["progress"]["done"] == 2
    assert rec["entry_ids"] == ["e1", "e2"]


def test_task_idempotency_reuse(state_dir):
    from backend.core.task_manager import TaskManager

    def runner(ctx):
        ctx.report(total=1)
        time.sleep(0.3)
        ctx.item("a", "succeeded")

    tm = TaskManager()
    r1, c1 = tm.create("mp", "collect", {"urls": ["u1"]}, runner)
    r2, c2 = tm.create("mp", "collect", {"urls": ["u1"]}, runner)
    assert c1 and not c2
    assert r1["task_id"] == r2["task_id"]


def test_task_partial_success(state_dir):
    from backend.core.task_manager import TaskManager, PARTIAL

    def runner(ctx):
        ctx.report(total=2)
        ctx.item("a", "succeeded")
        ctx.item("b", "failed", "boom")

    tm = TaskManager()
    rec, _ = tm.create("mp", "collect", {"urls": ["u"]}, runner)
    for _ in range(100):
        rec = tm.get(rec["task_id"])
        if rec["status"] not in ("queued", "running"):
            break
        time.sleep(0.05)
    assert rec["status"] == PARTIAL


def test_task_cancel_cooperative(state_dir):
    from backend.core.task_manager import TaskManager, CANCELLED

    def runner(ctx):
        for _ in range(50):
            ctx.check_cancel()
            time.sleep(0.02)

    tm = TaskManager()
    rec, _ = tm.create("mp", "collect", {"urls": []}, runner)
    time.sleep(0.1)
    tm.request_cancel(rec["task_id"])
    for _ in range(100):
        rec = tm.get(rec["task_id"])
        if rec["status"] in ("cancelled",):
            break
        time.sleep(0.05)
    assert rec["status"] == CANCELLED


def test_task_recovery_marks_interrupted(state_dir):
    from backend.core import state_store
    from backend.core.task_manager import TaskManager, INTERRUPTED

    # 预置一条 running 记录
    rec = {"task_id": "t_dead", "idempotency_key": "k1", "platform": "mp", "kind": "collect",
           "params": {}, "status": "running", "created_at": time.time(), "started_at": time.time(),
           "updated_at": time.time(), "progress": {}, "items": [], "entry_ids": [],
           "error": None, "cursor": "page3", "cancel_requested": False, "resumable": False,
           "suggested_poll_interval": 2}
    state_store.append_jsonl(state_store.TASKS_DIR / "20260905.jsonl", rec)

    tm = TaskManager()
    interrupted = tm.recover()
    assert "t_dead" in interrupted
    assert tm.get("t_dead")["status"] == INTERRUPTED
    assert tm.get("t_dead")["resumable"] is True  # 有 cursor → 可续采


# ── html2md ──────────────────────────────────────────────

def test_html_to_markdown_basics():
    from backend.core.html2md import html_to_markdown
    html = "<h2>标题</h2><p>你好 <strong>世界</strong> <a href='https://x.com'>链接</a></p><ul><li>一</li><li>二</li></ul>"
    md = html_to_markdown(html)
    assert "## 标题" in md
    assert "**世界**" in md
    assert "[链接](https://x.com)" in md
    assert "- 一" in md and "- 二" in md


def test_html_to_markdown_strips_script():
    from backend.core.html2md import html_to_markdown
    md = html_to_markdown("<p>正文</p><script>alert(1)</script>")
    assert "alert" not in md and "正文" in md


# ── library（§10 原子提交/去重/导出） ─────────────────────

def _mk_item(url: str, text: str = "正文内容") -> dict:
    return {
        "platform_item_id": "mp:abc123",
        "source_url": url,
        "content_type": "article",
        "title": "测试文章",
        "author": {"name": "测试号", "id": "gh_1", "url": ""},
        "publish_time": "2026-09-05T10:00:00",
        "content_md": f"# 测试\n\n{text}",
        "content_text": f"# 测试\n\n{text}",
        "media_paths": [],
        "extra": {},
    }


def test_library_commit_and_complete_marker(state_dir, library_dir):
    from backend import library
    result = library.commit_entry("mp", _mk_item("https://mp.weixin.qq.com/s/abc123"))
    entry_dir = library.find_entry(result["entry_id"])
    assert entry_dir is not None
    assert (entry_dir / "_COMPLETE").exists()
    meta = json.loads((entry_dir / "metadata.json").read_text(encoding="utf-8"))
    assert meta["schema_version"] == "1.0"
    assert meta["platform"] == "mp"
    assert meta["canonical_url"] == "https://mp.weixin.qq.com/s/abc123"
    assert any(f["path"] == "content.md" for f in meta["files"])
    assert not any(p.name.startswith(".tmp_") for p in entry_dir.parent.iterdir())


def test_library_dedup_same_content(state_dir, library_dir):
    from backend import library
    r1 = library.commit_entry("mp", _mk_item("https://mp.weixin.qq.com/s/abc123?chksm=1"))
    r2 = library.commit_entry("mp", _mk_item("https://mp.weixin.qq.com/s/abc123?scene=2"))
    assert not r1["deduped"]
    assert r2["deduped"]
    assert r1["entry_id"] == r2["entry_id"]


def test_library_content_change_versions_entry(state_dir, library_dir):
    from backend import library
    r1 = library.commit_entry("mp", _mk_item("https://mp.weixin.qq.com/s/abc123", "v1文本"))
    r2 = library.commit_entry("mp", _mk_item("https://mp.weixin.qq.com/s/abc123", "v2修改后文本"))
    assert not r2["deduped"]
    assert r1["dir"] != r2["dir"]


def test_library_export_with_checksum(state_dir, library_dir, tmp_path):
    from backend import library
    r = library.commit_entry("mp", _mk_item("https://mp.weixin.qq.com/s/abc123"))
    dest = tmp_path / "export"
    result = library.export_entries([r["entry_id"]], str(dest))
    assert result["exported"] == 1
    exported_dir = next((dest).iterdir())
    assert (exported_dir / "_COMPLETE").exists()


def test_library_list_filters(state_dir, library_dir):
    from backend import library
    library.commit_entry("mp", _mk_item("https://mp.weixin.qq.com/s/abc123"))
    entries = library.list_entries("mp")
    assert len(entries) == 1
    assert library.list_entries("douyin") == []


# ── security（§4） ───────────────────────────────────────

def test_local_access_token_and_origin(state_dir):
    from flask import Flask
    from backend.core import state_store
    from backend.security import local_access_required

    app = Flask(__name__)
    token = state_store.ensure_service_token(5200)["token"]

    @app.post("/protected")
    @local_access_required
    def protected():
        return {"ok": True}

    client = app.test_client()
    # 无令牌无同源 → 403
    assert client.post("/protected").status_code == 403
    # 令牌 → 200
    assert client.post("/protected", headers={"Authorization": f"Bearer {token}"}).status_code == 200
    # 同源 Origin → 200
    assert client.post("/protected", headers={"Origin": "http://127.0.0.1:5200"},
                       base_url="http://127.0.0.1:5200/").status_code == 200
    # 恶意外域 Origin → 403
    assert client.post("/protected", headers={"Origin": "http://evil.example.com"}).status_code == 403
    # 非本机 Host → 403（防 DNS rebinding）
    assert client.post("/protected", headers={"Authorization": f"Bearer {token}"},
                       base_url="http://evil.example.com/").status_code == 403


# ── MCP 协议（§7） ───────────────────────────────────────

@pytest.fixture()
def mcp_client(state_dir, monkeypatch):
    from backend.mcp_server import app as mcp_app, backend_client
    from backend.core import state_store
    token = state_store.ensure_service_token(5200)["token"]

    def fake_call(path, method="GET", payload=None, timeout=60):
        if path == "/api/collect/detect-url":
            return {"success": True, "summary": "识别成功", "data": {"platform": "mp"}, "error": None}
        if path == "/api/collect/mp":
            return {"success": True, "summary": "任务已创建",
                    "data": {"task_id": "t_test123", "status": "queued"}, "error": None}
        return {"success": True, "summary": "ok", "data": {}, "error": None}

    monkeypatch.setattr(backend_client, "call", fake_call)
    client = mcp_app.create_app().test_client()
    return client, token


def _rpc(client, token, method, params=None, msg_id=1):
    body = {"jsonrpc": "2.0", "id": msg_id, "method": method}
    if params is not None:
        body["params"] = params
    return client.post("/mcp", data=json.dumps(body), content_type="application/json",
                       headers={"Authorization": f"Bearer {token}"})


def test_mcp_initialize(mcp_client):
    client, token = mcp_client
    resp = _rpc(client, token, "initialize")
    assert resp.status_code == 200
    result = resp.get_json()["result"]
    assert result["protocolVersion"] == "2025-03-26"
    assert "tools" in result["capabilities"]
    assert result["serverInfo"]["name"] == "wechat-mp-tools"


def test_mcp_unauthorized(mcp_client):
    client, _ = mcp_client
    resp = client.post("/mcp", data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
                       content_type="application/json")
    assert resp.status_code == 401


def test_mcp_tools_list_and_call(mcp_client):
    client, token = mcp_client
    tools = _rpc(client, token, "tools/list").get_json()["result"]["tools"]
    names = {t["name"] for t in tools}
    assert {"mp_collect", "mp_start_auth", "library_list", "service_status",
            "platform_capabilities"} <= names
    # 每个 tool 都有 inputSchema
    assert all(t.get("inputSchema", {}).get("type") == "object" for t in tools)

    resp = _rpc(client, token, "tools/call",
                {"name": "collect_detect_url", "arguments": {"url": "https://mp.weixin.qq.com/s/x"}})
    result = resp.get_json()["result"]
    assert result["isError"] is False
    payload = json.loads(result["content"][0]["text"])
    assert payload["success"] and payload["data"]["platform"] == "mp"


def test_mcp_resources(mcp_client):
    client, token = mcp_client
    resources = _rpc(client, token, "resources/list").get_json()["result"]["resources"]
    uris = {r["uri"] for r in resources}
    assert {"mp-tools://status", "mp-tools://tasks", "mp-tools://auth/pending",
            "mp-tools://capabilities"} <= uris
    resp = _rpc(client, token, "resources/read", {"uri": "mp-tools://capabilities/mp"})
    payload = json.loads(resp.get_json()["result"]["contents"][0]["text"])
    assert payload["platform"] == "mp"


# ── AuthRequest（§9） ────────────────────────────────────

@pytest.fixture()
def auth_env(monkeypatch):
    from backend import auth_requests
    monkeypatch.setattr(auth_requests, "_requests", {})
    monkeypatch.setattr(auth_requests, "QR_TTL_SECONDS", 180)
    return auth_requests


def test_auth_start_returns_qr_image(auth_env, monkeypatch):
    auth_env = auth_env

    def fake_start():
        return {"qr_content": "https://weread.qq.com/x/123", "message": "请扫码"}

    monkeypatch.setitem(auth_env._PLATFORMS, "mp", {"start": fake_start, "check": lambda: {"status": "pending"}})
    rec = auth_env.start_auth("mp")
    assert rec["status"] == "pending"
    assert rec["qr_image"].startswith("data:image/png;base64,")
    base64.b64decode(rec["qr_image"].split(",", 1)[1])  # 是合法 PNG base64


def test_auth_single_active_request(auth_env, monkeypatch):
    def fake_start():
        return {"qr_content": "https://weread.qq.com/x/1", "message": ""}

    monkeypatch.setitem(auth_env._PLATFORMS, "mp", {"start": fake_start, "check": lambda: {"status": "pending"}})
    r1 = auth_env.start_auth("mp")
    r2 = auth_env.start_auth("mp")
    assert r1["id"] == r2["id"]  # 活跃期内复用同一请求


def test_auth_refresh_budget(auth_env, monkeypatch):
    calls = {"n": 0}

    def fake_start():
        calls["n"] += 1
        return {"qr_content": f"https://weread.qq.com/x/{calls['n']}", "message": ""}

    monkeypatch.setitem(auth_env._PLATFORMS, "mp", {"start": fake_start, "check": lambda: {"status": "pending"}})
    auth_env.start_auth("mp")
    for i in range(auth_env.REFRESH_BUDGET):
        auth_env.start_auth("mp", refresh=True)
    from backend.core.errors import CollectError
    with pytest.raises(CollectError):
        auth_env.start_auth("mp", refresh=True)


def test_auth_expiry_on_check(auth_env, monkeypatch):
    def fake_start():
        return {"qr_content": "https://weread.qq.com/x/exp", "message": ""}

    monkeypatch.setitem(auth_env._PLATFORMS, "mp", {"start": fake_start,
                                                    "check": lambda: {"status": "pending"}})
    rec = auth_env.start_auth("mp")
    # 把过期时间拨回过去
    from backend import auth_requests
    auth_env._requests[rec["id"]]["expire_at"] = time.time() - 1
    checked = auth_env.check_auth(rec["id"])
    assert checked["status"] == "expired"
    # check 不返回二维码（只读，不隐式发新码）
    assert "qr_image" not in checked


def test_mp_blocked_page_detection():
    """微信风控/错误页必须被识别，绝不能当成功入库（爆款桥接教训）。"""
    from backend.collectors.mp import _detect_blocked_page

    # 环境异常挑战页（200 + 有内容，但不是文章）
    assert _detect_blocked_page('<html>环境异常<br>完成验证后即可继续访问 去验证</html>')
    assert _detect_blocked_page('<html><body>参数错误</body></html>')
    # 空壳挑战页：无任何文章标记
    assert _detect_blocked_page('<html><body>： ， 。</body></html>')
    # 被删除/违规页
    assert _detect_blocked_page('<html>该内容已被发布者删除</html>')

    # 正常文章页不误伤（短链采集页含 msg_title/js_content）
    real = '<html><script>var msg_title = "标题";</script><div id="js_content">正文</div></html>'
    assert _detect_blocked_page(real) is None
    # 含"环境异常"字样的正常文章不误伤（正文里提到该词）
    article_mention = real.replace('正文', '正文讨论了环境异常问题')
    assert _detect_blocked_page(article_mention) is None


def test_credential_store_roundtrip(state_dir, monkeypatch):
    """敏感凭证加解密往返 + 旧明文透传兼容。"""
    import importlib
    from backend.core import state_store
    from backend.core import credential_store
    # 用临时 state 目录，避免污染真实凭证
    monkeypatch.setattr(state_store, "CREDENTIALS_DIR", state_dir / "credentials")
    importlib.reload(credential_store)

    plain = "cookie=abc;token=xyz"
    enc = credential_store.encrypt_secret(plain)
    assert enc != plain and enc.startswith("gAAAAA")
    assert credential_store.decrypt_secret(enc) == plain
    # 旧明文透传
    assert credential_store.decrypt_secret("plain-cookie") == "plain-cookie"
    # 损坏密文返回 None
    assert credential_store.decrypt_secret("gAAAAAcorrupted!") is None


def test_validate_state_rolls_back_corrupt(state_dir, monkeypatch):
    """state 校验：损坏 JSON 从 .bak 回滚，残留 .tmp 被清理。"""
    from backend.core import state_store
    (state_dir / "x.json").write_text('{"a": 1}', encoding="utf-8")
    (state_dir / "x.json.bak").write_text('{"a": 2}', encoding="utf-8")
    (state_dir / "x.json").write_text('{broken', encoding="utf-8")  # 损坏
    (state_dir / "stale.tmp").write_text("junk", encoding="utf-8")

    import json as _json
    monkeypatch.setattr(state_store, "STATE_DIR", state_dir)
    affected = state_store.validate_state_dir()
    assert _json.loads((state_dir / "x.json").read_text(encoding="utf-8")) == {"a": 2}  # 已回滚
    assert not (state_dir / "stale.tmp").exists()  # 已清理
    assert any("rollback" in a for a in affected)


def _run_task(tm, runner, params=None):
    from backend.core.task_manager import TaskManager
    rec, _ = tm.create("mp", "collect", params or {"urls": ["u"]}, runner)
    for _ in range(100):
        rec = tm.get(rec["task_id"])
        if rec["status"] not in ("queued", "running", "waiting_auth"):
            break
        time.sleep(0.05)
    return rec


def test_task_all_failed_is_failed(state_dir):
    """全失败必须判 failed，不得误报 partial（上一版 bug）。"""
    from backend.core.task_manager import TaskManager, FAILED, PARTIAL

    def runner(ctx):
        ctx.report(total=3)
        ctx.item("a", "failed", "x")
        ctx.item("b", "failed", "y")
        ctx.item("c", "failed", "z")

    rec = _run_task(TaskManager(), runner)
    assert rec["status"] == FAILED, rec["status"]
    assert rec["status"] != PARTIAL


def test_task_failed_plus_skipped_is_failed(state_dir):
    """失败+跳过但无成功：无新产物成功，仍判 failed（注明跳过数）。"""
    from backend.core.task_manager import TaskManager, FAILED

    def runner(ctx):
        ctx.report(total=3)
        ctx.item("a", "skipped", "已存在")
        ctx.item("b", "failed", "boom")

    rec = _run_task(TaskManager(), runner)
    assert rec["status"] == FAILED
    assert rec.get("detail", {}).get("skipped_existing") == 1


def test_task_all_skipped_is_succeeded_with_note(state_dir):
    """全部已存在而跳过：不判失败，注明 all_skipped_existing。"""
    from backend.core.task_manager import TaskManager, SUCCEEDED

    def runner(ctx):
        ctx.report(total=2)
        ctx.item("a", "skipped", "已存在")
        ctx.item("b", "skipped", "已存在")

    rec = _run_task(TaskManager(), runner)
    assert rec["status"] == SUCCEEDED
    assert rec.get("detail", {}).get("all_skipped_existing") is True


def test_task_mixed_success_failed_is_partial(state_dir):
    """成功与失败并存 -> partial（保留原行为）。"""
    from backend.core.task_manager import TaskManager, PARTIAL

    def runner(ctx):
        ctx.report(total=2)
        ctx.item("a", "succeeded")
        ctx.item("b", "failed", "boom")

    rec = _run_task(TaskManager(), runner)
    assert rec["status"] == PARTIAL


def test_platform_strict_host_matching():
    """URL 平台识别必须用严格域名匹配，伪造域名/端口不容错认。"""
    from backend.collect_api import _platform_of

    # 正常识别
    assert _platform_of("https://www.bilibili.com/video/BV1xx") == "bilibili"
    assert _platform_of("https://b23.tv/abc") == "bilibili"
    assert _platform_of("https://www.douyin.com/video/1") == "douyin"
    assert _platform_of("https://mp.weixin.qq.com/s/x") == "mp"
    assert _platform_of("https://www.kuaishou.com/short-video/x") == "kuaishou"
    assert _platform_of("https://www.xiaohongshu.com/explore/x") == "xiaohongshu"
    # 端口不影响 hostname 判定
    assert _platform_of("https://bilibili.com:8443/v/1") == "bilibili"
    # 伪造域名不误命中
    assert _platform_of("https://evilbilibili.com/x") == "generic"
    assert _platform_of("https://notdouyin.com/x") == "generic"
    assert _platform_of("https://bilibili.com.evil.com/x") == "generic"
    # 非 http(s) / 无 hostname
    assert _platform_of("javascript:alert(1)") == "generic"
    assert _platform_of("") == "generic"


def test_canonical_platform_id():
    """detect 平台名 → 内容库存储名 的一致映射（单一事实来源）。"""
    from backend.core.urlnorm import canonical_platform_id
    assert canonical_platform_id("bilibili") == "bili"
    assert canonical_platform_id("kuaishou") == "ks"
    assert canonical_platform_id("xiaohongshu") == "xhs"
    assert canonical_platform_id("mp") == "mp"
    assert canonical_platform_id("channels") == "channels"
    assert canonical_platform_id("unknown") == "unknown"


def test_task_queue_cancel_before_runner(state_dir):
    """排队任务在 runner 启动前取消时，不应执行 runner。"""
    from backend.core.task_manager import TaskManager
    started = []
    import backend.core.task_manager as mod
    old_workers, old_queue = mod.MAX_WORKERS, mod.MAX_QUEUE
    try:
        mod.MAX_WORKERS = 1
        mod.MAX_QUEUE = 2
        tm = TaskManager()
        gate = threading.Event()
        def blocker(ctx): gate.wait(2)
        first, _ = tm.create("mp", "block", {"n": 1}, blocker)
        second, _ = tm.create("mp", "collect", {"n": 2}, lambda ctx: started.append(True))
        tm.request_cancel(second["task_id"])
        gate.set()
        for _ in range(100):
            rec = tm.get(second["task_id"])
            if rec["status"] in ("cancelled", "succeeded", "failed"):
                break
            time.sleep(0.02)
        assert rec["status"] == "cancelled"
        assert started == []
    finally:
        mod.MAX_WORKERS, mod.MAX_QUEUE = old_workers, old_queue


def test_retry_failed_only_uses_failed_keys(state_dir):
    """重试入口只携带失败条目 URL。"""
    from backend.core.task_manager import TaskManager
    captured = []
    tm = TaskManager()
    def runner(ctx):
        captured.extend(ctx.params.get("urls", []))
        ctx.report(total=len(captured))
        for u in captured: ctx.item(u, "succeeded")
    original, _ = tm.create("mp", "collect", {"urls": ["ok", "bad", "skip"]},
                            lambda ctx: (ctx.report(total=3), ctx.item("ok", "succeeded"),
                                         ctx.item("bad", "failed", "x"), ctx.item("skip", "skipped", "exists")))
    for _ in range(100):
        original = tm.get(original["task_id"])
        if original["status"] not in ("queued", "running"): break
        time.sleep(.02)
    rec, created, count = tm.retry_failed(original["task_id"], runner)
    assert created and count == 1
    assert rec["params"]["urls"] == ["bad"]


def test_library_search_and_pagination(state_dir, library_dir):
    from backend import library
    library.commit_entry("mp", _mk_item("https://mp.weixin.qq.com/s/search-a", "Alpha 文本"))
    library.commit_entry("mp", _mk_item("https://mp.weixin.qq.com/s/search-b", "Beta 文本"))
    assert len(library.list_entries("mp")) == 2
    result = library.list_entries("mp", query="测试号", page=1, page_size=1)
    assert result["total"] == 2 and result["entries"][0]["title"] == "测试文章"
    result = library.list_entries("mp", page=2, page_size=1)
    assert result["total"] == 2 and len(result["entries"]) == 1 and result["has_more"] is False


def test_library_integrity_detects_missing_and_hash(state_dir, library_dir):
    from backend import library
    r = library.commit_entry("mp", _mk_item("https://mp.weixin.qq.com/s/integrity"))
    entry = library.find_entry(r["entry_id"])
    meta = json.loads((entry / "metadata.json").read_text(encoding="utf-8"))
    content = entry / "content.md"
    content.write_text("tampered", encoding="utf-8")
    result = library.check_entry_integrity(entry, meta)
    assert result["status"] == "corrupt"
    assert any(f["path"] == "content.md" and f["status"] in {"hash_mismatch", "size_mismatch"}
               for f in result["files"])


def test_library_backup_validate_restore_excludes_credentials(state_dir, library_dir, tmp_path):
    from backend import backup, library
    r = library.commit_entry("mp", _mk_item("https://mp.weixin.qq.com/s/backup"))
    dest = tmp_path / "library-backup.zip"
    created = backup.create_backup(str(dest))
    assert created["file_count"] >= 2 and dest.exists()
    validation = backup.validate_backup(str(dest))
    assert validation["valid"] is True
    import zipfile
    with zipfile.ZipFile(dest) as z:
        names = z.namelist()
        assert "BACKUP_MANIFEST.json" in names
        assert not any("credential" in n or "service.json" in n or "mp_admin_config" in n for n in names)
    # 恢复到当前目录的 merge 模式，条目应保持完整
    restored = backup.restore_backup(str(dest), "merge")
    assert restored["credentials_restored"] is False
    assert restored["restored_entries"] >= 1


def test_library_backup_rejects_corrupt_archive(state_dir, library_dir, tmp_path):
    from backend import backup
    bad = tmp_path / "bad.zip"
    bad.write_bytes(b"not a zip")
    with pytest.raises(Exception):
        backup.validate_backup(str(bad))


def test_library_api_page_size_alone_enables_paging(state_dir, library_dir):
    from backend import library
    library.commit_entry("mp", _mk_item("https://mp.weixin.qq.com/s/page-size"))
    assert isinstance(library.list_entries("mp", page=1, page_size=1), dict)
