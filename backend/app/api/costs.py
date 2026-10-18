"""五类成本路由 /api/costs。"""

from __future__ import annotations

from datetime import date

from fastapi import Depends, Query
from sqlalchemy.orm import Session

from ..db import get_db
from ..models.cost import COST_TYPES
from ..schemas.cost import (
    AdvanceCostCreate,
    CostPaymentIn,
    CostUpdate,
    LaborCostCreate,
    MachineCostCreate,
    MaterialCostCreate,
    MiscCostCreate,
)
from ..services import cost_service, payable_service
from ..utils.errors import BadRequest, NotFound
from ..utils.response import EnvelopeJSONResponse, ok, page_data
from .deps import CommonQuery, make_router

router = make_router("/api/costs", "costs")


def _parse_types(raw: str | None) -> list[str] | None:
    if not raw:
        return None
    items = [part.strip() for part in raw.split(",") if part.strip()]
    invalid = [item for item in items if item not in COST_TYPES]
    if invalid:
        raise BadRequest(f"成本类型不正确：{','.join(invalid)}")
    return items or None


@router.get("", summary="五类成本混合列表")
def list_costs(
    type: str | None = Query(None, description="多选用逗号：labor,material"),
    category: str | None = Query(None),
    q: CommonQuery = Depends(),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    items, total = cost_service.list_costs(
        db, types=_parse_types(type), category=category, **q.as_list_kwargs()
    )
    return ok(page_data(items, total, q.page, q.page_size))


@router.get("/summary", summary="成本汇总")
def summary(
    type: str | None = Query(None),
    project_id: int | None = Query(None, ge=1),
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    return ok(
        cost_service.summary(
            db, types=_parse_types(type), project_id=project_id, start=start_date, end=end_date
        )
    )


@router.post("/labor", summary="录工天（实时入成本）")
def create_labor(payload: LaborCostCreate, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(cost_service.create_labor(db, payload.model_dump()))


@router.post("/material", summary="录材料采购（同时入库）")
def create_material(payload: MaterialCostCreate, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(cost_service.create_material(db, payload.model_dump()))


@router.post("/machine", summary="录机械费")
def create_machine(payload: MachineCostCreate, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(cost_service.create_machine(db, payload.model_dump()))


@router.post("/misc", summary="录杂费")
def create_misc(payload: MiscCostCreate, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(cost_service.create_misc(db, payload.model_dump()))


@router.post("/advance", summary="录垫付")
def create_advance(payload: AdvanceCostCreate, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(cost_service.create_advance(db, payload.model_dump()))


@router.put("/{cost_id}", summary="修改成本")
def update_cost(cost_id: int, payload: CostUpdate, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(cost_service.update_cost(db, cost_id, payload.changes()))


@router.delete("/{cost_id}", summary="软删除成本")
def delete_cost(cost_id: int, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(cost_service.delete_cost(db, cost_id))


@router.get("/{cost_id}/brief", summary="该条成本的轻量摘要（关联成本列悬停/跳转用）")
def cost_brief(cost_id: int, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    """不加载四张明细表，只返回类别 / 对象 / 金额 / 日期，供「关联成本」列显示与悬停。"""
    brief = cost_service.cost_brief(db, [cost_id]).get(int(cost_id))
    if brief is None:
        raise NotFound("成本记录不存在")
    return ok(brief)


@router.get("/{cost_id}/logs", summary="该条成本的修改记录")
def cost_logs(cost_id: int, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    cost_service.get_cost(db, cost_id, include_deleted=True)
    return ok({"items": cost_service.logs(db, cost_id)})


@router.get("/{cost_id}/payable", summary="该成本自动生成的应付单（含冲销情况）")
def cost_payable(cost_id: int, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    """录入成本后弹窗预填用：看这张应付单已付多少、还欠多少。"""
    return ok(payable_service.summary_for_cost(db, cost_id))


@router.post("/{cost_id}/pay", summary="登记该成本的已付金额（生成付款流水并自动冲销应付单）")
def pay_cost(
    cost_id: int,
    payload: CostPaymentIn,
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    return ok(payable_service.settle_cost_payment(db, cost_id, payload.model_dump()))
