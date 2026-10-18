"""密码与密保散列（标准库 hashlib.pbkdf2_hmac，不引入额外依赖）。

存储格式：`pbkdf2_sha256$迭代次数$盐$散列`（docs/02-数据库设计.md 2.1）
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from typing import Any

ALGORITHM = "pbkdf2_sha256"
ITERATIONS = 200_000
SALT_BYTES = 16
DIGEST = "sha256"


def _pbkdf2(password: str, salt_hex: str, iterations: int) -> str:
    dk = hashlib.pbkdf2_hmac(
        DIGEST,
        password.encode("utf-8"),
        bytes.fromhex(salt_hex),
        iterations,
    )
    return dk.hex()


def hash_secret(raw: Any, iterations: int = ITERATIONS) -> str:
    """生成 `pbkdf2_sha256$迭代$盐$散列`。"""
    text = "" if raw is None else str(raw)
    salt_hex = secrets.token_hex(SALT_BYTES)
    digest = _pbkdf2(text, salt_hex, iterations)
    return f"{ALGORITHM}${iterations}${salt_hex}${digest}"


def verify_secret(raw: Any, stored: str | None) -> bool:
    """校验明文与散列是否匹配。

    注意：这里**不做任何规范化**（密码区分大小写）。
    密保答案的大小写不敏感由 `verify_answer()` 负责，两边必须成对使用。
    """
    if not stored:
        return False
    try:
        algorithm, iterations, salt_hex, digest = stored.split("$")
        if algorithm != ALGORITHM:
            return False
        expected = _pbkdf2("" if raw is None else str(raw), salt_hex, int(iterations))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(expected, digest)


def normalize(raw: Any) -> str:
    """密保答案统一规范化：去首尾空格 + 忽略大小写。"""
    return ("" if raw is None else str(raw)).strip().casefold()


def hash_answer(raw: Any, iterations: int = ITERATIONS) -> str:
    """密保答案散列（先规范化再散列，与 verify_answer 成对）。"""
    return hash_secret(normalize(raw), iterations)


def verify_answer(raw: Any, stored: str | None) -> bool:
    """密保答案校验（规范化后比对，与 hash_answer 成对）。"""
    return verify_secret(normalize(raw), stored)


def new_token(prefix: str = "") -> str:
    """随机 token（会话 / 密保票据）。"""
    return f"{prefix}{secrets.token_urlsafe(32)}"
