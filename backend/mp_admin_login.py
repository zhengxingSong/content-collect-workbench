"""公众号后台管理员扫码登录（设计文档 §9 扩展，2026-09-06）。

背景：微信读书平台登录接口被官方下线（/web/login/platform* 404），原中转通道失效。
本模块改走 mp.weixin.qq.com 官方公众平台登录（管理员扫码）：
  - Playwright 打开后台首页 → 截取登录二维码 → Web/agent 直接展示（无需中转）
  - 扫码确认后页面跳转 /cgi-bin/home?...&token=NNN → 提取 token + 导出 Cookie
  - 凭证落 data/mp_admin_config.json；articles.py 据此走官方 appmsg 接口拉文章列表
"""

from __future__ import annotations

import base64
import json
import threading
import time

from flask import Blueprint, jsonify, request

from backend.config import DATA_DIR, load_json, save_json
from backend.runtime import launch_chromium

mp_admin_bp = Blueprint("mp_admin", __name__, url_prefix="/api/mp-admin")

MP_CONFIG_FILE = DATA_DIR / "mp_admin_config.json"
LOGIN_URL = "https://mp.weixin.qq.com/"
HOME_URL_PREFIX = "/cgi-bin/home"

_state = {
    "status": "idle",       # idle / scanning / success / failed
    "message": "",
    "progress": 0,
    "qr_image": "",         # data URL（PNG base64），供 Web/agent 直接展示
}
_lock = threading.Lock()
_thread: threading.Thread | None = None


def _set(status: str, message: str = "", progress: int = 0, qr_image: str | None = None):
    with _lock:
        _state["status"] = status
        _state["message"] = message
        _state["progress"] = progress
        if qr_image:
            _state["qr_image"] = qr_image


def _get_saved() -> dict | None:
    cfg = load_json(MP_CONFIG_FILE)
    if cfg and cfg.get("cookie") and cfg.get("token"):
        # 兼容迁移：旧明文 / 已加密混用场景统一按加密值解密读取
        from backend.core.credential_store import decrypt_secret
        out = dict(cfg)
        out["cookie"] = decrypt_secret(cfg["cookie"])
        out["token"] = decrypt_secret(cfg["token"])
        # 解密失败（密钥不匹配/损坏）不返回，视为未认证
        if out["cookie"] and out["token"]:
            return out
        return None
    return None


def get_mp_admin_credential() -> dict | None:
    """供 articles.py 使用：返回 {cookie, token} 或 None。"""
    return _get_saved()


def _validate_saved() -> bool:
    """带 Cookie 请求后台 home 页，判断是否仍有效。"""
    cfg = _get_saved()
    if not cfg:
        return False
    try:
        from curl_cffi import requests as c_req
        resp = c_req.get(
            f"https://mp.weixin.qq.com/cgi-bin/home?t=home/index&lang=zh_CN&token={cfg['token']}",
            headers={"Cookie": cfg["cookie"], "Referer": "https://mp.weixin.qq.com/"},
            timeout=15, impersonate="chrome",
        )
        return resp.status_code == 200 and "appmsg" in resp.text
    except Exception:
        return False


def _do_login():
    """后台线程：打开后台登录页 → 截二维码 → 轮询跳转 → 落盘凭证。"""
    from playwright.sync_api import sync_playwright

    headless = _wmt_headless()
    _set("scanning", "正在打开微信公众平台登录页...", 10)
    try:
        with sync_playwright() as p:
            browser = launch_chromium(p.chromium, headless=headless,
                                      args=["--disable-blink-features=AutomationControlled"])
            context = browser.new_context(locale="zh-CN")
            page = context.new_page()
            page.goto(LOGIN_URL, timeout=45000, wait_until="domcontentloaded")

            # 等待登录二维码出现（首页登录浮层 img.qrcode）
            qr_el = None
            for sel in ("img.qrcode", "div.login__type__container__scan img", "img[src*='qrcode']"):
                try:
                    qr_el = page.wait_for_selector(sel, timeout=8000)
                    if qr_el:
                        break
                except Exception:
                    continue
            if not qr_el:
                # 兜底：截首屏（非 headless 用户直接看窗口；headless 场景提示失败）
                if headless:
                    _set("failed", "未找到登录二维码元素，页面结构可能已变化")
                    browser.close()
                    return
                shot = page.screenshot(type="png")
            else:
                qr_el.scroll_into_view_if_needed()
                shot = qr_el.screenshot(type="png")

            qr_data_url = "data:image/png;base64," + base64.b64encode(shot).decode()
            _set("scanning", "请使用管理员微信扫码并确认登录", 40, qr_data_url)

            # 轮询登录成功：页面跳转到含 token= 的后台首页
            token = ""
            deadline = time.time() + 300
            while time.time() < deadline:
                time.sleep(2)
                with _lock:
                    if _state["status"] == "idle":
                        browser.close()
                        return
                try:
                    url = page.url or ""
                except Exception:
                    continue
                if "token=" in url:
                    token = url.split("token=")[-1].split("&")[0]
                    break
                # 二维码过期：页面可能出现"已过期"提示，重新截取
                try:
                    if page.query_selector("text=已过期"):
                        page.reload(wait_until="domcontentloaded")
                        for sel in ("img.qrcode", "img[src*='qrcode']"):
                            el = page.query_selector(sel)
                            if el:
                                shot = el.screenshot(type="png")
                                _set("scanning", "二维码已刷新，请重新扫码", 40,
                                     "data:image/png;base64," + base64.b64encode(shot).decode())
                                break
                except Exception:
                    pass

            if not token:
                _set("failed", "扫码登录超时（5分钟），请重试")
                browser.close()
                return

            cookie_str = "; ".join(
                f"{c['name']}={c['value']}" for c in context.cookies("https://mp.weixin.qq.com")
            )
            # 拿昵称（失败不影响登录态）
            nickname = ""
            try:
                page.goto(f"https://mp.weixin.qq.com/cgi-bin/home?t=home/index&lang=zh_CN&token={token}",
                          timeout=30000, wait_until="domcontentloaded")
                el = page.query_selector(".weui-desktop_account__nickname, .user_name")
                nickname = (el.inner_text() if el else "").strip()
            except Exception:
                pass

            browser.close()

        from backend.core.credential_store import encrypt_secret
        save_json(MP_CONFIG_FILE, {
            "cookie": encrypt_secret(cookie_str),
            "token": encrypt_secret(token),
            "nickname": nickname,
            "type": "mp_admin",
            "save_time": time.time(),
            "encrypted": True,
        })
        _set("success", f"登录成功！{nickname or '公众号后台'}", 100)
    except Exception as e:
        _set("failed", f"登录异常: {str(e)[:120]}")


def _wmt_headless() -> bool:
    import os
    return os.environ.get("WMT_HEADLESS") == "1"


@mp_admin_bp.route("/login", methods=["POST"])
def login():
    global _thread
    with _lock:
        if _state["status"] == "scanning":
            return jsonify({"message": "正在登录中，请扫码", "login_state": _state})
    _set("scanning", "正在启动登录流程...", 5)
    _thread = threading.Thread(target=_do_login, daemon=True)
    _thread.start()
    return jsonify({"message": "已发起公众号后台扫码登录"})


@mp_admin_bp.route("/status", methods=["GET"])
def status():
    with _lock:
        st = dict(_state)
    saved = _get_saved()
    return jsonify({
        "login_state": st,
        "logged_in": bool(saved),
        "nickname": (saved or {}).get("nickname", ""),
        "save_time": (saved or {}).get("save_time", 0),
        "credential_valid": _validate_saved() if saved else False,
    })


@mp_admin_bp.route("/cancel", methods=["POST"])
def cancel():
    _set("idle", "登录已取消")
    return jsonify({"message": "已取消"})


@mp_admin_bp.route("/logout", methods=["POST"])
def logout():
    try:
        MP_CONFIG_FILE.unlink()
    except OSError:
        pass
    _set("idle", "已退出登录")
    return jsonify({"message": "已退出"})


@mp_admin_bp.route("/check", methods=["GET"])
def check():
    saved = _get_saved()
    if not saved:
        return jsonify({"valid": False, "message": "尚未登录公众号后台"})
    ok = _validate_saved()
    return jsonify({"valid": ok,
                    "message": "凭证有效" if ok else "凭证已失效，请重新扫码登录"})


# ── 官方高级能力（统一路由到 mp 后台服务，2026-09-06） ─────

def mp_admin_get(path: str, params: dict, timeout: int = 25):
    """带管理员凭证请求 mp 后台官方接口；凭证缺失/失效抛 RuntimeError。"""
    cfg = _get_saved()
    if not cfg:
        raise RuntimeError("mp_admin_not_configured")
    from curl_cffi import requests as c_req
    params = {**params, "token": cfg["token"], "lang": "zh_CN", "f": "json", "ajax": "1"}
    resp = c_req.get(
        f"https://mp.weixin.qq.com{path}",
        params=params,
        headers={"Cookie": cfg["cookie"], "Referer": "https://mp.weixin.qq.com/",
                 "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"},
        timeout=timeout, impersonate="chrome",
    )
    if resp.status_code != 200:
        raise RuntimeError(f"mp_admin HTTP {resp.status_code}")
    data = resp.json()
    ret = (data.get("base_resp") or {}).get("ret")
    if ret not in (0, None):
        if ret == 200013:
            raise RuntimeError("mp_admin 频率限制，请稍后再试")
        if ret in (200003, 200018):
            raise PermissionError("公众号后台登录失效，请重新扫码")
        raise RuntimeError(f"mp_admin 接口错误 ret={ret}: {(data.get('base_resp') or {}).get('err_msg','')}")
    return data


@mp_admin_bp.route("/search-biz", methods=["GET"])
def search_biz():
    """官方接口：按名称搜索公众号（返回 fakeid/nickname/头像/签名）。"""
    query = (request.args.get("query") or "").strip()
    if not query:
        return jsonify({"error": "query 不能为空"}), 400
    try:
        data = mp_admin_get("/cgi-bin/searchbiz", {
            "action": "search_biz", "begin": 0, "count": 10, "query": query,
        })
    except RuntimeError as e:
        if "mp_admin_not_configured" in str(e):
            return jsonify({"error": "尚未登录公众号后台（仪表盘 → 扫码认证）"}), 401
        return jsonify({"error": str(e)}), 500
    except PermissionError as e:
        return jsonify({"error": str(e)}), 401
    out = []
    for item in data.get("list") or []:
        if isinstance(item, dict) and item.get("fakeid"):
            out.append({
                "fakeid": item.get("fakeid"),
                "nickname": item.get("nickname", ""),
                "alias": item.get("alias", ""),
                "round_head_img": item.get("round_head_img", ""),
                "signature": item.get("signature", ""),
                "service_type": item.get("service_type", 0),
            })
    return jsonify({"list": out, "total": len(out)})
