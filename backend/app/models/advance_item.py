"""advance_item 垫付明细（1:1 关联 cost）。"""

from __future__ import annotations

from sqlalchemy import ForeignKey, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base


class AdvanceItem(Base):
    __tablename__ = "advance_item"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    cost_id: Mapped[int] = mapped_column(Integer, ForeignKey("cost.id"), unique=True, nullable=False)
    payer: Mapped[str | None] = mapped_column(Text, nullable=True)
    purpose: Mapped[str | None] = mapped_column(Text, nullable=True)
