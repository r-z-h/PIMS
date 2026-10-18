"""SQLAlchemy 声明式基类与通用 Mixin。"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    """所有模型的基类（表结构以 app/db/schema.sql 为准）。"""


class TimestampMixin:
    """created_at / updated_at 由系统自动写。"""

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now, onupdate=datetime.now, nullable=False)


class SoftDeleteMixin:
    """全部业务表软删除（docs/00-需求冻结.md R10）。"""

    deleted: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
