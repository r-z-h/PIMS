"""应收应付单（**不参与利润计算**，docs/00-需求冻结.md FR-4.5 / R4）。"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..models.ar_ap import (
    DIRECTION_BY_TYPE,
    PAYABLE_BIZ_TYPES,
    RECEIVABLE_BIZ_TYPES,
    STATUS_CLOSED,
    STATUS_LABELS,
    STATUS_PARTIAL,
    TYPE_LABELS,
    TYPE_PAYABLE,
    TYPE_RECEIVABLE,
    ArAp,
)
from ..models.ar_ap_offset import ArApOffset
from ..models.funds_flow import BIZ_TYPE_LABELS
from ..models.project import Project
from ..utils.changelog import log_change, log_create, log_update, row_to_dict
from ..utils.dates import check_range, dstr, range_conds
from ..utils.errors import BadRequest, Conflict, NotFound
from ..utils.money import ZERO, money, sum_money


def unsettled_of(row: ArAp) -> Decimal:
    """未结金额 = 金额 − 已冲销额（派生值，不落库）。"""
    value = money(row.amount) - money(row.settled_amount)
    return money(value) if value > 0 else ZERO


def serialize(row: ArAp, project_name: str | None = None, offset_count: int | None = None) -> dict[str, Any]:
    data = {
        "id": row.id,
        "project_id": row.project_id,
        "type": row.type,
        "type_label": TYPE_LABELS.get(row.type, row.type),
        "biz_type": row.biz_type,
        "biz_type_label": BIZ_TYPE_LABELS.get(row.biz_type, row.biz_type),
        "amount": money(row.amount),
        "settled_amount": money(row.settled_amount),
        "unsettled": unsettled_of(row),
        "status": row.status,
        "status_label": STATUS_LABELS.get(row.status, row.status),
        "biz_date": row.biz_date,
        "partner": row.partner,
        "cost_id": row.cost_id,
        "remark": row.remark,
        "deleted": row.deleted,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }
    if project_name is not None:
        data["project_name"] = project_name
    if offset_count is not None:
        data["offset_count"] = offset_count
    return data


def get_arap(db: Session, arap_id: int, include_deleted: bool = False) -> ArAp:
    row = db.get(ArAp, int(arap_id))
    if row is None or (row.deleted and not include_deleted):
        raise NotFound("单据不存在")
    return row


def _check_biz_type(type_: str, biz_type: str) -> None:
    allowed = RECEIVABLE_BIZ_TYPES if type_ == TYPE_RECEIVABLE else PAYABLE_BIZ_TYPES
    if biz_type not in allowed:
        label = TYPE_LABELS.get(type_, type_)
        raise BadRequest(f"{label}单不支持「{BIZ_TYPE_LABELS.get(biz_type, biz_type)}」类型")


def offset_count(db: Session, arap_id: int) -> int:
    return int(
        db.execute(
            select(func.count()).select_from(ArApOffset).where(ArApOffset.ar_ap_id == int(arap_id))
        ).scalar()
        or 0
    )


def list_arap(
    db: Session,
    *,
    type_: str | None = None,
    project_id: int | None = None,
    status: str | None = None,
    start: date | None = None,
    end: date | None = None,
    keyword: str | None = None,
    only_unsettled: bool = False,
    page: int = 1,
    page_size: int = 20,
    include_deleted: bool = False,
) -> tuple[list[dict[str, Any]], int]:
    check_range(start, end)
    stmt = select(ArAp, Project.name).join(Project, Project.id == ArAp.project_id)
    conds = []
    if not include_deleted:
        conds.append(ArAp.deleted == 0)
        conds.append(Project.deleted == 0)
    if type_:
        conds.append(ArAp.type == type_)
    if project_id is not None:
        conds.append(ArAp.project_id == int(project_id))
    if status:
        conds.append(ArAp.status == status)
    if only_unsettled:
        conds.append(ArAp.status != STATUS_CLOSED)
    conds.extend(range_conds(ArAp.biz_date, start, end))
    if keyword:
        like = f"%{keyword.strip()}%"
        conds.append(or_(ArAp.partner.like(like), ArAp.remark.like(like)))
    stmt = stmt.where(*conds)

    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar() or 0
    rows = db.execute(
        stmt.order_by(ArAp.biz_date.desc(), ArAp.id.desc()).offset((page - 1) * page_size).limit(page_size)
    ).all()
    return [serialize(row, name) for row, name in rows], int(total)


def create_arap(db: Session, data: dict[str, Any], *, commit: bool = True) -> dict[str, Any]:
    """新增应收/应付单。`commit=False` 时交给调用方提交（用于与成本组成同一事务）。"""
    from .locks import ensure_mutable

    project = ensure_mutable(db, int(data["project_id"]))
    type_ = data["type"]
    biz_type = data["biz_type"]
    _check_biz_type(type_, biz_type)

    row = ArAp(
        project_id=project.id,
        type=type_,
        biz_type=biz_type,
        amount=money(data["amount"]),
        settled_amount=ZERO,
        status="open",
        biz_date=dstr(data["biz_date"]),
        partner=data.get("partner"),
        cost_id=data.get("cost_id"),
        remark=data.get("remark"),
        deleted=0,
    )
    db.add(row)
    db.flush()
    log_create(db, "ar_ap", row)
    if commit:
        db.commit()
    return serialize(row, project.name, 0)


def update_arap(db: Session, arap_id: int, changes: dict[str, Any]) -> dict[str, Any]:
    """修改；金额不得小于已冲销额，否则 400。"""
    from .locks import ensure_mutable

    row = get_arap(db, arap_id)
    ensure_mutable(db, row.project_id)
    before = row_to_dict(row, raw=True)

    biz_type = changes.get("biz_type") or row.biz_type
    _check_biz_type(row.type, biz_type)
    row.biz_type = biz_type

    if changes.get("amount") is not None:
        new_amount = money(changes["amount"])
        if new_amount < money(row.settled_amount):
            raise BadRequest(f"单据金额不能小于已冲销金额 {money(row.settled_amount):.2f}")
        row.amount = new_amount
    if changes.get("biz_date") is not None:
        row.biz_date = dstr(changes["biz_date"])
    for field in ("partner", "cost_id", "remark"):
        if field in changes:
            setattr(row, field, changes[field])

    row.status = compute_status(row.amount, row.settled_amount)
    db.flush()
    log_update(db, "ar_ap", row, before=before)
    db.commit()
    return serialize(row, offset_count=offset_count(db, row.id))


def delete_arap(db: Session, arap_id: int) -> dict[str, Any]:
    """软删除；已有冲销时返回 409。"""
    from .locks import ensure_mutable

    row = get_arap(db, arap_id)
    ensure_mutable(db, row.project_id)
    if offset_count(db, row.id) > 0:
        raise Conflict("该单据已产生冲销记录，请先撤销冲销再删除")

    before = row_to_dict(row, raw=True)
    row.deleted = 1
    db.flush()
    log_change(db, "ar_ap", row.id, "delete", before=before, after=row)
    db.commit()
    return {"deleted": True, "ar_ap_id": row.id}


def compute_status(amount: Any, settled: Any) -> str:
    """状态流转：未收付 → 部分 → 已结清。"""
    total = money(amount)
    done = money(settled)
    if done <= 0:
        return "open"
    if done >= total:
        return STATUS_CLOSED
    return STATUS_PARTIAL


def pending(db: Session, project_id: int, type_: str) -> list[dict[str, Any]]:
    """待冲销单据：指定项目 + 单据类型，`status <> closed`。"""
    rows = db.execute(
        select(ArAp)
        .where(
            ArAp.deleted == 0,
            ArAp.project_id == int(project_id),
            ArAp.type == type_,
            ArAp.status != STATUS_CLOSED,
        )
        .order_by(ArAp.biz_date.asc(), ArAp.id.asc())
    ).scalars().all()
    return [serialize(row) for row in rows]


def detail(db: Session, arap_id: int) -> dict[str, Any]:
    """单据详情（含冲销历史）。"""
    from ..models.funds_flow import FundsFlow

    row = get_arap(db, arap_id)
    project_name = db.execute(select(Project.name).where(Project.id == row.project_id)).scalar()
    out = serialize(row, project_name)
    offsets = db.execute(
        select(ArApOffset, FundsFlow)
        .join(FundsFlow, FundsFlow.id == ArApOffset.funds_flow_id)
        .where(ArApOffset.ar_ap_id == row.id)
        .order_by(ArApOffset.id.asc())
    ).all()
    out["offsets"] = [
        {
            "offset_id": offset.id,
            "funds_flow_id": offset.funds_flow_id,
            "amount": money(offset.amount),
            "offset_date": offset.offset_date,
            "remark": offset.remark,
            "flow_direction": flow.direction,
            "flow_biz_type": flow.biz_type,
            "flow_date": flow.biz_date,
            "flow_partner": flow.partner,
        }
        for offset, flow in offsets
    ]
    out["offset_amount"] = sum_money(item["amount"] for item in out["offsets"])
    return out


def summary(
    db: Session,
    *,
    project_id: int | None = None,
    start: date | None = None,
    end: date | None = None,
) -> dict[str, Any]:
    """该收未收 / 该付未付合计。"""
    check_range(start, end)
    base = [ArAp.deleted == 0, *range_conds(ArAp.biz_date, start, end)]
    if project_id is not None:
        base.append(ArAp.project_id == int(project_id))

    result = {
        "receivable_amount": ZERO,
        "receivable_settled": ZERO,
        "receivable_unsettled": ZERO,
        "payable_amount": ZERO,
        "payable_settled": ZERO,
        "payable_unsettled": ZERO,
        "open_count": 0,
    }
    rows = db.execute(
        select(
            ArAp.type,
            func.sum(ArAp.amount),
            func.sum(ArAp.settled_amount),
            func.sum(ArAp.amount - ArAp.settled_amount),
            func.count(),
        )
        .where(*base)
        .group_by(ArAp.type)
    ).all()
    for type_, amount, settled, unsettled, count in rows:
        prefix = "receivable" if type_ == TYPE_RECEIVABLE else "payable"
        result[f"{prefix}_amount"] = money(amount)
        result[f"{prefix}_settled"] = money(settled)
        value = money(unsettled, ZERO)
        result[f"{prefix}_unsettled"] = value if value > 0 else ZERO

    result["open_count"] = int(
        db.execute(
            select(func.count())
            .select_from(ArAp)
            .where(*base, ArAp.status != STATUS_CLOSED)
        ).scalar()
        or 0
    )
    return result


def flow_direction_for(type_: str) -> str:
    return DIRECTION_BY_TYPE[type_]
