"""labor_work 工天明细（1:1 关联 cost）。"""

from __future__ import annotations

from sqlalchemy import ForeignKey, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from ..utils.money import Money, Qty2
from .base import Base


class LaborWork(Base):
    __tablename__ = "labor_work"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    cost_id: Mapped[int] = mapped_column(Integer, ForeignKey("cost.id"), unique=True, nullable=False)
    worker_name: Mapped[str] = mapped_column(Text, nullable=False)
    work_days: Mapped[object] = mapped_column(Qty2, nullable=False)
    day_rate: Mapped[object] = mapped_column(Money, nullable=False)
    remark: Mapped[str | None] = mapped_column(Text, nullable=True)
