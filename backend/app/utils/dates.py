"""业务日期工具（docs/00-需求冻结.md R8：时间段筛选一律按业务日期）。"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

FMT = "%Y-%m-%d"


def today() -> date:
    return date.today()


def to_date(value: Any) -> date | None:
    """把 date / datetime / 'YYYY-MM-DD' 统一成 date，无法解析返回 None。"""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        text = value.strip()
        for fmt in (FMT, "%Y/%m/%d", "%Y.%m.%d"):
            try:
                return datetime.strptime(text, fmt).date()
            except ValueError:
                continue
        try:  # ISO8601 带时间
            return datetime.fromisoformat(text).date()
        except ValueError:
            return None
    return None


def dstr(value: Any) -> str | None:
    """转成 'YYYY-MM-DD' 文本（数据库里 biz_date 就是 TEXT）。"""
    d = to_date(value)
    return d.strftime(FMT) if d else None


def month_of(value: Any) -> str | None:
    """转成 'YYYY-MM'。"""
    d = to_date(value)
    return d.strftime("%Y-%m") if d else None


def is_future(value: Any) -> bool:
    d = to_date(value)
    return bool(d and d > today())


def in_range(value: Any, start: date | None = None, end: date | None = None) -> bool:
    d = to_date(value)
    if d is None:
        return False
    if start and d < start:
        return False
    if end and d > end:
        return False
    return True


def check_range(start: date | None, end: date | None) -> None:
    """开始日期晚于结束日期时直接报参数错误。"""
    from .errors import BadRequest

    if start and end and start > end:
        raise BadRequest("开始日期不能晚于结束日期")


def range_conds(column, start: date | None, end: date | None) -> list:
    """按业务日期（biz_date，TEXT 'YYYY-MM-DD'）生成筛选条件。

    业务口径：时间段筛选一律按业务发生日期，不是创建时间（docs/00-需求冻结.md R8）。
    """
    conds = []
    if start:
        conds.append(column >= dstr(start))
    if end:
        conds.append(column <= dstr(end))
    return conds
