"""看板与报表路由 /api/dashboard。"""

from __future__ import annotations

from datetime import date

from fastapi import Depends, Query
from sqlalchemy.orm import Session

from ..db import get_db
from ..services import dashboard_service
from ..utils.response import EnvelopeJSONResponse, ok
from .deps import make_router

router = make_router("/api/dashboard", "dashboard")


@router.get("/projects", summary="首页项目盈亏总表")
def projects(
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    date_field: str | None = Query(
        None,
        description="日期按什么筛：start_date=开工日期；activity=区间内有业务数据",
        pattern="^(start_date|activity)$",
    ),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    """首页盈亏总表。

    `date_field`（2026-10-17 需求）：**项目列表怎么筛，首页就怎么筛**，两处口径一致。
    """
    return ok(dashboard_service.project_table(db, start_date, end_date, date_field=date_field))


@router.get("/recent", summary="最近业务动态")
def recent(
    limit: int = Query(10, ge=1, le=50),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    items = dashboard_service.recent(db, limit)
    return ok({"items": items, "total": len(items)})


@router.get("/cost-trend", summary="按月成本趋势")
def cost_trend(
    project_id: int | None = Query(None, ge=1),
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    return ok(dashboard_service.cost_trend(db, project_id=project_id, start=start_date, end=end_date))
