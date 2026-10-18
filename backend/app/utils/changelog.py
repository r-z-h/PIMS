"""变更日志（docs/02-数据库设计.md 2.16、docs/01-开发手册.md 4.5）。

铁律：所有业务表的增删改都要写一条 change_log（表名 / 记录 ID / 动作 / 前后快照）。
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models.change_log import ChangeLog
from .serialize import row_to_dict

OPERATOR = "boss"  # 单用户系统，操作人固定（docs/00-需求冻结.md）


def _dump(snapshot: dict[str, Any] | None) -> str | None:
    if snapshot is None:
        return None
    return json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"), default=str)


def log_change(
    db: Session,
    table_name: str,
    record_id: int,
    action: str,
    before: Any = None,
    after: Any = None,
    operator: str = OPERATOR,
) -> ChangeLog:
    """写一条变更日志（不 commit，由调用方所在事务统一提交）。"""
    before_snapshot = row_to_dict(before, raw=True) if before is not None and not isinstance(before, dict) else before
    after_snapshot = row_to_dict(after, raw=True) if after is not None and not isinstance(after, dict) else after
    log = ChangeLog(
        table_name=table_name,
        record_id=int(record_id),
        action=action,
        before_json=_dump(before_snapshot),
        after_json=_dump(after_snapshot),
        operator=operator,
        created_at=datetime.now(),
    )
    db.add(log)
    return log


def log_create(db: Session, table_name: str, obj: Any, record_id: int | None = None) -> ChangeLog:
    return log_change(db, table_name, record_id or getattr(obj, "id"), "create", before=None, after=obj)


def log_update(db: Session, table_name: str, obj: Any, before: dict[str, Any], record_id: int | None = None) -> ChangeLog:
    return log_change(
        db,
        table_name,
        record_id or getattr(obj, "id"),
        "update",
        before=before,
        after=obj,
    )


def log_delete(db: Session, table_name: str, obj: Any, record_id: int | None = None) -> ChangeLog:
    return log_change(db, table_name, record_id or getattr(obj, "id"), "delete", before=obj, after=None)


def record_logs(db: Session, table_name: str, record_id: int) -> list[ChangeLog]:
    """某条记录的全部修改历史（按时间正序，用于详情时间线）。"""
    stmt = (
        select(ChangeLog)
        .where(ChangeLog.table_name == table_name, ChangeLog.record_id == int(record_id))
        .order_by(ChangeLog.id.asc())
    )
    return list(db.execute(stmt).scalars().all())
