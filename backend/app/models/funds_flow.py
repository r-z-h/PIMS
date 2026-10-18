"""funds_flow 资金流水（不参与利润计算）。"""

from __future__ import annotations

from sqlalchemy import ForeignKey, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from ..utils.money import Money
from .base import Base, SoftDeleteMixin, TimestampMixin

DIRECTION_IN = "in"
DIRECTION_OUT = "out"
DIRECTIONS = (DIRECTION_IN, DIRECTION_OUT)
DIRECTION_LABELS = {DIRECTION_IN: "收", DIRECTION_OUT: "付"}

BIZ_TYPE_PROGRESS = "progress"
BIZ_TYPE_SETTLE = "settle"
BIZ_TYPE_ADVANCE = "advance"
BIZ_TYPE_MATERIAL = "material"
BIZ_TYPE_LABOR = "labor"
BIZ_TYPE_MACHINE = "machine"
BIZ_TYPE_MISC = "misc"
BIZ_TYPE_ADVANCE_PAY = "advance_pay"
BIZ_TYPE_OTHER = "other"

BIZ_TYPES = (
    BIZ_TYPE_PROGRESS,
    BIZ_TYPE_SETTLE,
    BIZ_TYPE_ADVANCE,
    BIZ_TYPE_MATERIAL,
    BIZ_TYPE_LABOR,
    BIZ_TYPE_MACHINE,
    BIZ_TYPE_MISC,
    BIZ_TYPE_ADVANCE_PAY,
    BIZ_TYPE_OTHER,
)

BIZ_TYPE_LABELS = {
    BIZ_TYPE_PROGRESS: "进度款",
    BIZ_TYPE_SETTLE: "结算款",
    BIZ_TYPE_ADVANCE: "预支",
    BIZ_TYPE_MATERIAL: "材料款",
    BIZ_TYPE_LABOR: "人工费",
    BIZ_TYPE_MACHINE: "机械费",
    BIZ_TYPE_MISC: "杂费",
    BIZ_TYPE_ADVANCE_PAY: "垫付",
    BIZ_TYPE_OTHER: "其他",
}

# 收入 / 支出各自允许的业务类型（docs/00-需求冻结.md FR-3.2 / FR-3.3）
IN_BIZ_TYPES = (BIZ_TYPE_PROGRESS, BIZ_TYPE_SETTLE, BIZ_TYPE_ADVANCE, BIZ_TYPE_OTHER)
OUT_BIZ_TYPES = (
    BIZ_TYPE_MATERIAL,
    BIZ_TYPE_LABOR,
    BIZ_TYPE_MACHINE,
    BIZ_TYPE_MISC,
    BIZ_TYPE_ADVANCE_PAY,
    BIZ_TYPE_OTHER,
)

PAY_METHODS = ("cash", "wechat", "bank_card", "transfer")
PAY_METHOD_LABELS = {
    "cash": "现金",
    "wechat": "微信",
    "bank_card": "银行卡",
    "transfer": "转账",
}


class FundsFlow(Base, SoftDeleteMixin, TimestampMixin):
    __tablename__ = "funds_flow"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(Integer, ForeignKey("project.id"), nullable=False)
    direction: Mapped[str] = mapped_column(Text, nullable=False)
    biz_type: Mapped[str] = mapped_column(Text, nullable=False)
    amount: Mapped[object] = mapped_column(Money, nullable=False)
    biz_date: Mapped[str] = mapped_column(Text, nullable=False)
    partner: Mapped[str | None] = mapped_column(Text, nullable=True)
    pay_method: Mapped[str | None] = mapped_column(Text, nullable=True)
    remark: Mapped[str | None] = mapped_column(Text, nullable=True)
