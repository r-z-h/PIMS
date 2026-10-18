"""应收应付与冲销出入参。"""

from __future__ import annotations

from datetime import date

from pydantic import Field

from .common import ArApType, FundsBizType, InModel, MoneyAmount, PatchModel


class ArApCreate(InModel):
    project_id: int = Field(gt=0)
    type: ArApType
    biz_type: FundsBizType
    amount: MoneyAmount = Field(gt=0)
    biz_date: date
    partner: str | None = Field(default=None, max_length=100)
    cost_id: int | None = None
    remark: str | None = None


class ArApUpdate(PatchModel):
    biz_type: FundsBizType | None = None
    amount: MoneyAmount | None = Field(default=None, gt=0)
    biz_date: date | None = None
    partner: str | None = Field(default=None, max_length=100)
    cost_id: int | None = None
    remark: str | None = None


class OffsetItem(InModel):
    ar_ap_id: int = Field(gt=0)
    amount: MoneyAmount = Field(gt=0)


class OffsetCreate(InModel):
    """手工冲销：一次可以冲多张单据。"""

    funds_flow_id: int = Field(gt=0)
    offsets: list[OffsetItem] = Field(min_length=1)
    offset_date: date
    remark: str | None = None
