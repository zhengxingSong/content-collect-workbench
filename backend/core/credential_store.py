"""敏感凭证的加密存储（设计文档 §3.5 的最小诚实实现）。

策略：
- 敏感字段（cookie/token）用 Fernet（AES-128-CBC + HMAC）加密后落盘；
- 主密钥（Fernet key）：
  - Windows：用 DPAPI 保护后写入 `state/credentials/`，换取"当前 Windows 用户可解密、他用户不能"的系统级保护；
  - 其他平台（Linux/Docker）：主钥以 0600 权限落 `state/credentials/`，仅依赖文件权限收敛。
    因此**在 Linux/Docker 下不宣称系统级加密**——真正的边界是文件权限 + 目录不入库。

兼容迁移：读取到旧明文凭证时，就地加密重写（向后兼容 v1）。
失败降级：解密失败不阻塞功能——返回 None 并记日志，避免认证静默断裂。
"""

from __future__ import annotations

import base64
import logging
import os
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

try:
    from cryptography.fernet import Fernet, InvalidToken
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    _CRYPTO = True
except ImportError:  # cryptography 未安装时降级为明文（极少见，依赖树通常已含）
    _CRYPTO = False

from backend.core.state_store import CREDENTIALS_DIR, _restrict_perms

MASTER_KEY_FILE = CREDENTIALS_DIR / "master.key"


def _dpapi_protect(data: bytes) -> bytes:
    """Windows DPAPI 加密（当前用户范围）。返回 blob。"""
    import ctypes
    from ctypes import wintypes
    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]
    buffer_in = ctypes.create_string_buffer(data)
    blob_in = DATA_BLOB(len(data), ctypes.cast(buffer_in, ctypes.POINTER(ctypes.c_byte)))
    blob_out = DATA_BLOB()
    if not ctypes.windll.crypt32.CryptProtectData(
            ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)):
        raise OSError("CryptProtectData failed")
    out = ctypes.string_at(blob_out.pbData, blob_out.cbData)
    ctypes.windll.kernel32.LocalFree(blob_out.pbData)
    return out


def _dpapi_unprotect(blob: bytes) -> bytes:
    import ctypes
    from ctypes import wintypes
    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]
    buffer_in = ctypes.create_string_buffer(blob)
    blob_in = DATA_BLOB(len(blob), ctypes.cast(buffer_in, ctypes.POINTER(ctypes.c_byte)))
    blob_out = DATA_BLOB()
    if not ctypes.windll.crypt32.CryptUnprotectData(
            ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)):
        raise OSError("CryptUnprotectData failed")
    out = ctypes.string_at(blob_out.pbData, blob_out.cbData)
    ctypes.windll.kernel32.LocalFree(blob_out.pbData)
    return out


_MASTER_KEY_CACHE = None


def _get_master_key() -> bytes:
    """读取或创建主密钥。Windows 用 DPAPI 包裹，其余平台 0600 落盘。"""
    global _MASTER_KEY_CACHE
    if _MASTER_KEY_CACHE is not None:
        return _MASTER_KEY_CACHE
    key = None
    if MASTER_KEY_FILE.exists():
        raw = MASTER_KEY_FILE.read_bytes()
        if sys.platform == "win32":
            try:
                key = _dpapi_unprotect(raw)
            except Exception:
                key = None
        else:
            key = raw
    if not key:
        key = Fernet.generate_key()
        CREDENTIALS_DIR.mkdir(parents=True, exist_ok=True)
        payload = _dpapi_protect(key) if sys.platform == "win32" else key
        MASTER_KEY_FILE.write_bytes(payload)
        _restrict_perms(MASTER_KEY_FILE)
    _MASTER_KEY_CACHE = key
    return key


def _fernet() -> "Fernet | None":
    if not _CRYPTO:
        return None
    try:
        return Fernet(_get_master_key())
    except Exception as e:  # noqa: BLE001
        logger.warning("凭证加密初始化失败，降级明文存储: %s", e)
        return None


def encrypt_secret(plain: str) -> str:
    """加密敏感字段。返回 base64 密文；不可用时返回原文（调用方日志可见）。"""
    f = _fernet()
    if f is None or not plain:
        return plain
    return f.encrypt(plain.encode()).decode()


def decrypt_secret(cipher: str) -> str | None:
    """解密敏感字段。密文非法/密钥不匹配时返回 None（不抛异常）。"""
    if not _CRYPTO or not cipher:
        return cipher
    # 兼容旧明文：无加密标记的视为明文原样返回（向后迁移）
    if not cipher.startswith("gAAAAA"):
        return cipher
    try:
        return _fernet().decrypt(cipher.encode()).decode()
    except (InvalidToken, Exception):  # noqa: BLE001
        logger.error("凭证解密失败：密钥不匹配或数据损坏")
        return None


def protect_credential_file(path: Path, sensitive_fields: tuple[str, ...]) -> bool:
    """就地加密 JSON 文件中的敏感字段（幂等；兼容已加密）。返回是否发生写入。"""
    if not path.exists() or not _CRYPTO:
        return False
    try:
        import json as _json
        data = _json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return False
    changed = False
    for k in sensitive_fields:
        v = data.get(k)
        if isinstance(v, str) and v and not v.startswith("gAAAAA"):
            data[k] = encrypt_secret(v)
            changed = True
    if changed:
        import json as _json
        path.write_text(_json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        try:
            _restrict_perms(path)
        except Exception:
            pass
    return changed
