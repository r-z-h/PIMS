"""sys_setting 系统设置（键值对）。"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Text
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base


class SysSetting(Base):
    __tablename__ = "sys_setting"

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    value: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, default=datetime.now, nullable=True)


# 预置键（docs/02-数据库设计.md 2.1）
KEY_PASSWORD_HASH = "password_hash"
KEY_PWD_INITIALIZED = "pwd_initialized"
KEY_SECURITY_READY = "security_ready"
KEY_SESSION_TOKEN = "session_token"
KEY_SESSION_EXPIRE_AT = "session_expire_at"
KEY_SCHEMA_VERSION = "schema_version"
KEY_RESET_TICKET = "reset_ticket"
KEY_RESET_TICKET_EXPIRE_AT = "reset_ticket_expire_at"
KEY_LOGIN_FAIL_COUNT = "login_fail_count"
KEY_LOGIN_LOCKED_UNTIL = "login_locked_until"

SEC_QUESTION_KEYS = ("sec_q1", "sec_q2", "sec_q3")
SEC_ANSWER_KEYS = ("sec_a1", "sec_a2", "sec_a3")
