"""password_reset_log 改密记录。"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base

# action 取值
ACTION_CHANGE = "change"  # 正常改密
ACTION_RESET_BY_SECURITY = "reset_by_security"  # 密保重置
ACTION_REINIT = "reinit"  # 清空业务数据重来


class PasswordResetLog(Base):
    __tablename__ = "password_reset_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    action: Mapped[str] = mapped_column(Text, nullable=False)
    result: Mapped[str] = mapped_column(Text, nullable=False)
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now, nullable=False)
