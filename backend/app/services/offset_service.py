"""应收应付「手工冲销」（docs/01-开发手册.md 4.4、docs/00-需求冻结.md R9）。

口径：
- 必须**手工指定单据**，不做自动冲最早
- 单张冲销额 ≤ 该单据未结额
- 本次冲销合计（含该流水历史上已冲销的部分）≤ 流水金额
- 冲销后重算 `settled_amount` 与 `status`（open / partial / closed）
- 撤销冲销要完整回滚 `settled_amount` 与状态
- **冲销不改成本、不改利润**
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models.ar_ap import DIRECTION_BY_TYPE, TYPE_LABELS, ArAp
from ..models.ar_ap_offset import ArApOffset
from ..models.funds_flow import BIZ_TYPE_LABELS, FundsFlow
from ..utils.changelog import log_change, log_create, row_to_dict
from ..utils.dates import dstr
from ..utils.errors import BadRequest, NotFound
from ..utils.money import ZERO, money, sum_money
from . import arap_service, funds_service

# 流水方向 → 该方向能冲销的单据类型（收款冲应收、付款冲应付）
DIRECTION_TO_TYPE = {direction: arap_type for arap_type, direction in DIRECTION_BY_TYPE.items()}


def recalc(db: Session, arap: ArAp) -> ArAp:
    """按全部冲销记录重算 settled_amount 与 status。"""
    settled = db.execute(
        select(func.sum(ArApOffset.amount)).where(ArApOffset.ar_ap_id == arap.id)
    ).scalar()
    arap.settled_amount = money(settled, ZERO)
    if arap.settled_amount > money(arap.amount):
        arap.settled_amount = money(arap.amount)
    arap.status = arap_service.compute_status(arap.amount, arap.settled_amount)
    db.flush()
    return arap


def auto_offset_plan(db: Session, funds_flow_id: int) -> dict[str, Any]:
    """**自动冲销计划（只算不写）**：给界面「预冲窗口」用（需求 T4）。

    规则（用户 2026-10-16 指定，必须可预期）：
    1. 优先冲**同一项目**下、**业务类型相同**、**日期最早**的未结单据
    2. 一笔付款不够冲一张单 → 该单形成「部分」；还有余额 → 继续冲下一张
    3. 冲完仍有余款 → 留在该笔流水上作为**可冲余额**（不报错、不丢弃）
    4. 同一项目下找不到可冲的未结单据 → 返回空计划 + 提示文案

    只返回建议，**不落库**；用户确认后再走 `create_offset`。
    """
    flow = funds_service.get_flow(db, int(funds_flow_id))
    flow_amount = money(flow.amount)
    already = funds_service.offset_total(db, flow.id)
    available = money(flow_amount - already)

    arap_type = DIRECTION_TO_TYPE.get(flow.direction)
    if arap_type is None:
        raise BadRequest("流水方向不合法，无法自动冲销")

    result: dict[str, Any] = {
        "funds_flow_id": flow.id,
        "direction": flow.direction,
        "arap_type": arap_type,
        "flow_amount": flow_amount,
        "already_offset": money(already),
        "available": available if available > ZERO else ZERO,
        "plan": [],
        "plan_total": ZERO,
        "remaining": available if available > ZERO else ZERO,
        "has_candidate": False,
        "message": "",
    }
    if available <= ZERO:
        result["remaining"] = ZERO
        result["message"] = "这笔流水的金额已全部用于冲销，没有可再冲的额度。"
        return result

    # 候选：同项目 + 同类型 + 未结清，日期最早优先（同日按 id，保证顺序稳定可预期）
    stmt = (
        select(ArAp)
        .where(
            ArAp.deleted == 0,
            ArAp.project_id == flow.project_id,
            ArAp.type == arap_type,
            ArAp.status != "closed",
        )
        .order_by(ArAp.biz_date.asc(), ArAp.id.asc())
    )
    pool = list(db.execute(stmt).scalars().all())

    # 候选筛选优先级（2026-10-16 修正）：
    #   ① 对方一致 + 业务类型一致  —— "我付给李四的钱，先冲李四的欠款"
    #   ② 业务类型一致            —— 同类型里按日期最早
    #   ③ 全部未结单据            —— 兜底，避免"明明有欠款却冲不了"
    #
    # 为什么必须有 ①：原来只按「同项目 + 同业务类型 + 日期最早」，
    # **完全不看这笔钱是付给谁的**。于是给李四发 1500 工资，会先冲掉张三更早的欠款，
    # 李四那笔还挂着 —— 从"谁欠谁"的角度这钱就记错人了。
    flow_partner = (flow.partner or "").strip()
    typed = [row for row in pool if flow.biz_type and row.biz_type == flow.biz_type]
    if flow_partner:
        same_partner = [row for row in typed if (row.partner or "").strip() == flow_partner]
        if same_partner:
            candidates = same_partner
        elif typed:
            candidates = typed
        else:
            candidates = pool
    elif typed:
        candidates = typed
    else:
        candidates = pool

    left = available
    plan: list[dict[str, Any]] = []
    for arap in candidates:
        if left <= ZERO:
            break
        unsettled = arap_service.unsettled_of(arap)
        if unsettled <= ZERO:
            continue
        take = unsettled if unsettled <= left else left
        plan.append(
            {
                "ar_ap_id": arap.id,
                "biz_date": arap.biz_date,
                "biz_type": arap.biz_type,
                "biz_type_label": BIZ_TYPE_LABELS.get(str(arap.biz_type), str(arap.biz_type)),
                "partner": arap.partner,
                "amount": money(arap.amount),
                "unsettled": money(unsettled),
                "amount_to_offset": money(take),
            }
        )
        left = money(left - take)

    plan_total = sum_money(item["amount_to_offset"] for item in plan)
    result["plan"] = plan
    result["plan_total"] = plan_total
    result["remaining"] = money(left)
    result["has_candidate"] = bool(plan)
    if not plan:
        label = "应收单" if arap_type == "receivable" else "应付单"
        result["message"] = f"本次未找到可冲销的{label}（同一项目下没有未结单据），付款已正常记录。"
    elif left > ZERO:
        result["message"] = (
            f"按「同项目、同业务类型、日期最早优先」自动冲销 {len(plan)} 张单，"
            f"合计 {plan_total:.2f}；剩余 {left:.2f} 留在本笔流水上作为可冲余额。"
        )
    else:
        result["message"] = f"按「同项目、同业务类型、日期最早优先」自动冲销 {len(plan)} 张单，合计 {plan_total:.2f}。"
    return result


def _flow_biz_date(db: Session, funds_flow_id: int) -> str:
    """取流水自身的业务日期，作为自动冲销的缺省冲销日期。"""
    flow = funds_service.get_flow(db, int(funds_flow_id))
    return dstr(flow.biz_date)


def auto_offset_apply(db: Session, funds_flow_id: int, *, commit: bool = True) -> dict[str, Any]:
    """按自动规则**直接执行**冲销（预冲窗口里用户没改动时走这条）。"""
    plan = auto_offset_plan(db, funds_flow_id)
    if not plan["plan"]:
        return {
            **plan,
            "applied": False,
            "offset_ids": [],
            "result_message": plan["message"],
        }
    created = create_offset(
        db,
        {
            "funds_flow_id": funds_flow_id,
            "offsets": [
                {"ar_ap_id": item["ar_ap_id"], "amount": item["amount_to_offset"]}
                for item in plan["plan"]
            ],
            # 缺省用流水自身的业务日期（界面预冲窗口里用户可改）
            "offset_date": plan.get("offset_date") or _flow_biz_date(db, funds_flow_id),
        },
        commit=commit,
    )
    return {
        **plan,
        "applied": True,
        **created,
        "result_message": plan["message"],
    }


def create_offset(db: Session, data: dict[str, Any], *, commit: bool = True) -> dict[str, Any]:
    """一次可冲多张单据。`commit=False` 时交给调用方提交（用于与付款流水/成本同一事务）。"""
    from .locks import ensure_mutable

    flow = funds_service.get_flow(db, int(data["funds_flow_id"]))
    ensure_mutable(db, flow.project_id)
    flow_amount = money(flow.amount)
    already = funds_service.offset_total(db, flow.id)

    # 同一张单据在一次请求里出现多次 → 合并
    merged: dict[int, Decimal] = {}
    for item in data["offsets"]:
        arap_id = int(item["ar_ap_id"])
        merged[arap_id] = money(merged.get(arap_id, ZERO) + money(item["amount"]))

    total = sum_money(merged.values())
    if total > money(flow_amount - already):
        remaining = money(flow_amount - already)
        raise BadRequest(f"本次冲销合计 {total:.2f} 超过流水可冲销金额 {remaining:.2f}")

    expect_direction = DIRECTION_BY_TYPE  # 应收↔收款(in)、应付↔付款(out)
    offset_date = dstr(data["offset_date"])
    created: list[ArApOffset] = []
    updated: list[ArAp] = []

    for arap_id, amount in merged.items():
        arap = arap_service.get_arap(db, arap_id)
        if arap.project_id != flow.project_id:
            raise BadRequest("单据与收付款流水不属于同一个项目")
        if flow.direction != expect_direction[arap.type]:
            label = TYPE_LABELS.get(arap.type, arap.type)
            direction_label = "收款" if flow.direction == "in" else "付款"
            raise BadRequest(f"{label}单只能用{direction_label}流水冲销")

        available = arap_service.unsettled_of(arap)
        if amount > available:
            raise BadRequest(
                f"单据 #{arap.id} 冲销额 {amount:.2f} 超过未结金额 {available:.2f}"
            )

        offset = ArApOffset(
            ar_ap_id=arap.id,
            funds_flow_id=flow.id,
            amount=amount,
            offset_date=offset_date,
            remark=data.get("remark"),
        )
        db.add(offset)
        db.flush()
        log_create(db, "ar_ap_offset", offset)

        before = row_to_dict(arap, raw=True)
        recalc(db, arap)
        log_change(db, "ar_ap", arap.id, "update", before=before, after=arap)
        created.append(offset)
        updated.append(arap)

    if commit:
        db.commit()
    return {
        "offset_ids": [row.id for row in created],
        "funds_flow_id": flow.id,
        "flow_amount": flow_amount,
        "offset_amount": total,
        "flow_offset_total": money(already + total),
        "flow_offset_remaining": money(flow_amount - already - total),
        "items": [arap_service.serialize(row) for row in updated],
    }


def delete_offset(db: Session, offset_id: int) -> dict[str, Any]:
    """撤销某条冲销：回滚 settled_amount 与状态。"""
    offset = db.get(ArApOffset, int(offset_id))
    if offset is None:
        raise NotFound("冲销记录不存在")

    arap = db.get(ArAp, offset.ar_ap_id)
    if arap is None:  # pragma: no cover - 外键保证不会出现
        raise NotFound("单据不存在")

    # 撤销冲销同样是"改已锁项目的账"（2026-10-17）
    from .locks import ensure_mutable

    ensure_mutable(db, arap.project_id)

    snapshot = row_to_dict(offset, raw=True)
    db.delete(offset)
    db.flush()
    log_change(db, "ar_ap_offset", offset_id, "delete", before=snapshot, after=None)

    before = row_to_dict(arap, raw=True)
    recalc(db, arap)
    log_change(db, "ar_ap", arap.id, "update", before=before, after=arap)
    db.commit()

    flow = db.get(FundsFlow, offset.funds_flow_id)
    flow_amount = money(flow.amount) if flow is not None else ZERO
    remaining_on_flow = money(flow_amount - funds_service.offset_total(db, offset.funds_flow_id))
    return {
        "deleted": True,
        "offset_id": offset_id,
        "ar_ap_id": arap.id,
        "unsettled": arap_service.unsettled_of(arap),
        "status": arap.status,
        "flow_offset_remaining": remaining_on_flow,
        "flow_offset_total": funds_service.offset_total(db, offset.funds_flow_id),
    }


def offsets_by_arap(db: Session, arap_id: int) -> list[ArApOffset]:
    return list(
        db.execute(
            select(ArApOffset).where(ArApOffset.ar_ap_id == int(arap_id)).order_by(ArApOffset.id.asc())
        )
        .scalars()
        .all()
    )
