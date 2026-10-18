"""material_item 材料采购明细（1:1 关联 cost）。"""

from __future__ import annotations

from sqlalchemy import ForeignKey, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from ..utils.money import Money, Qty
from .base import Base


class MaterialItem(Base):
    __tablename__ = "material_item"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    cost_id: Mapped[int] = mapped_column(Integer, ForeignKey("cost.id"), unique=True, nullable=False)
    material_name: Mapped[str] = mapped_column(Text, nullable=False)
    unit: Mapped[str] = mapped_column(Text, nullable=False)
    quantity: Mapped[object] = mapped_column(Qty, nullable=False)
    unit_price: Mapped[object] = mapped_column(Money, nullable=False)
    supplier: Mapped[str | None] = mapped_column(Text, nullable=True)
    inventory_txn_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("inventory_txn.id"), nullable=True)
