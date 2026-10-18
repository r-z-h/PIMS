"""project 项目档案。"""

from __future__ import annotations

from sqlalchemy import Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from ..utils.money import Money
from .base import Base, SoftDeleteMixin, TimestampMixin

STATUS_ONGOING = "ongoing"
STATUS_FINISHED = "finished"
STATUSES = (STATUS_ONGOING, STATUS_FINISHED)


class Project(Base, SoftDeleteMixin, TimestampMixin):
    __tablename__ = "project"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    client_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    location: Mapped[str | None] = mapped_column(Text, nullable=True)
    manager: Mapped[str | None] = mapped_column(Text, nullable=True)
    start_date: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(Text, default=STATUS_ONGOING, nullable=False)
    client_budget: Mapped[object] = mapped_column(Money, default=0, nullable=False)
    cost_budget: Mapped[object] = mapped_column(Money, default=0, nullable=False)
    members: Mapped[str | None] = mapped_column(Text, nullable=True)
    remark: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 完工锁（2026-10-17 需求）：
    #   NULL  = 已锁定（完工后默认锁定，写操作需先输密码解锁）
    #   有值  = 已解锁，记录解锁时间；一直有效直到手动「重新锁定」
    # 在建项目不看这个字段（本来就不锁）。
    unlocked_at: Mapped[str | None] = mapped_column(Text, nullable=True)
