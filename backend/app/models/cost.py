"""cost 成本主表（五类统一存放）。"""

from __future__ import annotations

from sqlalchemy import ForeignKey, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from ..utils.money import Money
from .base import Base, SoftDeleteMixin, TimestampMixin

TYPE_LABOR = "labor"
TYPE_MATERIAL = "material"
TYPE_MACHINE = "machine"
TYPE_MISC = "misc"
TYPE_ADVANCE = "advance"
COST_TYPES = (TYPE_LABOR, TYPE_MATERIAL, TYPE_MACHINE, TYPE_MISC, TYPE_ADVANCE)

TYPE_LABELS = {
    TYPE_LABOR: "人工",
    TYPE_MATERIAL: "材料",
    TYPE_MACHINE: "机械",
    TYPE_MISC: "杂费",
    TYPE_ADVANCE: "垫付",
}


class Cost(Base, SoftDeleteMixin, TimestampMixin):
    __tablename__ = "cost"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(Integer, ForeignKey("project.id"), nullable=False)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str | None] = mapped_column(Text, nullable=True)  # 仅杂费使用
    amount: Mapped[object] = mapped_column(Money, nullable=False)
    biz_date: Mapped[str] = mapped_column(Text, nullable=False)
    partner: Mapped[str | None] = mapped_column(Text, nullable=True)
    remark: Mapped[str | None] = mapped_column(Text, nullable=True)
