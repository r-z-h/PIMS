"""变更日志查询（docs/03-接口设计.md 第 12 节）。"""

from __future__ import annotations

import json
from datetime import date
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models.change_log import ACTION_LABELS, ChangeLog
from ..utils.dates import check_range, range_conds


def serialize(row: ChangeLog, parse: bool = True) -> dict[str, Any]:
    def _load(raw: str | None) -> Any:
        if not raw:
            return None
        if not parse:
            return raw
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return raw

    return {
        "id": row.id,
        "table_name": row.table_name,
        "record_id": row.record_id,
        "action": row.action,
        "action_label": ACTION_LABELS.get(row.action, row.action),
        "before": _load(row.before_json),
        "after": _load(row.after_json),
        "operator": row.operator,
        "created_at": row.created_at,
    }


def list_logs(
    db: Session,
    *,
    table_name: str | None = None,
    record_id: int | None = None,
    action: str | None = None,
    start: date | None = None,
    end: date | None = None,
    page: int = 1,
    page_size: int = 20,
) -> tuple[list[dict[str, Any]], int]:
    check_range(start, end)
    stmt = select(ChangeLog)
    conds = []
    if table_name:
        conds.append(ChangeLog.table_name == table_name)
    if record_id is not None:
        conds.append(ChangeLog.record_id == int(record_id))
    if action:
        conds.append(ChangeLog.action == action)
    conds.extend(range_conds(func.date(ChangeLog.created_at), start, end))
    stmt = stmt.where(*conds)

    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar() or 0
    rows = db.execute(
        stmt.order_by(ChangeLog.id.desc()).offset((page - 1) * page_size).limit(page_size)
    ).scalars().all()
    return [serialize(row) for row in rows], int(total)


def record_history(db: Session, table_name: str, record_id: int) -> list[dict[str, Any]]:
    """某条记录的全部修改历史（详情抽屉的时间线数据源），按时间正序。"""
    rows = db.execute(
        select(ChangeLog)
        .where(ChangeLog.table_name == table_name, ChangeLog.record_id == int(record_id))
        .order_by(ChangeLog.id.asc())
    ).scalars().all()
    return [serialize(row) for row in rows]


def recent(db: Session, limit: int = 20) -> list[dict[str, Any]]:
    rows = db.execute(select(ChangeLog).order_by(ChangeLog.id.desc()).limit(limit)).scalars().all()
    return [serialize(row) for row in rows]
