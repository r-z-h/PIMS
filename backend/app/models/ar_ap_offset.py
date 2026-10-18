"""ar_ap_offset 冲销记录。"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from ..utils.money import Money
from .base import Base


class ArApOffset(Base):
    __tablename__ = "ar_ap_offset"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ar_ap_id: Mapped[int] = mapped_column(Integer, ForeignKey("ar_ap.id"), nullable=False)
    funds_flow_id: Mapped[int] = mapped_column(Integer, ForeignKey("funds_flow.id"), nullable=False)
    amount: Mapped[object] = mapped_column(Money, nullable=False)
    offset_date: Mapped[str] = mapped_column(Text, nullable=False)
    remark: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now, nullable=False)
