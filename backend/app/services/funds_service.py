"""资金流水：只反映钱的进出，**不参与利润计算**（docs/00-需求冻结.md FR-3.5 / R4）。"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..models.ar_ap_offset import ArApOffset
from ..models.funds_flow import (
    BIZ_TYPE_LABELS,
    DIRECTION_IN,
    DIRECTION_LABELS,
    DIRECTION_OUT,
    IN_BIZ_TYPES,
    OUT_BIZ_TYPES,
    PAY_METHOD_LABELS,
    FundsFlow,
)
from ..models.project import Project
from ..utils.changelog import log_change, log_create, log_update, row_to_dict
from ..utils.dates import check_range, dstr, range_conds
from ..utils.errors import BadRequest, Conflict, NotFound
from ..utils.money import ZERO, money, sum_money


def serialize(row: FundsFlow, project_name: str | None = None) -> dict[str, Any]:
    data = {
        "id": row.id,
        "project_id": row.project_id,
        "direction": row.direction,
        "direction_label": DIRECTION_LABELS.get(row.direction, row.direction),
        "biz_type": row.biz_type,
        "biz_type_label": BIZ_TYPE_LABELS.get(row.biz_type, row.biz_type),
        "amount": money(row.amount),
        "biz_date": row.biz_date,
        "partner": row.partner,
        "pay_method": row.pay_method,
        "pay_method_label": PAY_METHOD_LABELS.get(row.pay_method) if row.pay_method else None,
        "remark": row.remark,
        "deleted": row.deleted,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }
    if project_name is not None:
        data["project_name"] = project_name
    return data


def get_flow(db: Session, flow_id: int, include_deleted: bool = False) -> FundsFlow:
    row = db.get(FundsFlow, int(flow_id))
    if row is None or (row.deleted and not include_deleted):
        raise NotFound("资金流水不存在")
    return row


def offset_total(db: Session, flow_id: int) -> Decimal:
    """该流水已冲销合计。"""
    total = db.execute(
        select(func.sum(ArApOffset.amount)).where(ArApOffset.funds_flow_id == int(flow_id))
    ).scalar()
    return money(total, ZERO)


def offsets_of_flow(db: Session, flow_id: int) -> list[dict[str, Any]]:
    from ..models.ar_ap import ArAp

    rows = db.execute(
        select(ArApOffset, ArAp)
        .join(ArAp, ArAp.id == ArApOffset.ar_ap_id)
        .where(ArApOffset.funds_flow_id == int(flow_id))
        .order_by(ArApOffset.id.asc())
    ).all()
    return [
        {
            "offset_id": offset.id,
            "ar_ap_id": offset.ar_ap_id,
            "type": arap.type,
            "biz_type": arap.biz_type,
            "biz_date": arap.biz_date,
            "partner": arap.partner,
            "amount": money(offset.amount),
            "offset_date": offset.offset_date,
            "remark": offset.remark,
        }
        for offset, arap in rows
    ]


def _check_biz_type(direction: str, biz_type: str) -> None:
    allowed = IN_BIZ_TYPES if direction == DIRECTION_IN else OUT_BIZ_TYPES
    if biz_type not in allowed:
        label = "收入" if direction == DIRECTION_IN else "支出"
        raise BadRequest(f"{label}类型不支持「{BIZ_TYPE_LABELS.get(biz_type, biz_type)}」")


def list_flows(
    db: Session,
    *,
    project_id: int | None = None,
    direction: str | None = None,
    biz_type: str | None = None,
    pay_method: str | None = None,
    start: date | None = None,
    end: date | None = None,
    keyword: str | None = None,
    page: int = 1,
    page_size: int = 20,
    include_deleted: bool = False,
) -> tuple[list[dict[str, Any]], int]:
    check_range(start, end)
    stmt = select(FundsFlow, Project.name).join(Project, Project.id == FundsFlow.project_id)
    conds = []
    if not include_deleted:
        conds.append(FundsFlow.deleted == 0)
        conds.append(Project.deleted == 0)
    if project_id is not None:
        conds.append(FundsFlow.project_id == int(project_id))
    if direction:
        conds.append(FundsFlow.direction == direction)
    if biz_type:
        conds.append(FundsFlow.biz_type == biz_type)
    if pay_method:
        conds.append(FundsFlow.pay_method == pay_method)
    conds.extend(range_conds(FundsFlow.biz_date, start, end))
    if keyword:
        like = f"%{keyword.strip()}%"
        conds.append(
            or_(
                FundsFlow.partner.like(like),
                FundsFlow.remark.like(like),
            )
        )
    stmt = stmt.where(*conds)

    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar() or 0
    rows = db.execute(
        stmt.order_by(FundsFlow.biz_date.desc(), FundsFlow.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    items = []
    for flow, project_name in rows:
        data = serialize(flow, project_name)
        data["offset_amount"] = offset_total(db, flow.id)
        items.append(data)
    return items, int(total)


def create_flow(db: Session, data: dict[str, Any], *, commit: bool = True) -> dict[str, Any]:
    """新增收付款流水。`commit=False` 时交给调用方提交（用于与成本/应付单组成同一事务）。"""
    from .locks import ensure_mutable

    project = ensure_mutable(db, int(data["project_id"]))
    direction = data["direction"]
    biz_type = data["biz_type"]
    _check_biz_type(direction, biz_type)

    row = FundsFlow(
        project_id=project.id,
        direction=direction,
        biz_type=biz_type,
        amount=money(data["amount"]),
        biz_date=dstr(data["biz_date"]),
        partner=data.get("partner"),
        pay_method=data.get("pay_method"),
        remark=data.get("remark"),
        deleted=0,
    )
    db.add(row)
    db.flush()
    log_create(db, "funds_flow", row)
    if commit:
        db.commit()
    out = serialize(row, project.name)
    out["offset_amount"] = ZERO
    return out


def update_flow(db: Session, flow_id: int, changes: dict[str, Any]) -> dict[str, Any]:
    from .locks import ensure_mutable

    row = get_flow(db, flow_id)
    ensure_mutable(db, row.project_id)
    before = row_to_dict(row, raw=True)

    direction = changes.get("direction") or row.direction
    biz_type = changes.get("biz_type") or row.biz_type
    _check_biz_type(direction, biz_type)

    if changes.get("amount") is not None:
        new_amount = money(changes["amount"])
        already = offset_total(db, row.id)
        if new_amount < already:
            raise BadRequest(f"流水金额不能小于已冲销金额 {already:.2f}")
        row.amount = new_amount
    row.direction = direction
    row.biz_type = biz_type
    if changes.get("biz_date") is not None:
        row.biz_date = dstr(changes["biz_date"])
    for field in ("partner", "pay_method", "remark"):
        if field in changes:
            setattr(row, field, changes[field])

    db.flush()
    log_update(db, "funds_flow", row, before=before)
    db.commit()
    out = serialize(row)
    out["offset_amount"] = offset_total(db, row.id)
    return out


def delete_flow(db: Session, flow_id: int) -> dict[str, Any]:
    """软删除；已产生冲销记录时返回 409，提示先撤销冲销。"""
    from .locks import ensure_mutable

    row = get_flow(db, flow_id)
    ensure_mutable(db, row.project_id)
    if offset_total(db, row.id) > 0:
        raise Conflict("该流水已产生冲销记录，请先撤销冲销再删除")

    before = row_to_dict(row, raw=True)
    row.deleted = 1
    db.flush()
    log_change(db, "funds_flow", row.id, "delete", before=before, after=row)
    db.commit()
    return {"deleted": True, "flow_id": row.id}


def detail(db: Session, flow_id: int) -> dict[str, Any]:
    """流水详情（含已被冲销的单据列表）。"""
    row = get_flow(db, flow_id)
    project_name = db.execute(select(Project.name).where(Project.id == row.project_id)).scalar()
    out = serialize(row, project_name)
    offsets = offsets_of_flow(db, row.id)
    out["offsets"] = offsets
    out["offset_amount"] = sum_money(item["amount"] for item in offsets)
    out["unoffset_amount"] = money(out["amount"] - out["offset_amount"])
    return out


def summary(
    db: Session,
    *,
    project_id: int | None = None,
    start: date | None = None,
    end: date | None = None,
    direction: str | None = None,
) -> dict[str, Any]:
    """汇总：收 / 付 / 净额（仅资金口径，与利润无关）。

    `direction` 传入 in / out 时，**两个合计都只统计该方向**（另一方向归零），
    好让界面在"只看收款 / 只看付款"时合计与列表口径一致。
    """
    check_range(start, end)
    conds = [FundsFlow.deleted == 0, *range_conds(FundsFlow.biz_date, start, end)]
    if project_id is not None:
        conds.append(FundsFlow.project_id == int(project_id))
    if direction:
        conds.append(FundsFlow.direction == direction)

    stmt = (
        select(FundsFlow.direction, func.sum(FundsFlow.amount), func.count())
        .where(*conds)
        .group_by(FundsFlow.direction)
    )
    totals = {DIRECTION_IN: ZERO, DIRECTION_OUT: ZERO}
    counts = {DIRECTION_IN: 0, DIRECTION_OUT: 0}
    for row_direction, amount, count in db.execute(stmt).all():
        totals[str(row_direction)] = money(amount)
        counts[str(row_direction)] = int(count)

    by_type_stmt = (
        select(FundsFlow.direction, FundsFlow.biz_type, func.sum(FundsFlow.amount))
        .where(*conds)
        .group_by(FundsFlow.direction, FundsFlow.biz_type)
    )
    by_type = [
        {
            "direction": row_direction,
            "biz_type": biz_type,
            "biz_type_label": BIZ_TYPE_LABELS.get(str(biz_type), str(biz_type)),
            "amount": money(amount),
        }
        for row_direction, biz_type, amount in db.execute(by_type_stmt).all()
    ]

    return {
        "total_in": totals[DIRECTION_IN],
        "total_out": totals[DIRECTION_OUT],
        "net": money(totals[DIRECTION_IN] - totals[DIRECTION_OUT]),
        "count_in": counts[DIRECTION_IN],
        "count_out": counts[DIRECTION_OUT],
        "by_type": sorted(by_type, key=lambda item: item["amount"], reverse=True),
        "range": {"start_date": dstr(start), "end_date": dstr(end)},
    }
