"""ar_ap 应收应付单（不参与利润计算）。"""

from __future__ import annotations

from sqlalchemy import ForeignKey, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from ..utils.money import Money
from .base import Base, SoftDeleteMixin, TimestampMixin

TYPE_RECEIVABLE = "receivable"
TYPE_PAYABLE = "payable"
AR_AP_TYPES = (TYPE_RECEIVABLE, TYPE_PAYABLE)
TYPE_LABELS = {TYPE_RECEIVABLE: "应收", TYPE_PAYABLE: "应付"}

STATUS_OPEN = "open"
STATUS_PARTIAL = "partial"
STATUS_CLOSED = "closed"
STATUSES = (STATUS_OPEN, STATUS_PARTIAL, STATUS_CLOSED)
STATUS_LABELS = {STATUS_OPEN: "未收付", STATUS_PARTIAL: "部分", STATUS_CLOSED: "已结清"}

# 应收只允许：进度款 / 结算款（docs/00-需求冻结.md FR-4.1）
RECEIVABLE_BIZ_TYPES = ("progress", "settle")
PAYABLE_BIZ_TYPES = ("material", "labor", "machine", "misc", "advance_pay", "other")

# 单据类型 ←→ 资金流水方向
DIRECTION_BY_TYPE = {TYPE_RECEIVABLE: "in", TYPE_PAYABLE: "out"}


class ArAp(Base, SoftDeleteMixin, TimestampMixin):
    __tablename__ = "ar_ap"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(Integer, ForeignKey("project.id"), nullable=False)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    biz_type: Mapped[str] = mapped_column(Text, nullable=False)
    amount: Mapped[object] = mapped_column(Money, nullable=False)
    settled_amount: Mapped[object] = mapped_column(Money, default=0, nullable=False)
    status: Mapped[str] = mapped_column(Text, default=STATUS_OPEN, nullable=False)
    biz_date: Mapped[str] = mapped_column(Text, nullable=False)
    partner: Mapped[str | None] = mapped_column(Text, nullable=True)
    cost_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("cost.id"), nullable=True)
    remark: Mapped[str | None] = mapped_column(Text, nullable=True)
