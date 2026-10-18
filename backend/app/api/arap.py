"""应收应付与冲销路由 /api/arap（不参与利润计算）。"""

from __future__ import annotations

from datetime import date

from fastapi import Depends, Query
from sqlalchemy.orm import Session

from ..db import get_db
from ..schemas.arap import ArApCreate, ArApUpdate, OffsetCreate
from ..services import arap_service, offset_service
from ..utils.response import EnvelopeJSONResponse, ok, page_data
from .deps import CommonQuery, make_router

router = make_router("/api/arap", "arap")

TYPE_PATTERN = "^(receivable|payable)$"


@router.get("", summary="应收 / 应付列表")
def list_arap(
    type: str | None = Query(None, pattern=TYPE_PATTERN),
    status: str | None = Query(None, pattern="^(open|partial|closed)$"),
    only_unsettled: bool = Query(False),
    q: CommonQuery = Depends(),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    items, total = arap_service.list_arap(
        db, type_=type, status=status, only_unsettled=only_unsettled, **q.as_list_kwargs()
    )
    return ok(page_data(items, total, q.page, q.page_size))


@router.post("", summary="新增应收单 / 应付单")
def create_arap(payload: ArApCreate, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(arap_service.create_arap(db, payload.model_dump()))


@router.get("/pending", summary="待冲销单据")
def pending(
    project_id: int = Query(..., ge=1),
    type: str = Query(..., pattern=TYPE_PATTERN),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    items = arap_service.pending(db, project_id, type)
    return ok(page_data(items, len(items), 1, len(items) or 20))


@router.post("/offset", summary="手工冲销（一次可冲多张）")
def create_offset(payload: OffsetCreate, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    data = payload.model_dump()
    data["offsets"] = [item.model_dump() if hasattr(item, "model_dump") else item for item in payload.offsets]
    return ok(offset_service.create_offset(db, data))


@router.get("/auto-offset/plan", summary="自动冲销计划（只算不写，供预冲窗口）")
def auto_offset_plan(
    funds_flow_id: int = Query(..., ge=1),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    """按「同项目、同业务类型、日期最早优先」算出打算冲哪几张单（需求 T4）。

    只返回建议，不落库；用户确认后走 POST /api/arap/offset（可手工调整）。
    """
    return ok(offset_service.auto_offset_plan(db, funds_flow_id))


@router.post("/auto-offset/apply", summary="按自动规则直接冲销")
def auto_offset_apply(
    funds_flow_id: int = Query(..., ge=1),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    """用户没有调整、直接确认时调用；无可冲单据时返回 applied=false 与提示文案。"""
    return ok(offset_service.auto_offset_apply(db, funds_flow_id))


@router.delete("/offset/{offset_id}", summary="撤销冲销")
def delete_offset(offset_id: int, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(offset_service.delete_offset(db, offset_id))


@router.get("/summary", summary="该收未收 / 该付未付")
def summary(
    project_id: int | None = Query(None, ge=1),
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    return ok(arap_service.summary(db, project_id=project_id, start=start_date, end=end_date))


@router.get("/{arap_id}", summary="单据详情（含冲销历史）")
def detail(arap_id: int, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(arap_service.detail(db, arap_id))


@router.put("/{arap_id}", summary="修改单据")
def update_arap(arap_id: int, payload: ArApUpdate, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(arap_service.update_arap(db, arap_id, payload.changes()))


@router.delete("/{arap_id}", summary="删除单据（已冲销返回 409）")
def delete_arap(arap_id: int, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(arap_service.delete_arap(db, arap_id))
