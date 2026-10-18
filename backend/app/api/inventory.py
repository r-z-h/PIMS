"""库存路由 /api/inventory（按项目隔离）。"""

from __future__ import annotations

from fastapi import Depends, Query
from sqlalchemy.orm import Session

from ..db import get_db
from ..schemas.inventory import InventoryInCreate, InventoryOutCreate, InventoryTxnUpdate
from ..services import inventory_service
from ..utils.money import ZERO, money
from ..utils.response import EnvelopeJSONResponse, ok, page_data
from .deps import CommonQuery, make_router

router = make_router("/api/inventory", "inventory")


@router.get("", summary="库存余量（project_id 必填）")
def balances(
    project_id: int = Query(..., ge=1),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    items = inventory_service.list_balances(db, project_id)
    total_amount = sum((item["balance_amount"] or ZERO for item in items), ZERO)
    return ok(
        {
            "total": len(items),
            "page": 1,
            "page_size": len(items) or 20,
            "items": items,
            "total_balance_amount": money(total_amount),
        }
    )


@router.get("/txns", summary="库存流水")
def list_txns(
    material_name: str | None = Query(None),
    txn_type: str | None = Query(None, pattern="^(in|out)$"),
    q: CommonQuery = Depends(),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    items, total = inventory_service.list_txns(
        db,
        material_name=material_name,
        txn_type=txn_type,
        **q.as_list_kwargs(),
    )
    return ok(page_data(items, total, q.page, q.page_size))


@router.post("/in", summary="手工补录入库（不生成成本）")
def create_in(payload: InventoryInCreate, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(inventory_service.create_in(db, payload.model_dump()))


@router.post("/out", summary="领用（只减库存，不生成成本）")
def create_out(payload: InventoryOutCreate, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(inventory_service.create_out(db, payload.model_dump()))


@router.put("/txns/{txn_id}", summary="修改库存流水（同步重算聚合）")
def update_txn(
    txn_id: int, payload: InventoryTxnUpdate, db: Session = Depends(get_db)
) -> EnvelopeJSONResponse:
    return ok(inventory_service.update_txn(db, txn_id, payload.changes()))


@router.delete("/txns/{txn_id}", summary="软删除库存流水（同步重算聚合）")
def delete_txn(txn_id: int, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(inventory_service.delete_txn(db, txn_id))
