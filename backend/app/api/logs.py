"""变更日志路由 /api/logs。"""

from __future__ import annotations

from fastapi import Depends, Query
from sqlalchemy.orm import Session

from ..db import get_db
from ..services import log_service
from ..utils.response import EnvelopeJSONResponse, ok, page_data
from .deps import CommonQuery, make_router

router = make_router("/api/logs", "logs")


@router.get("", summary="变更日志列表")
def list_logs(
    table_name: str | None = Query(None),
    record_id: int | None = Query(None),
    action: str | None = Query(None, pattern="^(create|update|delete)$"),
    q: CommonQuery = Depends(),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    items, total = log_service.list_logs(
        db,
        table_name=table_name,
        record_id=record_id,
        action=action,
        start=q.start_date,
        end=q.end_date,
        page=q.page,
        page_size=q.page_size,
    )
    return ok(page_data(items, total, q.page, q.page_size))


@router.get("/{table_name}/{record_id}", summary="某条记录的全部修改历史")
def record_history(
    table_name: str,
    record_id: int,
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    items = log_service.record_history(db, table_name, record_id)
    return ok({"items": items, "total": len(items)})
