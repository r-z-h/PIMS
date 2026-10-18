"""资金流水路由 /api/funds（不参与利润计算）。"""

from __future__ import annotations

from datetime import date

from fastapi import Depends, Query
from sqlalchemy.orm import Session

from ..db import get_db
from ..schemas.funds import FundsCreate, FundsUpdate
from ..services import funds_service
from ..utils.response import EnvelopeJSONResponse, ok, page_data
from .deps import CommonQuery, make_router

router = make_router("/api/funds", "funds")


@router.get("", summary="资金流水列表")
def list_flows(
    direction: str | None = Query(None, pattern="^(in|out)$"),
    biz_type: str | None = Query(None),
    pay_method: str | None = Query(None),
    q: CommonQuery = Depends(),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    items, total = funds_service.list_flows(
        db,
        direction=direction,
        biz_type=biz_type,
        pay_method=pay_method,
        **q.as_list_kwargs(),
    )
    return ok(page_data(items, total, q.page, q.page_size))


@router.post("", summary="新增收 / 付款")
def create_flow(payload: FundsCreate, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(funds_service.create_flow(db, payload.model_dump()))


@router.get("/summary", summary="收付款汇总")
def summary(
    project_id: int | None = Query(None, ge=1),
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    direction: str | None = Query(None, description="按收付方向过滤：in / out；不传则两者都统计"),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    return ok(
        funds_service.summary(
            db, project_id=project_id, start=start_date, end=end_date, direction=direction
        )
    )


@router.get("/{flow_id}", summary="流水详情（含冲销单据）")
def detail(flow_id: int, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(funds_service.detail(db, flow_id))


@router.put("/{flow_id}", summary="修改流水")
def update_flow(flow_id: int, payload: FundsUpdate, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(funds_service.update_flow(db, flow_id, payload.changes()))


@router.delete("/{flow_id}", summary="删除流水（已冲销返回 409）")
def delete_flow(flow_id: int, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(funds_service.delete_flow(db, flow_id))
