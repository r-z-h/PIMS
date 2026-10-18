"""五类成本：人工 / 材料 / 机械 / 杂费 / 垫付。

口径（docs/00-需求冻结.md R1 / R5 / R6）：
- 实际成本 = 五类成本 `deleted=0` 之和
- 人工录工天即入成本；材料采购即成本
- 材料采购在**一个事务**里写 cost + material_item + inventory_txn(in) + inventory 聚合
- 改 / 删都写 change_log（软删除），时间段筛选按 biz_date
"""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..models.advance_item import AdvanceItem
from ..models.cost import (
    COST_TYPES,
    TYPE_ADVANCE,
    TYPE_LABOR,
    TYPE_MACHINE,
    TYPE_MISC,
    TYPE_MATERIAL,
    TYPE_LABELS,
    Cost,
)
from ..models.labor_work import LaborWork
from ..models.machine_item import MachineItem
from ..models.material_item import MaterialItem
from ..models.project import Project
from ..utils.changelog import log_change, log_create, log_update, record_logs, row_to_dict
from ..utils.dates import check_range, dstr, range_conds
from ..utils.errors import BadRequest, NotFound
from ..utils.money import ZERO, money, mul_money, qty, qty2, sum_money
from . import inventory_service, payable_service


# --------------------------------------------------------------------------- 序列化


def _detail_of(
    cost: Cost,
    labor: LaborWork | None,
    material: MaterialItem | None,
    machine: MachineItem | None,
    advance: AdvanceItem | None,
) -> dict[str, Any]:
    if cost.type == TYPE_LABOR and labor is not None:
        return {
            "worker_name": labor.worker_name,
            "work_days": qty2(labor.work_days),
            "day_rate": money(labor.day_rate),
        }
    if cost.type == TYPE_MATERIAL and material is not None:
        return {
            "material_name": material.material_name,
            "unit": material.unit,
            "quantity": qty(material.quantity),
            "unit_price": money(material.unit_price),
            "supplier": material.supplier,
            "inventory_txn_id": material.inventory_txn_id,
        }
    if cost.type == TYPE_MACHINE and machine is not None:
        return {
            "machine_name": machine.machine_name,
            "measure": machine.measure,
            "quantity": qty2(machine.quantity),
            "unit_price": money(machine.unit_price),
            "lessor": machine.lessor,
        }
    if cost.type == TYPE_ADVANCE and advance is not None:
        return {"payer": advance.payer, "purpose": advance.purpose}
    return {}


def serialize(
    cost: Cost,
    labor: LaborWork | None = None,
    material: MaterialItem | None = None,
    machine: MachineItem | None = None,
    advance: AdvanceItem | None = None,
    project_name: str | None = None,
) -> dict[str, Any]:
    data: dict[str, Any] = {
        "id": cost.id,
        "project_id": cost.project_id,
        "type": cost.type,
        "type_label": TYPE_LABELS.get(cost.type, cost.type),
        "category": cost.category,
        "amount": money(cost.amount),
        "biz_date": cost.biz_date,
        "partner": cost.partner,
        "remark": cost.remark,
        "deleted": cost.deleted,
        "created_at": cost.created_at,
        "updated_at": cost.updated_at,
    }
    if project_name is not None:
        data["project_name"] = project_name
    data.update(_detail_of(cost, labor, material, machine, advance))
    return data


# --------------------------------------------------------------------------- 查询


def _subject_names(db: Session, ids: list[int]) -> dict[int, str]:
    """批量取「对象名」：材料→材料名、人工→姓名、机械→设备名、垫付→垫付人。

    成本主表的 `partner` 存的是**往来对象**（供应商 / 出租方 / 垫付人），
    而这一列要的是"能认出来是哪一笔"的对象名，所以材料/机械得从明细表取。
    四类各一次 IN 查询，避免逐行查（N+1）。
    """
    names: dict[int, str] = {}
    for cost_id, name in db.execute(
        select(MaterialItem.cost_id, MaterialItem.material_name).where(MaterialItem.cost_id.in_(ids))
    ).all():
        if name:
            names[int(cost_id)] = str(name)
    for cost_id, name in db.execute(
        select(LaborWork.cost_id, LaborWork.worker_name).where(LaborWork.cost_id.in_(ids))
    ).all():
        if name:
            names[int(cost_id)] = str(name)
    for cost_id, name in db.execute(
        select(MachineItem.cost_id, MachineItem.machine_name).where(MachineItem.cost_id.in_(ids))
    ).all():
        if name:
            names[int(cost_id)] = str(name)
    for cost_id, name in db.execute(
        select(AdvanceItem.cost_id, AdvanceItem.payer).where(AdvanceItem.cost_id.in_(ids))
    ).all():
        if name:
            names[int(cost_id)] = str(name)
    return names


def cost_brief(db: Session, cost_ids: list[int]) -> dict[int, dict[str, Any]]:
    """给别的模块用的**轻量成本摘要**（不加载完整的成本详情，但会取一次对象名）。

    用途：库存流水等处的「关联成本」列要显示成
    `#17（材料 · 水泥 40,000.00）` 并能看到悬停摘要（需求 T3）；
    调用方一次批量取，避免逐行查询造成 N+1。
    """
    ids = [int(cid) for cid in cost_ids if cid]
    if not ids:
        return {}
    rows = db.execute(select(Cost).where(Cost.id.in_(ids))).scalars().all()
    names = _subject_names(db, ids)
    out: dict[int, dict[str, Any]] = {}
    for cost in rows:
        expense = cost.category if cost.type == TYPE_MISC else names.get(int(cost.id))
        type_label = TYPE_LABELS.get(cost.type, cost.type)
        amount = money(cost.amount)
        out[int(cost.id)] = {
            "id": cost.id,
            "type": cost.type,
            "type_label": type_label,
            # expense＝「对象名」：材料名 / 姓名 / 设备名 / 垫付人 / 杂费小类
            "subject": expense,
            "expense": expense,
            # partner＝往来对象：供应商 / 工人 / 出租方（可用于显示"跟谁买的"）
            "partner": cost.partner,
            "amount": amount,
            "biz_date": cost.biz_date,
            "category": cost.category,
            "deleted": cost.deleted,
            "label": f"{type_label} · {expense} {amount}" if expense else f"{type_label} {amount}",
        }
    return out


def get_cost(db: Session, cost_id: int, include_deleted: bool = False) -> Cost:
    cost = db.get(Cost, int(cost_id))
    if cost is None or (cost.deleted and not include_deleted):
        raise NotFound("成本记录不存在")
    return cost


def cost_detail(db: Session, cost: Cost) -> dict[str, Any]:
    return {
        TYPE_LABOR: lambda: db.execute(
            select(LaborWork).where(LaborWork.cost_id == cost.id)
        ).scalar_one_or_none(),
        TYPE_MATERIAL: lambda: db.execute(
            select(MaterialItem).where(MaterialItem.cost_id == cost.id)
        ).scalar_one_or_none(),
        TYPE_MACHINE: lambda: db.execute(
            select(MachineItem).where(MachineItem.cost_id == cost.id)
        ).scalar_one_or_none(),
        TYPE_ADVANCE: lambda: db.execute(
            select(AdvanceItem).where(AdvanceItem.cost_id == cost.id)
        ).scalar_one_or_none(),
    }.get(cost.type, lambda: None)()


def load_one(db: Session, cost: Cost, project_name: str | None = None) -> dict[str, Any]:
    detail = cost_detail(db, cost)
    kwargs: dict[str, Any] = {}
    if cost.type == TYPE_LABOR:
        kwargs["labor"] = detail
    elif cost.type == TYPE_MATERIAL:
        kwargs["material"] = detail
    elif cost.type == TYPE_MACHINE:
        kwargs["machine"] = detail
    elif cost.type == TYPE_ADVANCE:
        kwargs["advance"] = detail
    return serialize(cost, project_name=project_name, **kwargs)


def list_costs(
    db: Session,
    *,
    types: list[str] | None = None,
    project_id: int | None = None,
    start: date | None = None,
    end: date | None = None,
    keyword: str | None = None,
    category: str | None = None,
    page: int = 1,
    page_size: int = 20,
    include_deleted: bool = False,
) -> tuple[list[dict[str, Any]], int]:
    check_range(start, end)
    stmt = (
        select(Cost, LaborWork, MaterialItem, MachineItem, AdvanceItem, Project.name)
        .join(Project, Project.id == Cost.project_id)
        .outerjoin(LaborWork, LaborWork.cost_id == Cost.id)
        .outerjoin(MaterialItem, MaterialItem.cost_id == Cost.id)
        .outerjoin(MachineItem, MachineItem.cost_id == Cost.id)
        .outerjoin(AdvanceItem, AdvanceItem.cost_id == Cost.id)
    )
    conds = []
    if not include_deleted:
        conds.append(Cost.deleted == 0)
        # 项目被删除后，其成本一并隐藏（docs/01-开发手册.md 5.3）
        conds.append(Project.deleted == 0)
    if types:
        conds.append(Cost.type.in_(types))
    if project_id is not None:
        conds.append(Cost.project_id == int(project_id))
    if category:
        conds.append(Cost.category == category)
    conds.extend(range_conds(Cost.biz_date, start, end))
    if keyword:
        like = f"%{keyword.strip()}%"
        conds.append(
            or_(
                Cost.partner.like(like),
                Cost.remark.like(like),
                Cost.category.like(like),
                LaborWork.worker_name.like(like),
                MaterialItem.material_name.like(like),
                MaterialItem.supplier.like(like),
                MachineItem.machine_name.like(like),
                MachineItem.lessor.like(like),
                AdvanceItem.payer.like(like),
                AdvanceItem.purpose.like(like),
            )
        )
    stmt = stmt.where(*conds)

    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar() or 0
    rows = db.execute(
        stmt.order_by(Cost.biz_date.desc(), Cost.id.desc()).offset((page - 1) * page_size).limit(page_size)
    ).all()
    items = [
        serialize(cost, labor, material, machine, advance, project_name)
        for cost, labor, material, machine, advance, project_name in rows
    ]
    return items, int(total)


def summary(
    db: Session,
    *,
    types: list[str] | None = None,
    project_id: int | None = None,
    start: date | None = None,
    end: date | None = None,
) -> dict[str, Any]:
    """汇总：按 type 分组、按 category 分组（杂费小类）、按项目分组。"""
    from .project_service import cost_category_totals

    check_range(start, end)
    base_conds = [Cost.deleted == 0, *range_conds(Cost.biz_date, start, end)]
    if types:
        base_conds.append(Cost.type.in_(types))
    if project_id is not None:
        base_conds.append(Cost.project_id == int(project_id))

    by_type = {ctype: ZERO for ctype in COST_TYPES}
    detail_by_type: list[dict[str, Any]] = []
    type_rows = db.execute(
        select(Cost.type, func.sum(Cost.amount), func.count()).where(*base_conds).group_by(Cost.type)
    ).all()
    for ctype, total, count in type_rows:
        by_type[str(ctype)] = money(total)
        detail_by_type.append(
            {"type": ctype, "type_label": TYPE_LABELS.get(str(ctype), str(ctype)), "amount": money(total), "count": int(count)}
        )

    project_rows = db.execute(
        select(Cost.project_id, func.sum(Cost.amount), func.count())
        .where(*base_conds)
        .group_by(Cost.project_id)
    ).all()
    names = {
        pid: name
        for pid, name in db.execute(
            select(Project.id, Project.name).where(Project.id.in_([row[0] for row in project_rows] or [0]))
        ).all()
    }
    by_project = [
        {
            "project_id": int(pid),
            "project_name": names.get(pid),
            "amount": money(total),
            "count": int(count),
        }
        for pid, total, count in project_rows
    ]

    return {
        "by_type": by_type,
        "by_type_detail": detail_by_type,
        "by_category": cost_category_totals(db, project_id, start, end),
        "by_project": sorted(by_project, key=lambda item: item["amount"], reverse=True),
        "total": sum_money(by_type.values()),
        "count": sum(item["count"] for item in detail_by_type),
        "range": {"start_date": dstr(start), "end_date": dstr(end)},
    }


def logs(db: Session, cost_id: int) -> list[dict[str, Any]]:
    """该条成本的修改记录（时间线）。"""
    rows = record_logs(db, "cost", cost_id)
    out = []
    for row in rows:
        out.append(
            {
                "id": row.id,
                "table_name": row.table_name,
                "record_id": row.record_id,
                "action": row.action,
                "before": json.loads(row.before_json) if row.before_json else None,
                "after": json.loads(row.after_json) if row.after_json else None,
                "operator": row.operator,
                "created_at": row.created_at,
            }
        )
    return out


# --------------------------------------------------------------------------- 录入


def _check_project(db: Session, project_id: int) -> Project:
    """取项目并做**完工锁检查**（2026-10-17）：五类成本的新增都走这里。"""
    from .locks import ensure_mutable

    return ensure_mutable(db, project_id)


def _check_amount(amount: Decimal, message: str = "金额必须大于 0") -> Decimal:
    if money(amount) <= 0:
        raise BadRequest(message)
    return money(amount)


def create_labor(db: Session, data: dict[str, Any]) -> dict[str, Any]:
    """录工天：实时计入成本，金额 = 工日数 × 日工价（可手改）。"""
    project = _check_project(db, int(data["project_id"]))
    work_days = qty2(data["work_days"])
    day_rate = money(data["day_rate"])
    if work_days <= 0:
        raise BadRequest("工日数必须大于 0")
    if day_rate <= 0:
        raise BadRequest("日工价必须大于 0")
    amount = money(data["amount"]) if data.get("amount") is not None else mul_money(work_days, day_rate)
    _check_amount(amount)

    worker_name = str(data["worker_name"]).strip()
    cost = Cost(
        project_id=project.id,
        type=TYPE_LABOR,
        category=None,
        amount=amount,
        biz_date=dstr(data["biz_date"]),
        partner=worker_name,
        remark=data.get("remark"),
        deleted=0,
    )
    db.add(cost)
    db.flush()

    detail = LaborWork(
        cost_id=cost.id,
        worker_name=worker_name,
        work_days=work_days,
        day_rate=day_rate,
        remark=data.get("remark"),
    )
    db.add(detail)
    db.flush()

    log_create(db, "cost", cost)
    log_create(db, "labor_work", detail)
    payable_service.register_for_cost(db, cost)
    db.commit()
    return {"cost_id": cost.id, "amount": money(cost.amount), "biz_date": cost.biz_date}


def create_material(db: Session, data: dict[str, Any]) -> dict[str, Any]:
    """录材料采购：一个事务写 cost + material_item + inventory_txn(in) + 聚合。"""
    project = _check_project(db, int(data["project_id"]))
    quantity = qty(data["quantity"])
    unit_price = money(data["unit_price"])
    if quantity <= 0:
        raise BadRequest("数量必须大于 0")
    amount = money(data["amount"]) if data.get("amount") is not None else mul_money(quantity, unit_price)
    _check_amount(amount)

    material_name = str(data["material_name"]).strip()
    unit = str(data["unit"]).strip()
    cost = Cost(
        project_id=project.id,
        type=TYPE_MATERIAL,
        category=None,
        amount=amount,
        biz_date=dstr(data["biz_date"]),
        partner=data.get("supplier"),
        remark=data.get("remark"),
        deleted=0,
    )
    db.add(cost)
    db.flush()

    detail = MaterialItem(
        cost_id=cost.id,
        material_name=material_name,
        unit=unit,
        quantity=quantity,
        unit_price=unit_price,
        supplier=data.get("supplier"),
    )
    db.add(detail)
    db.flush()

    # 采购即入库：库存流水 + 聚合
    txn_result = inventory_service.create_in(
        db,
        {
            "project_id": project.id,
            "material_name": material_name,
            "unit": unit,
            "quantity": quantity,
            "unit_price": unit_price,
            "supplier": data.get("supplier"),
            "biz_date": data["biz_date"],
            "remark": data.get("remark"),
        },
        cost_id=cost.id,
        commit=False,
    )
    detail.inventory_txn_id = txn_result["txn_id"]
    db.flush()

    log_create(db, "cost", cost)
    log_create(db, "material_item", detail)
    payable_service.register_for_cost(db, cost)
    db.commit()
    return {
        "cost_id": cost.id,
        "inventory_txn_id": txn_result["txn_id"],
        "inventory_balance": txn_result["balance"],
        "amount": money(cost.amount),
    }


def create_machine(db: Session, data: dict[str, Any]) -> dict[str, Any]:
    """录机械费（台班 / 小时）。"""
    project = _check_project(db, int(data["project_id"]))
    quantity = qty2(data["quantity"])
    unit_price = money(data["unit_price"])
    if quantity <= 0:
        raise BadRequest("数量必须大于 0")
    amount = money(data["amount"]) if data.get("amount") is not None else mul_money(quantity, unit_price)
    _check_amount(amount)

    cost = Cost(
        project_id=project.id,
        type=TYPE_MACHINE,
        category=None,
        amount=amount,
        biz_date=dstr(data["biz_date"]),
        partner=data.get("lessor"),
        remark=data.get("remark"),
        deleted=0,
    )
    db.add(cost)
    db.flush()

    detail = MachineItem(
        cost_id=cost.id,
        machine_name=str(data["machine_name"]).strip(),
        measure=str(data["measure"]).strip(),
        quantity=quantity,
        unit_price=unit_price,
        lessor=data.get("lessor"),
    )
    db.add(detail)
    db.flush()

    log_create(db, "cost", cost)
    log_create(db, "machine_item", detail)
    payable_service.register_for_cost(db, cost)
    db.commit()
    return {"cost_id": cost.id, "amount": money(cost.amount)}


def create_misc(db: Session, data: dict[str, Any]) -> dict[str, Any]:
    """录杂费（小类取字典，可自定义）。"""
    project = _check_project(db, int(data["project_id"]))
    category = str(data["category"]).strip()
    if not category:
        raise BadRequest("杂费小类必填")
    amount = _check_amount(money(data["amount"]))

    cost = Cost(
        project_id=project.id,
        type=TYPE_MISC,
        category=category,
        amount=amount,
        biz_date=dstr(data["biz_date"]),
        partner=None,
        remark=data.get("remark"),
        deleted=0,
    )
    db.add(cost)
    db.flush()
    log_create(db, "cost", cost)
    payable_service.register_for_cost(db, cost)
    db.commit()
    return {"cost_id": cost.id, "amount": money(cost.amount)}


def create_advance(db: Session, data: dict[str, Any]) -> dict[str, Any]:
    """录垫付。"""
    project = _check_project(db, int(data["project_id"]))
    amount = _check_amount(money(data["amount"]))
    payer = (data.get("payer") or "老板").strip()

    cost = Cost(
        project_id=project.id,
        type=TYPE_ADVANCE,
        category=None,
        amount=amount,
        biz_date=dstr(data["biz_date"]),
        partner=payer,
        remark=data.get("remark"),
        deleted=0,
    )
    db.add(cost)
    db.flush()

    detail = AdvanceItem(cost_id=cost.id, payer=payer, purpose=data.get("purpose"))
    db.add(detail)
    db.flush()

    log_create(db, "cost", cost)
    log_create(db, "advance_item", detail)
    payable_service.register_for_cost(db, cost)
    db.commit()
    return {"cost_id": cost.id, "amount": money(cost.amount)}


# --------------------------------------------------------------------------- 改 / 删


DETAIL_TABLES = {
    TYPE_LABOR: "labor_work",
    TYPE_MATERIAL: "material_item",
    TYPE_MACHINE: "machine_item",
    TYPE_ADVANCE: "advance_item",
}


def update_cost(db: Session, cost_id: int, changes: dict[str, Any]) -> dict[str, Any]:
    """改成本：金额与明细一起改，材料类同步库存入库流水与聚合。"""
    from ..models.inventory_txn import InventoryTxn
    from .locks import ensure_mutable

    cost = get_cost(db, cost_id)
    ensure_mutable(db, cost.project_id)
    if "amount" in changes and changes["amount"] is None:
        changes.pop("amount")

    # 先取变更前快照（否则会被后面的赋值污染）
    before_cost = row_to_dict(cost, raw=True)
    detail = cost_detail(db, cost)
    before_detail = row_to_dict(detail, raw=True) if detail is not None else None

    if "biz_date" in changes and changes["biz_date"] is not None:
        cost.biz_date = dstr(changes["biz_date"])
    if "remark" in changes:
        cost.remark = changes["remark"]

    if cost.type == TYPE_MISC:
        if changes.get("category"):
            cost.category = str(changes["category"]).strip()
        if changes.get("amount") is not None:
            cost.amount = money(changes["amount"])
        _check_amount(cost.amount)

    elif cost.type == TYPE_LABOR:
        assert isinstance(detail, LaborWork)
        if changes.get("worker_name"):
            detail.worker_name = str(changes["worker_name"]).strip()
            cost.partner = detail.worker_name
        if changes.get("work_days") is not None:
            detail.work_days = qty2(changes["work_days"])
        if changes.get("day_rate") is not None:
            detail.day_rate = money(changes["day_rate"])
        if changes.get("amount") is not None:
            cost.amount = money(changes["amount"])
        elif "work_days" in changes or "day_rate" in changes:
            cost.amount = mul_money(detail.work_days, detail.day_rate)
        _check_amount(cost.amount)

    elif cost.type == TYPE_MATERIAL:
        assert isinstance(detail, MaterialItem)
        new_name = str(changes.get("material_name") or detail.material_name).strip()
        new_unit = str(changes.get("unit") or detail.unit).strip()
        new_quantity = qty(changes["quantity"]) if changes.get("quantity") is not None else qty(detail.quantity)
        new_price = money(changes["unit_price"]) if changes.get("unit_price") is not None else money(detail.unit_price)
        if new_quantity <= 0:
            raise BadRequest("数量必须大于 0")

        if "supplier" in changes:
            detail.supplier = changes["supplier"]
            cost.partner = changes["supplier"]

        # 库存聚合：先扣掉旧的（材料名 / 单位可能变了），再记新的
        inventory_service.apply_delta(
            db, cost.project_id, detail.material_name, detail.unit, delta_in=-qty(detail.quantity)
        )
        detail.material_name = new_name
        detail.unit = new_unit
        detail.quantity = new_quantity
        detail.unit_price = new_price

        txn = db.get(InventoryTxn, detail.inventory_txn_id) if detail.inventory_txn_id else None
        before_txn = row_to_dict(txn, raw=True) if txn is not None else None
        if txn is not None and not txn.deleted:
            txn.material_name = new_name
            txn.unit = new_unit
            txn.quantity = new_quantity
            txn.unit_price = new_price
            txn.supplier = detail.supplier
            txn.biz_date = cost.biz_date
        inventory_service.apply_delta(db, cost.project_id, new_name, new_unit, delta_in=new_quantity)

        if changes.get("amount") is not None:
            cost.amount = money(changes["amount"])
        elif "quantity" in changes or "unit_price" in changes:
            cost.amount = mul_money(new_quantity, new_price)
        _check_amount(cost.amount)
        db.flush()
        if txn is not None:
            log_update(db, "inventory_txn", txn, before=before_txn)

    elif cost.type == TYPE_MACHINE:
        assert isinstance(detail, MachineItem)
        if changes.get("machine_name"):
            detail.machine_name = str(changes["machine_name"]).strip()
        if changes.get("measure"):
            detail.measure = changes["measure"]
        if changes.get("quantity") is not None:
            detail.quantity = qty2(changes["quantity"])
        if changes.get("unit_price") is not None:
            detail.unit_price = money(changes["unit_price"])
        if "lessor" in changes:
            detail.lessor = changes["lessor"]
            cost.partner = changes["lessor"]
        if changes.get("amount") is not None:
            cost.amount = money(changes["amount"])
        elif "quantity" in changes or "unit_price" in changes:
            cost.amount = mul_money(detail.quantity, detail.unit_price)
        _check_amount(cost.amount)

    elif cost.type == TYPE_ADVANCE:
        assert isinstance(detail, AdvanceItem)
        if changes.get("payer"):
            detail.payer = str(changes["payer"]).strip()
            cost.partner = detail.payer
        if "purpose" in changes:
            detail.purpose = changes["purpose"]
        if changes.get("amount") is not None:
            cost.amount = money(changes["amount"])
        _check_amount(cost.amount)

    db.flush()
    if detail is not None:
        log_update(db, DETAIL_TABLES[cost.type], detail, before=before_detail)
    log_update(db, "cost", cost, before=before_cost)
    # 金额/对方/日期同步到自动生成的应付单；已被冲销过且金额变化 → 这里会抛 400
    payable_service.sync_from_cost(db, cost, old_amount=money(before_cost["amount"]))
    db.commit()
    return load_one(db, cost)


def delete_cost(db: Session, cost_id: int) -> dict[str, Any]:
    """软删除成本；材料类同时回冲库存入库流水。

    口径：成本删除后，**它生成的应付单保留**（不自动删），只把提示信息回传给前端。
    """
    from .locks import ensure_mutable

    cost = get_cost(db, cost_id)
    ensure_mutable(db, cost.project_id)
    before = row_to_dict(cost, raw=True)

    if cost.type == TYPE_MATERIAL:
        inventory_service.remove_for_cost(db, cost.id)

    payable_kept = payable_service.on_cost_deleted(db, cost)

    cost.deleted = 1
    db.flush()
    log_change(db, "cost", cost.id, "delete", before=before, after=cost)
    db.commit()
    return {
        "deleted": True,
        "cost_id": cost.id,
        "type": cost.type,
        "amount": money(cost.amount),
        "payable": payable_kept,
    }
