"""系统出入参。"""

from __future__ import annotations

from pydantic import Field

from .common import InModel


class ResetIn(InModel):
    """清空业务数据（保留密码与密保）——必须显式二次确认。"""

    confirm: str = Field(default="", max_length=50)
    keep_dict: bool = True
