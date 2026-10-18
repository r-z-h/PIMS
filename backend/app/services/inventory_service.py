"""库存：入库 / 领用 / 余量（按 项目 + 材料名称 + 单位 隔离）。

口径（docs/00-需求冻结.md R5 / R7、docs/01-开发手册.md 4.2）：
- 余量 = Σ入库 − Σ领用，按「项目 + 材料名称 + 单位」分别计算，项目之间干净隔离
- 采购（cost.material）在一个事务里同时写 cost + material_item + inventory_txn(in) + 聚合
- **领用只减库存，绝不写 cost**；余量不足时接口仍返回 code=0，只把 enough 置 false
- 不做退还 / 退货 / 项目间调拨
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..models.inventory import Inventory
from ..models.inventory_txn import TXN_IN, TXN_OUT, InventoryTxn
from ..utils.changelog import log_change, log_create, log_update, row_to_dict
from ..utils.dates import check_range, dstr, range_conds
from ..utils.errors import BadRequest, NotFound
from ..utils.money import MILLI, ZERO, money, qty

MAX_QUANTITY = Decimal("999999999.999")


# --------------------------------------------------------------------------- 聚合


def _aggregate(db: Session, project_id: int, material_name: str, unit: str) -> Inventory | None:
    return db.execute(
        select(Inventory).where(
            Inventory.project_id == int(project_id),
            Inventory.material_name == material_name,
            Inventory.unit == unit,
        )
    ).scalar_one_or_none()


def _get_or_create(db: Session, project_id: int, material_name: str, unit: str) -> Inventory:
    row = _aggregate(db, project_id, material_name, unit)
    if row is None:
        row = Inventory(
            project_id=int(project_id),
            material_name=material_name,
            unit=unit,
            in_qty=ZERO,
            out_qty=ZERO,
        )
        db.add(row)
        db.flush()
    return row


def apply_delta(
    db: Session,
    project_id: int,
    material_name: str,
    unit: str,
    delta_in: Decimal | int | str = 0,
    delta_out: Decimal | int | str = 0,
) -> Inventory:
    """把入库 / 领用的增量写进聚合表（不提交，由调用方事务统一提交）。"""
    row = _get_or_create(db, project_id, material_name, unit)
    row.in_qty = qty(row.in_qty + qty(delta_in))
    row.out_qty = qty(row.out_qty + qty(delta_out))
    db.flush()
    return row


def balance_of(db: Session, project_id: int, material_name: str, unit: str) -> Decimal:
    row = _aggregate(db, project_id, material_name, unit)
    if row is None:
        return ZERO
    return qty(row.in_qty - row.out_qty)


def last_in_price(db: Session, project_id: int, material_name: str, unit: str) -> Decimal | None:
    """最近一次入库单价（仅作参考金额，不参与利润计算）。"""
    row = db.execute(
        select(InventoryTxn.unit_price)
        .where(
            InventoryTxn.project_id == int(project_id),
            InventoryTxn.material_name == material_name,
            InventoryTxn.unit == unit,
            InventoryTxn.txn_type == TXN_IN,
            InventoryTxn.deleted == 0,
            InventoryTxn.unit_price.is_not(None),
        )
        .order_by(InventoryTxn.biz_date.desc(), InventoryTxn.id.desc())
        .limit(1)
    ).scalar()
    return money(row) if row is not None else None


def list_balances(db: Session, project_id: int | None = None) -> list[dict[str, Any]]:
    """库存余量列表（project_id 为空时跨项目，用于导出）。

    入库与领用都为 0 的聚合行（改材料名 / 改单位后遗留的空壳）不展示。
    """
    stmt = select(Inventory).where(
        or_(Inventory.in_qty != 0, Inventory.out_qty != 0),
    )
    if project_id is not None:
        stmt = stmt.where(Inventory.project_id == int(project_id))
    rows = db.execute(stmt.order_by(Inventory.project_id.asc(), Inventory.material_name.asc())).scalars().all()

    items: list[dict[str, Any]] = []
    for row in rows:
        balance = qty(row.in_qty - row.out_qty)
        price = last_in_price(db, row.project_id, row.material_name, row.unit)
        items.append(
            {
                "inventory_id": row.id,
                "project_id": row.project_id,
                "material_name": row.material_name,
                "unit": row.unit,
                "in_qty": qty(row.in_qty),
                "out_qty": qty(row.out_qty),
                "balance": balance,
                "last_unit_price": price,
                "balance_amount": money(balance * price) if price is not None else None,
                "updated_at": row.updated_at,
            }
        )
    return items


# --------------------------------------------------------------------------- 流水


def get_txn(db: Session, txn_id: int, include_deleted: bool = False) -> InventoryTxn:
    row = db.get(InventoryTxn, int(txn_id))
    if row is None or (row.deleted and not include_deleted):
        raise NotFound("库存流水不存在")
    return row


def serialize_txn(row: InventoryTxn, cost: dict[str, Any] | None = None) -> dict[str, Any]:
    data = row_to_dict(row)
    assert data is not None
    data["quantity"] = qty(row.quantity)
    data["txn_label"] = "入库" if row.txn_type == TXN_IN else "领用"
    # 「关联成本」列要显示成 #17（材料 · 水泥 40,000.00）并支持悬停摘要（需求 T3）
    if cost is not None:
        data["cost"] = cost
        data["cost_label"] = cost.get("label")
    elif row.cost_id:
        # 成本已被删除等取不到摘要的情况：至少保住 id，前端仍显示 #id
        data["cost"] = None
        data["cost_label"] = None
    return data


def list_txns(
    db: Session,
    *,
    project_id: int | None = None,
    material_name: str | None = None,
    txn_type: str | None = None,
    start: date | None = None,
    end: date | None = None,
    keyword: str | None = None,
    page: int = 1,
    page_size: int = 20,
    include_deleted: bool = False,
) -> tuple[list[dict[str, Any]], int]:
    from ..models.project import Project

    check_range(start, end)
    stmt = select(InventoryTxn).join(Project, Project.id == InventoryTxn.project_id)
    conds = []
    if not include_deleted:
        conds.append(InventoryTxn.deleted == 0)
        conds.append(Project.deleted == 0)
    if project_id is not None:
        conds.append(InventoryTxn.project_id == int(project_id))
    if material_name:
        conds.append(InventoryTxn.material_name == material_name)
    if txn_type:
        conds.append(InventoryTxn.txn_type == txn_type)
    conds.extend(range_conds(InventoryTxn.biz_date, start, end))
    if keyword:
        like = f"%{keyword.strip()}%"
        conds.append(
            or_(
                InventoryTxn.material_name.like(like),
                InventoryTxn.supplier.like(like),
                InventoryTxn.remark.like(like),
            )
        )
    stmt = stmt.where(*conds)

    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar() or 0
    rows = (
        db.execute(
            stmt.order_by(InventoryTxn.biz_date.desc(), InventoryTxn.id.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        .scalars()
        .all()
    )
    return _attach_costs(db, rows), int(total)


def _attach_costs(db: Session, rows: list[InventoryTxn]) -> list[dict[str, Any]]:
    """批量补上「关联成本」摘要，避免逐行查询（N+1）。"""
    from .cost_service import cost_brief

    briefs = cost_brief(db, [row.cost_id for row in rows if row.cost_id])
    return [serialize_txn(row, briefs.get(int(row.cost_id)) if row.cost_id else None) for row in rows]


def create_in(db: Session, data: dict[str, Any], *, cost_id: int | None = None, commit: bool = True) -> dict[str, Any]:
    """手工补录入库：**不生成成本**（常规采购请走 /api/costs/material）。"""
    from .locks import ensure_mutable

    project = ensure_mutable(db, int(data["project_id"]))
    quantity = qty(data["quantity"])
    if quantity <= 0:
        raise BadRequest("入库数量必须大于 0")

    row = InventoryTxn(
        project_id=project.id,
        material_name=str(data["material_name"]).strip(),
        unit=str(data["unit"]).strip(),
        txn_type=TXN_IN,
        quantity=quantity,
        unit_price=money(data["unit_price"]) if data.get("unit_price") is not None else None,
        supplier=data.get("supplier"),
        cost_id=cost_id,
        biz_date=dstr(data["biz_date"]),
        remark=data.get("remark"),
        deleted=0,
    )
    db.add(row)
    db.flush()
    aggregate = apply_delta(db, project.id, row.material_name, row.unit, delta_in=quantity)
    log_create(db, "inventory_txn", row)
    if commit:
        db.commit()
    return {
        "txn_id": row.id,
        "balance": qty(aggregate.in_qty - aggregate.out_qty),
        "enough": True,
        "cost_id": row.cost_id,
    }


def create_out(db: Session, data: dict[str, Any], commit: bool = True) -> dict[str, Any]:
    """领用：只写库存流水 + 更新聚合，**不写 cost**。"""
    from .locks import ensure_mutable

    project = ensure_mutable(db, int(data["project_id"]))
    quantity = qty(data["quantity"])
    if quantity <= 0:
        raise BadRequest("领用数量必须大于 0")

    material_name = str(data["material_name"]).strip()
    unit = str(data["unit"]).strip()
    before = balance_of(db, project.id, material_name, unit)
    enough = quantity <= before

    row = InventoryTxn(
        project_id=project.id,
        material_name=material_name,
        unit=unit,
        txn_type=TXN_OUT,
        quantity=quantity,
        unit_price=None,
        supplier=None,
        cost_id=None,
        biz_date=dstr(data["biz_date"]),
        remark=data.get("remark"),
        deleted=0,
    )
    db.add(row)
    db.flush()
    aggregate = apply_delta(db, project.id, material_name, unit, delta_out=quantity)
    log_create(db, "inventory_txn", row)
    if commit:
        db.commit()
    # 余量不足：仍然 code=0，只把 enough 置 false（允许先领后补录）
    return {
        "txn_id": row.id,
        "balance": qty(aggregate.in_qty - aggregate.out_qty),
        "enough": bool(enough),
        "balance_before": before,
    }


def update_txn(db: Session, txn_id: int, changes: dict[str, Any], commit: bool = True) -> dict[str, Any]:
    """修改流水并同步重算 inventory 聚合。"""
    from .locks import ensure_mutable

    row = get_txn(db, txn_id)
    ensure_mutable(db, row.project_id)
    before = row_to_dict(row, raw=True)

    new_material = changes.get("material_name", row.material_name)
    new_unit = changes.get("unit", row.unit)
    new_quantity = qty(changes.get("quantity", row.quantity))
    if new_quantity <= 0:
        raise BadRequest("数量必须大于 0")
    if new_quantity > MAX_QUANTITY:
        raise BadRequest("数量超出允许范围")

    # 先把旧值从聚合里扣掉，再加新值（材料名 / 单位可能变了）
    old_delta_in = row.quantity if row.txn_type == TXN_IN else ZERO
    old_delta_out = row.quantity if row.txn_type == TXN_OUT else ZERO
    apply_delta(db, row.project_id, row.material_name, row.unit, delta_in=-old_delta_in, delta_out=-old_delta_out)

    row.material_name = str(new_material).strip()
    row.unit = str(new_unit).strip()
    row.quantity = new_quantity
    if "unit_price" in changes:
        row.unit_price = money(changes["unit_price"]) if changes["unit_price"] is not None else None
    if "supplier" in changes:
        row.supplier = changes["supplier"]
    if "biz_date" in changes and changes["biz_date"] is not None:
        row.biz_date = dstr(changes["biz_date"])
    if "remark" in changes:
        row.remark = changes["remark"]
    db.flush()

    new_delta_in = row.quantity if row.txn_type == TXN_IN else ZERO
    new_delta_out = row.quantity if row.txn_type == TXN_OUT else ZERO
    aggregate = apply_delta(db, row.project_id, row.material_name, row.unit, delta_in=new_delta_in, delta_out=new_delta_out)

    log_update(db, "inventory_txn", row, before=before)
    if commit:
        db.commit()
    return {
        "txn_id": row.id,
        "balance": qty(aggregate.in_qty - aggregate.out_qty),
        "enough": True,
    }


def delete_txn(db: Session, txn_id: int, commit: bool = True) -> dict[str, Any]:
    """软删除流水并同步重算聚合。"""
    from .locks import ensure_mutable

    row = get_txn(db, txn_id)
    ensure_mutable(db, row.project_id)
    before = row_to_dict(row, raw=True)

    delta_in = -row.quantity if row.txn_type == TXN_IN else ZERO
    delta_out = -row.quantity if row.txn_type == TXN_OUT else ZERO
    aggregate = apply_delta(db, row.project_id, row.material_name, row.unit, delta_in=delta_in, delta_out=delta_out)

    row.deleted = 1
    db.flush()
    log_change(db, "inventory_txn", row.id, "delete", before=before, after=row)
    if commit:
        db.commit()
    return {
        "deleted": True,
        "txn_id": row.id,
        "balance": qty(aggregate.in_qty - aggregate.out_qty),
    }


def remove_for_cost(db: Session, cost_id: int) -> None:
    """材料成本被删除时回冲对应的入库流水并重算聚合（docs/03-接口设计.md 第 7 节）。"""
    rows = (
        db.execute(
            select(InventoryTxn).where(InventoryTxn.cost_id == int(cost_id), InventoryTxn.deleted == 0)
        )
        .scalars()
        .all()
    )
    for row in rows:
        before = row_to_dict(row, raw=True)
        delta_in = -row.quantity if row.txn_type == TXN_IN else ZERO
        delta_out = -row.quantity if row.txn_type == TXN_OUT else ZERO
        apply_delta(db, row.project_id, row.material_name, row.unit, delta_in=delta_in, delta_out=delta_out)
        row.deleted = 1
        db.flush()
        log_change(db, "inventory_txn", row.id, "delete", before=before, after=row)
