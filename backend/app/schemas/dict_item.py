"""数据字典出入参。"""

from __future__ import annotations

from pydantic import Field

from .common import DictType, InModel, PatchModel


class DictCreate(InModel):
    dict_type: DictType
    name: str = Field(min_length=1, max_length=100)
    sort_no: int = 0
    enabled: int = 1
    remark: str | None = None


class DictUpdate(PatchModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    sort_no: int | None = None
    enabled: int | None = None
    remark: str | None = None
