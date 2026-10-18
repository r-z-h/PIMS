"""JSON 序列化辅助：ORM 行 → dict。"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any


def json_value(value: Any) -> Any:
    """把值转成可 JSON 化的形式（Decimal 保留自身小数位）。"""
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, date):
        return value.strftime("%Y-%m-%d")
    return value


def row_to_dict(obj: Any, *, raw: bool = False) -> dict[str, Any] | None:
    """ORM 对象 → dict（列名与原表一致）。

    raw=False：Decimal 原样保留，交给统一响应体渲染成 JSON 数字；
    raw=True ：Decimal 转字符串，用于写入 change_log 的 JSON 快照。
    """
    if obj is None:
        return None
    table = getattr(obj, "__table__", None)
    if table is None:
        return dict(obj)
    out: dict[str, Any] = {}
    for column in table.columns:
        value = getattr(obj, column.key, None)
        out[column.key] = json_value(value) if raw else value
    return out
