"""labor_settle 结算单（只汇总与记录发放，绝不新增 cost）。

2026-10-16 起从「人工结算」泛化为**五类成本结算**：
- `cost_type`：labor / material / machine / misc / advance
- `partner`  ：该类别的汇总依据值（人工=姓名、材料=供应商、机械=出租方、杂费=小类、垫付=垫付人）
- `worker_name` 保留：人工用它存姓名；其他类别存同一个汇总依据值（便于沿用旧代码与导出）
"""

from __future__ import annotations

from sqlalchemy import ForeignKey, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from ..utils.money import Money, Qty2
from .base import Base, TimestampMixin

STATUS_UNPAID = "unpaid"
STATUS_PARTIAL = "partial"
STATUS_PAID = "paid"
STATUSES = (STATUS_UNPAID, STATUS_PARTIAL, STATUS_PAID)
STATUS_LABELS = {STATUS_UNPAID: "未发", STATUS_PARTIAL: "部分", STATUS_PAID: "已发"}

# 结算类别（与 cost.type 一致）
SETTLE_TYPE_LABOR = "labor"
SETTLE_TYPES = ("labor", "material", "machine", "misc", "advance")
SETTLE_TYPE_LABELS = {
    SETTLE_TYPE_LABOR: "人工",
    "material": "材料",
    "machine": "机械",
    "misc": "杂费",
    "advance": "垫付",
}
# 该类别的「按什么汇总」（界面上要显示给用户看）
SETTLE_GROUP_LABELS = {
    SETTLE_TYPE_LABOR: "按工人姓名",
    "material": "按供应商",
    "machine": "按出租方",
    "misc": "按杂费小类",
    "advance": "按垫付人",
}
# 没填对方时的占位分组名
PARTNER_NONE_LABEL = "（未填对方）"


class LaborSettle(Base, TimestampMixin):
    __tablename__ = "labor_settle"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(Integer, ForeignKey("project.id"), nullable=False)
    worker_name: Mapped[str] = mapped_column(Text, nullable=False)
    cost_type: Mapped[str] = mapped_column(Text, default=SETTLE_TYPE_LABOR, nullable=False)
    partner: Mapped[str | None] = mapped_column(Text, nullable=True)
    total_days: Mapped[object] = mapped_column(Qty2, nullable=False)
    amount_due: Mapped[object] = mapped_column(Money, nullable=False)
    paid_amount: Mapped[object] = mapped_column(Money, default=0, nullable=False)
    status: Mapped[str] = mapped_column(Text, default=STATUS_UNPAID, nullable=False)
    settle_date: Mapped[str | None] = mapped_column(Text, nullable=True)
    pay_date: Mapped[str | None] = mapped_column(Text, nullable=True)
    pay_method: Mapped[str | None] = mapped_column(Text, nullable=True)
    remark: Mapped[str | None] = mapped_column(Text, nullable=True)
