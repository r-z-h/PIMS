"""认证路由 /api/auth（docs/03-接口设计.md 第 2 节）。

公开接口：status / login / security-questions / security/verify / password/reset
其余（logout / security/setup / password/change）需要已登录。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from .. import config
from ..db import get_db
from ..schemas.auth import (
    LoginIn,
    PasswordChangeIn,
    PasswordResetIn,
    SecuritySetupIn,
    SecurityVerifyIn,
)
from ..services import auth_service
from ..utils.response import EnvelopeJSONResponse, ok
from .deps import require_login

router = APIRouter(prefix="/api/auth", tags=["auth"])

SESSION_MAX_AGE = config.settings.session_days * 24 * 3600


def _set_session_cookie(response: EnvelopeJSONResponse, token: str) -> None:
    response.set_cookie(
        key=config.settings.cookie_name,
        value=token,
        max_age=SESSION_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=config.settings.cookie_secure,
        path="/",
    )


@router.get("/status", summary="系统状态")
def status(request: Request, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    """`logged_in` = 本请求携带的 Cookie 是否有效（见 auth_service.status 的说明）。"""
    token = request.cookies.get(config.settings.cookie_name)
    return ok(auth_service.status(db, token))


@router.post("/login", summary="密码登录")
def login(payload: LoginIn, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    data = auth_service.login(db, payload.password)
    token = data.pop("session_token")
    response = ok(data)
    _set_session_cookie(response, token)
    return response


@router.post("/logout", summary="退出登录", dependencies=[Depends(require_login)])
def logout(db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    auth_service.logout(db)
    response = ok({"logged_in": False})
    response.delete_cookie(config.settings.cookie_name, path="/")
    return response


@router.get("/security-questions", summary="取 3 个密保问题")
def security_questions(db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(auth_service.questions(db))


@router.post("/security/verify", summary="校验 3 个密保答案")
def security_verify(payload: SecurityVerifyIn, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(auth_service.verify_security(db, payload.answers))


@router.post("/security/setup", summary="设置 3 组密保", dependencies=[Depends(require_login)])
def security_setup(payload: SecuritySetupIn, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(auth_service.setup_security(db, payload.questions))


@router.post(
    "/password/change",
    summary="修改密码（需已登录 + 3 个密保全对，不校验旧密码）",
    dependencies=[Depends(require_login)],
)
def password_change(
    payload: PasswordChangeIn,
    request: Request,
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    data = auth_service.change_password(
        db,
        new_password=payload.new_password,
        answers=payload.answers,
        ticket=payload.ticket,
        old_password=payload.old_password,
    )
    response = ok(data)
    # 改密后刷新会话 Cookie 的有效期（服务端 token 不变）
    token = request.cookies.get(config.settings.cookie_name)
    if token:
        _set_session_cookie(response, token)
    return response


@router.post("/password/reset", summary="忘记密码：密保全对 → 重置")
def password_reset(payload: PasswordResetIn, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(auth_service.reset_password(db, payload.ticket, payload.new_password))
