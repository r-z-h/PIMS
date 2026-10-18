"""结算出入参（五类成本共用；结算不新增成本）。"""

from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import Field

from .common import InModel, MoneyAmount, PayMethod

# 结算类别：人工 / 材料 / 机械 / 杂费 / 垫付（与 cost.type 一致）
SettleType = Literal["labor", "material", "machine", "misc", "advance"]


class SettleCreate(InModel):
    """按预览生成结算单（重复生成时覆盖未发放部分）。"""

    project_id: int = Field(gt=0)
    # 不传默认人工（兼容旧调用）
    cost_type: SettleType | None = None
    settle_date: date | None = None
    remark: str | None = None
    # 汇总时间段（不传则汇总全部）
    start_date: date | None = None
    end_date: date | None = None


class PayCreate(InModel):
    """登记发放（按结算单 id，旧入口）。"""

    amount: MoneyAmount = Field(gt=0)
    pay_date: date
    pay_method: PayMethod | None = None
    remark: str | None = None


class PartnerPayCreate(InModel):
    """按「项目 + 类别 + 对象」登记发放（结算页总览表的发放按钮，2026-10-16 起）。"""

    project_id: int = Field(gt=0)
    cost_type: SettleType = "labor"
    partner: str = Field(min_length=1, max_length=200)
    amount: MoneyAmount = Field(gt=0)
    pay_date: date
    pay_method: PayMethod | None = None
    remark: str | None = None
