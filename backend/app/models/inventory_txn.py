"""inventory_txn 库存流水（入库 / 领用）。"""

from __future__ import annotations

from sqlalchemy import ForeignKey, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from ..utils.money import Money, Qty
from .base import Base, SoftDeleteMixin, TimestampMixin

TXN_IN = "in"
TXN_OUT = "out"
TXN_TYPES = (TXN_IN, TXN_OUT)
TXN_LABELS = {TXN_IN: "入库", TXN_OUT: "领用"}


class InventoryTxn(Base, SoftDeleteMixin, TimestampMixin):
    __tablename__ = "inventory_txn"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(Integer, ForeignKey("project.id"), nullable=False)
    material_name: Mapped[str] = mapped_column(Text, nullable=False)
    unit: Mapped[str] = mapped_column(Text, nullable=False)
    txn_type: Mapped[str] = mapped_column(Text, nullable=False)
    quantity: Mapped[object] = mapped_column(Qty, nullable=False)
    unit_price: Mapped[object | None] = mapped_column(Money, nullable=True)
    supplier: Mapped[str | None] = mapped_column(Text, nullable=True)
    cost_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("cost.id"), nullable=True)
    biz_date: Mapped[str] = mapped_column(Text, nullable=False)
    remark: Mapped[str | None] = mapped_column(Text, nullable=True)
