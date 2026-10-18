"""系统路由 /api/system：备份与重置。"""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.orm import Session

from ..db import get_db
from ..schemas.system import ResetIn
from ..services import system_service
from ..utils.errors import BadRequest
from ..utils.response import EnvelopeJSONResponse, ok
from .deps import make_router

router = make_router("/api/system", "system")


@router.get("/info", summary="数据库信息")
def info() -> EnvelopeJSONResponse:
    return ok(system_service.db_info())


@router.get("/backups", summary="备份列表")
def backups() -> EnvelopeJSONResponse:
    items = system_service.list_backups()
    return ok({"items": items, "total": len(items)})


@router.post("/backup", summary="备份数据库文件")
def backup() -> EnvelopeJSONResponse:
    return ok(system_service.backup())


@router.post("/reset", summary="清空业务数据（保留密码与密保）")
def reset(payload: ResetIn, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    if (payload.confirm or "").strip().upper() != "RESET":
        raise BadRequest("危险操作：请在 confirm 字段填写 RESET 以确认清空业务数据")
    system_service.auto_backup()  # 重置前先留一份备份
    return ok(system_service.reset_business_data(db, keep_dict=payload.keep_dict))
