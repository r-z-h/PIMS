"""路由公共依赖：会话校验、统一列表查询参数。"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from .. import config
from ..db import get_db
from ..services import auth_service
from ..utils.dates import check_range
from ..utils.errors import Unauthorized


def require_login(request: Request, db: Session = Depends(get_db)) -> None:
    """除 login / status / security-questions / security/verify / password/reset 外都要登录。"""
    token = request.cookies.get(config.settings.cookie_name)
    if not auth_service.session_valid(db, token):
        raise Unauthorized("未登录或会话已过期")


def make_router(prefix: str, tag: str) -> APIRouter:
    """带登录校验的路由（除认证模块的公开接口外全部使用）。"""
    return APIRouter(prefix=prefix, tags=[tag], dependencies=[Depends(require_login)])


class CommonQuery:
    """列表接口统一查询参数（docs/03-接口设计.md 1.4）。"""

    def __init__(
        self,
        page: int = Query(1, ge=1),
        page_size: int = Query(20, ge=1, le=200),
        project_id: int | None = Query(None, ge=1),
        start_date: date | None = Query(None),
        end_date: date | None = Query(None),
        keyword: str | None = Query(None),
        include_deleted: bool = Query(False),
    ) -> None:
        check_range(start_date, end_date)
        self.page = page
        self.page_size = page_size
        self.project_id = project_id
        self.start_date = start_date
        self.end_date = end_date
        self.keyword = keyword
        self.include_deleted = include_deleted

    def as_list_kwargs(self) -> dict:
        return {
            "project_id": self.project_id,
            "start": self.start_date,
            "end": self.end_date,
            "keyword": self.keyword,
            "page": self.page,
            "page_size": self.page_size,
            "include_deleted": self.include_deleted,
        }
