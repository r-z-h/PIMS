"""认证业务：密码、密保、会话、票据（docs/00-需求冻结.md FR-1）。

口径：
- 单密码 + 3 个密保问题，无角色无权限
- 会话 = HttpOnly Cookie（`pims_session`）+ `sys_setting.session_token`，默认 7 天
- 改密 / 重置密码都必须 3 个密保问题**全部答对**，密保校验失败一律
  `{"code":403,"message":"密保答案不正确"}`，绝不透露是哪一题错
- 登录密码错误 5 次锁定 1 分钟（docs/01-开发手册.md 4.6）
"""

from __future__ import annotations

import hmac
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.orm import Session

from .. import config
from ..models.password_reset_log import (
    ACTION_CHANGE,
    ACTION_RESET_BY_SECURITY,
    PasswordResetLog,
)
from ..models.sys_setting import (
    KEY_LOGIN_FAIL_COUNT,
    KEY_LOGIN_LOCKED_UNTIL,
    KEY_PASSWORD_HASH,
    KEY_PWD_INITIALIZED,
    KEY_RESET_TICKET,
    KEY_RESET_TICKET_EXPIRE_AT,
    KEY_SCHEMA_VERSION,
    KEY_SECURITY_READY,
    KEY_SESSION_EXPIRE_AT,
    KEY_SESSION_TOKEN,
    SEC_ANSWER_KEYS,
    SEC_QUESTION_KEYS,
)
from ..utils.errors import SECURITY_ANSWER_WRONG, BadRequest, Forbidden, NotFound
from ..utils.security import hash_answer, hash_secret, new_token, verify_answer, verify_secret
from . import setting_service as store

TICKET_PREFIX = "rst_"


# --------------------------------------------------------------------------- 状态


def status(db: Session, request_token: str | None = None) -> dict[str, Any]:
    """系统状态：是否需要初始化密保、**本请求**是否已登录、是否仍是初始密码。

    注意 `logged_in` 的语义是「本请求携带的 Cookie 有效」，而不是「服务端存在会话」：
    单用户系统里服务端只有一个 token，若只判断服务端是否有 token，
    任何没带 Cookie 的客户端都会被告知已登录，前端会据此渲染业务页并立刻收到 401，
    形成「401 → 跳登录 → 又跳回首页」的死循环。
    """
    return {
        "logged_in": session_valid(db, request_token),
        "security_ready": security_ready(db),
        "is_initial_password": is_initial_password(db),
        "pwd_initialized": store.get_int(db, KEY_PWD_INITIALIZED, 0),
        "schema_version": store.get_int(db, KEY_SCHEMA_VERSION, config.settings.schema_version),
        "app_version": config.settings.app_version,
    }


def security_ready(db: Session) -> bool:
    return store.get_bool(db, KEY_SECURITY_READY, False)


def is_initial_password(db: Session) -> bool:
    """`pwd_initialized=0` 表示还是初始密码 123456，登录后需要引导修改。"""
    return store.get_int(db, KEY_PWD_INITIALIZED, 0) == 0


def session_token(db: Session) -> str | None:
    """返回仍在有效期内的会话 token，否则 None。"""
    token = store.get(db, KEY_SESSION_TOKEN)
    if not token:
        return None
    expire_at = store.get_datetime(db, KEY_SESSION_EXPIRE_AT)
    if expire_at is not None and expire_at <= datetime.now():
        return None
    return token


def session_valid(db: Session, token: str | None) -> bool:
    current = session_token(db)
    if not current or not token:
        return False
    return hmac.compare_digest(current, token)


# --------------------------------------------------------------------------- 登录


def login(db: Session, password: str) -> dict[str, Any]:
    """密码登录；成功后覆盖旧 token（单用户系统）。"""
    _assert_not_locked(db)

    stored = store.get(db, KEY_PASSWORD_HASH)
    if not stored or not verify_secret(password, stored):
        _record_failure(db)
        raise BadRequest("密码不正确")

    _clear_failures(db)
    token = new_token()
    expire_at = datetime.now() + timedelta(days=config.settings.session_days)
    store.set_many(
        db,
        {
            KEY_SESSION_TOKEN: token,
            KEY_SESSION_EXPIRE_AT: expire_at.isoformat(timespec="seconds"),
        },
    )
    db.commit()
    return {
        "logged_in": True,
        "security_ready": security_ready(db),
        "is_initial_password": is_initial_password(db),
        "session_token": token,
        "expire_at": expire_at.strftime("%Y-%m-%d %H:%M:%S"),
        "expires_in": int(timedelta(days=config.settings.session_days).total_seconds()),
    }


def logout(db: Session) -> dict[str, Any]:
    store.remove(db, KEY_SESSION_TOKEN)
    store.remove(db, KEY_SESSION_EXPIRE_AT)
    db.commit()
    return {"logged_in": False}


def verify_password(db: Session, password: str) -> None:
    """**只校验密码**，不建会话、不改登录态（用于「撤销完工」「解锁」这类敏感操作）。

    与 `login` 的区别：登录会换 token（单用户系统会把别处的会话挤掉），
    而这里只是确认"是老板本人在操作"，不应该影响当前会话。
    仍复用登录失败计数与锁定策略，防止被暴力试密码。
    """
    _assert_not_locked(db)
    stored = store.get(db, KEY_PASSWORD_HASH)
    if not stored or not verify_secret(password, stored):
        _record_failure(db)
        raise BadRequest("密码不正确")
    _clear_failures(db)
    db.commit()


def _assert_not_locked(db: Session) -> None:
    locked_until = store.get_datetime(db, KEY_LOGIN_LOCKED_UNTIL)
    if locked_until and locked_until > datetime.now():
        seconds = int((locked_until - datetime.now()).total_seconds()) + 1
        raise BadRequest(f"密码错误次数过多，请 {seconds} 秒后再试")


def _record_failure(db: Session) -> None:
    count = store.get_int(db, KEY_LOGIN_FAIL_COUNT, 0) + 1
    if count >= config.settings.login_max_fail:
        locked_until = datetime.now() + timedelta(seconds=config.settings.login_lock_seconds)
        store.set_many(
            db,
            {
                KEY_LOGIN_FAIL_COUNT: 0,
                KEY_LOGIN_LOCKED_UNTIL: locked_until.isoformat(timespec="seconds"),
            },
        )
    else:
        store.set_value(db, KEY_LOGIN_FAIL_COUNT, count)
    db.commit()


def _clear_failures(db: Session) -> None:
    store.set_value(db, KEY_LOGIN_FAIL_COUNT, 0)
    store.remove(db, KEY_LOGIN_LOCKED_UNTIL)


# --------------------------------------------------------------------------- 密保


def questions(db: Session) -> dict[str, Any]:
    """取 3 个密保问题（不含答案），用于忘记密码页。"""
    if not security_ready(db):
        raise NotFound("密保未设置，请先登录后设置密保问题")
    items = [store.get(db, key) or "" for key in SEC_QUESTION_KEYS]
    return {"questions": items, "security_ready": True}


def _answers_all_correct(db: Session, answers: list[str] | None) -> bool:
    """3 题全对才返回 True；不对外暴露哪一题错。"""
    if not security_ready(db) or not answers or len(answers) != 3:
        return False
    stored = [store.get(db, key) for key in SEC_ANSWER_KEYS]
    if any(item is None for item in stored):
        return False
    results = [verify_answer(answers[i], stored[i]) for i in range(3)]
    return all(results)


def verify_security(db: Session, answers: list[str]) -> dict[str, Any]:
    """校验密保答案 → 下发 5 分钟有效的一次性票据（供重置密码使用）。"""
    if not security_ready(db):
        raise NotFound("密保未设置，请先登录后设置密保问题")

    if not _answers_all_correct(db, answers):
        db.add(
            PasswordResetLog(
                action=ACTION_RESET_BY_SECURITY,
                result="fail",
                detail="密保校验失败",
                created_at=datetime.now(),
            )
        )
        db.commit()
        raise Forbidden(SECURITY_ANSWER_WRONG)

    ticket = new_token(TICKET_PREFIX)
    ttl = config.settings.ticket_ttl_seconds
    store.set_many(
        db,
        {
            KEY_RESET_TICKET: ticket,
            KEY_RESET_TICKET_EXPIRE_AT: (datetime.now() + timedelta(seconds=ttl)).isoformat(timespec="seconds"),
        },
    )
    db.commit()
    return {"ticket": ticket, "expires_in": ttl}


def setup_security(db: Session, items: list[Any]) -> dict[str, Any]:
    """首次设置 3 组密保问题与答案（已登录才能调用）。

    问题明文保存（忘记密码页要回显），答案一律 pbkdf2 散列保存。
    重复调用视为重新设置，避免老板把自己锁在门外（单机单用户，仍需先通过密码登录）。
    """
    if len(items) != 3:
        raise BadRequest("必须设置 3 个密保问题")

    values: dict[str, Any] = {}
    for index, item in enumerate(items):
        question = getattr(item, "question", None) or (item.get("question") if isinstance(item, dict) else None)
        answer = getattr(item, "answer", None) or (item.get("answer") if isinstance(item, dict) else None)
        if not question or not answer:
            raise BadRequest("密保问题与答案都不能为空")
        values[SEC_QUESTION_KEYS[index]] = str(question).strip()
        values[SEC_ANSWER_KEYS[index]] = hash_answer(answer)
    values[KEY_SECURITY_READY] = "1"

    store.set_many(db, values)
    db.commit()
    return {"security_ready": True, "questions": [store.get(db, key) for key in SEC_QUESTION_KEYS]}


# --------------------------------------------------------------------------- 密码


def _ticket_valid(db: Session, ticket: str | None) -> bool:
    """密保票据是否有效（5 分钟一次性）。"""
    stored_ticket = store.get(db, KEY_RESET_TICKET)
    expire_at = store.get_datetime(db, KEY_RESET_TICKET_EXPIRE_AT)
    return bool(
        stored_ticket
        and ticket
        and hmac.compare_digest(stored_ticket, ticket)
        and expire_at is not None
        and expire_at > datetime.now()
    )


def change_password(
    db: Session,
    new_password: str,
    answers: list[str] | None = None,
    ticket: str | None = None,
    old_password: str | None = None,  # 兼容参数：按 FR-1.3 不校验
) -> dict[str, Any]:
    """已登录改密：3 个密保问题全部答对（或等价的密保票据）即可，无其他后门。"""
    if not security_ready(db):
        raise BadRequest("请先设置 3 个密保问题后再修改密码")

    verified = False
    if ticket:
        verified = _ticket_valid(db, ticket)
        if not verified:
            db.add(
                PasswordResetLog(
                    action=ACTION_CHANGE,
                    result="fail",
                    detail="密保票据无效或已过期",
                    created_at=datetime.now(),
                )
            )
            db.commit()
            raise Forbidden("密保校验已失效，请重新验证密保问题")
    elif answers is not None and len(answers) == 3:
        verified = _answers_all_correct(db, answers)
    else:
        raise BadRequest("改密码需要先回答 3 个密保问题")

    if not verified:
        db.add(
            PasswordResetLog(
                action=ACTION_CHANGE, result="fail", detail="密保答案不正确", created_at=datetime.now()
            )
        )
        db.commit()
        raise Forbidden(SECURITY_ANSWER_WRONG)

    store.set_many(
        db,
        {
            KEY_PASSWORD_HASH: hash_secret(new_password),
            KEY_PWD_INITIALIZED: "1",
        },
    )
    # 票据一次性使用
    store.remove(db, KEY_RESET_TICKET)
    store.remove(db, KEY_RESET_TICKET_EXPIRE_AT)
    db.add(
        PasswordResetLog(
            action=ACTION_CHANGE, result="success", detail="修改密码成功", created_at=datetime.now()
        )
    )
    db.commit()
    return {"changed": True, "is_initial_password": False}


def reset_password(db: Session, ticket: str, new_password: str) -> dict[str, Any]:
    """忘记密码：凭密保票据重置为新密码。"""
    if not _ticket_valid(db, ticket):
        db.add(
            PasswordResetLog(
                action=ACTION_RESET_BY_SECURITY,
                result="fail",
                detail="密保票据无效或已过期",
                created_at=datetime.now(),
            )
        )
        db.commit()
        raise Forbidden("密保校验已失效，请重新验证密保问题")

    store.set_many(
        db,
        {
            KEY_PASSWORD_HASH: hash_secret(new_password),
            KEY_PWD_INITIALIZED: "1",
        },
    )
    store.remove(db, KEY_RESET_TICKET)
    store.remove(db, KEY_RESET_TICKET_EXPIRE_AT)
    # 说明：这里**不**清 session_token。
    # 忘记密码是登录页（未登录）场景，本来就没有会话；老板已登录时用密保重置密码，
    # 前端希望继续留在系统里（scripts/integration_smoke.py 也是这个预期）。
    db.add(
        PasswordResetLog(
            action=ACTION_RESET_BY_SECURITY,
            result="success",
            detail="凭密保重置密码成功",
            created_at=datetime.now(),
        )
    )
    db.commit()
    return {"reset": True, "is_initial_password": False}


def reset_logs(db: Session, limit: int = 50) -> list[PasswordResetLog]:
    from sqlalchemy import select

    stmt = (
        select(PasswordResetLog).order_by(PasswordResetLog.id.desc()).limit(max(1, min(limit, 200)))
    )
    return list(db.execute(stmt).scalars().all())
