"""项目档案与盈亏计算（docs/01-开发手册.md 4.1）。

**利润口径唯一实现处**（其他模块一律调用这里，不得自己算）：

    实际成本 = Σ 五类成本（deleted = 0）
    预计利润 = 甲方预算 − 我方成本预算
    结算利润 = 甲方预算 − 实际成本
    资金流水、应收、应付一律不参与上述任何一步。
"""

from __future__ import annotations

import json
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import Select, func, or_, select, text
from sqlalchemy.orm import Session

from ..models.cost import COST_TYPES, Cost
from ..models.funds_flow import DIRECTION_IN, DIRECTION_OUT, FundsFlow
from ..models.project import STATUS_FINISHED, STATUS_ONGOING, Project
from ..utils.changelog import log_change, log_create, log_update, row_to_dict
from ..utils.dates import check_range, dstr, range_conds, today
from ..utils.errors import BadRequest, Conflict, NotFound
from ..utils.money import ZERO, money, percent, sum_money
from . import auth_service
from .locks import is_locked

# 与项目关联的业务表（删除项目时的关联数据检查）
RELATED_TABLES = ("cost", "funds_flow", "ar_ap", "inventory_txn", "labor_settle", "inventory")


# --------------------------------------------------------------------------- 口径


def compute_metrics(client_budget: Any, cost_budget: Any, actual_cost: Any) -> dict[str, Any]:
    """利润与预算指标（全项目唯一口径）。"""
    client = money(client_budget, ZERO)
    budget = money(cost_budget, ZERO)
    actual = money(actual_cost, ZERO)
    return {
        "client_budget": client,
        "cost_budget": budget,
        "expect_profit": money(client - budget),
        "actual_cost": actual,
        "settle_profit": money(client - actual),
        "budget_left": money(budget - actual),
        "budget_usage_rate": percent(actual, budget),
    }


# --------------------------------------------------------------------------- 查询


def actual_cost_by_project(
    db: Session,
    start: date | None = None,
    end: date | None = None,
    project_ids: list[int] | None = None,
) -> dict[int, Decimal]:
    """按项目汇总实际成本（五类之和，deleted=0，按 biz_date 过滤）。"""
    check_range(start, end)
    stmt = (
        select(Cost.project_id, func.sum(Cost.amount))
        .where(Cost.deleted == 0, *range_conds(Cost.biz_date, start, end))
        .group_by(Cost.project_id)
    )
    if project_ids:
        stmt = stmt.where(Cost.project_id.in_(project_ids))
    return {int(pid): money(total) for pid, total in db.execute(stmt).all()}


def cost_by_type(
    db: Session,
    project_id: int | None = None,
    start: date | None = None,
    end: date | None = None,
) -> dict[str, Decimal]:
    """按类型汇总成本，五类都给出键（无数据为 0.00）。"""
    stmt = (
        select(Cost.type, func.sum(Cost.amount))
        .where(Cost.deleted == 0, *range_conds(Cost.biz_date, start, end))
        .group_by(Cost.type)
    )
    if project_id is not None:
        stmt = stmt.where(Cost.project_id == project_id)
    result = {ctype: ZERO for ctype in COST_TYPES}
    for ctype, total in db.execute(stmt).all():
        result[str(ctype)] = money(total)
    return result


def funds_by_project(
    db: Session,
    direction: str,
    start: date | None = None,
    end: date | None = None,
    project_ids: list[int] | None = None,
) -> dict[int, Decimal]:
    """按项目汇总收 / 付金额（仅用于查看钱的进出，不参与利润）。"""
    stmt = (
        select(FundsFlow.project_id, func.sum(FundsFlow.amount))
        .where(
            FundsFlow.deleted == 0,
            FundsFlow.direction == direction,
            *range_conds(FundsFlow.biz_date, start, end),
        )
        .group_by(FundsFlow.project_id)
    )
    if project_ids:
        stmt = stmt.where(FundsFlow.project_id.in_(project_ids))
    return {int(pid): money(total) for pid, total in db.execute(stmt).all()}


def ar_ap_unsettled_by_project(
    db: Session,
    type_: str,
    start: date | None = None,
    end: date | None = None,
    project_ids: list[int] | None = None,
) -> dict[int, Decimal]:
    """按项目汇总未收 / 未付金额。"""
    from ..models.ar_ap import ArAp

    stmt = (
        select(ArAp.project_id, func.sum(ArAp.amount - ArAp.settled_amount))
        .where(ArAp.deleted == 0, ArAp.type == type_, *range_conds(ArAp.biz_date, start, end))
        .group_by(ArAp.project_id)
    )
    if project_ids:
        stmt = stmt.where(ArAp.project_id.in_(project_ids))
    out: dict[int, Decimal] = {}
    for pid, total in db.execute(stmt).all():
        value = money(total, ZERO)
        out[int(pid)] = value if value > 0 else ZERO
    return out


# --------------------------------------------------------------------------- 序列化


def parse_members(raw: str | None) -> list[str]:
    """成员名单：JSON 数组或逗号分隔文本都能读。"""
    if not raw:
        return []
    text = str(raw).strip()
    if text.startswith("["):
        try:
            data = json.loads(text)
            if isinstance(data, list):
                return [str(item).strip() for item in data if str(item).strip()]
        except json.JSONDecodeError:
            pass
    parts = text.replace("，", ",").replace("、", ",").split(",")
    return [part.strip() for part in parts if part.strip()]


def dump_members(members: list[str] | None) -> str | None:
    if members is None:
        return None
    return json.dumps([str(item).strip() for item in members if str(item).strip()], ensure_ascii=False)


def serialize(project: Project) -> dict[str, Any]:
    return {
        "id": project.id,
        "name": project.name,
        "client_name": project.client_name,
        "location": project.location,
        "manager": project.manager,
        "start_date": project.start_date,
        "status": project.status,
        # 完工锁：前端据此在按钮/表单上给出提示（真正的拦截在后端）
        "is_finished": project.status == STATUS_FINISHED,
        "is_locked": is_locked(project),
        "unlocked_at": project.unlocked_at,
        "client_budget": money(project.client_budget, ZERO),
        "cost_budget": money(project.cost_budget, ZERO),
        "members": parse_members(project.members),
        "remark": project.remark,
        "deleted": project.deleted,
        "created_at": project.created_at,
        "updated_at": project.updated_at,
    }


def ensure_mutable(db: Session, project_id: int) -> Project:
    """保留在此以便业务 service 从 project_service 直接引用。

    实现放在 `locks.py`（只依赖模型，避免 service 之间循环引用）；
    这里转一手，是为了老代码 `from .project_service import ensure_mutable` 也能用。
    """
    from .locks import ensure_mutable as _ensure_mutable

    return _ensure_mutable(db, project_id)


# --------------------------------------------------------------------------- CRUD


def get_project(db: Session, project_id: int, include_deleted: bool = False) -> Project:
    project = db.get(Project, int(project_id))
    if project is None or (project.deleted and not include_deleted):
        raise NotFound("项目不存在")
    return project


# 项目列表的「日期筛什么」（2026-10-17 用户需求）
#   start_date：按**开工日期**落在区间内
#   activity  ：该区间内**有业务数据**（成本/收付款/往来/入库/结算任一）
DATE_FIELD_START = "start_date"
DATE_FIELD_ACTIVITY = "activity"
DATE_FIELDS = (DATE_FIELD_START, DATE_FIELD_ACTIVITY)

# 「有业务数据」算哪几张表（都有 project_id + 业务日期）
ACTIVITY_SOURCES = (
    ("cost", "biz_date"),
    ("funds_flow", "biz_date"),
    ("ar_ap", "biz_date"),
    ("inventory_txn", "biz_date"),
    ("labor_settle", "settle_date"),
)


def projects_with_activity(
    db: Session, start: date | None, end: date | None
) -> set[int]:
    """区间内**有业务数据**的项目 id 集合（2026-10-17）。

    用于「项目列表按日期筛」的 activity 模式：老板想知道"这段时间哪些项目在动"。
    任何一张业务表在该区间内有记录，这个项目就算"有业务数据"。
    """
    check_range(start, end)
    ids: set[int] = set()
    if start is None and end is None:
        # 不限区间 = 有任意业务数据就算（避免"没选日期就全没了"）
        for table, _col in ACTIVITY_SOURCES:
            rows = db.execute(text(f"SELECT DISTINCT project_id FROM {table}")).scalars().all()
            ids.update(int(pid) for pid in rows if pid is not None)
        return ids

    for table, col in ACTIVITY_SOURCES:
        conds = []
        params: dict[str, Any] = {}
        if start is not None:
            conds.append(f"{col} >= :start")
            params["start"] = dstr(start)
        if end is not None:
            conds.append(f"{col} <= :end")
            params["end"] = dstr(end)
        if not conds:
            continue
        try:
            rows = db.execute(
                text(f"SELECT DISTINCT project_id FROM {table} WHERE {' AND '.join(conds)}"),
                params,
            ).scalars().all()
        except Exception:  # noqa: BLE001 - 表/列不存在时跳过（老库兼容）
            continue
        ids.update(int(pid) for pid in rows if pid is not None)

    # **刚建的项目也算"有业务数据"**（2026-10-17 实测发现）：
    # 否则新建项目在录第一笔数据之前会被筛没，用户会以为建失败了。
    created_conds = []
    created_params: dict[str, Any] = {}
    if start is not None:
        created_conds.append("date(created_at) >= :start")
        created_params["start"] = dstr(start)
    if end is not None:
        created_conds.append("date(created_at) <= :end")
        created_params["end"] = dstr(end)
    if created_conds:
        rows = db.execute(
            text("SELECT id FROM project WHERE deleted = 0 AND " + " AND ".join(created_conds)),
            created_params,
        ).scalars().all()
        ids.update(int(pid) for pid in rows if pid is not None)

    return ids


def list_projects(
    db: Session,
    *,
    status: str | None = None,
    keyword: str | None = None,
    start: date | None = None,
    end: date | None = None,
    date_field: str | None = None,
    page: int = 1,
    page_size: int = 20,
    include_deleted: bool = False,
) -> tuple[list[dict[str, Any]], int]:
    """项目列表。

    `date_field`（2026-10-17 用户需求「要通过名字和日期筛项目」）：
    - `start_date`：按**开工日期**落在 [start, end] 内筛
    - `activity` ：该区间内**有业务数据**的项目
    - 不传：不做日期筛选（老调用行为不变）
    """
    stmt: Select = select(Project)
    if not include_deleted:
        stmt = stmt.where(Project.deleted == 0)
    if status:
        stmt = stmt.where(Project.status == status)
    if keyword:
        like = f"%{keyword.strip()}%"
        stmt = stmt.where(
            or_(
                Project.name.like(like),
                Project.client_name.like(like),
                Project.manager.like(like),
                Project.location.like(like),
                Project.remark.like(like),
            )
        )

    if date_field and (start is not None or end is not None):
        check_range(start, end)
        if date_field == DATE_FIELD_START:
            # 开工日期落在区间内；没填开工日期的项目不参与（无法判断）
            if start is not None:
                stmt = stmt.where(Project.start_date.is_not(None), Project.start_date >= dstr(start))
            if end is not None:
                stmt = stmt.where(Project.start_date.is_not(None), Project.start_date <= dstr(end))
        elif date_field == DATE_FIELD_ACTIVITY:
            active_ids = projects_with_activity(db, start, end)
            # 空集合时用 -1 占位，保证返回空列表（IN () 语法不合法）
            stmt = stmt.where(Project.id.in_(active_ids or {-1}))

    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar() or 0
    rows = (
        db.execute(
            stmt.order_by(Project.status.asc(), Project.id.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        .scalars()
        .all()
    )

    # 列表直接带两个利润与已发生成本（FR-2.5）
    costs = actual_cost_by_project(db, project_ids=[row.id for row in rows] or None)
    items = []
    for row in rows:
        data = serialize(row)
        data.update(compute_metrics(row.client_budget, row.cost_budget, costs.get(row.id, ZERO)))
        items.append(data)
    return items, int(total)


def create_project(db: Session, data: dict[str, Any]) -> dict[str, Any]:
    name = (data.get("name") or "").strip()
    if not name:
        raise BadRequest("项目名称必填")

    duplicate = db.execute(
        select(Project.id).where(Project.name == name, Project.deleted == 0)
    ).scalar()

    project = Project(
        name=name,
        client_name=data.get("client_name"),
        location=data.get("location"),
        manager=data.get("manager"),
        start_date=dstr(data.get("start_date")),
        status=data.get("status") or STATUS_ONGOING,
        client_budget=money(data.get("client_budget"), ZERO),
        cost_budget=money(data.get("cost_budget"), ZERO),
        members=dump_members(data.get("members")),
        remark=data.get("remark"),
        deleted=0,
    )
    db.add(project)
    db.flush()
    log_create(db, "project", project)
    db.commit()
    out = serialize(project)
    out.update(compute_metrics(project.client_budget, project.cost_budget, ZERO))
    # 同名提示但允许（docs/01-开发手册.md 4.6）
    out["duplicate_name"] = bool(duplicate)
    return out


def update_project(db: Session, project_id: int, changes: dict[str, Any]) -> dict[str, Any]:
    project = get_project(db, project_id)
    # 完工锁（2026-10-17）：改已锁项目要先用密码解锁
    ensure_mutable(db, project.id)
    before = row_to_dict(project, raw=True)

    if "name" in changes and changes["name"] is not None:
        name = str(changes["name"]).strip()
        if not name:
            raise BadRequest("项目名称必填")
        project.name = name
    for field in ("client_name", "location", "manager", "remark"):
        if field in changes:
            setattr(project, field, changes[field])
    if "start_date" in changes:
        project.start_date = dstr(changes["start_date"])
    if "status" in changes and changes["status"] is not None:
        project.status = changes["status"]
    if "client_budget" in changes and changes["client_budget"] is not None:
        project.client_budget = money(changes["client_budget"])
    if "cost_budget" in changes and changes["cost_budget"] is not None:
        project.cost_budget = money(changes["cost_budget"])
    if "members" in changes:
        project.members = dump_members(changes["members"])

    db.flush()
    log_update(db, "project", project, before=before)
    db.commit()
    actual = actual_cost_by_project(db).get(project.id, ZERO)
    out = serialize(project)
    out.update(compute_metrics(project.client_budget, project.cost_budget, actual))
    return out


# --------------------------------------------------------------------------- 完工锁（2026-10-17 需求）
#
# 口径（用户确认）：
#   - 完工后**所有写操作**都要先解锁（成本/流水/往来/冲销/结算发放/库存/项目档案/删项目）
#   - 解锁 = 输**登录密码**；解锁后一直有效，**直到手动「重新锁定」**（重启也保持解锁）
#   - 完工本身不需要密码（在建 → 完工是加锁，不是改已锁数据）
#   - 「撤销完工」属于改已锁项目，**要密码**


def finish_project(db: Session, project_id: int) -> dict[str, Any]:
    """「完工」：把项目置为完工 → 同时落锁。"""
    project = get_project(db, int(project_id))
    if project.status == STATUS_FINISHED:
        raise BadRequest("该项目已经是完工状态")

    before = row_to_dict(project, raw=True)
    project.status = STATUS_FINISHED
    # 完工即落锁：清掉可能残留的解锁标记
    project.unlocked_at = None
    db.flush()
    log_update(db, "project", project, before=before)
    db.commit()
    return serialize(project)


def reopen_project(db: Session, project_id: int, password: str) -> dict[str, Any]:
    """「撤销完工」：改回在建。**必须输密码**（这是在改一个被锁定的项目）。"""
    project = get_project(db, int(project_id))
    if project.status != STATUS_FINISHED:
        raise BadRequest("该项目不是完工状态")

    auth_service.verify_password(db, password)

    before = row_to_dict(project, raw=True)
    project.status = STATUS_ONGOING
    project.unlocked_at = None
    db.flush()
    log_update(db, "project", project, before=before)
    db.commit()
    return serialize(project)


def unlock_project(db: Session, project_id: int, password: str) -> dict[str, Any]:
    """解锁：输登录密码 → 允许修改，**一直有效直到手动重新锁定**。"""
    project = get_project(db, int(project_id))
    if project.status != STATUS_FINISHED:
        raise BadRequest("只有已完工的项目需要解锁")

    auth_service.verify_password(db, password)

    before = row_to_dict(project, raw=True)
    project.unlocked_at = dstr(today()) + " " + datetime.now().strftime("%H:%M:%S")
    db.flush()
    log_update(db, "project", project, before=before)
    db.commit()
    return serialize(project)


def lock_project(db: Session, project_id: int) -> dict[str, Any]:
    """重新锁定（不需要密码：加锁永远是安全方向）。"""
    project = get_project(db, int(project_id))
    if project.status != STATUS_FINISHED:
        raise BadRequest("只有已完工的项目需要锁定")

    before = row_to_dict(project, raw=True)
    project.unlocked_at = None
    db.flush()
    log_update(db, "project", project, before=before)
    db.commit()
    return serialize(project)


def related_counts(db: Session, project_id: int) -> dict[str, int]:
    from ..models.ar_ap import ArAp
    from ..models.inventory import Inventory
    from ..models.inventory_txn import InventoryTxn
    from ..models.labor_settle import LaborSettle

    counts = {
        "cost": db.execute(
            select(func.count()).select_from(Cost).where(Cost.project_id == project_id, Cost.deleted == 0)
        ).scalar()
        or 0,
        "funds_flow": db.execute(
            select(func.count())
            .select_from(FundsFlow)
            .where(FundsFlow.project_id == project_id, FundsFlow.deleted == 0)
        ).scalar()
        or 0,
        "ar_ap": db.execute(
            select(func.count()).select_from(ArAp).where(ArAp.project_id == project_id, ArAp.deleted == 0)
        ).scalar()
        or 0,
        "inventory_txn": db.execute(
            select(func.count())
            .select_from(InventoryTxn)
            .where(InventoryTxn.project_id == project_id, InventoryTxn.deleted == 0)
        ).scalar()
        or 0,
        "labor_settle": db.execute(
            select(func.count()).select_from(LaborSettle).where(LaborSettle.project_id == project_id)
        ).scalar()
        or 0,
        "inventory": db.execute(
            select(func.count()).select_from(Inventory).where(Inventory.project_id == project_id)
        ).scalar()
        or 0,
    }
    return {key: int(value) for key, value in counts.items()}


def delete_project(db: Session, project_id: int, force: bool = False) -> dict[str, Any]:
    """软删除项目；项目下有成本 / 流水时返回 409，除非 force=true。"""
    project = get_project(db, project_id)
    # 完工锁（2026-10-17）：删已完工项目也要先解锁
    ensure_mutable(db, project.id)
    counts = related_counts(db, project_id)
    related = {key: value for key, value in counts.items() if value > 0}

    if related and not force:
        detail = "、".join(f"{key} {value} 条" for key, value in related.items())
        raise Conflict(f"项目下仍有数据（{detail}），如需继续请使用 force=true（将同时隐藏该项目下的成本与流水）")

    before = row_to_dict(project, raw=True)
    project.deleted = 1
    db.flush()
    log_change(db, "project", project.id, "delete", before=before, after=project)
    db.commit()
    return {"deleted": True, "project_id": project.id, "related": counts, "forced": bool(related and force)}


# --------------------------------------------------------------------------- 概览


def overview(
    db: Session,
    project_id: int,
    start: date | None = None,
    end: date | None = None,
) -> dict[str, Any]:
    """单项目概览：两个利润、实际成本、五类构成、已收已付、未收未付、库存金额。"""
    from ..models.ar_ap import TYPE_PAYABLE, TYPE_RECEIVABLE
    from ..services import inventory_service, labor_service

    check_range(start, end)
    project = get_project(db, project_id)

    by_type = cost_by_type(db, project.id, start, end)
    actual = sum_money(by_type.values())
    funded_in = funds_by_project(db, DIRECTION_IN, start, end, [project.id]).get(project.id, ZERO)
    funded_out = funds_by_project(db, DIRECTION_OUT, start, end, [project.id]).get(project.id, ZERO)
    receivable_unsettled = ar_ap_unsettled_by_project(db, TYPE_RECEIVABLE, start, end, [project.id]).get(
        project.id, ZERO
    )
    payable_unsettled = ar_ap_unsettled_by_project(db, TYPE_PAYABLE, start, end, [project.id]).get(
        project.id, ZERO
    )

    inventory_rows = inventory_service.list_balances(db, project.id)
    inventory_value = sum_money(row["balance"] * (row["last_unit_price"] or ZERO) for row in inventory_rows)
    settle_rows = labor_service.list_settles(db, project_id=project.id, page=1, page_size=1000)[0]

    return {
        "project": serialize(project),
        "metrics": compute_metrics(project.client_budget, project.cost_budget, actual),
        "cost_by_type": by_type,
        "cost_by_category": cost_category_totals(db, project.id, start, end),
        "ar_ap": {
            "receivable_unsettled": receivable_unsettled,
            "payable_unsettled": payable_unsettled,
        },
        "funds": {"total_in": funded_in, "total_out": funded_out},
        "inventory": {
            "items": inventory_rows,
            "inventory_value": inventory_value,
        },
        "labor_settle": {
            "count": len(settle_rows),
            "amount_due": sum_money(row["amount_due"] for row in settle_rows),
            "paid_amount": sum_money(row["paid_amount"] for row in settle_rows),
            "unpaid_amount": sum_money(row["amount_due"] - row["paid_amount"] for row in settle_rows),
        },
        "range": {"start_date": dstr(start), "end_date": dstr(end)},
    }


def cost_category_totals(
    db: Session,
    project_id: int | None = None,
    start: date | None = None,
    end: date | None = None,
) -> list[dict[str, Any]]:
    """杂费按小类汇总（其他类型 category 为空，仅统计有值的）。"""
    stmt = (
        select(Cost.category, func.sum(Cost.amount), func.count())
        .where(Cost.deleted == 0, Cost.category.is_not(None), *range_conds(Cost.biz_date, start, end))
        .group_by(Cost.category)
        .order_by(func.sum(Cost.amount).desc())
    )
    if project_id is not None:
        stmt = stmt.where(Cost.project_id == project_id)
    return [
        {"category": category, "amount": money(total), "count": int(count)}
        for category, total, count in db.execute(stmt).all()
    ]
