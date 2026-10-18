"""人工结算：只汇总与记录发放，**绝不新增成本**（docs/00-需求冻结.md FR-7 / R6）。

口径：
- 录工天即入成本（cost.type='labor'）
- 结算 = 按「项目 + 姓名」汇总总工天与应发金额（= 该人已入成本的金额合计）
- 发放只更新结算单的 `paid_amount / pay_date / pay_method / status`，不碰 cost
"""

from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..models.advance_item import AdvanceItem
from ..models.ar_ap import ArAp
from ..models.ar_ap_offset import ArApOffset
from ..models.cost import COST_TYPES, TYPE_LABOR, Cost
from ..models.funds_flow import PAY_METHOD_LABELS, FundsFlow
from ..models.labor_settle import (
    PARTNER_NONE_LABEL,
    SETTLE_GROUP_LABELS,
    SETTLE_TYPE_LABELS,
    SETTLE_TYPE_LABOR,
    SETTLE_TYPES,
    STATUS_LABELS,
    STATUS_PAID,
    STATUS_PARTIAL,
    STATUS_UNPAID,
    LaborSettle,
)
from ..models.labor_work import LaborWork
from ..models.machine_item import MachineItem
from ..models.material_item import MaterialItem
from ..models.project import Project
from ..utils.changelog import log_change, log_create, log_update, row_to_dict
from ..utils.dates import check_range, dstr, range_conds, today
from ..utils.errors import BadRequest, Conflict, NotFound
from ..utils.money import ZERO, money, qty2, sum_money
from . import funds_service, offset_service

NOTE = "结算不重复计入成本"

# 结算类别 → 付款流的业务类型（垫付是 advance_pay，与应收类的「预支 advance」区分开）
SETTLE_BIZ_TYPE = {
    SETTLE_TYPE_LABOR: "labor",
    "material": "material",
    "machine": "machine",
    "misc": "misc",
    "advance": "advance_pay",
}


def compute_settle_status(amount_due: Any, paid: Any) -> str:
    due = money(amount_due, ZERO)
    done = money(paid, ZERO)
    if done <= 0:
        return STATUS_UNPAID
    if done >= due:
        return STATUS_PAID
    return STATUS_PARTIAL


def serialize(row: LaborSettle, project_name: str | None = None) -> dict[str, Any]:
    """结算单快照的序列化。

    ⚠️ 2026-10-16 起 `paid_amount` **不再是结算单的属性**——
    已付由应付单上的冲销记录算出来（见 `settlement_overview`）。
    这里保留字段只为兼容旧调用，值固定为 0；**不要**拿它算"还欠多少"。
    """
    due = money(row.amount_due)
    cost_type = row.cost_type or SETTLE_TYPE_LABOR
    data = {
        "id": row.id,
        "project_id": row.project_id,
        "worker_name": row.worker_name,
        "cost_type": cost_type,
        "cost_type_label": SETTLE_TYPE_LABELS.get(cost_type, cost_type),
        "partner": row.partner or row.worker_name,
        "total_days": qty2(row.total_days),
        # 这张快照只表达"本期该结多少"
        "amount_due": due,
        "paid_amount": ZERO,
        "unpaid_amount": due,
        "status": row.status,
        "status_label": STATUS_LABELS.get(row.status, row.status),
        "settle_date": row.settle_date,
        "pay_date": row.pay_date,
        "pay_method": row.pay_method,
        "remark": row.remark,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }
    if project_name is not None:
        data["project_name"] = project_name
    return data


# --------------------------------------------------------------------------- 汇总依据

# 各类别「按什么字段汇总」：人工=姓名、材料=供应商、机械=出租方、杂费=小类、垫付=垫付人
# 材料/机械的对方可能没填，统一归到 PARTNER_NONE_LABEL 一组，保证这类钱也能结算
_GROUP_EXPR = {
    SETTLE_TYPE_LABOR: LaborWork.worker_name,
    "material": MaterialItem.supplier,
    "machine": MachineItem.lessor,
    "misc": Cost.category,
    "advance": AdvanceItem.payer,
}
# 需要 join 的明细表（杂费没有明细表，只用 cost 主表）
_GROUP_JOIN = {
    SETTLE_TYPE_LABOR: (LaborWork, LaborWork.cost_id),
    "material": (MaterialItem, MaterialItem.cost_id),
    "machine": (MachineItem, MachineItem.cost_id),
    "advance": (AdvanceItem, AdvanceItem.cost_id),
}


def normalize_settle_type(cost_type: str | None) -> str:
    """校验并归一结算类别；不传默认人工（兼容旧调用）。"""
    value = (cost_type or SETTLE_TYPE_LABOR).strip()
    if value not in SETTLE_TYPES:
        raise BadRequest(f"结算类别不正确：{value}（可选 {'/'.join(SETTLE_TYPES)}）")
    return value


def group_label(cost_type: str) -> str:
    """该项目该类别「按谁汇总」的显示名（材料没填供应商时按材料名兜底）。"""
    return SETTLE_GROUP_LABELS.get(cost_type, "")


def preview(
    db: Session,
    project_id: int,
    start: date | None = None,
    end: date | None = None,
    cost_type: str | None = None,
) -> dict[str, Any]:
    """结算预览：**按该类别的汇总依据**汇总金额（不写库、不新增成本）。

    - 人工：按工人姓名，并带上总工天
    - 材料：按供应商（没填的归「（未填对方）」）
    - 机械：按出租方（没填同上）
    - 杂费：按杂费小类
    - 垫付：按垫付人
    """
    from .project_service import get_project

    # 预览是**只读**的，完工锁不拦它——完工项目也要能看该结多少。
    project = get_project(db, project_id)
    check_range(start, end)
    kind = normalize_settle_type(cost_type)

    base_conds = [
        Cost.deleted == 0,
        Cost.project_id == project.id,
        Cost.type == kind,
        *range_conds(Cost.biz_date, start, end),
    ]

    rows_raw: list[tuple[Any, ...]] = []
    if kind in _GROUP_JOIN:
        detail_model, fk_col = _GROUP_JOIN[kind]
        group_col = _GROUP_EXPR[kind]
        stmt = select(
            group_col,
            func.sum(Cost.amount),
            func.count(Cost.id),
        ).join(Cost, Cost.id == fk_col)
        # 人工额外汇总总工天（其他类别没有"工天"这个概念）
        if kind == SETTLE_TYPE_LABOR:
            stmt = select(
                group_col,
                func.sum(Cost.amount),
                func.count(Cost.id),
                func.sum(LaborWork.work_days),
            ).join(Cost, Cost.id == fk_col)
        stmt = stmt.where(*base_conds).group_by(group_col).order_by(func.sum(Cost.amount).desc())
        rows_raw = [tuple(row) for row in db.execute(stmt).all()]
    else:
        # 杂费：没有明细表，直接用 cost 主表按小类汇总
        stmt = (
            select(Cost.category, func.sum(Cost.amount), func.count(Cost.id))
            .select_from(Cost)
            .where(*base_conds)
            .group_by(Cost.category)
            .order_by(func.sum(Cost.amount).desc())
        )
        rows_raw = [tuple(row) for row in db.execute(stmt).all()]

    items = []
    for row in rows_raw:
        partner = row[0]
        amount = row[1]
        count = row[2]
        days = row[3] if len(row) > 3 else ZERO
        name = str(partner).strip() if partner is not None and str(partner).strip() else PARTNER_NONE_LABEL
        items.append(
            {
                # worker_name 保留：人工就是姓名；其他类别存放同一个汇总依据值（沿用旧字段与导出）
                "worker_name": name,
                "partner": name,
                "cost_type": kind,
                "cost_type_label": SETTLE_TYPE_LABELS.get(kind, kind),
                "total_days": qty2(days or 0),
                "amount_due": money(amount),
                "cost_count": int(count or 0),
            }
        )

    return {
        "project_id": project.id,
        "project_name": project.name,
        "cost_type": kind,
        "cost_type_label": SETTLE_TYPE_LABELS.get(kind, kind),
        "group_label": group_label(kind),
        "items": items,
        "total_days": qty2(sum((item["total_days"] for item in items), ZERO)),
        "total_amount": sum_money(item["amount_due"] for item in items),
        "note": NOTE,
    }


def settle(
    db: Session,
    project_id: int,
    settle_date: date | None = None,
    remark: str | None = None,
    cost_type: str | None = None,
    start: date | None = None,
    end: date | None = None,
) -> dict[str, Any]:
    """保存结算单（按预览生成，重复生成时覆盖未发放部分）。

    五类成本共用这一套，只是**汇总依据不同**（人工=姓名、材料=供应商、机械=出租方、
    杂费=小类、垫付=垫付人）。同一项目下「同一类别 + 同一对象」只有一张结算单。
    """
    from .locks import ensure_mutable

    # 保存结算单是**写操作**：完工锁要拦（预览只读，不拦）
    ensure_mutable(db, project_id)
    kind = normalize_settle_type(cost_type)
    result = preview(db, project_id, start=start, end=end, cost_type=kind)
    day = dstr(settle_date) or dstr(today())

    existing: dict[str, LaborSettle] = {}
    for row in (
        db.execute(
            select(LaborSettle).where(
                LaborSettle.project_id == int(project_id),
                LaborSettle.cost_type == kind,
            )
        )
        .scalars()
        .all()
    ):
        existing[row.partner or row.worker_name] = row

    created: list[LaborSettle] = []
    updated: list[LaborSettle] = []
    preview_names: set[str] = set()

    for item in result["items"]:
        name = item["partner"]
        preview_names.add(name)
        row = existing.get(name)
        if row is None:
            row = LaborSettle(
                project_id=int(project_id),
                worker_name=name,
                cost_type=kind,
                partner=name,
                total_days=item["total_days"],
                amount_due=item["amount_due"],
                paid_amount=ZERO,
                status=STATUS_UNPAID,
                settle_date=day,
                remark=remark,
            )
            db.add(row)
            db.flush()
            log_create(db, "labor_settle", row)
            created.append(row)
        else:
            before = row_to_dict(row, raw=True)
            row.worker_name = name
            row.partner = name
            row.total_days = item["total_days"]
            row.amount_due = item["amount_due"]
            row.settle_date = day
            if remark is not None:
                row.remark = remark
            # 状态不再由结算单自己的 paid_amount 决定：按该对象的真实欠款算
            summary = settlement_overview_of(db, int(project_id), name, kind)
            row.status = compute_settle_status(item["amount_due"], summary["paid_amount"])
            db.flush()
            log_update(db, "labor_settle", row, before=before)
            updated.append(row)

    # 已经不在预览里的快照直接撤掉（不再以"发过钱"为由保留——钱在流水与冲销里，不在这张快照上）
    deleted = 0
    for name, row in existing.items():
        if name in preview_names:
            continue
        before = row_to_dict(row, raw=True)
        settle_id_value = row.id
        db.delete(row)
        db.flush()
        log_change(db, "labor_settle", settle_id_value, "delete", before=before, after=None)
        deleted += 1

    db.commit()
    return {
        "project_id": int(project_id),
        "cost_type": kind,
        "cost_type_label": SETTLE_TYPE_LABELS.get(kind, kind),
        "settle_date": day,
        "created": len(created),
        "updated": len(updated),
        "deleted": deleted,
        "items": [serialize(row) for row in created + updated],
        "total_amount": result["total_amount"],
        "note": NOTE,
    }


def settlement_overview(
    db: Session,
    project_id: int,
    cost_type: str | None = None,
    start: date | None = None,
    end: date | None = None,
) -> dict[str, Any]:
    """**欠款总览**（一对象一行，累计口径）—— 结算页上半张表。

    这是 2026-10-16 修「结算页已发跟应付单对不上」的核心：

    - **应付金额（累计）**：该对象名下**全部**未删除成本之和（不看时间段）
    - **已付（累计）**：该对象名下应付单上**所有冲销记录之和**
      —— 钱从哪个入口付的都算（收/付款页、冲销弹窗、登记已付、结算发放），
      所以不会再出现"应付单已冲 500、结算页却显示已发 0"
    - **还欠** = 应付 − 已付（发放的硬上限，防止多付）
    - **付款构成**：按 `pay_method` 汇总，如 `{wechat: 300, cash: 200}`
    - **本期该结**：按时间段算的金额（只用于展示与"保存结算单"的快照口径）

    时间段参数**只用来决定"显示哪些对象"**（该区间内有成本的对象），不影响上面的累计金额。
    """
    from .project_service import get_project

    # 欠款总览是**只读**的，完工锁不拦它。
    project = get_project(db, project_id)
    check_range(start, end)
    kind = normalize_settle_type(cost_type)
    biz_type = SETTLE_BIZ_TYPE[kind]

    # ① 该类别全部成本 → 按对象累计应付
    detail_model, fk_col = _GROUP_JOIN.get(kind), None
    group_col = _GROUP_EXPR[kind]
    if kind in _GROUP_JOIN:
        fk_col = _GROUP_JOIN[kind][1]
        cost_stmt = select(group_col, func.sum(Cost.amount)).join(Cost, Cost.id == fk_col)
    else:
        cost_stmt = select(group_col, func.sum(Cost.amount)).select_from(Cost)
    cost_stmt = cost_stmt.where(
        Cost.deleted == 0, Cost.project_id == project.id, Cost.type == kind
    ).group_by(group_col)

    if detail_model is None:
        detail_model = None  # 杂费没有明细表，只是为了类型检查占位

    due_map: dict[str, Decimal] = {}
    for partner, amount in db.execute(cost_stmt).all():
        name = _partner_name(partner)
        due_map[name] = money(amount)

    # ② 该对象名下所有冲销记录 → 累计已付（含付款方式构成）
    offset_stmt = (
        select(ArAp.partner, func.sum(ArApOffset.amount), FundsFlow.pay_method)
        .join(ArApOffset, ArApOffset.ar_ap_id == ArAp.id)
        .join(FundsFlow, FundsFlow.id == ArApOffset.funds_flow_id)
        .where(
            ArAp.deleted == 0,
            ArAp.project_id == project.id,
            ArAp.type == "payable",
            ArAp.biz_type == biz_type,
        )
        .group_by(ArAp.partner, FundsFlow.pay_method)
    )
    paid_map: dict[str, Decimal] = {}
    method_map: dict[str, dict[str, Decimal]] = {}
    for partner, amount, pay_method in db.execute(offset_stmt).all():
        name = _partner_name(partner)
        paid_map[name] = money(paid_map.get(name, ZERO) + money(amount))
        key = str(pay_method) if pay_method else "unknown"
        bucket = method_map.setdefault(name, {})
        bucket[key] = money(bucket.get(key, ZERO) + money(amount))

    # ③ 时间段内有成本的对象（决定显示哪些行）
    if start or end:
        range_stmt = select(group_col).join(Cost, Cost.id == fk_col) if fk_col is not None else select(group_col).select_from(Cost)
        range_stmt = range_stmt.where(
            Cost.deleted == 0,
            Cost.project_id == project.id,
            Cost.type == kind,
            *range_conds(Cost.biz_date, start, end),
        ).group_by(group_col)
        visible = {_partner_name(row[0]) for row in db.execute(range_stmt).all()}
    else:
        visible = set(due_map.keys())

    # ④ 本期该结（时间段内的成本）—— 与「保存结算单」的口径一致
    period = preview(db, project_id, start=start, end=end, cost_type=kind)
    period_map = {item["partner"]: item["amount_due"] for item in period["items"]}

    items: list[dict[str, Any]] = []
    for name in visible:
        due = money(due_map.get(name, ZERO))
        paid = money(paid_map.get(name, ZERO))
        # 已付可能因为别人多付而超过应付，这里夹到 0，不显示负数
        left = money(due - paid) if due > paid else ZERO
        methods = method_map.get(name, {})
        items.append(
            {
                "partner": name,
                "worker_name": name,
                "cost_type": kind,
                "cost_type_label": SETTLE_TYPE_LABELS.get(kind, kind),
                # 累计口径
                "amount_due": due,
                "paid_amount": paid,
                "unsettled": left,
                # 本期（时间段内）该结
                "period_amount": money(period_map.get(name, ZERO)),
                # 付款方式构成：[{pay_method, pay_method_label, amount}]
                "paid_methods": [
                    {
                        "pay_method": key,
                        "pay_method_label": PAY_METHOD_LABELS.get(key, key),
                        "amount": value,
                    }
                    for key, value in sorted(methods.items(), key=lambda kv: -kv[1])
                ],
                "status": "closed" if left <= ZERO else ("partial" if paid > ZERO else "open"),
            }
        )
    items.sort(key=lambda item: (-item["unsettled"], -item["amount_due"]))

    return {
        "project_id": project.id,
        "project_name": project.name,
        "cost_type": kind,
        "cost_type_label": SETTLE_TYPE_LABELS.get(kind, kind),
        "group_label": group_label(kind),
        "items": items,
        "total_due": sum_money(item["amount_due"] for item in items),
        "total_paid": sum_money(item["paid_amount"] for item in items),
        "total_unsettled": sum_money(item["unsettled"] for item in items),
        "note": "已付＝该对象名下应付单的全部冲销记录之和（钱从哪个入口付的都算）",
    }


def settlement_overview_of(db: Session, project_id: int, partner: str, cost_type: str | None = None) -> dict[str, Any]:
    """取某一个对象的欠款汇总（发放时用来校验上限与回填姓名）。"""
    data = settlement_overview(db, project_id, cost_type=cost_type)
    for item in data["items"]:
        if item["partner"] == partner:
            return item
    # 该对象没有未删除的成本也要给个零值，方便上层统一处理
    kind = normalize_settle_type(cost_type)
    return {
        "partner": partner,
        "worker_name": partner,
        "cost_type": kind,
        "cost_type_label": SETTLE_TYPE_LABELS.get(kind, kind),
        "amount_due": ZERO,
        "paid_amount": ZERO,
        "unsettled": ZERO,
        "period_amount": ZERO,
        "paid_methods": [],
        "status": "closed",
    }


def _partner_name(raw: Any) -> str:
    """把汇总字段的值归一成显示名（空值统一成「（未填对方）」）。"""
    if raw is None:
        return PARTNER_NONE_LABEL
    text = str(raw).strip()
    return text or PARTNER_NONE_LABEL


def pay_by_partner(
    db: Session,
    *,
    project_id: int,
    partner: str,
    cost_type: str | None = None,
    amount: Any,
    pay_date: date,
    pay_method: str | None = None,
    remark: str | None = None,
) -> dict[str, Any]:
    """按「项目 + 类别 + 对象」登记发放（结算页总览表的发放按钮走这里）。

    为什么不直接用结算单 id：**发放的口径是"这个人还欠多少"**，
    而结算单只是"本期该结多少"的快照；用户可能根本没生成过结算单，
    也可能一个月生成好几张。所以这里按对象找（没有快照就现补一张）再发放。
    """
    kind = normalize_settle_type(cost_type)
    from .locks import ensure_mutable

    ensure_mutable(db, project_id)
    partner = str(partner).strip()
    if not partner:
        raise BadRequest("缺少发放对象")

    # 找该对象在当前类别的快照；没有就按预览补一张（保证 pay() 有挂靠对象）
    row = db.execute(
        select(LaborSettle).where(
            LaborSettle.project_id == int(project_id),
            LaborSettle.cost_type == kind,
            LaborSettle.partner == partner,
        )
    ).scalars().first()
    if row is None:
        settle(
            db,
            project_id,
            settle_date=pay_date,
            cost_type=kind,
        )
        row = db.execute(
            select(LaborSettle).where(
                LaborSettle.project_id == int(project_id),
                LaborSettle.cost_type == kind,
                LaborSettle.partner == partner,
            )
        ).scalars().first()
    if row is None:
        raise NotFound(f"「{partner}」没有可结算的成本")

    return pay(db, row.id, amount, pay_date, pay_method, remark)


def get_settle(db: Session, settle_id: int) -> LaborSettle:
    row = db.get(LaborSettle, int(settle_id))
    if row is None:
        raise NotFound("结算单不存在")
    return row


def list_settles(
    db: Session,
    *,
    project_id: int | None = None,
    cost_type: str | None = None,
    status: str | None = None,
    keyword: str | None = None,
    page: int = 1,
    page_size: int = 20,
) -> tuple[list[dict[str, Any]], int]:
    stmt = select(LaborSettle, Project.name).join(Project, Project.id == LaborSettle.project_id)
    conds = [Project.deleted == 0]
    if project_id is not None:
        conds.append(LaborSettle.project_id == int(project_id))
    if cost_type:
        conds.append(LaborSettle.cost_type == normalize_settle_type(cost_type))
    if status:
        conds.append(LaborSettle.status == status)
    if keyword:
        like = f"%{keyword.strip()}%"
        conds.append(
            or_(
                LaborSettle.worker_name.like(like),
                LaborSettle.partner.like(like),
                LaborSettle.remark.like(like),
            )
        )
    stmt = stmt.where(*conds)

    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar() or 0
    rows = db.execute(
        stmt.order_by(LaborSettle.settle_date.desc(), LaborSettle.amount_due.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return [serialize(row, name) for row, name in rows], int(total)


def pay(
    db: Session,
    settle_id: int,
    amount: Any,
    pay_date: date,
    pay_method: str | None = None,
    remark: str | None = None,
) -> dict[str, Any]:
    """登记发放 → 更新结算单（**不动成本**），并**接上账**（需求 T6）：

    1. 生成一笔**付款流水**（方向=付、业务类型=该类别、对方=该对象）；
    2. 按自动冲销规则**冲销该对象对应的应付单**（同项目 → 同业务类型 → 日期最早优先），
       与「收/付款」页付款后自动冲销走**同一套逻辑**（`offset_service`）。

    2026-10-16 修正（用户实测发现）：**发放上限改用「真实未结额」**——
    即该对象名下累计应付 − 已冲销合计，而**不是**结算单自己记的 `paid_amount`。
    原因：钱可能从「收/付款」页或「登记已付」进来，那些路径不会回写结算单，
    只看结算单会把上限算高，导致**多付**。
    """
    from .locks import ensure_mutable

    row = get_settle(db, settle_id)
    ensure_mutable(db, row.project_id)

    pay_amount = money(amount)
    if pay_amount <= 0:
        raise BadRequest("发放金额必须大于 0")

    partner = row.partner or row.worker_name
    summary = settlement_overview_of(db, row.project_id, partner, row.cost_type)
    unsettled = money(summary["unsettled"])
    if unsettled <= ZERO:
        raise BadRequest(
            f"「{partner}」当前没有未结欠款（应付 {money(summary['amount_due']):.2f}，"
            f"已付 {money(summary['paid_amount']):.2f}），无需再发放。"
        )
    if pay_amount > unsettled:
        raise BadRequest(
            f"发放金额 {pay_amount:.2f} 超过未结欠款 {unsettled:.2f}"
            f"（应付 {money(summary['amount_due']):.2f} − 已付 {money(summary['paid_amount']):.2f}）。"
            f"请先到「往来」页核对，或改小金额。"
        )

    before = row_to_dict(row, raw=True)
    row.pay_date = dstr(pay_date)
    if pay_method:
        row.pay_method = pay_method
    if remark is not None:
        row.remark = remark
    db.flush()
    log_update(db, "labor_settle", row, before=before)

    # ① 生成付款流水（与「收/付款」页新增付款同一张表、同一套校验）
    #    业务类型跟着结算类别走：人工→labor、材料→material、机械→machine、杂费→misc、垫付→advance_pay
    settle_kind = row.cost_type or SETTLE_TYPE_LABOR
    partner_name = row.partner or row.worker_name
    type_label = SETTLE_TYPE_LABELS.get(settle_kind, settle_kind)
    flow = funds_service.create_flow(
        db,
        {
            "project_id": row.project_id,
            "direction": "out",
            "biz_type": SETTLE_BIZ_TYPE[settle_kind],
            "amount": pay_amount,
            "biz_date": dstr(pay_date),
            "partner": partner_name,
            "pay_method": pay_method,
            "remark": remark or f"{type_label}结算发放（{partner_name}）",
        },
        commit=False,
    )
    flow_id = int(flow["id"])

    # ② 冲销该对象对应的应付单（同业务类型、日期最早优先）
    offset_info: dict[str, Any] = {
        "applied": False,
        "offset_ids": [],
        "plan_total": ZERO,
        "remaining": pay_amount,
        "message": "",
    }
    try:
        plan = offset_service.auto_offset_apply(db, flow_id, commit=False)
        offset_info = {
            "applied": bool(plan.get("applied")),
            "offset_ids": list(plan.get("offset_ids") or []),
            "plan_total": money(plan.get("plan_total", ZERO)),
            "remaining": money(plan.get("remaining", ZERO)),
            "message": plan.get("result_message") or plan.get("message") or "",
        }
    except BadRequest:
        # 冲销失败不该让"钱已经发出去"这件事丢掉：流水照常保留，只在返回值里说明
        offset_info["message"] = "本次发放未能自动冲销应付单，请到「往来」页手工核销。"

    db.commit()

    return {
        **serialize(row),
        "funds_flow_id": flow_id,
        "offset": offset_info,
        "offset_hint": offset_info["message"],
    }


def delete_settle(db: Session, settle_id: int) -> dict[str, Any]:
    """删除结算单（**只删"本期该结多少"这张快照，不动已经付出去的钱**）。

    2026-10-16 起「已发」不再存在结算单里，所以不再用"已发放"来禁止删除；
    真金白银在付款流水与冲销记录里，删掉快照不影响它们。
    """
    from .locks import ensure_mutable

    row = get_settle(db, settle_id)
    ensure_mutable(db, row.project_id)
    before = row_to_dict(row, raw=True)
    settle_id_value = row.id
    db.delete(row)
    db.flush()
    log_change(db, "labor_settle", settle_id_value, "delete", before=before, after=None)
    db.commit()
    return {"deleted": True, "settle_id": settle_id_value}


def worker_names(db: Session, project_id: int) -> list[str]:
    """历史姓名下拉建议（来自本项目已录姓名）。"""
    rows = db.execute(
        select(LaborWork.worker_name)
        .join(Cost, Cost.id == LaborWork.cost_id)
        .where(Cost.deleted == 0, Cost.project_id == int(project_id), Cost.type == TYPE_LABOR)
        .group_by(LaborWork.worker_name)
        .order_by(LaborWork.worker_name.asc())
    ).scalars().all()
    return [str(name) for name in rows]


def settle_summary(db: Session, project_id: int | None = None) -> dict[str, Any]:
    """结算单快照合计（**只统计"本期该结"，不代表已付/欠款**）。

    已付/欠款看 `settlement_overview()`——那才是与应付单一致的数字。
    """
    conds = []
    if project_id is not None:
        conds.append(LaborSettle.project_id == int(project_id))
    rows = db.execute(
        select(
            func.sum(LaborSettle.amount_due),
            func.count(),
        ).where(*conds)
    ).one()
    due = money(rows[0], ZERO)
    return {
        "count": int(rows[1] or 0),
        "amount_due": due,
        "note": "结算单只记「本期该结」，已付与欠款见欠款总览（与应付单一致）",
    }


__all__ = [
    "compute_settle_status",
    "delete_settle",
    "get_settle",
    "list_settles",
    "pay",
    "preview",
    "serialize",
    "settle",
    "settlement_overview",
    "settlement_overview_of",
    "settle_summary",
    "worker_names",
]
