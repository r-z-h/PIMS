"""快速查询出入参（2026-10-19 需求）。"""

from __future__ import annotations

from datetime import date

from pydantic import Field

from .common import InModel


class QuickQueryRun(InModel):
    """执行一次快速查询。

    `types` 为勾选的查询编码，**顺序即渲染顺序**；
    只传一个就只返回一个 block（用户「只查一个内容」的场景）。
    """

    types: list[str] = Field(default_factory=list, description="勾选的查询编码；为空返回 400")
    project_id: int | None = Field(default=None, ge=1, description="项目 id；需要项目的查询必填")
    start_date: date | None = None
    end_date: date | None = None
