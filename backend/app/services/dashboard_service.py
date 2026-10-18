"""看板与报表：项目盈亏总表 / 最近动态 / 成本趋势。"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models.ar_ap import TYPE_PAYABLE, TYPE_RECEIVABLE
from ..models.cost import TYPE_LABELS, Cost
from ..models.funds_flow import DIRECTION_IN, DIRECTION_OUT, FundsFlow
from ..models.labor_settle import STATUS_LABELS as SETTLE_STATUS_LABELS
from ..models.labor_settle import LaborSettle
from ..models.labor_work import LaborWork
from ..models.project import Project
from ..utils.dates import check_range, dstr, range_conds
from ..utils.money import ZERO, money, sum_money
from . import project_service


def project_table(
    db: Session,
    start: date | None = None,
    end: date | None = None,
    *,
    date_field: str | None = None,
) -> dict[str, Any]:
    """首页项目盈亏总表：未删除项目 + 合计行（时间段可选）。

    `date_field`（2026-10-17 用户需求「项目列表和首页都按名字+日期筛」）：
    - `start_date`：只列**开工日期**落在区间内的项目
    - `activity`  ：只列该区间内**有业务数据**的项目
    - 不传：不筛项目（老行为），日期只影响金额
    """
    check_range(start, end)
    stmt = select(Project).where(Project.deleted == 0)
    if date_field and (start is not None or end is not None):
        if date_field == project_service.DATE_FIELD_START:
            if start is not None:
                stmt = stmt.where(Project.start_date.is_not(None), Project.start_date >= dstr(start))
            if end is not None:
                stmt = stmt.where(Project.start_date.is_not(None), Project.start_date <= dstr(end))
        elif date_field == project_service.DATE_FIELD_ACTIVITY:
            active_ids = project_service.projects_with_activity(db, start, end)
            stmt = stmt.where(Project.id.in_(active_ids or {-1}))

    projects = db.execute(
        stmt.order_by(Project.status.asc(), Project.id.desc())
    ).scalars().all()
    ids = [row.id for row in projects]

    costs = project_service.actual_cost_by_project(db, start, end, ids or None)
    received = project_service.funds_by_project(db, DIRECTION_IN, start, end, ids or None)
    paid = project_service.funds_by_project(db, DIRECTION_OUT, start, end, ids or None)
    unreceived = project_service.ar_ap_unsettled_by_project(db, TYPE_RECEIVABLE, start, end, ids or None)
    unpaid = project_service.ar_ap_unsettled_by_project(db, TYPE_PAYABLE, start, end, ids or None)

    items: list[dict[str, Any]] = []
    for project in projects:
        metrics = project_service.compute_metrics(
            project.client_budget, project.cost_budget, costs.get(project.id, ZERO)
        )
        items.append(
            {
                "project_id": project.id,
                "name": project.name,
                "client_name": project.client_name,
                "status": project.status,
                "start_date": project.start_date,
                **metrics,
                "received": received.get(project.id, ZERO),
                "unreceived": unreceived.get(project.id, ZERO),
                "paid": paid.get(project.id, ZERO),
                "unpaid": unpaid.get(project.id, ZERO),
            }
        )

    def _sum(field: str) -> Decimal:
        return sum_money(item[field] for item in items)

    total = {
        "client_budget": _sum("client_budget"),
        "cost_budget": _sum("cost_budget"),
        "expect_profit": _sum("expect_profit"),
        "actual_cost": _sum("actual_cost"),
        "settle_profit": _sum("settle_profit"),
        "budget_left": _sum("budget_left"),
        "received": _sum("received"),
        "unreceived": _sum("unreceived"),
        "paid": _sum("paid"),
        "unpaid": _sum("unpaid"),
    }
    return {
        "items": items,
        "total": total,
        "project_count": len(items),
        "range": {"start_date": dstr(start), "end_date": dstr(end)},
    }


def recent(db: Session, limit: int = 10) -> list[dict[str, Any]]:
    """最近业务动态：成本 / 流水 / 结算混合，按创建时间倒序。"""
    size = max(1, min(limit, 50))
    names = {pid: name for pid, name in db.execute(select(Project.id, Project.name)).all()}

    events: list[dict[str, Any]] = []

    cost_rows = db.execute(
        select(Cost).where(Cost.deleted == 0).order_by(Cost.created_at.desc(), Cost.id.desc()).limit(size)
    ).scalars().all()
    labor_names = {
        cost_id: worker
        for cost_id, worker in db.execute(
            select(LaborWork.cost_id, LaborWork.worker_name).where(
                LaborWork.cost_id.in_([row.id for row in cost_rows] or [0])
            )
        ).all()
    }
    for row in cost_rows:
        label = TYPE_LABELS.get(row.type, row.type)
        worker = labor_names.get(row.id)
        title = f"{label}成本" + (f"·{worker}" if worker else "")
        if row.category:
            title = f"{label}成本·{row.category}"
        events.append(
            {
                "kind": "cost",
                "kind_label": "成本",
                "table_name": "cost",
                "record_id": row.id,
                "project_id": row.project_id,
                "project_name": names.get(row.project_id),
                "title": title,
                "type": row.type,
                "amount": money(row.amount),
                "biz_date": row.biz_date,
                "partner": row.partner,
                "created_at": row.created_at,
            }
        )

    flow_rows = db.execute(
        select(FundsFlow)
        .where(FundsFlow.deleted == 0)
        .order_by(FundsFlow.created_at.desc(), FundsFlow.id.desc())
        .limit(size)
    ).scalars().all()
    for row in flow_rows:
        events.append(
            {
                "kind": "funds",
                "kind_label": "资金流水",
                "table_name": "funds_flow",
                "record_id": row.id,
                "project_id": row.project_id,
                "project_name": names.get(row.project_id),
                "title": "收款" if row.direction == DIRECTION_IN else "付款",
                "direction": row.direction,
                "amount": money(row.amount),
                "biz_date": row.biz_date,
                "partner": row.partner,
                "created_at": row.created_at,
            }
        )

    settle_rows = db.execute(
        select(LaborSettle).order_by(LaborSettle.created_at.desc(), LaborSettle.id.desc()).limit(size)
    ).scalars().all()
    for row in settle_rows:
        events.append(
            {
                "kind": "settle",
                "kind_label": "人工结算",
                "table_name": "labor_settle",
                "record_id": row.id,
                "project_id": row.project_id,
                "project_name": names.get(row.project_id),
                "title": f"人工结算·{row.worker_name}",
                "amount": money(row.amount_due),
                "paid_amount": money(row.paid_amount),
                "status": row.status,
                "status_label": SETTLE_STATUS_LABELS.get(row.status, row.status),
                "biz_date": row.settle_date,
                "created_at": row.created_at,
            }
        )

    events.sort(key=lambda item: (item["created_at"], item["record_id"]), reverse=True)
    return events[:size]


def cost_trend(
    db: Session,
    *,
    project_id: int | None = None,
    start: date | None = None,
    end: date | None = None,
) -> dict[str, Any]:
    """按月的成本趋势（用于可选图表）。"""
    check_range(start, end)
    month_col = func.strftime("%Y-%m", Cost.biz_date)
    stmt = (
        select(month_col, Cost.type, func.sum(Cost.amount))
        .where(Cost.deleted == 0, *range_conds(Cost.biz_date, start, end))
        .group_by(month_col, Cost.type)
        .order_by(month_col.asc())
    )
    if project_id is not None:
        stmt = stmt.where(Cost.project_id == int(project_id))

    buckets: dict[str, dict[str, Any]] = {}
    for month, ctype, amount in db.execute(stmt).all():
        key = str(month or "")
        bucket = buckets.setdefault(key, {"month": key, "by_type": {}, "total": ZERO})
        bucket["by_type"][str(ctype)] = money(amount)

    items: list[dict[str, Any]] = []
    for key in sorted(buckets.keys()):
        bucket = buckets[key]
        for ctype, label in TYPE_LABELS.items():
            bucket["by_type"].setdefault(ctype, ZERO)
        bucket["total"] = sum_money(bucket["by_type"].values())
        bucket["by_type_label"] = {TYPE_LABELS.get(k, k): v for k, v in bucket["by_type"].items()}
        items.append(bucket)
    return {
        "items": items,
        "month_count": len(items),
        "range": {"start_date": dstr(start), "end_date": dstr(end)},
    }


def monthly_cost_series(db: Session, project_id: int | None = None) -> list[dict[str, Any]]:
    return cost_trend(db, project_id=project_id)["items"]
