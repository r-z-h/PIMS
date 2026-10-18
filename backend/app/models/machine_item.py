"""machine_item 机械明细（1:1 关联 cost）。"""

from __future__ import annotations

from sqlalchemy import ForeignKey, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from ..utils.money import Money, Qty2
from .base import Base

MEASURE_SHIFT = "shift"
MEASURE_HOUR = "hour"
MEASURES = (MEASURE_SHIFT, MEASURE_HOUR)
MEASURE_LABELS = {MEASURE_SHIFT: "台班", MEASURE_HOUR: "小时"}


class MachineItem(Base):
    __tablename__ = "machine_item"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    cost_id: Mapped[int] = mapped_column(Integer, ForeignKey("cost.id"), unique=True, nullable=False)
    machine_name: Mapped[str] = mapped_column(Text, nullable=False)
    measure: Mapped[str] = mapped_column(Text, nullable=False)
    quantity: Mapped[object] = mapped_column(Qty2, nullable=False)
    unit_price: Mapped[object] = mapped_column(Money, nullable=False)
    lessor: Mapped[str | None] = mapped_column(Text, nullable=True)
