"""sys_setting 键值读写。"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models.sys_setting import SysSetting


def get(db: Session, key: str, default: str | None = None) -> str | None:
    row = db.get(SysSetting, key)
    if row is None or row.value is None:
        return default
    return row.value


def get_int(db: Session, key: str, default: int = 0) -> int:
    raw = get(db, key)
    try:
        return int(raw) if raw is not None else default
    except (TypeError, ValueError):
        return default


def get_bool(db: Session, key: str, default: bool = False) -> bool:
    raw = get(db, key)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def get_datetime(db: Session, key: str) -> datetime | None:
    raw = get(db, key)
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


def set_value(db: Session, key: str, value: Any) -> SysSetting:  # noqa: A001
    """写入（不提交，由调用方所在事务统一提交）。"""
    text = None if value is None else str(value)
    row = db.get(SysSetting, key)
    if row is None:
        row = SysSetting(key=key, value=text, updated_at=datetime.now())
        db.add(row)
    else:
        row.value = text
        row.updated_at = datetime.now()
    return row


def set_many(db: Session, values: dict[str, Any]) -> None:
    for key, value in values.items():
        set_value(db, key, value)


def remove(db: Session, key: str) -> None:
    row = db.get(SysSetting, key)
    if row is not None:
        db.delete(row)


def all_items(db: Session) -> dict[str, str | None]:
    return {row.key: row.value for row in db.execute(select(SysSetting)).scalars().all()}
