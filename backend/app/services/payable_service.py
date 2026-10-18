"""成本 ↔ 应付单联动，以及「录成本时顺手登记已付」的一体化服务。

口径（与需求方逐条确认过，见 docs/04-自测交接说明.md）：

- 记账 / 成本页每录一笔成本 → **同一事务**内生成一张应付单（金额＝成本全额，`cost_id` 关联该成本）
- 录完成本弹窗里填的「已付金额」→ 生成一笔付款流水，并**自动冲销**这张应付单；
  未填 / 关闭 → 当作已付 0，应付单全额挂账
- 成本**改金额** → 应付单实时跟着改；但该应付单**已被冲销过**则拒绝直接改，提示先撤销冲销
- 成本**删除** → 应付单**保留**（只提示，不自动删）
- 应付单保留手工新增；自动生成的用 `cost_id IS NOT NULL` 识别

金额一律 `Decimal`；本模块的所有写操作都在**调用方的事务**里完成，不自己 commit。
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models.ar_ap import TYPE_PAYABLE, ArAp
from ..models.ar_ap_offset import ArApOffset
from ..models.cost import (
    TYPE_ADVANCE,
    TYPE_LABOR,
    TYPE_MACHINE,
    TYPE_MISC,
    TYPE_MATERIAL,
    Cost,
)
from ..models.funds_flow import DIRECTION_OUT, FundsFlow
from ..utils.changelog import log_change, log_create, row_to_dict
from ..utils.dates import dstr
from ..utils.errors import BadRequest, NotFound
from ..utils.money import ZERO, money
from . import arap_service, funds_service, offset_service

# 成本类别 → 应付单的业务类型
COST_TO_BIZ_TYPE: dict[str, str] = {
    TYPE_LABOR: "labor",
    TYPE_MATERIAL: "material",
    TYPE_MACHINE: "machine",
    TYPE_MISC: "misc",
    TYPE_ADVANCE: "advance_pay",
}

SOURCE_LABEL = "由记账/成本录入自动生成"


def payable_of_cost(db: Session, cost_id: int) -> ArAp | None:
    """取某笔成本对应的应付单（自动生成的才会有）。"""
    return db.execute(
        select(ArAp)
        .where(ArAp.cost_id == int(cost_id), ArAp.deleted == 0)
        .order_by(ArAp.id.asc())
    ).scalars().first()


def _offset_count(db: Session, arap_id: int) -> int:
    from sqlalchemy import func

    return int(
        db.execute(
            select(func.count()).select_from(ArApOffset).where(ArApOffset.ar_ap_id == int(arap_id))
        ).scalar()
        or 0
    )


def offset_records(db: Session, arap_id: int) -> list[ArApOffset]:
    return list(
        db.execute(
            select(ArApOffset).where(ArApOffset.ar_ap_id == int(arap_id)).order_by(ArApOffset.id.asc())
        )
        .scalars()
        .all()
    )


def register_for_cost(db: Session, cost: Cost, *, commit: bool = False) -> ArAp:
    """为刚录入的成本生成应付单（调用方负责最终 commit）。"""
    row = ArAp(
        project_id=cost.project_id,
        type=TYPE_PAYABLE,
        biz_type=COST_TO_BIZ_TYPE.get(cost.type, "other"),
        amount=money(cost.amount),
        settled_amount=ZERO,
        status="open",
        biz_date=cost.biz_date,
        partner=cost.partner,
        cost_id=cost.id,
        remark=SOURCE_LABEL,
        deleted=0,
    )
    db.add(row)
    db.flush()
    log_create(db, "ar_ap", row)
    if commit:
        db.commit()
    return row


def sync_from_cost(
    db: Session,
    cost: Cost,
    *,
    old_amount: Decimal | None = None,
    commit: bool = False,
) -> ArAp | None:
    """成本被修改后同步应付单（金额 / 对方 / 日期）。

    - 应付单尚未被冲销 → 跟着改
    - 已被冲销过且**金额发生变化** → 400，提示先撤销冲销
    - 金额没变（只改了备注/日期等）→ 允许同步
    """
    row = payable_of_cost(db, cost.id)
    if row is None:
        return None

    new_amount = money(cost.amount)
    amount_changed = old_amount is not None and money(old_amount) != new_amount
    if amount_changed and _offset_count(db, row.id) > 0:
        raise BadRequest(
            f"该成本对应的应付单 #{row.id} 已有收付款冲销记录，无法直接改金额。"
            f"请先到「往来」页撤销冲销，再回到这里修改。"
        )

    before = row_to_dict(row, raw=True)
    row.amount = new_amount
    row.partner = cost.partner
    row.biz_date = cost.biz_date
    offset_service.recalc(db, row)
    log_change(db, "ar_ap", row.id, "update", before=before, after=row)
    db.flush()
    if commit:
        db.commit()
    return row


def on_cost_deleted(db: Session, cost: Cost) -> dict[str, Any]:
    """成本被删除：应付单**保留**，仅回传提示信息给前端。"""
    row = payable_of_cost(db, cost.id)
    if row is None:
        return {"kept": False}
    return {
        "kept": True,
        "payable_id": row.id,
        "payable_amount": money(row.amount),
        "payable_unsettled": arap_service.unsettled_of(row),
        "message": (
            f"该成本对应的应付单 #{row.id} 已保留（未删除）。"
            f"如不再需要，请到「往来」页自行处理。"
        ),
    }


def settle_cost_payment(db: Session, cost_id: int, data: dict[str, Any]) -> dict[str, Any]:
    """录完成本后登记「已付了多少」：生成付款流水 + 自动冲销该成本的应付单。

    全部字段选填：
    - 没填已付金额（或 ≤ 0）→ 什么都不做，应付单保持全额挂账
    - 已付金额 > 未结金额 → 400（请先到往来页处理，避免静默少冲销）
    - 已付金额 > 0 → 建付款流水 + 冲销记录；流水付清后仍有余额时提示（记作预付款）
    """
    cost = db.get(Cost, int(cost_id))
    if cost is None or cost.deleted:
        raise NotFound("成本不存在或已删除")

    row = payable_of_cost(db, cost.id)
    if row is None:
        raise BadRequest("该成本没有对应的应付单（可能不是通过记账/成本录入生成的）")

    raw_amount = data.get("paid_amount")
    paid = money(raw_amount) if raw_amount not in (None, "") else ZERO
    if paid < ZERO:
        raise BadRequest("已付金额不能为负数")
    if paid == ZERO:
        return {
            "recorded": False,
            "reason": "未填已付金额，应付单全额挂账",
            "arap": arap_service.serialize(row),
        }

    unsettled = arap_service.unsettled_of(row)
    if paid > unsettled:
        raise BadRequest(
            f"已付金额 {paid:.2f} 超过该应付单未结金额 {unsettled:.2f}；"
            f"请先到「往来」页核对，或填不超过未结金额的数。"
        )

    pay_date = dstr(data.get("pay_date")) or dstr(date.today())
    pay_method = data.get("pay_method")
    flow_remark = data.get("remark") or f"登记成本 #{cost.id} 的已付款"
    biz_type = COST_TO_BIZ_TYPE.get(cost.type, "other")

    flow = funds_service.create_flow(
        db,
        {
            "project_id": row.project_id,
            "direction": DIRECTION_OUT,
            "biz_type": biz_type,
            "amount": paid,
            "biz_date": pay_date,
            "partner": row.partner,
            "pay_method": pay_method,
            "remark": flow_remark,
        },
        commit=False,
    )
    flow_id = int(flow["id"])

    offset = offset_service.create_offset(
        db,
        {
            "funds_flow_id": flow_id,
            "offsets": [{"ar_ap_id": row.id, "amount": paid}],
            "offset_date": pay_date,
            "remark": f"登记成本 #{cost.id} 已付款",
        },
        commit=False,
    )

    db.commit()
    remaining = money(paid - money(offset["offset_amount"]))
    return {
        "recorded": True,
        "funds_flow_id": flow_id,
        "offset_ids": offset["offset_ids"],
        "paid_amount": paid,
        "flow_unapplied": remaining,
        "flow_unapplied_hint": (
            f"本次付款 {paid:.2f} 已全部用于冲销应付单；该付款流水已无剩余可冲金额。"
            if remaining == ZERO
            else f"本次付款有 {remaining:.2f} 未用于冲销（可到「往来」页冲其他单据）。"
        ),
        "arap": arap_service.serialize(row),
    }


def summary_for_cost(db: Session, cost_id: int) -> dict[str, Any]:
    """成本详情/弹窗预填用：返回该成本的应付单与冲销情况。"""
    cost = db.get(Cost, int(cost_id))
    if cost is None or cost.deleted:
        raise NotFound("成本不存在或已删除")
    row = payable_of_cost(db, cost.id)
    if row is None:
        return {"has_payable": False}
    offsets = offset_records(db, row.id)
    return {
        "has_payable": True,
        "arap": arap_service.serialize(row, offset_count=len(offsets)),
        "offsets": [
            {
                "id": item.id,
                "funds_flow_id": item.funds_flow_id,
                "amount": money(item.amount),
                "offset_date": item.offset_date,
                "remark": item.remark,
            }
            for item in offsets
        ],
        "paid_total": money(row.settled_amount),
        "unsettled": arap_service.unsettled_of(row),
    }
