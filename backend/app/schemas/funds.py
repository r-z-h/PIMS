"""资金流水出入参（不参与利润计算）。"""

from __future__ import annotations

from datetime import date

from pydantic import Field

from .common import FundsBizType, FundsDirection, InModel, MoneyAmount, PatchModel, PayMethod


class FundsCreate(InModel):
    project_id: int = Field(gt=0)
    direction: FundsDirection
    biz_type: FundsBizType
    amount: MoneyAmount = Field(gt=0)
    biz_date: date
    partner: str | None = Field(default=None, max_length=100)
    pay_method: PayMethod | None = None
    remark: str | None = None


class FundsUpdate(PatchModel):
    direction: FundsDirection | None = None
    biz_type: FundsBizType | None = None
    amount: MoneyAmount | None = Field(default=None, gt=0)
    biz_date: date | None = None
    partner: str | None = Field(default=None, max_length=100)
    pay_method: PayMethod | None = None
    remark: str | None = None
