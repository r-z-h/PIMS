"""Pydantic 公共类型与出入参基类。"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field

from ..utils.money import money, qty, qty2


def _to_money(value: Any) -> Decimal:
    """金额入参：字符串 / 数字都收，统一转 Decimal 两位。"""
    return money(value)


def _to_qty(value: Any) -> Decimal:
    return qty(value)


def _to_qty2(value: Any) -> Decimal:
    return qty2(value)


# 金额：接受 "4000000.00" 与 4000000.00，落到 Decimal(2 位)
MoneyAmount = Annotated[Decimal, BeforeValidator(_to_money)]
# 数量：三位小数
Quantity = Annotated[Decimal, BeforeValidator(_to_qty)]
# 工天数 / 台班数：两位小数
Quantity2 = Annotated[Decimal, BeforeValidator(_to_qty2)]

BizDate = date
ProjectStatus = Literal["ongoing", "finished"]
CostType = Literal["labor", "material", "machine", "misc", "advance"]
FundsDirection = Literal["in", "out"]
FundsBizType = Literal[
    "progress",
    "settle",
    "advance",
    "material",
    "labor",
    "machine",
    "misc",
    "advance_pay",
    "other",
]
PayMethod = Literal["cash", "wechat", "bank_card", "transfer"]
ArApType = Literal["receivable", "payable"]
ArApStatus = Literal["open", "partial", "closed"]
MachineMeasure = Literal["shift", "hour"]
DictType = Literal["misc_category", "material", "unit", "partner"]


class InModel(BaseModel):
    """入参基类：忽略多余字段，禁止未定义字段之外的隐式转换。"""

    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)


class PatchModel(InModel):
    """修改入参基类：只更新显式传入的字段。"""

    def changes(self) -> dict[str, Any]:
        return self.model_dump(exclude_unset=True)


class OutModel(BaseModel):
    """出参基类（响应由统一信封渲染，这里主要给文档与内部结构用）。"""

    model_config = ConfigDict(from_attributes=True)


class ResetConfirm(InModel):
    """危险操作二次确认。"""

    confirm: str = Field(default="", description="必须为 RESET")


__all__ = [
    "ArApStatus",
    "ArApType",
    "BizDate",
    "CostType",
    "DictType",
    "FundsBizType",
    "FundsDirection",
    "InModel",
    "MachineMeasure",
    "MoneyAmount",
    "OutModel",
    "PatchModel",
    "PayMethod",
    "ProjectStatus",
    "Quantity",
    "Quantity2",
    "ResetConfirm",
]
