"""结算路由 /api/labor（五类成本结算，不新增成本）。

> 路径前缀仍是 `/api/labor`（历史原因），但 2026-10-16 起支持五类：
> 用 `cost_type` 区分 人工/材料/机械/杂费/垫付，不传默认人工（兼容旧链接）。
"""

from __future__ import annotations

from datetime import date

from fastapi import Depends, Query
from sqlalchemy.orm import Session

from ..db import get_db
from ..models.labor_settle import SETTLE_GROUP_LABELS, SETTLE_TYPE_LABELS, SETTLE_TYPES
from ..schemas.labor import PartnerPayCreate, PayCreate, SettleCreate, SettleType
from ..services import labor_service
from ..utils.response import EnvelopeJSONResponse, ok, page_data
from .deps import make_router

router = make_router("/api/labor", "labor")


@router.get("/types", summary="结算类别（五类 + 各自的汇总依据名）")
def settle_types() -> EnvelopeJSONResponse:
    return ok(
        {
            "items": [
                {
                    "cost_type": kind,
                    "cost_type_label": SETTLE_TYPE_LABELS[kind],
                    "group_label": SETTLE_GROUP_LABELS.get(kind, ""),
                }
                for kind in SETTLE_TYPES
            ]
        }
    )


@router.get("/overview", summary="欠款总览（一对象一行：累计应付 / 已付来自冲销记录 / 还欠 / 付款构成）")
def overview(
    project_id: int = Query(..., ge=1),
    cost_type: SettleType = Query("labor"),
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    """结算页上半张表；「已付」把该对象名下应付单上的**全部冲销记录**加起来，
    所以不管钱从哪个入口付的（收/付款页、冲销弹窗、登记已付、结算发放），这里都对得上。
    时间段只决定"显示哪些对象"，不改累计金额。
    """
    return ok(labor_service.settlement_overview(db, project_id, cost_type, start_date, end_date))


@router.get("/preview", summary="结算预览（按该类别的汇总依据汇总；不写库、不新增成本）")
def preview(
    project_id: int = Query(..., ge=1),
    cost_type: SettleType = Query("labor"),
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    return ok(labor_service.preview(db, project_id, start_date, end_date, cost_type))


@router.post("/settle", summary="保存结算单（按预览生成）")
def settle(payload: SettleCreate, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(
        labor_service.settle(
            db,
            payload.project_id,
            payload.settle_date,
            payload.remark,
            cost_type=payload.cost_type,
            start=payload.start_date,
            end=payload.end_date,
        )
    )


@router.get("/settles", summary="结算单列表")
def list_settles(
    project_id: int | None = Query(None, ge=1),
    cost_type: SettleType | None = Query(None),
    status: str | None = Query(None, pattern="^(unpaid|partial|paid)$"),
    keyword: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    items, total = labor_service.list_settles(
        db,
        project_id=project_id,
        cost_type=cost_type,
        status=status,
        keyword=keyword,
        page=page,
        page_size=page_size,
    )
    return ok(page_data(items, total, page, page_size))


@router.get("/workers", summary="历史姓名（下拉建议）")
def workers(
    project_id: int = Query(..., ge=1),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    return ok({"items": labor_service.worker_names(db, project_id)})


@router.get("/summary", summary="结算合计")
def summary(
    project_id: int | None = Query(None, ge=1),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    return ok(labor_service.settle_summary(db, project_id))


@router.post("/pay", summary="按「项目 + 类别 + 对象」登记发放（结算页总览表的发放按钮）")
def pay_by_partner(payload: PartnerPayCreate, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    """发放的口径是"该对象还欠多少"，所以按对象发而不是按结算单发。

    上限 = 累计应付 − 已付（已付来自应付单的冲销记录），超过直接 400，防多付。
    """
    return ok(
        labor_service.pay_by_partner(
            db,
            project_id=payload.project_id,
            partner=payload.partner,
            cost_type=payload.cost_type,
            amount=payload.amount,
            pay_date=payload.pay_date,
            pay_method=payload.pay_method,
            remark=payload.remark,
        )
    )


@router.post("/settles/{settle_id}/pay", summary="登记发放（按结算单 id，旧入口保留）")
def pay(settle_id: int, payload: PayCreate, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(
        labor_service.pay(
            db, settle_id, payload.amount, payload.pay_date, payload.pay_method, payload.remark
        )
    )


@router.delete("/settles/{settle_id}", summary="删除结算单（仅未发放）")
def delete_settle(settle_id: int, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(labor_service.delete_settle(db, settle_id))
